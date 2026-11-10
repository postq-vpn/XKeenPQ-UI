//! IPv6 в основной сети роутера.
//!
//! Многие VPN-серверы не умеют IPv6. Если устройства открывают сервисы по IPv6-адресам, сервер без
//! IPv6 не может к ним подключиться, и сервисы через VPN не работают. Поэтому при первом запуске
//! панель отключает раздачу IPv6 в основной сети — так же, как галочка «Включить IPv6» у сегмента
//! в веб-интерфейсе роутера: удаляет `ipv6 subnet`, привязанный к сегменту. У самого роутера IPv6
//! от провайдера остаётся. Что удалено, запоминается в файле, чтобы вернуть как было.
//!
//! Дальше панель IPv6 сама не выключает: раз в 2 часа проверяет и, если IPv6 снова включён,
//! предупреждает в журнале. На главной всегда видно, включён IPv6 или нет, с кнопкой переключения,
//! а после отключения при первом запуске один раз показывается окно с объяснением.

use crate::logger::log;
use crate::policy::{rci_command, rci_get, with_token};
use crate::types::{AppState, VERSION, XKEEN_CONF_DIR};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Основной сегмент роутера, как в `policy`.
const HOME_SEGMENT: &str = "Bridge0";
const STATE_FILE: &str = "xkeen-ui-ipv6.json";
/// Короткая пауза после запуска, чтобы панель успела подняться; RCI роутера обычно уже отвечает.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(2);
/// Как часто проверять, не включили ли IPv6 снова.
const CHECK_INTERVAL: Duration = Duration::from_secs(2 * 3600);
/// Роутер не ответил при первом отключении (например, ещё загружается): пробуем снова скоро.
const RETRY_INTERVAL: Duration = Duration::from_secs(10);
const RCI_TIMEOUT: Duration = Duration::from_secs(8);
/// Сразу после загрузки роутера прошивка может ещё не применить настройки, и пустой список блоков
/// IPv6 значил бы не «выключен», а «не загружен». Решение откладывается до этого времени работы.
const MIN_UPTIME: Duration = Duration::from_secs(180);

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

/// Запись с пометками: кто и какой версией панели её сделал. Через временный файл и rename:
/// обрыв питания не оставит повреждённую запись.
async fn write_record(record: &Value) -> Result<(), String> {
    let mut record = record.clone();
    record["version"] = json!(VERSION);
    let path = state_path();
    let tmp = path.with_extension("json.tmp");
    crate::private_file::write(&tmp, format!("{record:#}\n")).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| e.to_string())
}

/// Время работы роутера с загрузки (`/proc/uptime`).
fn uptime() -> Option<Duration> {
    let text = std::fs::read_to_string("/proc/uptime").ok()?;
    parse_uptime(&text)
}

fn parse_uptime(text: &str) -> Option<Duration> {
    let seconds: f64 = text.split_whitespace().next()?.parse().ok()?;
    Some(Duration::from_secs_f64(seconds.max(0.0)))
}

/// Настройки к сохранению: прежние плюс текущие. Если отключение оборвалось на середине, уже
/// удалённые блоки остаются в записи, и «Включить» вернёт всё.
fn merge_subnets(saved: serde_json::Map<String, Value>, current: &Value, names: &[String]) -> serde_json::Map<String, Value> {
    let mut merged = saved;
    for name in names {
        merged.insert(name.clone(), current[name].clone());
    }
    merged
}

/// Настройки, сохранённые при последнем отключении.
async fn saved_subnets() -> serde_json::Map<String, Value> {
    read_record()
        .await
        .and_then(|r| r.get("subnets")?.as_object().cloned())
        .unwrap_or_default()
}

/// Отключает IPv6 в основной сети и запоминает, что было включено, чтобы потом вернуть как было.
/// `auto` — отключила сама панель при первом запуске: тогда пользователю покажут окно. Пока
/// отключение не закончено, в записи стоит `pending`: при ошибке следующая попытка продолжит.
async fn disable(state: &AppState, auto: bool) -> Result<(), String> {
    let subnets = rci_get(state, "ipv6/subnet").await?;
    let names = segment_subnets(&subnets, HOME_SEGMENT);
    if let Some(bad) = names.iter().find(|n| !is_plain_name(n)) {
        return Err(format!("непривычное имя настройки «{bad}»"));
    }
    let saved = merge_subnets(saved_subnets().await, &subnets, &names);
    let by = if auto { "first-run" } else { "button" };
    let mut record = json!({ "disabled_at": now(), "auto": auto, "by": by, "segment": HOME_SEGMENT, "subnets": saved });
    record["pending"] = json!(true);
    write_record(&record).await?;
    for name in &names {
        rci_command(state, &format!("no ipv6 subnet {name}")).await?;
    }
    // Без сохранения IPv6 вернулся бы после перезагрузки роутера
    if !names.is_empty()
        && let Err(e) = rci_command(state, "system configuration save").await
    {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    record["pending"] = json!(false);
    write_record(&record).await
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
    _ = write_record(&json!({ "enabled_at": now(), "by": "button", "segment": HOME_SEGMENT, "subnets": subnets })).await;
    Ok(())
}

/// Первый запуск: отключает IPv6 в основной сети. `Ok(true)` — IPv6 был включён и отключён.
/// Если он уже был выключен, это тоже запоминается: дальше панель его сама не трогает.
async fn first_run(state: &AppState) -> Result<bool, String> {
    let _guard = CHANGE_LOCK.lock().await;
    let record = read_record().await;
    let pending = record.as_ref().is_some_and(is_pending);
    // Решение уже принято; повреждённая запись тоже считается решением, чтобы не трогать IPv6 вслепую
    if !pending && tokio::fs::try_exists(state_path()).await.unwrap_or(false) {
        return Ok(false);
    }
    let subnets = rci_get(state, "ipv6/subnet").await?;
    if segment_subnets(&subnets, HOME_SEGMENT).is_empty() {
        if pending {
            // Прошлая попытка всё удалила, но не успела отметить это
            let mut record = record.unwrap_or_default();
            record["pending"] = json!(false);
            write_record(&record).await?;
            return Ok(true);
        }
        let uptime_s = uptime().map_or(0, |u| u.as_secs());
        let record = json!({ "found_off_at": now(), "by": "found-off", "uptime_s": uptime_s, "segment": HOME_SEGMENT, "subnets": {} });
        write_record(&record).await?;
        return Ok(false);
    }
    disable(state, true).await.map(|()| true)
}

fn is_pending(record: &Value) -> bool {
    record.get("pending").and_then(Value::as_bool) == Some(true)
}

async fn is_enabled(state: &AppState) -> Result<bool, String> {
    let subnets = rci_get(state, "ipv6/subnet").await?;
    Ok(!segment_subnets(&subnets, HOME_SEGMENT).is_empty())
}

pub fn start_check(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        // Роутер только что загрузился: ждём, пока прошивка применит свои настройки
        if let Some(up) = uptime()
            && up < MIN_UPTIME
        {
            tokio::time::sleep(MIN_UPTIME - up).await;
        }
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
                        log("WARN", format!("IPv6 в основной сети не отключён: {error}. Повтор через 10 секунд"));
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
    let result = if req.enabled { enable(&state).await } else { disable(&state, false).await };
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

/// Окно: панель сама отключила IPv6, он всё ещё выключен, а пользователь ещё не ответил. Записи
/// v1.2.24 пометки `auto` не имеют: их отключение тоже считается автоматическим, иначе после
/// обновления окно не показалось бы никогда.
fn should_ask(record: Option<&Value>, enabled: bool) -> bool {
    !enabled
        && record.is_some_and(|r| {
            let auto = r.get("auto").and_then(Value::as_bool).unwrap_or(r.get("disabled_at").is_some());
            auto && !is_pending(r) && r.get("answered").and_then(Value::as_bool) != Some(true)
        })
}

/// Пользователь прочитал окно и оставил IPv6 выключенным: окно больше не показывается.
pub async fn post_ipv6_accept() -> impl IntoResponse {
    let _guard = CHANGE_LOCK.lock().await;
    let Some(mut record) = read_record().await else {
        return Json(json!({ "success": false, "error": "Панель не отключала IPv6" }));
    };
    record["answered"] = json!(true);
    match write_record(&record).await {
        Ok(()) => Json(json!({ "success": true })),
        Err(e) => Json(json!({ "success": false, "error": e })),
    }
}

/// `available` — роутер ответил; `enabled` — IPv6 раздаётся в основную сеть; `ask` — показать окно.
pub async fn get_ipv6_status(State(state): State<AppState>) -> impl IntoResponse {
    match is_enabled(&state).await {
        Ok(enabled) => {
            let ask = should_ask(read_record().await.as_ref(), enabled);
            Json(json!({ "success": true, "available": true, "enabled": enabled, "ask": ask }))
        }
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
    fn asks_only_after_automatic_disable() {
        let auto = json!({ "disabled_at": 1, "auto": true });
        assert!(should_ask(Some(&auto), false));
        assert!(!should_ask(Some(&auto), true), "IPv6 уже включили");
        assert!(!should_ask(Some(&json!({ "disabled_at": 1, "auto": true, "answered": true })), false));
        assert!(!should_ask(Some(&json!({ "disabled_at": 1, "auto": false })), false), "отключили кнопкой");
        assert!(!should_ask(Some(&json!({ "found_off_at": 1 })), false), "был выключен до панели");
        assert!(should_ask(Some(&json!({ "disabled_at": 1 })), false), "запись v1.2.24 без пометки");
        assert!(!should_ask(Some(&json!({ "disabled_at": 1, "answered": true })), false), "запись v1.2.22 с ответом");
        assert!(!should_ask(Some(&json!({ "enabled_at": 1 })), false), "IPv6 вернули");
        assert!(!should_ask(None, false));
    }

    #[test]
    fn interrupted_disable_keeps_removed_subnets() {
        let saved = serde_json::Map::from_iter([("Default".to_string(), json!({ "bind": "Bridge0", "number": "0" }))]);
        let current = json!({ "Second": { "bind": "Bridge0", "number": "1" } });
        let merged = merge_subnets(saved, &current, &["Second".to_string()]);
        assert_eq!(merged.keys().collect::<Vec<_>>(), ["Default", "Second"]);
    }

    #[test]
    fn reads_uptime() {
        assert_eq!(parse_uptime("100702.18 291013.82\n"), Some(Duration::from_secs_f64(100702.18)));
        assert_eq!(parse_uptime(""), None);
        assert_eq!(parse_uptime("abc 1"), None);
    }

    #[test]
    fn no_dialog_while_disable_is_unfinished() {
        assert!(!should_ask(Some(&json!({ "disabled_at": 1, "auto": true, "pending": true })), false));
        assert!(should_ask(Some(&json!({ "disabled_at": 1, "auto": true, "pending": false })), false));
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
