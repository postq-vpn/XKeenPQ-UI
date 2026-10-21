//! Логи Xray: настройки закреплены панелью, размер файлов ограничен, файл можно скачать.
//!
//! Пункт «log» убран из меню «Технические файлы», поэтому `01_log.json` всегда приводится
//! к одному виду: access и error пишутся в файлы, DNS-лог включён, уровень берётся из
//! настроек панели (`log.xray_level`, по умолчанию warning).
//! Файлы не ротируются ни Xray, ни XKeen — панель раз в минуту обрезает их до хвоста.

use crate::logger::log;
use crate::subscriptions::routing::strip_jsonc;
use crate::types::*;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
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
pub const LOG_LEVELS: [&str; 5] = ["none", "error", "warning", "info", "debug"];

fn wanted_log_config(level: &str) -> Value {
    let level = if LOG_LEVELS.contains(&level) { level } else { "warning" };
    json!({
        "log": {
            "access": DEFAULT_ACCESS_LOG,
            "error": DEFAULT_ERROR_LOG,
            "loglevel": level,
            "dnsLog": true
        }
    })
}

/// Приводит `01_log.json` к закреплённым настройкам с уровнем `level`.
/// Возвращает true, если файл переписан.
pub fn ensure_log_config(level: &str) -> bool {
    let path = Path::new(XRAY_CONF_DIR).join(LOG_CONFIG_FILE);
    let wanted = wanted_log_config(level);
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
        format!(
            "{}: access и error в файлы, уровень {}, DNS-лог включён",
            path.display(),
            wanted["log"]["loglevel"].as_str().unwrap_or_default()
        ),
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

/// Скачивание журнала: `?file=error.log` (по умолчанию), `?file=access.log` или `?file=all` —
/// zip-архив с обоими журналами.
pub async fn get_log_download(State(state): State<AppState>, Query(q): Query<DownloadQuery>) -> Response {
    if q.file.as_deref() == Some("all") {
        let tz = state.settings.read().unwrap().log.timezone;
        return download_logs_zip(tz);
    }
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

/// Отдаёт оба журнала одним zip-архивом. Архив собирается в отдельном потоке и уходит клиенту
/// частями по мере сжатия: журналы до 10 МБ каждый не держим в памяти роутера целиком.
fn download_logs_zip(tz: i32) -> Response {
    let now = chrono::Utc::now() + chrono::Duration::hours(i64::from(tz));
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::task::spawn_blocking(move || {
        let writer = ChannelWriter { tx, buf: Vec::with_capacity(DOWNLOAD_CHUNK) };
        if let Err(e) = write_logs_zip(writer, now.naive_utc())
            && !matches!(&e, zip::result::ZipError::Io(io) if io.kind() == std::io::ErrorKind::BrokenPipe)
        {
            log("ERROR", format!("Не удалось собрать архив журналов: {e}"));
        }
    });
    let chunks = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|chunk| (chunk, rx)) });
    (
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"xray-logs-{}.zip\"", now.format("%Y%m%d-%H%M%S")),
            ),
        ],
        Body::from_stream(chunks),
    )
        .into_response()
}

fn write_logs_zip<W: Write>(writer: W, now: chrono::NaiveDateTime) -> zip::result::ZipResult<()> {
    use chrono::{Datelike, Timelike};
    use zip::write::SimpleFileOptions;
    let modified = zip::DateTime::from_date_and_time(
        now.year() as u16,
        now.month() as u8,
        now.day() as u8,
        now.hour() as u8,
        now.minute() as u8,
        now.second() as u8,
    )
    .unwrap_or_default();
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(modified);
    let mut zip = zip::ZipWriter::new_stream(writer);
    for (name, path) in [("error.log", error_log_path()), ("access.log", access_log_path())] {
        zip.start_file(name, options)?;
        match std::fs::File::open(&path) {
            Ok(mut file) => {
                std::io::copy(&mut file, &mut zip)?;
            }
            // Журнала ещё нет — в архиве будет пустой файл
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    zip.finish()?;
    Ok(())
}

/// Копит байты архива и отправляет их в тело ответа кусками по `DOWNLOAD_CHUNK`.
struct ChannelWriter {
    tx: tokio::sync::mpsc::Sender<std::io::Result<Bytes>>,
    buf: Vec<u8>,
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= DOWNLOAD_CHUNK {
            self.flush()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(&mut self.buf, Vec::with_capacity(DOWNLOAD_CHUNK)));
        // Клиент закрыл соединение — прекращаем собирать архив
        self.tx
            .blocking_send(Ok(chunk))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "клиент отключился"))
    }
}

impl Drop for ChannelWriter {
    fn drop(&mut self) {
        let _ = self.flush();
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
    fn logs_zip_contains_both_logs() {
        struct Sink(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for Sink {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let now = chrono::NaiveDate::from_ymd_opt(2026, 10, 21).unwrap().and_hms_opt(12, 0, 0).unwrap();
        write_logs_zip(Sink(out.clone()), now).unwrap();
        let bytes = out.lock().unwrap().clone();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<_> = archive.file_names().map(str::to_string).collect();
        assert!(names.contains(&"error.log".to_string()) && names.contains(&"access.log".to_string()), "{names:?}");
        assert_eq!(archive.by_name("error.log").unwrap().last_modified().unwrap().year(), 2026);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn zip_download_streams_valid_archive() {
        let response = download_logs_zip(3);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/zip");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let archive = zip::ZipArchive::new(std::io::Cursor::new(body.to_vec())).unwrap();
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn wanted_config_shape() {
        let c = wanted_log_config("warning");
        assert_eq!(c["log"]["loglevel"], "warning");
        assert_eq!(wanted_log_config("debug")["log"]["loglevel"], "debug");
        assert_eq!(wanted_log_config("verbose")["log"]["loglevel"], "warning");
        assert_eq!(c["log"]["dnsLog"], true);
        assert_eq!(c["log"]["access"], DEFAULT_ACCESS_LOG);
    }
}
