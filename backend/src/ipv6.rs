//! IPv6 в основной сети роутера.
//!
//! Многие VPN-серверы не умеют IPv6. Если устройства открывают сервисы по IPv6-адресам, сервер без
//! IPv6 не может к ним подключиться, и сервисы через VPN не работают. Поэтому при первом запуске
//! панель отключает раздачу IPv6 в основной сети — так же, как галочка «Включить IPv6» у сегмента
//! в веб-интерфейсе роутера: удаляет `ipv6 subnet`, привязанный к сегменту. У самого роутера IPv6
//! от провайдера остаётся. Что удалено, запоминается в файле, чтобы вернуть как было.
//!
//! Дальше панель IPv6 сама не выключает: раз в 2 часа проверяет и, если IPv6 снова включён,
//! предупреждает в журнале. На главной всегда видно, включён IPv6 или нет, с кнопкой переключения.

use crate::logger::log;
use crate::policy::{rci_command, rci_get, with_token};
use crate::types::{AppState, XKEEN_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Основной сегмент роутера, как в `policy`.
const HOME_SEGMENT: &str = "Bridge0";
const STATE_FILE: &str = "xkeen-ui-ipv6.json";
/// Роутер отвечает на RCI не сразу после загрузки.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Как часто проверять, не включили ли IPv6 снова.
const CHECK_INTERVAL: Duration = Duration::from_secs(2 * 3600);
/// Роутер не ответил при первом отключении: пробуем снова скоро.
const RETRY_INTERVAL: Duration = Duration::from_secs(60);
const RCI_TIMEOUT: Duration = Duration::from_secs(8);

/// Отключение, включение и фоновая проверка не должны идти одновременно.
static CHANGE_LOCK: Mutex<()> = Mutex::const_new(());

fn state_path() -> std::path::PathBuf {
    std::path::Path::new(XKEEN_CONF_DIR).join(STATE_FILE)
}

/// Имена блоков `ipv6 subnet`, которые раздают IPv6 в сегмент.
fn segment_subnets(subnets: &Value, segment: &str) -> Vec<String> {
    subnets.as_object().map_or(vec![], |all| {
        all.iter()
            .filter(|(_, s)| s.get("bind").and_then(Value::as_str) == Some(segment))
            .map(|(name, _)| name.clone())
            .collect()
    })
}

/// Безопасное имя для команды консоли: роутер называет блоки сам (`Default`, `ipv6Subnet_Bridge0`).
fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

async fn read_record() -> Option<Value> {
    let text = tokio::fs::read_to_string(state_path()).await.ok()?;
    serde_json::from_str(&text).ok()
}

async fn write_record(record: &Value) -> Result<(), String> {
    tokio::fs::write(state_path(), format!("{record:#}\n")).await.map_err(|e| e.to_string())
}

/// Настройки, сохранённые при последнем отключении.
async fn saved_subnets() -> serde_json::Map<String, Value> {
    read_record()
        .await
        .and_then(|r| r.get("subnets")?.as_object().cloned())
        .unwrap_or_default()
}

/// Отключает IPv6 в основной сети и запоминает, что было включено, чтобы потом вернуть как было.
async fn disable(state: &AppState) -> Result<(), String> {
    let subnets = rci_get(state, "ipv6/subnet").await?;
    let names = segment_subnets(&subnets, HOME_SEGMENT);
    if let Some(bad) = names.iter().find(|n| !is_plain_name(n)) {
        return Err(format!("непривычное имя настройки «{bad}»"));
    }
    // Уже выключен: сохранённые раньше настройки не затираем
    let saved = if names.is_empty() {
        saved_subnets().await
    } else {
        names.iter().map(|n| (n.clone(), subnets[n].clone())).collect()
    };
    write_record(&json!({ "disabled_at": now(), "segment": HOME_SEGMENT, "subnets": saved })).await?;
    for name in &names {
        rci_command(state, &format!("no ipv6 subnet {name}")).await?;
    }
    // Без сохранения IPv6 вернулся бы после перезагрузки роутера
    if !names.is_empty()
        && let Err(e) = rci_command(state, "system configuration save").await
    {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    Ok(())
}

/// Запрос, которым веб-интерфейс роутера создаёт блок `ipv6 subnet`: команда консоли с вложенными
/// параметрами в одну строку роутер не принимает.
fn subnet_write(name: &str, config: &Value) -> Value {
    let mut subnet = config.as_object().cloned().unwrap_or_default();
    subnet.insert("name".into(), json!(name));
    json!({ "ipv6": { "subnet": subnet } })
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

async fn rci_write(state: &AppState, body: &Value) -> Result<(), String> {
    let request = state.http_client.post("http://127.0.0.1:79/rci/").timeout(RCI_TIMEOUT).json(body);
    let response = with_token(request, state).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("роутер ответил {}", response.status()));
    }
    let answer: Value = response.json().await.map_err(|e| e.to_string())?;
    write_error(&answer).map_or(Ok(()), Err)
}

/// Настройки, с которыми веб-интерфейс роутера включает IPv6 у сегмента. Имя `Default` берётся,
/// только если оно свободно: иначе запись перепривязала бы блок другого сегмента.
fn default_subnets(current: &Value) -> serde_json::Map<String, Value> {
    let name = if current.get("Default").is_some() { format!("ipv6Subnet_{HOME_SEGMENT}") } else { "Default".into() };
    let config = json!({ "bind": HOME_SEGMENT, "mode": { "slaac": true }, "prefix": { "length": 64 }, "number": "0" });
    serde_json::Map::from_iter([(name, config)])
}

/// Возвращает блоки `ipv6 subnet`, сохранённые при отключении, а если их нет — настройки как у
/// веб-интерфейса.
async fn enable(state: &AppState) -> Result<(), String> {
    let current = rci_get(state, "ipv6/subnet").await?;
    if !segment_subnets(&current, HOME_SEGMENT).is_empty() {
        return Ok(());
    }
    let saved = saved_subnets().await;
    let subnets = if saved.is_empty() { default_subnets(&current) } else { saved };
    for (name, config) in &subnets {
        rci_write(state, &subnet_write(name, config)).await?;
    }
    if let Err(e) = rci_command(state, "system configuration save").await {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    // Запись остаётся: первый запуск уже был, панель не отключит IPv6 сама
    _ = write_record(&json!({ "enabled_at": now(), "segment": HOME_SEGMENT, "subnets": subnets })).await;
    Ok(())
}

/// Первый запуск: отключает IPv6 в основной сети. `Ok(true)` — IPv6 был включён и отключён.
/// Если он уже был выключен, это тоже запоминается: дальше панель его сама не трогает.
async fn first_run(state: &AppState) -> Result<bool, String> {
    let _guard = CHANGE_LOCK.lock().await;
    if tokio::fs::try_exists(state_path()).await.unwrap_or(false) {
        return Ok(false);
    }
    let subnets = rci_get(state, "ipv6/subnet").await?;
    if segment_subnets(&subnets, HOME_SEGMENT).is_empty() {
        write_record(&json!({ "found_off_at": now(), "segment": HOME_SEGMENT, "subnets": {} })).await?;
        return Ok(false);
    }
    match disable(state).await {
        Ok(()) => Ok(true),
        Err(e) => {
            _ = tokio::fs::remove_file(state_path()).await;
            Err(e)
        }
    }
}

async fn is_enabled(state: &AppState) -> Result<bool, String> {
    let subnets = rci_get(state, "ipv6/subnet").await?;
    Ok(!segment_subnets(&subnets, HOME_SEGMENT).is_empty())
}

pub fn start_check(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        // Одна и та же ошибка пишется в журнал один раз, а не каждую минуту
        let mut last_error = None;
        loop {
            match first_run(&state).await {
                Ok(disabled) => {
                    if disabled {
                        log("INFO", "IPv6 в основной сети отключён: устройства ходят через VPN по IPv4. Включить можно на главной панели".into());
                    }
                    break;
                }
                Err(error) => {
                    if last_error.as_ref() != Some(&error) {
                        log("WARN", format!("IPv6 в основной сети не отключён: {error}. Повтор через минуту"));
                        last_error = Some(error);
                    }
                    tokio::time::sleep(RETRY_INTERVAL).await;
                }
            }
        }
        // Дальше только предупреждаем: включённый IPv6 мог вернуть пользователь или сам роутер
        let mut warned = false;
        loop {
            tokio::time::sleep(CHECK_INTERVAL).await;
            let _guard = CHANGE_LOCK.lock().await;
            match is_enabled(&state).await {
                Ok(true) if !warned => {
                    log("WARN", "IPv6 в основной сети включён: часть сервисов может не открываться через VPN. Отключить можно на главной панели".into());
                    warned = true;
                }
                Ok(true) => {}
                Ok(false) => warned = false,
                Err(_) => {}
            }
        }
    });
}

#[derive(serde::Deserialize)]
pub struct Ipv6Req {
    enabled: bool,
}

/// Включает или отключает IPv6 в основной сети.
pub async fn post_ipv6(State(state): State<AppState>, Json(req): Json<Ipv6Req>) -> impl IntoResponse {
    let _guard = CHANGE_LOCK.lock().await;
    let result = if req.enabled { enable(&state).await } else { disable(&state).await };
    let action = if req.enabled { "включить" } else { "отключить" };
    match result {
        Ok(()) => {
            let done = if req.enabled { "включён" } else { "отключён" };
            log("INFO", format!("IPv6 в основной сети {done} из панели"));
            Json(json!({ "success": true }))
        }
        Err(e) => {
            log("ERROR", format!("Не удалось {action} IPv6 в основной сети: {e}"));
            Json(json!({ "success": false, "error": format!("Не удалось {action} IPv6: {e}") }))
        }
    }
}

/// `available` — роутер ответил; `enabled` — IPv6 раздаётся в основную сеть.
pub async fn get_ipv6_status(State(state): State<AppState>) -> impl IntoResponse {
    match is_enabled(&state).await {
        Ok(enabled) => Json(json!({ "success": true, "available": true, "enabled": enabled })),
        Err(_) => Json(json!({ "success": true, "available": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_subnets_of_segment() {
        let subnets = json!({
            "Default": { "bind": "Bridge0", "mode": { "slaac": true }, "prefix": { "length": 64 } },
            "ipv6Subnet_Bridge1": { "bind": "Bridge1" },
        });
        assert_eq!(segment_subnets(&subnets, "Bridge0"), ["Default"]);
        assert!(segment_subnets(&subnets, "Bridge2").is_empty());
        assert!(segment_subnets(&json!({}), "Bridge0").is_empty());
    }

    #[test]
    fn restores_subnet_like_the_web_interface() {
        let config = json!({ "bind": "Bridge0", "mode": { "slaac": true }, "prefix": { "length": 64 }, "number": "0" });
        assert_eq!(
            subnet_write("Default", &config),
            json!({ "ipv6": { "subnet": {
                "name": "Default", "bind": "Bridge0", "mode": { "slaac": true }, "prefix": { "length": 64 }, "number": "0"
            } } })
        );
    }

    #[test]
    fn finds_errors_in_write_answer() {
        let done = json!({ "ipv6": { "subnet": { "status": [{ "status": "message", "message": "created subnet" }] } } });
        assert!(write_error(&done).is_none());
        let failed = json!({ "ipv6": { "subnet": { "status": [{ "status": "error", "message": "argument parse error." }] } } });
        assert_eq!(write_error(&failed).unwrap(), "argument parse error.");
    }

    #[test]
    fn default_subnet_does_not_take_another_segments_name() {
        let free = default_subnets(&json!({}));
        assert_eq!(segment_subnets(&Value::Object(free.clone()), "Bridge0"), ["Default"]);
        let taken = default_subnets(&json!({ "Default": { "bind": "Bridge1" } }));
        assert_eq!(taken.keys().collect::<Vec<_>>(), ["ipv6Subnet_Bridge0"]);
    }

    #[test]
    fn only_plain_names_reach_the_console() {
        assert!(is_plain_name("Default"));
        assert!(is_plain_name("ipv6Subnet_Bridge0"));
        assert!(!is_plain_name(""));
        assert!(!is_plain_name("a b"));
        assert!(!is_plain_name("x;y"));
    }
}
