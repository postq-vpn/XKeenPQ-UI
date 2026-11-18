//! Доступ к роутеру: RCI (`127.0.0.1:79`), а если он не пускает — консоль `ndmc`.
//!
//! Обычно локальный RCI отвечает без токена, но некоторые прошивки (KeeneticOS 5.1) пускают только
//! с токеном доступа из `xkeen.json`. Токен теряется (обновление прошивки, переустановка), а выпустить его из консоли
//! можно не везде. Чтобы панель не ломалась от этого, при отказе RCI (401/403) или если он не
//! отвечает, тот же запрос выполняется через консоль: панель работает от root, консоль доступна
//! ей без токена. RCI пробуется снова раз в 10 минут: появится токен — панель вернётся на RCI.
//!
//! Перед переходом на консоль при отказе RCI панель пробует выпустить токен сама (KeeneticOS 5.2+,
//! см. `rci_token`): тогда запрос повторяется уже с ним.

use crate::console;
use crate::logger::log;
use crate::rci_token;
use crate::types::AppState;
use axum::extract::State;
use axum::response::Json;
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const RCI: &str = "http://127.0.0.1:79/rci";
const TIMEOUT: Duration = Duration::from_secs(8);
/// Как долго после отказа RCI идти сразу в консоль, не пробуя RCI.
const RECHECK: Duration = Duration::from_secs(600);

/// С какого момента RCI отказывает; `None` — RCI работает (или ещё не пробовали).
static DENIED_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

enum Failure {
    /// RCI не пускает (401/403) с этим токеном — можно выпустить новый или идти через консоль.
    Denied { reason: String, token: Option<String> },
    /// RCI не отвечает — можно через консоль.
    Unavailable(String),
    /// RCI ответил, но с ошибкой — консоль тут не поможет.
    Failed(String),
}

fn console_mode() -> bool {
    DENIED_SINCE.lock().unwrap().is_some_and(|since| since.elapsed() < RECHECK)
}

/// Панель сейчас работает с роутером через консоль.
pub fn using_console() -> bool {
    DENIED_SINCE.lock().unwrap().is_some()
}

fn mark_unavailable(reason: &str) {
    let mut since = DENIED_SINCE.lock().unwrap();
    if since.is_none() {
        log(
            "WARN",
            format!("RCI роутера недоступен ({reason}). Панель работает с роутером через его консоль"),
        );
    }
    *since = Some(Instant::now());
}

fn mark_available() {
    let mut since = DENIED_SINCE.lock().unwrap();
    if since.take().is_some() {
        log("INFO", "RCI роутера снова доступен".into());
    }
}

async fn send(state: &AppState, request: reqwest::RequestBuilder) -> Result<Value, Failure> {
    let token = rci_token::current(state);
    let request = match token.as_deref() {
        Some(token) => request.header("X-Ndma-Tkn", token),
        None => request,
    };
    let response = match request.timeout(TIMEOUT).send().await {
        Ok(response) => response,
        Err(e) => return Err(Failure::Unavailable(e.to_string())),
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        let reason = match token {
            Some(_) => format!("код {}, токен доступа не принят", status.as_u16()),
            None => format!("код {}, нет токена доступа", status.as_u16()),
        };
        return Err(Failure::Denied { reason, token });
    }
    if !status.is_success() {
        return Err(Failure::Failed(format!("роутер ответил {status}")));
    }
    response.json().await.map_err(|e| Failure::Failed(e.to_string()))
}

/// Через RCI, а если он недоступен — через консоль. При отказе RCI сначала выпускается новый
/// токен и запрос повторяется с ним: отклонённый запрос роутер не выполнял, повтор безопасен.
async fn with_fallback<F, Fut, C, CFut, T>(state: &AppState, rci: F, console: C) -> Result<T, String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, Failure>>,
    C: FnOnce() -> CFut,
    CFut: Future<Output = Result<T, String>>,
{
    if !console_mode() {
        let mut result = rci().await;
        if let Err(Failure::Denied { token, .. }) = &result
            && rci_token::renew(state, token.as_deref()).await
        {
            result = rci().await;
        }
        match result {
            Ok(value) => {
                mark_available();
                return Ok(value);
            }
            Err(Failure::Failed(error)) => return Err(error),
            Err(Failure::Denied { reason, .. } | Failure::Unavailable(reason)) => mark_unavailable(&reason),
        }
    }
    console().await
}

/// Чтение: `show/system`, `show/ip/policy`, `ip/hotspot`…
pub async fn get(state: &AppState, path: &str) -> Result<Value, String> {
    with_fallback(
        state,
        || send(state, state.http_client.get(format!("{RCI}/{path}"))),
        || console::get(path),
    )
    .await
}

/// Текст первой ошибки из ответа RCI на команду консоли.
fn command_error(response: &Value) -> Option<String> {
    response.as_array()?.iter().find_map(|item| {
        item.pointer("/parse/status")?.as_array()?.iter().find_map(|status| {
            (status.get("status")?.as_str()? == "error").then(|| Some(status.get("message")?.as_str()?.to_string()))?
        })
    })
}

/// Выполняет команду консоли роутера. Через RCI ошибка команды приходит в теле ответа с кодом 200.
pub async fn command(state: &AppState, command: &str) -> Result<(), String> {
    with_fallback(
        state,
        || async {
            let request = state.http_client.post(format!("{RCI}/")).json(&json!([{ "parse": command }]));
            let body = send(state, request).await?;
            command_error(&body).map_or(Ok(()), |e| Err(Failure::Failed(e)))
        },
        || async { console::run(command).await.map(drop) },
    )
    .await
}

/// Ошибка из ответа RCI на запись настроек (`status: error` где-либо в ответе).
fn write_error(response: &Value) -> Option<String> {
    match response {
        Value::Object(map) => {
            if map.get("status").and_then(Value::as_str) == Some("error") {
                return Some(map.get("message").and_then(Value::as_str).unwrap_or("ошибка").to_string());
            }
            map.values().find_map(write_error)
        }
        Value::Array(list) => list.iter().find_map(write_error),
        _ => None,
    }
}

/// Запись вложенных настроек JSON-запросом, как веб-интерфейс роутера. В консоль такое одной
/// командой не передать, поэтому без RCI запись не выполняется — с понятной причиной.
pub async fn write(state: &AppState, body: &Value) -> Result<(), String> {
    with_fallback(
        state,
        || async {
            let answer = send(state, state.http_client.post(format!("{RCI}/")).json(body)).await?;
            write_error(&answer).map_or(Ok(()), |e| Err(Failure::Failed(e)))
        },
        || async { Err("роутер не пускает панель к RCI (нет токена доступа), а через консоль эту настройку не изменить".to_string()) },
    )
    .await
}

/// Для уведомления в панели: RCI не пускает без токена, а прошивка выпустить его не может —
/// поможет только обновление до KeeneticOS 5.2+. Пока панель работает через консоль.
pub async fn get_rci_status(State(state): State<AppState>) -> Json<Value> {
    let hidden = state.settings.read().unwrap().gui.hide_rci_hint;
    let firmware_update_needed = !hidden && using_console() && rci_token::unsupported();
    Json(json!({ "success": true, "firmware_update_needed": firmware_update_needed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_command_errors() {
        let failed = json!([{ "parse": { "status": [
            { "status": "error", "message": "no such command: polcy." }
        ] } }]);
        assert_eq!(command_error(&failed).unwrap(), "no such command: polcy.");
        let done = json!([{ "parse": { "status": [{ "status": "message", "message": "created." }] } }]);
        assert!(command_error(&done).is_none());
    }

    #[test]
    fn reads_write_errors() {
        let done = json!({ "ipv6": { "subnet": { "status": [{ "status": "message", "message": "created subnet" }] } } });
        assert!(write_error(&done).is_none());
        let failed = json!({ "ipv6": { "subnet": { "status": [{ "status": "error", "message": "argument parse error." }] } } });
        assert_eq!(write_error(&failed).unwrap(), "argument parse error.");
    }
}
