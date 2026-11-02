use crate::logger::{process_log_line, ts};
use crate::types::*;
use axum::extract::{Query, State};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Json};
use futures_util::sink::SinkExt;
use futures_util::stream::StreamExt;
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

static WS_COUNTER: AtomicU32 = AtomicU32::new(0);
const TICKET_TTL: Duration = Duration::from_secs(30);
static TICKETS: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn drop_expired(tickets: &mut HashMap<String, Instant>) {
    tickets.retain(|_, issued| issued.elapsed() < TICKET_TTL);
}

/// Одноразовый билет на подключение к журналу. Прокси роутера убирает `Origin`, а домены
/// `*.netcraze.pro` для браузера один сайт, и кука уходит со страницы чужого роутера. Прочитать
/// этот ответ такая страница не может: CORS не разрешает ответы на запросы с кукой.
pub async fn get_ws_ticket() -> impl IntoResponse {
    let ticket = Uuid::new_v4().to_string();
    let mut tickets = TICKETS.lock().unwrap();
    drop_expired(&mut tickets);
    tickets.insert(ticket.clone(), Instant::now());
    Json(serde_json::json!({ "success": true, "ticket": ticket }))
}

fn take_ticket(ticket: &str) -> bool {
    let mut tickets = TICKETS.lock().unwrap();
    drop_expired(&mut tickets);
    tickets.remove(ticket).is_some()
}

/// WebSocket не подчиняется CORS. Запрос без `Origin` пропускаем: так его присылает прокси роутера.
fn is_same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let origin = origin.to_str().unwrap_or("");
    let origin = crate::auth::host_name(origin.split_once("://").map_or("", |(_, rest)| rest));
    ["x-forwarded-host", "host"].iter().any(|name| {
        headers
            .get(*name)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|host| !origin.is_empty() && crate::auth::host_name(host).eq_ignore_ascii_case(origin))
    })
}

pub async fn ws_handler(
    ws: WebSocketUpgrade, headers: HeaderMap, Query(params): Query<HashMap<String, String>>, State(state): State<AppState>,
) -> impl IntoResponse {
    if !is_same_origin(&headers) || !params.get("ticket").is_some_and(|t| take_ticket(t)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

fn read_log_file(p: String, offset: u64, query: String, full: bool, tz: i32) -> (String, Vec<String>, u64) {
    let mut f = match File::open(&p) {
        Ok(f) => f,
        _ => return ("clear".into(), vec![], 0),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut current_pos = offset;

    if full && query.is_empty() && len > 128000 {
        let seek_pos = len - 128000;
        _ = f.seek(SeekFrom::Start(seek_pos));
        let mut reader = BufReader::new(&mut f);
        let mut discard = String::new();
        let skipped = reader.read_line(&mut discard).unwrap_or(0);
        current_pos = seek_pos + skipped as u64;
    } else if !full && len < offset {
        return ("clear".into(), vec![], 0);
    } else if full {
        current_pos = 0;
    }

    _ = f.seek(SeekFrom::Start(current_pos));
    let mut lines = Vec::new();
    let mut total_bytes = 0usize;
    let mut bytes_read = current_pos;
    let keywords: Vec<String> = query
        .split('|')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let reader = BufReader::new(f);

    for line in reader.lines().map_while(Result::ok) {
        let line_len = line.len() + 1;
        bytes_read += line_len as u64;

        let matched = if query.is_empty() {
            true
        } else {
            let normalized = line
                .replace("[Debug]", "[DEBUG]")
                .replace("level=debug", "level=DEBUG")
                .replace("[Info]", "[INFO]")
                .replace("level=info", "level=INFO")
                .replace("[Warning]", "[WARN]")
                .replace("level=warning", "level=WARN")
                .replace("[Error]", "[ERROR]")
                .replace("level=error", "level=ERROR")
                .replace("[Fatal]", "[FATAL]")
                .replace("level=fatal", "level=FATAL");
            keywords.iter().any(|k| normalized.contains(k))
        };

        if matched {
            let proc = process_log_line(line, tz);
            if !proc.is_empty() {
                if full && !query.is_empty() {
                    total_bytes += line_len;
                    if total_bytes >= 128000 {
                        break;
                    }
                }
                lines.push(proc);
            }
        }
    }
    (if full { "initial".into() } else { "append".into() }, lines, bytes_read)
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let debug = state.debug;
    let count = WS_COUNTER.fetch_add(1, Ordering::SeqCst);
    if debug {
        println!("{} [INFO] WS-{} Connected (Total: {})", ts(), count, count + 1);
    }

    {
        let mut guard = state.log_watcher.lock().await;
        let need_spawn = guard.as_ref().is_none_or(|h| h.is_finished());
        if need_spawn {
            if debug {
                println!("{} [INFO] 🚀 Starting log watcher...", ts());
            }
            let tx = state.log_tx.clone();
            let handle = tokio::spawn(async move {
                let (mpsc_tx, mut mpsc_rx) = tokio::sync::mpsc::channel::<String>(32);
                let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
                    if let Ok(e) = res
                        && e.kind.is_modify() {
                            for path in e.paths {
                                let _ = mpsc_tx.try_send(path.to_string_lossy().to_string());
                            }
                        }
                })
                .unwrap();

                let error_log = error_log_path();
                let access_log = access_log_path();
                let _ = watcher.watch(Path::new(&error_log), RecursiveMode::NonRecursive);
                let _ = watcher.watch(Path::new(&access_log), RecursiveMode::NonRecursive);

                while let Some(path) = mpsc_rx.recv().await {
                    let _ = tx.send(path);
                }
            });

            *guard = Some(handle.abort_handle());
        }
    }

    let (mut tx, mut rx) = socket.split();
    let mut log_rx = state.log_tx.subscribe();
    let mut path = error_log_path();
    let mut query = String::new();
    let tz = state.settings.read().unwrap().log.timezone;

    let p_clone = path.clone();
    let q_clone = query.clone();
    let (t, l, mut offset) = tokio::task::spawn_blocking(move || read_log_file(p_clone, 0, q_clone, true, tz))
        .await
        .unwrap();

    let init_msg = if l.is_empty() {
        serde_json::json!({"type": "clear"})
    } else {
        serde_json::json!({"type": t, "lines": l})
    };
    if tx.send(Message::Text(init_msg.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            Some(msg) = rx.next() => {
                match msg {
                    Ok(Message::Text(txt)) => {
                        let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                        let tz = state.settings.read().unwrap().log.timezone;
                        match v["type"].as_str() {
                            Some("switchFile") => {
                                path = if v["file"] == "access.log" { access_log_path() } else { error_log_path() };

                                let p = path.clone();
                                let q = query.clone();
                                let (t, l, off) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await.unwrap();
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": t, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("filter") | Some("reload") => {
                                query = v["query"].as_str().unwrap_or("").to_string();
                                let q = query.clone();
                                let p = path.clone();
                                let (t, l, off) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await.unwrap();
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": if v["type"] == "filter" { "filtered" } else { t.as_str() }, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("clear") => {
                                let p = path.clone();
                                offset = 0;
                                tokio::task::spawn_blocking(move || { File::create(p).ok(); });
                                if tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                            },
                            _ => {}
                        }
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            result = log_rx.recv() => {
                let changed_path = match result {
                    Ok(p) => p,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => path.clone(),
                    Err(_) => break,
                };
                if changed_path == path {
                    let tz = state.settings.read().unwrap().log.timezone;
                    let p = path.clone();
                    let q = query.clone();
                    let off_curr = offset;
                    let (t, l, new_off) = tokio::task::spawn_blocking(move || read_log_file(p, off_curr, q, false, tz)).await.unwrap();
                    offset = new_off;

                    if !l.is_empty() {
                        let content = l.join("\n");
                        if tx.send(Message::Text(serde_json::json!({"type": t, "content": content}).to_string().into())).await.is_err() { break; }
                    } else if t == "clear"
                         && tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                }
            }
        }
    }

    let count_after = WS_COUNTER.fetch_sub(1, Ordering::SeqCst);
    if debug {
        println!("{} [INFO] WS Disconnected. Remaining: {}", ts(), count_after - 1);
    }

    if count_after == 1 {
        if debug {
            println!("{} [INFO] 💤 Stopping log watcher...", ts());
        }
        if let Some(abort_handle) = state.log_watcher.lock().await.take() {
            abort_handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        pairs
            .iter()
            .map(|(k, v)| (axum::http::HeaderName::from_static(k), HeaderValue::from_static(v)))
            .collect()
    }

    #[test]
    fn ticket_works_once_and_expires() {
        let mut tickets = TICKETS.lock().unwrap();
        tickets.insert("fresh".into(), Instant::now());
        tickets.insert("old".into(), Instant::now() - TICKET_TTL);
        drop(tickets);
        assert!(!take_ticket("old"));
        assert!(!take_ticket("unknown"));
        assert!(take_ticket("fresh"));
        assert!(!take_ticket("fresh"));
    }

    #[test]
    fn origin_must_match_host() {
        assert!(is_same_origin(&headers(&[("host", "192.168.1.1:1000")])));
        assert!(is_same_origin(&headers(&[("host", "192.168.1.1:1000"), ("origin", "http://192.168.1.1:1000")])));
        assert!(is_same_origin(&headers(&[("host", "a.netcraze.pro"), ("origin", "https://A.netcraze.pro")])));
        assert!(is_same_origin(&headers(&[
            ("host", "127.0.0.1:1000"),
            ("x-forwarded-host", "a.netcraze.pro"),
            ("origin", "https://a.netcraze.pro")
        ])));
        assert!(!is_same_origin(&headers(&[("host", "a.netcraze.pro"), ("origin", "https://b.netcraze.pro")])));
        assert!(!is_same_origin(&headers(&[("host", "a.netcraze.pro"), ("origin", "null")])));
        assert!(!is_same_origin(&headers(&[("origin", "https://a.netcraze.pro")])));
    }
}
