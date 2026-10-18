//! Логи Xray: настройки закреплены панелью, размер файлов ограничен, файл можно скачать.
//!
//! Пункт «log» убран из меню «Технические файлы», поэтому `01_log.json` всегда приводится
//! к одному виду: access и error пишутся в файлы, уровень warning, DNS-лог включён.
//! Файлы не ротируются ни Xray, ни XKeen — панель раз в минуту обрезает их до хвоста.

use crate::logger::log;
use crate::subscriptions::routing::strip_jsonc;
use crate::types::*;
use axum::body::{Body, Bytes};
use axum::extract::Query;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncReadExt;

const LOG_CONFIG_FILE: &str = "01_log.json";
/// Больше этого размера файл обрезается…
const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024;
/// …до последних строк такого объёма: обрезка случается редко, а свежая история остаётся.
const KEEP_LOG_SIZE: u64 = 5 * 1024 * 1024;
const DOWNLOAD_CHUNK: usize = 64 * 1024;
const TRIM_INTERVAL: Duration = Duration::from_secs(60);

fn wanted_log_config() -> Value {
    json!({
        "log": {
            "access": DEFAULT_ACCESS_LOG,
            "error": DEFAULT_ERROR_LOG,
            "loglevel": "warning",
            "dnsLog": true
        }
    })
}

/// Приводит `01_log.json` к закреплённым настройкам. Возвращает true, если файл переписан.
pub fn ensure_log_config() -> bool {
    let path = Path::new(XRAY_CONF_DIR).join(LOG_CONFIG_FILE);
    let wanted = wanted_log_config();
    let current = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&strip_jsonc(&text)).ok());
    if current.as_ref().and_then(|c| c.get("log")) == wanted.get("log") {
        return false;
    }
    if let Err(e) = std::fs::create_dir_all(XRAY_CONF_DIR)
        .and_then(|_| std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&wanted).unwrap())))
    {
        log("ERROR", format!("Не удалось записать {}: {}", path.display(), e));
        return false;
    }
    log(
        "INFO",
        format!("{}: access и error в файлы, уровень warning, DNS-лог включён", path.display()),
    );
    true
}

/// Оставляет в файле последние `keep` байт, начиная с целой строки. Xray пишет с O_APPEND,
/// поэтому после обрезки продолжает дописывать в конец того же файла.
fn trim_file(path: &str, max: u64, keep: u64) -> std::io::Result<bool> {
    let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let len = file.metadata()?.len();
    if len <= max {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(len - keep))?;
    let mut tail = Vec::with_capacity(keep as usize);
    file.read_to_end(&mut tail)?;
    let start = tail.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1);
    file.set_len(0)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&tail[start..])?;
    Ok(true)
}

pub fn start_log_trimmer() {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(TRIM_INTERVAL).await;
            for path in [error_log_path(), access_log_path()] {
                let p = path.clone();
                match tokio::task::spawn_blocking(move || trim_file(&p, MAX_LOG_SIZE, KEEP_LOG_SIZE)).await {
                    Ok(Ok(true)) => log("INFO", format!("{path} больше 10 МБ — оставлены последние 5 МБ")),
                    Ok(Err(e)) if e.kind() != std::io::ErrorKind::NotFound => {
                        log("ERROR", format!("Не удалось обрезать {path}: {e}"))
                    }
                    _ => {}
                }
            }
        }
    });
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    file: Option<String>,
}

/// Скачивание журнала: `?file=error.log` (по умолчанию) или `?file=access.log`.
pub async fn get_log_download(Query(q): Query<DownloadQuery>) -> Response {
    let (name, path) = match q.file.as_deref() {
        Some("access.log") => ("access.log", access_log_path()),
        _ => ("error.log", error_log_path()),
    };
    match tokio::fs::File::open(&path).await {
        // Отдаём частями: файл до 10 МБ не держим в памяти роутера целиком.
        Ok(file) => {
            let chunks = futures_util::stream::unfold(file, |mut file| async move {
                let mut buf = vec![0u8; DOWNLOAD_CHUNK];
                match file.read(&mut buf).await {
                    Ok(0) => None,
                    Ok(n) => {
                        buf.truncate(n);
                        Some((Ok::<_, std::io::Error>(Bytes::from(buf)), file))
                    }
                    Err(e) => Some((Err(e), file)),
                }
            });
            (
                [
                    (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"xray-{name}\""),
                    ),
                ],
                Body::from_stream(chunks),
            )
                .into_response()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (StatusCode::OK, Vec::new()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_keeps_whole_tail_lines() {
        let path = std::env::temp_dir().join(format!("xkeen-ui-trim-{}.log", std::process::id()));
        let text: String = (0..100).map(|i| format!("line {i:03}\n")).collect();
        std::fs::write(&path, &text).unwrap();
        let p = path.to_str().unwrap();

        assert!(!trim_file(p, 10_000, 100).unwrap());
        assert!(trim_file(p, 500, 50).unwrap());
        let left = std::fs::read_to_string(&path).unwrap();
        assert!(left.starts_with("line "), "{left}");
        assert!(left.ends_with("line 099\n"));
        assert!(left.len() <= 50);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn wanted_config_shape() {
        let c = wanted_log_config();
        assert_eq!(c["log"]["loglevel"], "warning");
        assert_eq!(c["log"]["dnsLog"], true);
        assert_eq!(c["log"]["access"], DEFAULT_ACCESS_LOG);
    }
}
