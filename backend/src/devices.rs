//! Устройства роутера и выбор, какие из них идут через VPN.
//!
//! Через VPN идёт устройство в политике XKeen: своей (`ip hotspot host <mac> policy <xkeen>`) или
//! политике своего сегмента. Панель меняет только привязку самого устройства; политику сегмента
//! не трогает. Метка политики не меняется, поэтому XKeen перезапускать не нужно — роутер
//! применяет привязку сразу.

use crate::console::as_list;
use crate::logger::log;
use crate::policy::{host_segment, segment_policy, xkeen_policy_name};
use crate::rci;
use crate::types::AppState;
use axum::extract::State;
use axum::response::Json;
use serde::Deserialize;
use regex_lite::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;
use tokio::sync::Mutex;

/// Изменения привязок идут по одному: каждое заканчивается сохранением настроек роутера.
static CHANGE_LOCK: Mutex<()> = Mutex::const_new(());

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Число из ответа роутера: RCI отдаёт число, консоль — строку.
fn number(value: &Value, key: &str) -> Option<u64> {
    let value = value.get(key)?;
    value.as_u64().or_else(|| value.as_str()?.trim().parse().ok())
}

/// Понятное имя сегмента: описание («Основная»), имя («Home») или id («Bridge0»).
fn segment_title(host: &Value) -> Option<&str> {
    let interface = host.get("interface")?;
    text(interface, "description").or_else(|| text(interface, "name")).or_else(|| host_segment(host))
}

/// Имя, которое роутер даёт устройству сам: «<имя или MAC> - <сегмент> - 2026-11-06 12:48».
static AUTO_NAME_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" - .+ - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$").unwrap());

/// Имя для списка: заданное в роутере без автохвоста, сетевое имя или имя из SSDP. MAC вместо
/// имени — не имя: тогда `None`, и панель пишет «Без имени».
fn display_name(host: &Value) -> Option<String> {
    let given = text(host, "name").map(|n| AUTO_NAME_TAIL.replace(n, "").trim().to_string());
    [given.as_deref(), text(host, "hostname"), host.get("ssdp").and_then(|s| text(s, "name"))]
        .into_iter()
        .flatten()
        .find(|n| !n.is_empty() && !valid_mac(&n.to_ascii_lowercase()))
        .map(String::from)
}

/// Описание политики («xkeen») или её имя, если описания нет.
fn policy_title(policies: &Value, name: &str) -> String {
    policies.get(name).and_then(|p| text(p, "description")).unwrap_or(name).to_string()
}

/// Устройства из `show ip hotspot` с отметкой, идут ли они через VPN.
fn devices(hosts: &Value, hotspot: &Value, policies: &Value, xkeen: Option<&str>) -> Vec<Value> {
    as_list(hosts.get("host"))
        .into_iter()
        // Узлы Wi-Fi-системы — не устройства пользователя
        .filter(|h| h.get("mws-backhaul").and_then(Value::as_bool) != Some(true))
        .filter_map(|host| {
            let mac = text(host, "mac")?.to_ascii_lowercase();
            let own = text(host, "policy");
            let segment = host_segment(host).and_then(|s| segment_policy(hotspot, s));
            let segment_vpn = xkeen.is_some() && segment.as_deref() == xkeen;
            let vpn = xkeen.is_some() && (own == xkeen || (own.is_none() && segment_vpn));
            let other_policy = own.filter(|p| Some(*p) != xkeen).map(|p| policy_title(policies, p));
            Some(json!({
                "mac": mac,
                "name": display_name(host),
                "ip": text(host, "ip"),
                "segment": segment_title(host),
                "active": host.get("active").and_then(Value::as_bool).unwrap_or(false),
                // Через узел Wi-Fi-системы данные Wi-Fi лежат в `mws`
                "ssid": text(host, "ssid").or_else(|| host.get("mws").and_then(|m| text(m, "ssid"))),
                "hostname": text(host, "hostname"),
                "last_seen": number(host, "last-seen"),
                "vpn": vpn,
                // Через VPN идёт весь сегмент: исключить одно устройство панель не может
                "segment_vpn": segment_vpn,
                "other_policy": other_policy,
            }))
        })
        .collect()
}

pub async fn get_devices(State(state): State<AppState>) -> Json<Value> {
    let read = async {
        let hosts = rci::get(&state, "show/ip/hotspot").await?;
        let hotspot = rci::get(&state, "ip/hotspot").await?;
        let policies = rci::get(&state, "show/ip/policy").await?;
        Ok::<_, String>((hosts, hotspot, policies))
    };
    match read.await {
        Ok((hosts, hotspot, policies)) => {
            let xkeen = xkeen_policy_name(&policies);
            Json(json!({
                "success": true,
                "policy": xkeen.is_some(),
                "devices": devices(&hosts, &hotspot, &policies, xkeen.as_deref()),
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": format!("Не удалось получить список устройств: {e}") })),
    }
}

/// MAC в виде `aa:bb:cc:dd:ee:ff` — он подставляется в команду роутера.
fn valid_mac(mac: &str) -> bool {
    let parts: Vec<&str> = mac.split(':').collect();
    parts.len() == 6 && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[derive(Deserialize)]
pub struct VpnChange {
    macs: Vec<String>,
    enabled: bool,
}

/// Сколько устройств можно изменить одним запросом.
const MAX_BATCH: usize = 256;

/// Меняет привязку устройств; ошибки — по каждому MAC отдельно.
async fn change_vpn(state: &AppState, macs: &[String], enabled: bool) -> Result<Vec<(String, String)>, String> {
    let policies = rci::get(state, "show/ip/policy").await?;
    let xkeen = xkeen_policy_name(&policies).ok_or("В роутере нет политики xkeen")?;
    if !xkeen.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("Непонятное имя политики xkeen: {xkeen}"));
    }
    // Устройство из сегмента, который целиком идёт через VPN, своей привязкой не исключить
    let (hosts, hotspot) = match enabled {
        true => (Value::Null, Value::Null),
        false => (rci::get(state, "show/ip/hotspot").await?, rci::get(state, "ip/hotspot").await?),
    };
    let mut failed = Vec::new();
    for mac in macs {
        let segment_vpn = !enabled
            && as_list(hosts.get("host"))
                .into_iter()
                .find(|h| text(h, "mac").is_some_and(|m| m.eq_ignore_ascii_case(mac)))
                .and_then(host_segment)
                .and_then(|s| segment_policy(&hotspot, s))
                .is_some_and(|p| p == xkeen);
        if segment_vpn {
            failed.push((mac.clone(), "через VPN идёт весь его сегмент".to_string()));
            continue;
        }
        let command = match enabled {
            true => format!("ip hotspot host {mac} policy {xkeen}"),
            false => format!("no ip hotspot host {mac} policy"),
        };
        if let Err(e) = rci::command(state, &command).await {
            failed.push((mac.clone(), e));
        }
    }
    Ok(failed)
}

pub async fn post_device_vpn(State(state): State<AppState>, Json(change): Json<VpnChange>) -> Json<Value> {
    let mut macs: Vec<String> = change.macs.iter().map(|m| m.to_ascii_lowercase()).collect();
    macs.sort();
    macs.dedup();
    if macs.is_empty() || macs.len() > MAX_BATCH {
        return Json(json!({ "success": false, "error": "Не выбраны устройства" }));
    }
    if let Some(bad) = macs.iter().find(|m| !valid_mac(m)) {
        return Json(json!({ "success": false, "error": format!("Неверный MAC-адрес: {bad}") }));
    }
    let _guard = CHANGE_LOCK.lock().await;
    let failed = match change_vpn(&state, &macs, change.enabled).await {
        Ok(failed) => failed,
        Err(e) => return Json(json!({ "success": false, "error": e })),
    };
    let changed = macs.len() - failed.len();
    let action = if change.enabled { "через VPN" } else { "мимо VPN" };
    if changed > 0 {
        log("INFO", format!("Устройств переведено {action}: {changed}"));
    }
    for (mac, e) in &failed {
        log("WARN", format!("Устройство {mac} не переведено {action}: {e}"));
    }
    // Без сохранения привязки пропали бы после перезагрузки роутера
    let save_error = match changed {
        0 => None,
        _ => rci::command(&state, "system configuration save").await.err(),
    };
    if let Some(e) = &save_error {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    let failed: Vec<Value> = failed.into_iter().map(|(mac, error)| json!({ "mac": mac, "error": error })).collect();
    Json(json!({ "success": true, "changed": changed, "failed": failed, "save_error": save_error }))
}

/// Имя устройства для команды `known host "<имя>" <mac>`: без кавычек, обратной косой черты и
/// управляющих символов — иначе их пришлось бы экранировать в строке консоли.
fn valid_name(name: &str) -> bool {
    let length = name.chars().count();
    (1..=64).contains(&length) && name.chars().all(|c| !c.is_control() && c != '"' && c != '\\')
}

#[derive(Deserialize)]
pub struct NameChange {
    mac: String,
    name: String,
}

/// Имя устройства в роутере (то же, что «Изменить имя» в списке клиентов). Устройство без
/// записи при этом регистрируется.
pub async fn post_device_name(State(state): State<AppState>, Json(change): Json<NameChange>) -> Json<Value> {
    let mac = change.mac.to_ascii_lowercase();
    let name = change.name.trim();
    if !valid_mac(&mac) {
        return Json(json!({ "success": false, "error": "Неверный MAC-адрес" }));
    }
    if !valid_name(name) {
        return Json(json!({ "success": false, "error": "Имя — от 1 до 64 символов, без кавычек и обратной косой черты" }));
    }
    let _guard = CHANGE_LOCK.lock().await;
    if let Err(e) = rci::command(&state, &format!("known host \"{name}\" {mac}")).await {
        return Json(json!({ "success": false, "error": format!("Роутер не принял имя: {e}") }));
    }
    log("INFO", format!("Устройство {mac} переименовано в «{name}»"));
    let save_error = rci::command(&state, "system configuration save").await.err();
    if let Some(e) = &save_error {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {e}"));
    }
    Json(json!({ "success": true, "save_error": save_error }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(mac: &str, segment: &str, policy: &str) -> Value {
        json!({ "mac": mac, "hostname": "phone", "interface": { "id": segment, "name": "Home", "description": "Основная" },
                "policy": policy, "active": true, "ssid": "wifi" })
    }

    #[test]
    fn marks_devices_going_through_vpn() {
        let hosts = json!({ "host": [
            host("AA:00:00:00:00:01", "Bridge0", "Policy0"),
            host("aa:00:00:00:00:02", "Bridge0", ""),
            host("aa:00:00:00:00:03", "Bridge1", ""),
            host("aa:00:00:00:00:04", "Bridge1", "Policy1"),
            { "mac": "aa:00:00:00:00:05", "mws-backhaul": true },
        ] });
        let hotspot = json!({ "policy": [{ "interface": "Bridge0", "access": "permit" }, { "interface": "Bridge1", "policy": "Policy0" }] });
        let policies = json!({ "Policy0": { "description": "xkeen" }, "Policy1": { "description": "Игры" } });
        let list = devices(&hosts, &hotspot, &policies, Some("Policy0"));
        assert_eq!(list.len(), 4);
        assert_eq!(list[0]["mac"], "aa:00:00:00:00:01");
        assert_eq!((list[0]["vpn"].as_bool(), list[0]["segment_vpn"].as_bool()), (Some(true), Some(false)));
        assert_eq!(list[1]["vpn"], false);
        assert_eq!((list[2]["vpn"].as_bool(), list[2]["segment_vpn"].as_bool()), (Some(true), Some(true)));
        // Своя политика важнее политики сегмента
        assert_eq!(list[3]["vpn"], false);
        assert_eq!(list[3]["other_policy"], "Игры");
        assert_eq!(list[0]["segment"], "Основная");
        assert_eq!(list[0]["name"], "phone");
        // Без политики xkeen через VPN не идёт никто
        assert!(devices(&hosts, &hotspot, &policies, None).iter().all(|d| d["vpn"] == false));
    }

    #[test]
    fn cleans_router_given_names() {
        let named = |name: &str, hostname: &str| json!({ "name": name, "hostname": hostname });
        assert_eq!(display_name(&named("postQ-Cloud - Home network - 2026-11-06 12:36", "")).as_deref(), Some("postQ-Cloud"));
        assert_eq!(display_name(&named("3c:0b:4f:15:cc:16 - Основная - 2026-11-06 12:48", "iPhone")).as_deref(), Some("iPhone"));
        assert_eq!(display_name(&named("3c:0b:4f:15:cc:16 - Основная - 2026-11-06 12:48", "")), None);
        assert_eq!(display_name(&named("Телевизор", "android-1")).as_deref(), Some("Телевизор"));
        let nas = json!({ "name": "", "ssdp": { "name": "NAS (DS423+)" } });
        assert_eq!(display_name(&nas).as_deref(), Some("NAS (DS423+)"));
    }

    #[test]
    fn checks_name() {
        assert!(valid_name("Телевизор в спальне"));
        assert!(!valid_name(""));
        assert!(!valid_name("a\" b"));
        assert!(!valid_name("a\\b"));
        assert!(!valid_name("line\nbreak"));
        assert!(!valid_name(&"я".repeat(65)));
    }

    #[test]
    fn reads_wifi_through_mesh_node() {
        let hosts = json!({ "host": [{ "mac": "aa:00:00:00:00:01", "mws": { "ssid": "postQ" } }] });
        let list = devices(&hosts, &json!({}), &json!({}), None);
        assert_eq!(list[0]["ssid"], "postQ");
    }

    #[test]
    fn reads_numbers_from_console_too() {
        assert_eq!(number(&json!({ "last-seen": 5 }), "last-seen"), Some(5));
        assert_eq!(number(&json!({ "last-seen": "5" }), "last-seen"), Some(5));
        assert_eq!(number(&json!({}), "last-seen"), None);
    }

    #[test]
    fn checks_mac() {
        assert!(valid_mac("aa:bb:cc:dd:ee:ff"));
        assert!(!valid_mac("aa:bb:cc:dd:ee"));
        assert!(!valid_mac("aa:bb:cc:dd:ee:ff; reboot"));
    }

    #[test]
    fn finds_xkeen_policy_name() {
        let policies = json!({ "Policy1": { "description": "Игры" }, "Policy0": { "description": "XKeen" } });
        assert_eq!(xkeen_policy_name(&policies).as_deref(), Some("Policy0"));
    }
}
