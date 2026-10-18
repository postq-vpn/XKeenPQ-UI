//! Геобазы для routing по умолчанию: загрузка по кнопке и автообновление раз в сутки.

use super::*;

/// Откуда брать geo-файлы шаблона (`ext:<файл>:…` в default_routing.json).
const GEO_SOURCES: [(&str, &str); 3] = [
    ("zkeen.dat", "https://github.com/jameszeroX/zkeen-domains/releases/latest/download/zkeen.dat"),
    ("zkeenip.dat", "https://github.com/jameszeroX/zkeen-ip/releases/latest/download/zkeenip.dat"),
    (
        "geosite_v2fly.dat",
        "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat",
    ),
];
/// Как часто обновлять геобазы, когда автообновление включено.
pub(super) const GEO_UPDATE_INTERVAL: i64 = 86400;
const GEO_TIMEOUT: Duration = Duration::from_secs(120);
/// Меньше этого — точно не геобаза (страница ошибки зеркала и т.п.).
const MIN_GEO_SIZE: usize = 1024;

async fn fetch(client: &reqwest::Client, url: &str, proxies: &[String]) -> Result<Vec<u8>, String> {
    let urls = std::iter::once(url.to_string()).chain(
        proxies
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| format!("{}/{}", p.trim_end_matches('/'), url)),
    );
    let mut last_error = String::from("нет источников");
    for u in urls {
        match client.get(&u).timeout(GEO_TIMEOUT).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) if b.len() >= MIN_GEO_SIZE => return Ok(b.to_vec()),
                Ok(b) => last_error = format!("слишком маленький ответ ({} байт)", b.len()),
                Err(e) => last_error = without_url(&e),
            },
            Ok(r) => last_error = format!("HTTP {}", r.status().as_u16()),
            Err(e) => last_error = without_url(&e),
        }
    }
    Err(last_error)
}

/// Скачивает геобазы шаблона в `XRAY_ASSET_DIR`. `only_missing` — только отсутствующие.
/// Возвращает (обновлённые файлы, ошибки).
pub(super) async fn download_geo_files(state: &AppState, only_missing: bool) -> (Vec<String>, Vec<String>) {
    // Кнопка и автообновление не должны писать одни и те же .tmp одновременно
    static GEO_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = GEO_LOCK.lock().await;
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let dir = std::path::Path::new(XRAY_ASSET_DIR);
    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        return (vec![], vec![format!("{}: {}", dir.display(), e)]);
    }
    let (mut updated, mut errors) = (vec![], vec![]);
    for (name, url) in GEO_SOURCES {
        let path = dir.join(name);
        if only_missing && path.exists() {
            continue;
        }
        let data = match fetch(&state.http_client, url, &proxies).await {
            Ok(d) => d,
            Err(e) => {
                errors.push(format!("{name}: {e}"));
                continue;
            }
        };
        match write_geo_file(&path, &data).await {
            Ok(false) => {}
            Ok(true) => {
                log("INFO", format!("Геобаза {name} обновлена ({:.1} МБ)", data.len() as f64 / 1048576.0));
                updated.push(name.to_string());
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    (updated, errors)
}

/// Атомарно записывает геобазу; false — содержимое не изменилось. XKeen держит `zkeen.dat` и
/// `zkeenip.dat` симлинками на `geosite_zkeen.dat`/`geoip_zkeenip.dat` (или наоборот): пишем в цель
/// ссылки, иначе rename заменил бы симлинк копией, а XKeen при `-ug` вернул бы его обратно.
async fn write_geo_file(path: &std::path::Path, data: &[u8]) -> std::io::Result<bool> {
    let target = tokio::fs::canonicalize(path).await.unwrap_or_else(|_| path.to_path_buf());
    if tokio::fs::read(&target).await.is_ok_and(|old| old == data) {
        return Ok(false);
    }
    let tmp = target.with_extension("dat.tmp");
    let written = async {
        tokio::fs::write(&tmp, data).await?;
        tokio::fs::rename(&tmp, &target).await
    }
    .await;
    if written.is_err() {
        _ = tokio::fs::remove_file(&tmp).await;
    }
    written.map(|()| true)
}

/// Задача планировщика XKeen (`xkeen -ug`), которая уже обновляет геобазы: тогда панель их не качает.
const XKEEN_CRONTAB: &str = "/opt/var/spool/cron/crontabs/root";

fn crontab_updates_geo(crontab: &str) -> bool {
    crontab.lines().map(str::trim).filter(|line| !line.starts_with('#')).any(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        words.windows(2).any(|w| w[0].ends_with("/xkeen") && w[1] == "-ug")
    })
}

pub(super) async fn xkeen_updates_geo() -> bool {
    tokio::fs::read_to_string(XKEEN_CRONTAB).await.is_ok_and(|c| crontab_updates_geo(&c))
}

/// Кнопка в предупреждении: скачать недостающие геобазы, включить их автообновление и,
/// если теперь всего хватает, поставить routing по умолчанию.
pub async fn post_geo_download(State(state): State<AppState>) -> impl IntoResponse {
    let (updated, errors) = download_geo_files(&state, true).await;

    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    store.geo_auto_update = true;
    if errors.is_empty() {
        store.geo_last_update = now();
    }
    let routing_applied = store.routing_pending && apply_default_routing(&mut store).await;
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    let restart_error = finish_change(&mut store, routing_applied || !updated.is_empty()).await;
    Json(json!({
        "success": errors.is_empty(),
        "error": (!errors.is_empty()).then(|| errors.join("\n")),
        "updated": updated,
        "routing_applied": routing_applied,
        "routing_pending": store.routing_pending,
        "restart_error": restart_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crontab_detection() {
        assert!(crontab_updates_geo("15 3 * * 1 /opt/sbin/xkeen -ug\n"));
        assert!(crontab_updates_geo("# комментарий\n0 4 * * 1 /opt/sbin/xkeen -ug >/dev/null 2>&1"));
        assert!(!crontab_updates_geo("# 15 3 * * 1 /opt/sbin/xkeen -ug"));
        assert!(!crontab_updates_geo("55 4 * * 2 /opt/sbin/xkeen -uk auto"));
        assert!(!crontab_updates_geo("15 3 * * 1 /opt/sbin/xkeen -ugc"));
        assert!(!crontab_updates_geo(""));
    }

    #[tokio::test]
    async fn write_goes_through_symlink() {
        let dir = std::env::temp_dir().join(format!("geo-symlink-{}", std::process::id()));
        _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("geosite_zkeen.dat");
        let link = dir.join("zkeen.dat");
        std::fs::write(&target, b"old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(write_geo_file(&link, b"new").await.unwrap());
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "ссылка должна остаться ссылкой");
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert!(!write_geo_file(&link, b"new").await.unwrap(), "одинаковое содержимое не перезаписывается");

        let plain = dir.join("geosite_v2fly.dat");
        assert!(write_geo_file(&plain, b"fresh").await.unwrap());
        assert_eq!(std::fs::read(&plain).unwrap(), b"fresh");
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sources_cover_default_routing_assets() {
        let sources: Vec<&str> = GEO_SOURCES.iter().map(|(name, _)| *name).collect();
        for asset in routing::default_routing_assets() {
            assert!(sources.contains(&asset.as_str()), "нет источника для {asset}");
        }
    }
}
