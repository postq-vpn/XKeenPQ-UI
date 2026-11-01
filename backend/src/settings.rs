use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    Json(
        serde_json::json!({ "success": true, "gui": s.gui, "updater": s.updater, "log": s.log, "auth": { "enabled": s.auth.enabled }, "plugins": s.plugins }),
    )
}

pub async fn patch_settings(State(state): State<AppState>, Json(patch): Json<serde_json::Value>) -> impl IntoResponse {
    let _guard = state.app_config_lock.lock().await;
    let mut file_json = match read_config(APP_CONFIG).await {
        Ok(json) => json,
        Err(e) => return Json(serde_json::json!({"success": false, "error": e})),
    };

    let patch_sets_tz = patch.get("log").and_then(|l| l.get("timezone")).is_some();

    json_merge(&mut file_json, patch);

    if let serde_json::Value::Object(ref mut map) = file_json
        && let Some(legacy) = map.remove("timezoneOffset")
            && !patch_sets_tz
                && let Some(log) = map.entry("log").or_insert(serde_json::json!({})).as_object_mut() {
                    log.insert("timezone".into(), legacy);
                }

    let mut settings: AppSettings = match serde_json::from_value(file_json.clone()) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({"success": false, "error": e.to_string()})),
    };

    if settings.log.timezone < -12 || settings.log.timezone > 14 {
        return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
    }
    if !crate::xray_log::LOG_LEVELS.contains(&settings.log.xray_level.as_str()) {
        return Json(serde_json::json!({"success": false, "error": "Неверный уровень логов"}));
    }
    if let Err(e) = settings.validate_plugins() {
        return Json(serde_json::json!({"success": false, "error": e}));
    }
    let url = &settings.updater.xray_repo;
    if url.trim().is_empty() {
        return Json(serde_json::json!({"success": false, "error": "URL репозитория Xray не может быть пустым"}));
    }
    if !crate::updater::valid_repo_url(url) {
        return Json(serde_json::json!({"success": false, "error": "Некорректный URL репозитория Xray"}));
    }
    settings.normalize_proxies();

    let xray_level = settings.log.xray_level.clone();
    let level_changed = {
        let mut current = state.settings.write().unwrap();
        let changed = current.log.xray_level != xray_level;
        *current = settings;
        changed
    };

    if let Err(e) = tokio::fs::create_dir_all(XKEEN_CONF_DIR).await {
        return Json(serde_json::json!({"success": false, "error": e.to_string()}));
    }

    let serialized = serde_json::to_string_pretty(&file_json).unwrap();
    let tmp = format!("{}.tmp", APP_CONFIG);
    let saved = match crate::private_file::write(&tmp, &serialized).await {
        Ok(_) => tokio::fs::rename(&tmp, APP_CONFIG).await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = saved {
        return Json(serde_json::json!({"success": false, "error": e}));
    }

    if level_changed && apply_xray_log_level(xray_level).await.is_err() {
        return Json(serde_json::json!({"success": false, "error": "Уровень сохранён, но Xray не перезапустился"}));
    }
    Json(serde_json::json!({"success": true}))
}

/// Записывает уровень в `01_log.json` и перезапускает Xray, если он запущен.
async fn apply_xray_log_level(level: String) -> Result<(), ()> {
    let changed = tokio::task::spawn_blocking(move || crate::xray_log::ensure_log_config(&level))
        .await
        .unwrap_or(false);
    if !changed || crate::controller::get_pid("xray").is_empty() {
        return Ok(());
    }
    crate::logger::log("INFO", "Перезапуск Xray после изменения уровня логов".into());
    crate::controller::soft_restart("xray").await.map_err(|e| {
        crate::logger::log("ERROR", format!("Не удалось перезапустить Xray: {e}"));
    })
}

fn json_merge(a: &mut serde_json::Value, b: serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                json_merge(a.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b,
    }
}

/// Файл настроек как JSON-объект; файла ещё нет — пустой объект. Ошибка — чтобы запись
/// не заменила настройки, которые сейчас не удалось прочитать.
pub async fn read_config(path: &str) -> Result<serde_json::Value, String> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(e) => return Err(format!("Не удалось прочитать {path}: {e}")),
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| e.to_string())
        .and_then(|json| if json.is_object() { Ok(json) } else { Err("ожидался объект".into()) })
        .map_err(|e| format!("Файл {path} повреждён: {e}"))
}

/// Настройки по умолчанию, но с включённой авторизацией: если прочитать настройки не удалось,
/// неизвестно, был ли задан пароль, и панель не должна открываться без него.
pub fn locked_defaults() -> AppSettings {
    let mut settings = AppSettings::default();
    settings.auth.enabled = true;
    settings
}

/// Повреждённый файл настроек откладывается в `<path>.corrupt`, вместо него пишутся
/// `locked_defaults`: пароль задаётся заново, остальные настройки можно поднять из копии.
pub fn recover_corrupt_config(path: &str) -> AppSettings {
    let settings = locked_defaults();
    let corrupt = format!("{path}.corrupt");
    match std::fs::rename(path, &corrupt) {
        Ok(()) => crate::logger::log("ERROR", format!("Файл настроек повреждён, копия сохранена: {corrupt}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => crate::logger::log("ERROR", format!("Не удалось сохранить копию {corrupt}: {e}")),
    }
    let tmp = format!("{path}.tmp");
    let written = crate::private_file::create(std::path::Path::new(&tmp)).and_then(|mut file| {
        use std::io::Write;
        file.write_all(serde_json::to_string_pretty(&settings).unwrap().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    });
    if let Err(e) = written {
        crate::logger::log("ERROR", format!("Не удалось записать {path}: {e}"));
    }
    settings
}

/// Перечитывает настройки с диска в память (после восстановления из бэкапа). Если файла нет
/// или он не читается, остаётся то, что в памяти.
pub async fn reload(state: &AppState) {
    let content = match tokio::fs::read_to_string(APP_CONFIG).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => return crate::logger::log("ERROR", format!("Не удалось прочитать {APP_CONFIG}: {e}")),
    };
    match serde_json::from_str::<AppSettings>(&content) {
        Ok(mut settings) => {
            settings.normalize_proxies();
            *state.settings.write().unwrap() = settings;
        }
        Err(e) => crate::logger::log("ERROR", format!("Настройки не применены, файл {APP_CONFIG} повреждён: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-settings-{name}-{}", std::process::id()));
        _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn read_config_refuses_damaged_file() {
        let dir = temp_dir("read");
        let path = dir.join("c.json");
        let p = path.to_str().unwrap();

        assert_eq!(read_config(p).await.unwrap(), serde_json::json!({}));
        for damaged in ["", "{\"auth\":", "[1]"] {
            std::fs::write(&path, damaged).unwrap();
            assert!(read_config(p).await.is_err(), "{damaged:?}");
        }
        std::fs::write(&path, "{\"a\":1}").unwrap();
        assert_eq!(read_config(p).await.unwrap()["a"], 1);
        _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_config_is_kept_and_auth_stays_on() {
        let dir = temp_dir("recover");
        let path = dir.join("c.json");
        let p = path.to_str().unwrap();
        std::fs::write(&path, "{\"auth\":{\"password_hash\":\"x").unwrap();

        assert!(recover_corrupt_config(p).auth.enabled);

        let kept = std::fs::read_to_string(format!("{p}.corrupt")).unwrap();
        assert!(kept.contains("password_hash"));
        let saved: AppSettings = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.auth.enabled && saved.auth.password_hash.is_none());
        _ = std::fs::remove_dir_all(&dir);
    }
}
