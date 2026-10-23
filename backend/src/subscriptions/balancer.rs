//! Режим «Авто»: трафик подписки идёт через балансировщик Xray.
//!
//! Если сервер подписки не выбран вручную, правила routing с `"outboundTag": "<tag>"` переводятся
//! на `"balancerTag": "<tag>"`, а в routing добавляется балансировщик `leastPing` с селектором
//! `<tag>--` (все серверы подписки). Xray сам раз в минуту проверяет серверы (observatory) и ведёт
//! трафик через самый быстрый из рабочих; если не работает ни один — через outbound `<tag>`
//! (`fallbackTag`). Проверяются только зарубежные серверы: российские («Обратный VPN» и т.п.)
//! в observatory не попадают, поэтому `leastPing` их не выбирает.
//!
//! `routing` из нескольких файлов Xray не объединяет (последний заменяет целиком), поэтому
//! балансировщик пишется в тот же файл, где правила. Observatory — отдельный объект верхнего
//! уровня, его панель держит в своём файле вместе с API Xray на 127.0.0.1 — через него
//! интерфейс узнаёт, какой сервер выбран сейчас. Правки routing точечные: комментарии
//! и форматирование сохраняются. Когда сервер выбирают вручную или подписку удаляют,
//! всё возвращается обратно.

use super::routing::{ConfFile, read_conf_files, strip_jsonc};
use super::*;

const OBSERVATORY_FILE: &str = "07_observatory_sub.json";
const PROBE_URL: &str = "https://www.gstatic.com/generate_204";
const PROBE_INTERVAL: &str = "1m";
/// API Xray только для панели: `api.listen` не требует inbound и правила в routing.
const API_LISTEN: &str = "127.0.0.1:61085";
const API_TIMEOUT: Duration = Duration::from_secs(5);

/// Российские серверы для обхода блокировок не годятся (как «Не рекомендуется» в интерфейсе).
pub(super) fn is_not_recommended(name: &str) -> bool {
    let name = name.to_lowercase();
    name.contains("росси") || name.contains("russia")
}

/// Имя сервера из подписки (с флагами), по тегу `<tag>--<имя>`.
fn server_name<'a>(sub: &'a Subscription, tag: &'a str) -> &'a str {
    let short = tag.strip_prefix(&format!("{}--", sub.tag)).unwrap_or(tag);
    sub.server_names.get(short).map_or(short, String::as_str)
}

/// Сервер подписки годится для автовыбора.
pub(super) fn is_recommended(sub: &Subscription, outbound: &Value) -> bool {
    outbound["tag"]
        .as_str()
        .is_some_and(|tag| !is_not_recommended(server_name(sub, tag)))
}

/// Подписка работает через балансировщик: сервер не выбран вручную и список серверов получен.
fn is_balanced(sub: &Subscription) -> bool {
    sub.primary.is_empty() && !sub.cached_outbounds.is_empty()
}

/// Серверы, которые проверяет observatory: зарубежные, а если таких нет — все включённые.
fn pool(sub: &Subscription) -> Vec<String> {
    let Ok(enabled) = enabled_outbounds(sub, &sub.cached_outbounds) else {
        return vec![];
    };
    let tags = |list: Vec<&Value>| -> Vec<String> {
        list.iter()
            .filter_map(|o| Some(o["tag"].as_str()?.to_string()))
            .collect()
    };
    let recommended = tags(enabled.iter().filter(|o| is_recommended(sub, o)).collect());
    if recommended.is_empty() {
        tags(enabled.iter().collect())
    } else {
        recommended
    }
}

fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

/// Балансировщик подписки в том виде, в каком его пишет панель.
fn balancer_text(tag: &str) -> String {
    format!(
        r#"{{ "tag": {t}, "selector": [{s}], "strategy": {{ "type": "leastPing" }}, "fallbackTag": {t} }}"#,
        t = quoted(tag),
        s = quoted(&format!("{tag}--")),
    )
}

/// Балансировщик записан панелью (по нему узнаём, что его можно убрать).
fn is_panel_balancer(b: &Value) -> Option<&str> {
    let tag = b.get("tag")?.as_str()?;
    let selector = b.get("selector")?.as_array()?;
    (selector.len() == 1
        && selector[0].as_str() == Some(&format!("{tag}--"))
        && b.get("fallbackTag")?.as_str() == Some(tag)
        && b.pointer("/strategy/type")?.as_str() == Some("leastPing"))
    .then_some(tag)
}

/// `"from": "<tag>"` → `"to": "<tag>"`, пробелы вокруг двоеточия сохраняются.
fn replace_key(text: &str, from: &str, to: &str, tag: &str) -> String {
    let re = Regex::new(&format!(r#""{from}"(\s*:\s*){}"#, regex_lite::escape(&quoted(tag)))).unwrap();
    re.replace_all(text, |caps: &regex_lite::Captures| {
        format!("\"{to}\"{}{}", &caps[1], quoted(tag))
    })
    .into_owned()
}

/// Добавляет балансировщик в `routing.balancers` (или создаёт массив в начале `routing`).
fn insert_balancer(text: &str, tag: &str) -> Option<String> {
    let obj = balancer_text(tag);
    let array = Regex::new(r#"("balancers"\s*:\s*\[)(\s*)(\]?)"#).unwrap();
    if let Some(caps) = array.captures(text) {
        let (start, end) = (caps.get(0)?.start(), caps.get(0)?.end());
        let (open, ws, close) = (&caps[1], &caps[2], &caps[3]);
        let inserted = if close.is_empty() {
            format!("{open}{ws}{obj},{ws}")
        } else {
            format!("{open}{obj}{close}")
        };
        return Some(format!("{}{inserted}{}", &text[..start], &text[end..]));
    }
    let routing = Regex::new(r#"("routing"\s*:\s*\{)(\s*)"#).unwrap();
    let caps = routing.captures(text)?;
    let (start, end) = (caps.get(0)?.start(), caps.get(0)?.end());
    let ws = if caps[2].is_empty() { " " } else { &caps[2] };
    Some(format!(
        "{}{}{ws}\"balancers\": [{obj}],{ws}{}",
        &text[..start],
        &caps[1],
        &text[end..]
    ))
}

/// Убирает балансировщик панели вместе с запятой. Объект ищется по содержимому, поэтому
/// находится в любом форматировании и порядке ключей (например, после GUI-редактора).
fn remove_balancer(text: &str, tag: &str) -> String {
    // Объект с одним уровнем вложенности — как `{ ..., "strategy": { ... }, ... }`.
    let object = Regex::new(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}").unwrap();
    let Some(found) = object.find_iter(text).find(|m| {
        serde_json::from_str::<Value>(&strip_jsonc(m.as_str())).is_ok_and(|v| is_panel_balancer(&v) == Some(tag))
    }) else {
        return text.to_string();
    };
    let (before, after) = (&text[..found.start()], &text[found.end()..]);
    let next_comma = after.trim_start().strip_prefix(',');
    if let Some(rest) = next_comma {
        // За объектом есть элемент: убираем объект и запятую после него.
        return format!("{before}{}", rest.trim_start());
    }
    // Последний элемент: убираем запятую перед ним, если она есть.
    let trimmed = before.trim_end();
    let before = trimmed.strip_suffix(',').unwrap_or(before);
    format!("{before}{after}")
}

/// Новый текст файла с правилами: балансировщики для `balanced`, остальные панельные — обратно
/// на outbound. `None` — менять нечего.
fn update_routing_file(file: &ConfFile, balanced: &HashSet<String>) -> Option<String> {
    let json = file.json.as_ref()?;
    let rules = json.pointer("/routing/rules")?.as_array()?;
    let balancers: Vec<&Value> = json
        .pointer("/routing/balancers")
        .and_then(Value::as_array)
        .map(|b| b.iter().collect())
        .unwrap_or_default();
    let mut text = file.text.clone();

    for tag in balancers.iter().filter_map(|b| is_panel_balancer(b)) {
        if !balanced.contains(tag) {
            text = remove_balancer(&text, tag);
            text = replace_key(&text, "balancerTag", "outboundTag", tag);
        }
    }
    for tag in balanced {
        let uses = rules.iter().any(|r| {
            r.get("outboundTag").and_then(Value::as_str) == Some(tag.as_str())
                || r.get("balancerTag").and_then(Value::as_str) == Some(tag.as_str())
        });
        if !uses {
            continue;
        }
        text = replace_key(&text, "outboundTag", "balancerTag", tag);
        if !balancers
            .iter()
            .any(|b| b.get("tag").and_then(Value::as_str) == Some(tag.as_str()))
        {
            text = insert_balancer(&text, tag)?;
        }
    }
    (text != file.text).then_some(text)
}

/// `api` — добавить API Xray (если его уже не настроил пользователь в своём файле).
fn observatory_text(subjects: &[String], api: bool) -> String {
    let mut config = json!({
        "observatory": {
            "subjectSelector": subjects,
            "probeUrl": PROBE_URL,
            "probeInterval": PROBE_INTERVAL,
            "enableConcurrency": true,
        }
    });
    if api {
        config["api"] = json!({ "tag": "xkeen-ui-api", "listen": API_LISTEN, "services": ["RoutingService"] });
    }
    let mut content = serde_json::to_string_pretty(&config).unwrap();
    content.push('\n');
    content
}

async fn write_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    // Без расширения .json, чтобы Xray не подхватил недописанный файл.
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("ошибка записи {}: {}", tmp.display(), e))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("ошибка записи {}: {}", path.display(), e))
}

/// Пишет observatory для серверов `subjects` (пусто — удаляет файл). Возвращает true при изменении.
async fn sync_observatory(files: &[ConfFile], subjects: &[String]) -> Result<bool, String> {
    let path = std::path::Path::new(XRAY_CONF_DIR).join(OBSERVATORY_FILE);
    if subjects.is_empty() {
        return Ok(tokio::fs::remove_file(&path).await.is_ok());
    }
    let foreign = |key: &str| {
        files
            .iter()
            .find(|f| f.path != path && f.json.as_ref().is_some_and(|j| j.get(key).is_some()))
    };
    if let Some(f) = foreign("observatory") {
        log(
            "WARN",
            format!(
                "Автовыбор сервера: observatory уже задан в {}, серверы подписок им могут не проверяться",
                f.path.display()
            ),
        );
        return Ok(tokio::fs::remove_file(&path).await.is_ok());
    }
    let content = observatory_text(subjects, foreign("api").is_none());
    if files.iter().any(|f| f.path == path && f.text == content) {
        return Ok(false);
    }
    write_atomic(&path, &content).await?;
    Ok(true)
}

/// Приводит routing и observatory к режимам подписок. Возвращает true, если конфиги изменились.
pub(super) async fn sync(subs: &[Subscription]) -> Result<bool, String> {
    let files = read_conf_files().await;
    let balanced: Vec<&Subscription> = subs.iter().filter(|s| is_balanced(s)).collect();
    let tags: HashSet<String> = balanced.iter().map(|s| s.tag.clone()).collect();

    let mut changed = false;
    for file in files.iter().filter(|f| !f.is_subscription()) {
        let Some(updated) = update_routing_file(file, &tags) else {
            continue;
        };
        if serde_json::from_str::<Value>(&strip_jsonc(&updated)).is_err() {
            log(
                "ERROR",
                format!(
                    "Автовыбор сервера: не удалось изменить {}, файл оставлен как есть",
                    file.path.display()
                ),
            );
            continue;
        }
        write_atomic(&file.path, &updated).await?;
        log(
            "INFO",
            format!(
                "Маршрутизация: балансировщики подписок обновлены ({})",
                file.path.display()
            ),
        );
        changed = true;
    }

    let subjects: Vec<String> = balanced.iter().flat_map(|s| pool(s)).collect();
    changed |= sync_observatory(&files, &subjects).await?;
    Ok(changed)
}

/// Сервер, выбранный балансировщиком подписки сейчас (по API Xray). `None` — Xray не запущен,
/// API выключен или балансировщик ещё ничего не выбрал.
async fn current_server(tag: &str) -> Option<String> {
    let output = tokio::time::timeout(
        API_TIMEOUT,
        tokio::process::Command::new("xray")
            .args(["api", "bi", "-json", "--server", API_LISTEN, tag])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_current(&String::from_utf8_lossy(&output.stdout))
}

/// Ответ `xray api bi -json`: ручной выбор (`override`) важнее выбора стратегии.
fn parse_current(json_text: &str) -> Option<String> {
    let json: Value = serde_json::from_str(json_text).ok()?;
    let first = |pointer: &str| Some(json.pointer(pointer)?.get(0)?.as_str()?.to_string());
    first("/balancer/override/target")
        .or_else(|| first("/balancer/override/tag"))
        .or_else(|| first("/balancer/principleTarget/tag"))
        .filter(|t| !t.is_empty())
}

/// Текущий сервер подписок в режиме «Авто»: `{ current: { <тег подписки>: <тег сервера> } }`.
pub async fn get_current() -> impl IntoResponse {
    let store = load_store().await;
    let mut current = serde_json::Map::new();
    if !crate::controller::get_pid("xray").is_empty() {
        for sub in store.subscriptions.iter().filter(|s| is_balanced(s)) {
            if let Some(server) = current_server(&sub.tag).await {
                current.insert(sub.tag.clone(), json!(server));
            }
        }
    }
    Json(json!({ "success": true, "current": current }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf(text: &str) -> ConfFile {
        ConfFile {
            path: "05_routing.json".into(),
            text: text.to_string(),
            json: serde_json::from_str(&strip_jsonc(text)).ok(),
        }
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(&strip_jsonc(text)).unwrap()
    }

    const ROUTING: &str = r#"{
  "routing": {
    "rules": [
      // через VPN
      { "port": "53", "outboundTag": "vpn" },
      { "network": "tcp,udp", "outboundTag" : "direct" }
    ]
  }
}"#;

    #[test]
    fn enables_and_disables_balancer() {
        let on = update_routing_file(&conf(ROUTING), &HashSet::from(["vpn".to_string()])).unwrap();
        assert!(on.contains("// через VPN"));
        let json = parse(&on);
        assert_eq!(json["routing"]["rules"][0]["balancerTag"], "vpn");
        assert_eq!(json["routing"]["rules"][1]["outboundTag"], "direct");
        let b = &json["routing"]["balancers"][0];
        assert_eq!(is_panel_balancer(b), Some("vpn"));
        assert_eq!(b["selector"][0], "vpn--");

        // Повторно ничего не меняется.
        assert!(update_routing_file(&conf(&on), &HashSet::from(["vpn".to_string()])).is_none());

        let off = update_routing_file(&conf(&on), &HashSet::new()).unwrap();
        let json = parse(&off);
        assert_eq!(json["routing"]["rules"][0]["outboundTag"], "vpn");
        assert_eq!(json["routing"]["balancers"], json!([]));
        assert!(off.contains("// через VPN"));
    }

    #[test]
    fn keeps_user_balancers() {
        let text = r#"{"routing": {"balancers": [{"tag": "mine", "selector": ["x"]}], "rules": [{"outboundTag": "vpn"}, {"balancerTag": "mine"}]}}"#;
        let on = update_routing_file(&conf(text), &HashSet::from(["vpn".to_string()])).unwrap();
        let json = parse(&on);
        assert_eq!(json["routing"]["balancers"].as_array().unwrap().len(), 2);
        assert_eq!(json["routing"]["rules"][0]["balancerTag"], "vpn");

        // Пользователь переформатировал файл (как GUI-редактор) — балансировщик всё равно убирается.
        let pretty = serde_json::to_string_pretty(&json).unwrap();
        let off = update_routing_file(&conf(&pretty), &HashSet::new()).unwrap();
        let json = parse(&off);
        assert_eq!(
            json["routing"]["balancers"],
            json!([{"tag": "mine", "selector": ["x"]}])
        );
        assert_eq!(json["routing"]["rules"][0]["outboundTag"], "vpn");
        assert_eq!(json["routing"]["rules"][1]["balancerTag"], "mine");
    }

    #[test]
    fn skips_files_without_subscription_rules() {
        assert!(update_routing_file(&conf(ROUTING), &HashSet::from(["other".to_string()])).is_none());
        let no_rules = conf(r#"{"outbounds": []}"#);
        assert!(update_routing_file(&no_rules, &HashSet::from(["vpn".to_string()])).is_none());
    }

    #[test]
    fn pool_skips_russian_servers() {
        let sub = Subscription {
            tag: "vpn".into(),
            cached_outbounds: vec![
                json!({ "tag": "vpn--NL", "protocol": "vless" }),
                json!({ "tag": "vpn--Россия 1 БС", "protocol": "vless" }),
                json!({ "tag": "vpn--RU", "protocol": "vless" }),
            ],
            server_names: BTreeMap::from([("RU".to_string(), "🇷🇺 Russia reverse".to_string())]),
            ..Default::default()
        };
        assert_eq!(pool(&sub), ["vpn--NL"]);
        assert!(is_balanced(&sub));
        assert!(!is_balanced(&Subscription {
            primary: "vpn--NL".into(),
            ..sub.clone()
        }));

        let only_ru = Subscription {
            cached_outbounds: sub.cached_outbounds[1..].to_vec(),
            ..sub
        };
        assert_eq!(pool(&only_ru), ["vpn--Россия 1 БС", "vpn--RU"]);
    }

    #[test]
    fn observatory_lists_subjects() {
        let json: Value = serde_json::from_str(&observatory_text(&["vpn--NL".into()], true)).unwrap();
        assert_eq!(json["observatory"]["subjectSelector"], json!(["vpn--NL"]));
        assert_eq!(json["observatory"]["probeUrl"], PROBE_URL);
        assert_eq!(json["api"]["listen"], API_LISTEN);
        let json: Value = serde_json::from_str(&observatory_text(&[], false)).unwrap();
        assert!(json.get("api").is_none());
    }

    #[test]
    fn parses_balancer_info() {
        let auto = r#"{"balancer": {"override": {}, "principleTarget": {"tag": ["vpn--NL"]}}}"#;
        assert_eq!(parse_current(auto).as_deref(), Some("vpn--NL"));
        assert_eq!(parse_current(r#"{"balancer": {"override": {}}}"#), None);
        assert_eq!(parse_current("not json"), None);
    }
}
