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
        if tokio::fs::read(&path).await.is_ok_and(|old| old == data) {
            continue;
        }
        let tmp = path.with_extension("dat.tmp");
        let written = async {
            tokio::fs::write(&tmp, &data).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await;
        match written {
            Ok(()) => {
                log("INFO", format!("Геобаза {name} обновлена ({:.1} МБ)", data.len() as f64 / 1048576.0));
                updated.push(name.to_string());
            }
            Err(e) => {
                _ = tokio::fs::remove_file(&tmp).await;
                errors.push(format!("{name}: {e}"));
            }
        }
    }
    (updated, errors)
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
    fn sources_cover_default_routing_assets() {
        let sources: Vec<&str> = GEO_SOURCES.iter().map(|(name, _)| *name).collect();
        for asset in routing::default_routing_assets() {
            assert!(sources.contains(&asset.as_str()), "нет источника для {asset}");
        }
    }
}
