//! IPv6 в основной сети роутера.
//!
//! Многие VPN-серверы не умеют IPv6. Если провайдер даёт IPv6, телефоны идут в Instagram и другие
//! сервисы по IPv6-адресам, сервер без IPv6 не может к ним подключиться, и сервисы через VPN не
//! работают. Поэтому панель один раз отключает раздачу IPv6 в основной сети — так же, как галочка
//! «Включить IPv6» у сегмента в веб-интерфейсе роутера: удаляет `ipv6 subnet`, привязанный к
//! сегменту. У самого роутера IPv6 от провайдера остаётся. Сделанное запоминается в файле: если
//! пользователь потом включит IPv6 сам или из панели, панель его больше не отключает. При первом
//! открытии панели после отключения показывается окно с объяснением: принять или вернуть IPv6.

use crate::logger::log;
use crate::policy::{rci_command, rci_get, with_token};
use crate::types::{AppState, XKEEN_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Основной сегмент роутера, как в `policy`.
const HOME_SEGMENT: &str = "Bridge0";
const STATE_FILE: &str = "xkeen-ui-ipv6.json";
/// Роутер отвечает на RCI не сразу после загрузки.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// IPv6 у провайдера может появиться позже, например после переподключения.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
/// Роутер не ответил или не принял команду: пробуем снова скоро, а не через `CHECK_INTERVAL`.
const RETRY_INTERVAL: Duration = Duration::from_secs(60);
const RCI_TIMEOUT: Duration = Duration::from_secs(8);

fn state_path() -> std::path::PathBuf {
    std::path::Path::new(XKEEN_CONF_DIR).join(STATE_FILE)
}

/// Роутер получил от провайдера настоящий префикс IPv6, а не только свой внутренний `fd…`.
/// Единственный префикс может прийти объектом, а не списком.
fn has_isp_prefix(prefixes: &Value) -> bool {
    let list = match prefixes.get("prefix") {
        Some(Value::Array(list)) => list.iter().collect::<Vec<_>>(),
        Some(single) => vec![single],
        None => vec![],
    };
    list.iter().any(|p| p.get("global").and_then(Value::as_bool) == Some(true))
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

/// Отключает IPv6 в основной сети и запоминает, что было включено, чтобы потом вернуть как было.
async fn disable(state: &AppState) -> Result<(), String> {
    let subnets = rci_get(state, "ipv6/subnet").await?;
    let names = segment_subnets(&subnets, HOME_SEGMENT);
    if let Some(bad) = names.iter().find(|n| !is_plain_name(n)) {
        return Err(format!("непривычное имя настройки «{bad}»"));
    }
    // Уже выключен: сохранённые раньше настройки не затираем
    let saved: serde_json::Map<String, Value> = if names.is_empty() {
        read_record().await.and_then(|r| r.get("subnets")?.as_object().cloned()).unwrap_or_default()
    } else {
        names.iter().map(|n| (n.clone(), subnets[n].clone())).collect()
    };
    let record = json!({ "disabled_at": now(), "segment": HOME_SEGMENT, "subnets": saved });
    tokio::fs::write(state_path(), format!("{record:#}\n")).await.map_err(|e| e.to_string())?;
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

/// Итог проверки: что делать дальше фоновой задаче.
#[derive(Debug, PartialEq)]
enum Check {
    /// Отключено или панель уже решала раньше: больше не проверяем.
    Done,
    /// Сейчас делать нечего (у провайдера нет IPv6 или в сети он уже выключен): проверим позже.
    Later,
    /// Роутер не ответил или не выполнил команду: скоро повторим.
    Retry(String),
}

/// Отключает IPv6 в основной сети, если панель ещё этого не делала.
async fn disable_once(state: &AppState) -> Check {
    if tokio::fs::try_exists(state_path()).await.unwrap_or(false) {
        return Check::Done;
    }
    let prefixes = match rci_get(state, "show/ipv6/prefixes").await {
        Ok(prefixes) => prefixes,
        Err(e) => return Check::Retry(format!("не удалось прочитать префиксы IPv6: {e}")),
    };
    if !has_isp_prefix(&prefixes) {
        return Check::Later;
    }
    let subnets = match rci_get(state, "ipv6/subnet").await {
        Ok(subnets) => subnets,
        Err(e) => return Check::Retry(format!("не удалось прочитать настройки IPv6: {e}")),
    };
    // IPv6 в основной сети уже выключен: делать нечего, это покажет баннер
    if segment_subnets(&subnets, HOME_SEGMENT).is_empty() {
        return Check::Later;
    }
    match disable(state).await {
        Ok(()) => {
            log("INFO", "IPv6 в основной сети отключён: устройства ходят через VPN по IPv4. Вернуть можно на главной панели".into());
            Check::Done
        }
        Err(e) => {
            _ = tokio::fs::remove_file(state_path()).await;
            Check::Retry(format!("не удалось отключить IPv6: {e}"))
        }
    }
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

/// Настройки, с которыми веб-интерфейс роутера включает IPv6 у сегмента.
fn default_subnets() -> serde_json::Map<String, Value> {
    let config = json!({ "bind": HOME_SEGMENT, "mode": { "slaac": true }, "prefix": { "length": 64 }, "number": "0" });
    serde_json::Map::from_iter([("Default".to_string(), config)])
}

/// Возвращает блоки `ipv6 subnet`, сохранённые при отключении, а если их нет — настройки как у
/// веб-интерфейса. Файл состояния остаётся: панель больше не отключает IPv6 сама.
async fn enable(state: &AppState) -> Result<(), String> {
    let current = rci_get(state, "ipv6/subnet").await?;
    if !segment_subnets(&current, HOME_SEGMENT).is_empty() {
        return Ok(());
    }
    let saved = read_record().await.and_then(|r| r.get("subnets")?.as_object().cloned());
    let subnets = saved.filter(|s| !s.is_empty()).unwrap_or_else(default_subnets);
    for (name, config) in &subnets {
        rci_write(state, &subnet_write(name, config)).await?;
    }
    if let Err(e) = rci_command(state, "system configuration save").await {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    // Запись остаётся, чтобы панель не отключила IPv6 снова при следующей проверке
    let mut record = read_record()
        .await
        .unwrap_or_else(|| json!({ "segment": HOME_SEGMENT, "subnets": subnets }));
    record["enabled_at"] = json!(now());
    record["answered"] = json!(true);
    _ = tokio::fs::write(state_path(), format!("{record:#}\n")).await;
    Ok(())
}

/// Пользователь принял отключение IPv6: окно больше не показывается.
pub async fn post_ipv6_accept() -> impl IntoResponse {
    let Some(mut record) = read_record().await else {
        return Json(json!({ "success": false, "error": "Панель не отключала IPv6" }));
    };
    record["answered"] = json!(true);
    match tokio::fs::write(state_path(), format!("{record:#}\n")).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub struct Ipv6Req {
    enabled: bool,
}

/// Включает или отключает IPv6 в основной сети.
pub async fn post_ipv6(State(state): State<AppState>, Json(req): Json<Ipv6Req>) -> impl IntoResponse {
    let result = if req.enabled { enable(&state).await } else { disable(&state).await };
    match result {
        Ok(()) => {
            let action = if req.enabled { "включён" } else { "отключён" };
            log("INFO", format!("IPv6 в основной сети {action} из панели"));
            Json(json!({ "success": true }))
        }
        Err(e) => {
            let action = if req.enabled { "включить" } else { "отключить" };
            log("ERROR", format!("Не удалось {action} IPv6 в основной сети: {e}"));
            Json(json!({ "success": false, "error": format!("Не удалось {action} IPv6: {e}") }))
        }
    }
}

pub fn start_check(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        // Одна и та же ошибка пишется в журнал один раз, а не каждую минуту
        let mut last_error = None;
        loop {
            let delay = match disable_once(&state).await {
                Check::Done => return,
                Check::Later => {
                    last_error = None;
                    CHECK_INTERVAL
                }
                Check::Retry(error) => {
                    if last_error.as_ref() != Some(&error) {
                        log("WARN", format!("IPv6 в основной сети: {error}. Повтор через минуту"));
                        last_error = Some(error);
                    }
                    RETRY_INTERVAL
                }
            };
            tokio::time::sleep(delay).await;
        }
    });
}

/// `ask` — панель сама отключила IPv6, он до сих пор выключен, а пользователь ещё не ответил.
fn should_ask(record: Option<&Value>, enabled: bool) -> bool {
    record.is_some_and(|r| {
        r.get("disabled_at").is_some() && r.get("answered").and_then(Value::as_bool) != Some(true) && !enabled
    })
}

/// Баннер: IPv6 в основной сети выключен, а провайдер его даёт или его отключила панель. Кто
/// выключил — неважно: пользователь должен видеть, почему у устройств нет IPv6, и мочь вернуть его.
fn should_notice(record: Option<&Value>, enabled: bool, isp: bool) -> bool {
    !enabled && (isp || record.is_some_and(|r| r.get("disabled_at").is_some()))
}

/// `enabled` — IPv6 раздаётся в основную сеть; `ask` — показать окно про отключённый панелью IPv6;
/// `notice` — показать баннер. Если роутер не ответил, ни окна, ни баннера нет.
pub async fn get_ipv6_status(State(state): State<AppState>) -> impl IntoResponse {
    let (Ok(subnets), Ok(prefixes)) = (rci_get(&state, "ipv6/subnet").await, rci_get(&state, "show/ipv6/prefixes").await) else {
        return Json(json!({ "success": true, "ask": false, "notice": false }));
    };
    let record = read_record().await;
    let enabled = !segment_subnets(&subnets, HOME_SEGMENT).is_empty();
    Json(json!({
        "success": true,
        "enabled": enabled,
        "ask": should_ask(record.as_ref(), enabled),
        "notice": should_notice(record.as_ref(), enabled, has_isp_prefix(&prefixes)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_prefix_is_not_from_isp() {
        let local = json!({ "prefix": [{ "prefix": "fd45:8eee:8e52::/48", "global": false }] });
        assert!(!has_isp_prefix(&local));
        assert!(!has_isp_prefix(&json!({})));
        let isp = json!({ "prefix": [
            { "prefix": "fd45:8eee:8e52::/48", "global": false },
            { "prefix": "2a02:2698:4c2c:f800::/56", "global": true },
        ] });
        assert!(has_isp_prefix(&isp));
        let single = json!({ "prefix": { "prefix": "2a02:2698::/56", "global": true } });
        assert!(has_isp_prefix(&single));
    }

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
    fn asks_once_after_auto_disable() {
        let fresh = json!({ "disabled_at": 1, "subnets": {} });
        assert!(should_ask(Some(&fresh), false));
        assert!(!should_ask(Some(&fresh), true), "IPv6 уже включили в роутере");
        let answered = json!({ "disabled_at": 1, "answered": true });
        assert!(!should_ask(Some(&answered), false));
        let enabled_by_user = json!({ "enabled_at": 1 });
        assert!(!should_ask(Some(&enabled_by_user), false));
        assert!(!should_ask(None, false));
    }

    #[test]
    fn notice_shows_whoever_turned_ipv6_off() {
        let by_panel = json!({ "disabled_at": 1 });
        assert!(should_notice(Some(&by_panel), false, true));
        assert!(should_notice(Some(&by_panel), false, false), "провайдер перестал давать IPv6, а панель отключала");
        assert!(should_notice(None, false, true), "выключили вручную, провайдер даёт IPv6");
        assert!(!should_notice(None, false, false), "IPv6 нет вовсе");
        assert!(!should_notice(Some(&by_panel), true, true), "IPv6 уже вернули");
    }

    #[test]
    fn default_subnet_matches_web_interface() {
        let subnets = default_subnets();
        assert_eq!(segment_subnets(&Value::Object(subnets), "Bridge0"), ["Default"]);
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
