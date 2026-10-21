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
    let mut file_json = tokio::fs::read_to_string(APP_CONFIG)
        .await
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(serde_json::json!({}));

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
