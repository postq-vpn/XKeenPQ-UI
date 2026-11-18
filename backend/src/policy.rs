//! Политика XKeen в роутере: через неё в Xray идут только нужные устройства.
//!
//! XKeen читает метку политики только при запуске, поэтому политика, созданная или изменённая
//! позже, заработает после его перезапуска. Панель показывает такое расхождение и умеет создать
//! политику, если её нет: для основного сегмента, через текущее основное подключение.

use crate::console::as_list;
use crate::logger::log;
use crate::rci;
use crate::types::AppState;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::Mutex;

const XKEEN_POLICY: &str = "xkeen";
const XKEEN_PROXY_SCRIPT: &str = "/opt/etc/ndm/netfilter.d/proxy.sh";
/// Основной сегмент роутера (провод и основной Wi-Fi). Остальные сегменты панель не трогает.
const HOME_SEGMENT: &str = "Bridge0";
/// Сколько в роутере может быть политик; номера берутся из этого диапазона.
const POLICY_SLOTS: u32 = 32;
/// Маршрут появляется в таблице политики не сразу после разрешения подключения.
const ROUTE_CHECKS: u32 = 10;
const ROUTE_CHECK_DELAY: Duration = Duration::from_secs(1);

/// Создание политики и перезапуск нельзя запускать параллельно.
static CREATE_LOCK: Mutex<()> = Mutex::const_new(());

/// Метка, с которой запущен XKeen (строка `policy_mark='…'` его скрипта файрвола).
/// Пустая строка — запущен без политики, `None` — скрипта или строки нет.
fn applied_mark(script: &str) -> Option<&str> {
    script
        .lines()
        .find_map(|line| line.strip_prefix("policy_mark='")?.strip_suffix('\''))
}

/// Политика XKeen из `show ip policy`: ищется по описанию, как в самом XKeen.
fn xkeen_policy(policies: &Value) -> Option<&Value> {
    policies.as_object()?.values().find(|policy| {
        policy
            .get("description")
            .and_then(Value::as_str)
            .is_some_and(|d| d.eq_ignore_ascii_case(XKEEN_POLICY))
    })
}

/// Имя политики XKeen в роутере (`Policy0`…).
pub(crate) fn xkeen_policy_name(policies: &Value) -> Option<String> {
    let found = xkeen_policy(policies)?;
    policies.as_object()?.iter().find_map(|(name, policy)| std::ptr::eq(policy, found).then(|| name.clone()))
}

fn router_mark(policies: &Value) -> Option<String> {
    Some(format!("0x{}", xkeen_policy(policies)?.get("mark")?.as_str()?))
}

/// Метка из кеша XKeen (политику удалили) перезапуском не исправляется: этот случай сюда не входит.
fn mark_outdated(script: &str, policies: &Value) -> bool {
    match (applied_mark(script), router_mark(policies)) {
        (Some(applied), Some(current)) => !applied.eq_ignore_ascii_case(&current),
        _ => false,
    }
}

fn free_policy_name(policies: &Value) -> Option<String> {
    let used = policies.as_object()?;
    (0..POLICY_SLOTS)
        .map(|n| format!("Policy{n}"))
        .find(|name| !used.contains_key(name))
}

/// Подключение, через которое роутер сейчас выходит в интернет (`show interface`).
fn default_connection(interfaces: &Value) -> Option<String> {
    interfaces.as_object()?.iter().find_map(|(id, interface)| {
        let is_default = interface.get("defaultgw").and_then(Value::as_bool) == Some(true);
        is_default.then(|| id.clone())
    })
}

/// Политика сегмента из `ip hotspot`. Единственная запись может прийти объектом, а не списком.
pub(crate) fn segment_policy(hotspot: &Value, segment: &str) -> Option<String> {
    as_list(hotspot.get("policy")).into_iter().find_map(|entry| {
        (entry.get("interface")?.as_str()? == segment).then(|| Some(entry.get("policy")?.as_str()?.to_string()))?
    })
}

fn has_default_route(policy: &Value) -> bool {
    as_list(policy.pointer("/route4/route"))
        .into_iter()
        .any(|r| r.get("destination").and_then(Value::as_str) == Some("0.0.0.0/0"))
}

/// Сегмент устройства: строка (`Bridge0`) или объект `{ "id": "Bridge0", "name": "Home" }`.
pub(crate) fn host_segment(host: &Value) -> Option<&str> {
    let interface = host.get("interface")?;
    interface.as_str().or_else(|| interface.get("id")?.as_str())
}

/// Активные устройства сегмента вне его политики (свои настройки доступа в роутере).
fn hosts_outside(hosts: &Value, segment: &str) -> usize {
    as_list(hosts.get("host"))
        .into_iter()
        .filter(|h| {
            h.get("active").and_then(Value::as_bool) == Some(true)
                && host_segment(h) == Some(segment)
                && h.get("policy").and_then(Value::as_str).is_none_or(str::is_empty)
        })
        .count()
}

/// Предупреждения показываются только при уверенности: ошибка чтения — не повод для них.
pub async fn get_policy_status(State(state): State<AppState>) -> impl IntoResponse {
    let (mut outdated, mut missing) = (false, false);
    if let Ok(policies) = rci::get(&state, "show/ip/policy").await {
        let script = tokio::fs::read_to_string(XKEEN_PROXY_SCRIPT).await.unwrap_or_default();
        outdated = mark_outdated(&script, &policies);
        let hidden = state.settings.read().unwrap().gui.hide_policy_hint;
        missing = !hidden && xkeen_policy(&policies).is_none();
    }
    Json(json!({ "success": true, "outdated": outdated, "missing": missing }))
}

/// Без маршрута по умолчанию метка политики ведёт в blackhole: привязанный сегмент остался бы
/// без интернета. Поэтому сегмент привязывается только после появления маршрута.
async fn wait_default_route(state: &AppState, name: &str) -> Result<(), String> {
    for _ in 0..ROUTE_CHECKS {
        tokio::time::sleep(ROUTE_CHECK_DELAY).await;
        let policies = rci::get(state, "show/ip/policy").await?;
        if policies.get(name).is_some_and(has_default_route) {
            return Ok(());
        }
    }
    Err("у новой политики не появился маршрут в интернет".into())
}

async fn build_policy(state: &AppState, name: &str, connection: &str) -> Result<(), String> {
    rci::command(state, &format!("ip policy {name}")).await?;
    rci::command(state, &format!("ip policy {name} description {XKEEN_POLICY}")).await?;
    rci::command(state, &format!("ip policy {name} permit global {connection}")).await?;
    wait_default_route(state, name).await?;
    rci::command(state, &format!("ip hotspot policy {HOME_SEGMENT} {name}")).await?;
    let hotspot = rci::get(state, "ip/hotspot").await?;
    if segment_policy(&hotspot, HOME_SEGMENT).as_deref() != Some(name) {
        return Err("роутер не применил политику к основной сети".into());
    }
    Ok(())
}

/// Создаёт политику, если её нет. Возвращает её имя, `None` — политика уже была.
/// При ошибке созданное удаляется: роутер остаётся как был.
async fn ensure_policy(state: &AppState) -> Result<Option<String>, String> {
    let policies = rci::get(state, "show/ip/policy").await?;
    if xkeen_policy(&policies).is_some() {
        return Ok(None);
    }
    let hotspot = rci::get(state, "ip/hotspot").await?;
    if let Some(other) = segment_policy(&hotspot, HOME_SEGMENT) {
        return Err(format!("На основной сети уже стоит другая политика ({other}), панель её не меняет"));
    }
    let interfaces = rci::get(state, "show/interface").await?;
    if interfaces.get(HOME_SEGMENT).is_none() {
        return Err("На роутере нет основной сети (Bridge0)".into());
    }
    let connection = default_connection(&interfaces).ok_or("Нет активного подключения к интернету")?;
    let name = free_policy_name(&policies).ok_or("На роутере нет свободного места для политики")?;

    if let Err(error) = build_policy(state, &name, &connection).await {
        if let Err(e) = rci::command(state, &format!("no ip policy {name}")).await {
            log("ERROR", format!("Не удалось удалить политику {name}: {e}"));
        }
        log("ERROR", format!("Политика xkeen не создана: {error}"));
        return Err(format!("Не удалось создать политику: {error}"));
    }
    log("INFO", format!("Создана политика xkeen ({name}) для основной сети через {connection}"));
    Ok(Some(name))
}

pub async fn post_policy(State(state): State<AppState>) -> impl IntoResponse {
    let Ok(_guard) = CREATE_LOCK.try_lock() else {
        return Json(json!({ "success": false, "error": "Политика уже создаётся" }));
    };
    let created = match ensure_policy(&state).await {
        Ok(created) => created,
        Err(error) => return Json(json!({ "success": false, "error": error })),
    };
    // Без сохранения политика пропала бы после перезагрузки роутера
    let save_error = match created {
        Some(_) => rci::command(&state, "system configuration save").await.err(),
        None => None,
    };
    if let Some(error) = &save_error {
        log("ERROR", format!("Не удалось сохранить настройки роутера: {error}"));
    }
    let restart_error = crate::controller::restart_xkeen(&state).await.err();
    let outside = match rci::get(&state, "show/ip/hotspot").await {
        Ok(hosts) => hosts_outside(&hosts, HOME_SEGMENT),
        Err(_) => 0,
    };
    Json(json!({
        "success": true,
        "created": created.is_some(),
        "save_error": save_error,
        "restart_error": restart_error,
        "hosts_outside": outside,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policies() -> Value {
        json!({
            "Policy1": { "description": "other", "mark": "aaa" },
            "Policy0": { "description": "XKeen", "mark": "ffffaaa" },
        })
    }

    #[test]
    fn policy_created_after_start_is_outdated() {
        assert!(mark_outdated("mode_proxy='Hybrid'\npolicy_mark=''\n", &policies()));
    }

    #[test]
    fn changed_mark_is_outdated() {
        assert!(mark_outdated("policy_mark='0xbbb'\n", &policies()));
    }

    #[test]
    fn applied_mark_is_not_outdated() {
        assert!(!mark_outdated("policy_mark='0xFFFFAAA'\n", &policies()));
    }

    #[test]
    fn nothing_to_compare_is_not_outdated() {
        let no_policy = json!({ "Policy1": { "description": "other", "mark": "aaa" } });
        assert!(!mark_outdated("policy_mark=''\n", &no_policy));
        assert!(!mark_outdated("policy_mark='0xffffaaa'\n", &no_policy));
        assert!(!mark_outdated("", &policies()));
        assert!(!mark_outdated("policy_mark_full=''\n", &policies()));
        assert!(!mark_outdated("policy_mark=''\n", &json!({ "Policy0": { "description": "xkeen" } })));
    }

    #[test]
    fn finds_free_policy_slot() {
        assert_eq!(free_policy_name(&json!({})).unwrap(), "Policy0");
        assert_eq!(free_policy_name(&json!({ "Policy0": {}, "Policy2": {} })).unwrap(), "Policy1");
    }

    #[test]
    fn picks_default_connection() {
        let interfaces = json!({
            "Bridge5": { "global": true, "defaultgw": false },
            "GigabitEthernet1": { "global": true, "defaultgw": true },
            "Bridge0": {},
        });
        assert_eq!(default_connection(&interfaces).unwrap(), "GigabitEthernet1");
        assert!(default_connection(&json!({ "Bridge5": { "defaultgw": false } })).is_none());
    }

    #[test]
    fn reads_segment_policy_from_list_or_object() {
        let list = json!({ "policy": [
            { "interface": "Bridge1", "policy": "Policy1" },
            { "interface": "Bridge0", "policy": "Policy0" },
        ] });
        assert_eq!(segment_policy(&list, "Bridge0").unwrap(), "Policy0");
        assert!(segment_policy(&list, "Bridge2").is_none());
        let single = json!({ "policy": { "interface": "Bridge0", "policy": "Policy0" } });
        assert_eq!(segment_policy(&single, "Bridge0").unwrap(), "Policy0");
        assert!(segment_policy(&json!({}), "Bridge0").is_none());
    }

    #[test]
    fn requires_default_route() {
        let without = json!({ "route4": { "route": [{ "destination": "192.168.1.0/24" }] } });
        let with = json!({ "route4": { "route": [{ "destination": "0.0.0.0/0" }] } });
        assert!(!has_default_route(&without));
        assert!(has_default_route(&with));
        assert!(!has_default_route(&json!({})));
        // Один маршрут приходит объектом, а не списком
        let single = json!({ "route4": { "route": { "destination": "0.0.0.0/0" } } });
        assert!(has_default_route(&single));
    }

    #[test]
    fn counts_active_segment_hosts_outside_policy() {
        let hosts = json!({ "host": [
            { "active": true, "interface": "Bridge0", "policy": "" },
            { "active": true, "interface": "Bridge0", "policy": "Policy0" },
            { "active": false, "interface": "Bridge0", "policy": "" },
            { "active": true, "interface": "Bridge2", "policy": "" },
            { "active": true, "interface": { "id": "Bridge0", "name": "Home" }, "policy": "" },
        ] });
        assert_eq!(hosts_outside(&hosts, "Bridge0"), 2);
    }
}
