//! Консоль роутера (`ndmc`) — запасной путь, когда RCI не пускает панель.
//!
//! KeeneticOS 5.x пускает к локальному RCI (`127.0.0.1:79`) только с токеном доступа, а выпустить
//! его из консоли можно не на всех прошивках. Консоль же доступна root без токена: панель работает
//! от root, поэтому через неё читает то же самое и выполняет те же команды.
//!
//! Консоль отвечает текстом, а не JSON. Здесь он разбирается в ту же форму, что отдаёт RCI:
//! `show …` — в дерево (вложенность задаётся колонкой двоеточия, повторяющиеся ключи — список,
//! заголовки `policy, name = Policy0` — ключи объекта), а конфигурация (`ip/hotspot`,
//! `ipv6/subnet`) — из `show running-config`.
//!
//! Каждый вызов `ndmc` оставляет две строки в журнале роутера, поэтому часто опрашиваемое
//! (загрузка процессора и памяти) берётся не отсюда, а из `/proc`.

use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const NDMC: &str = "/bin/ndmc";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Основной сегмент, как в `policy` и `ipv6`.
const HOME_SEGMENT: &str = "Bridge0";
/// Имена интерфейсов меняются редко, а `show interface` — тысяча строк.
const ALIASES_TTL: Duration = Duration::from_secs(600);

/// Escape-последовательности, которыми `ndmc` чистит строку терминала (`ESC [ K`).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// Текст ошибки консоли: `Command::Base error[7405600]: no such command: polcy.`
fn console_error(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (_, rest) = line.split_once("error[")?;
        let (_, message) = rest.split_once("]: ")?;
        Some(message.trim().to_string())
    })
}

/// Выполняет команду консоли и возвращает её вывод. Команда передаётся одним аргументом, без
/// оболочки; что в ней можно передать, проверяют вызывающие (MAC, имена политик).
pub async fn run(command: &str) -> Result<String, String> {
    let child = tokio::process::Command::new(NDMC)
        .args(["-c", command])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(TIMEOUT, child).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("консоль роутера недоступна: {e}")),
        Err(_) => return Err("консоль роутера не ответила".into()),
    };
    let text = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let errors = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    match console_error(&text).or_else(|| console_error(&errors)) {
        Some(error) => Err(error),
        None => Ok(text),
    }
}

/// Синхронный вариант для `xkeen-ui -v`, где асинхронного рантайма ещё нет.
pub fn run_blocking(command: &str) -> Option<String> {
    let output = std::process::Command::new(NDMC)
        .args(["-c", command])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    console_error(&text).is_none().then_some(text)
}

// --- Разбор вывода `show …` ---

struct Entry {
    /// Колонка двоеточия после первого слова ключа: у соседей она одна (ключи выровнены вправо),
    /// у вложенных — больше.
    col: usize,
    key: String,
    /// Поля из заголовка `policy, name = Policy0, description = xkeen`.
    attrs: Vec<(String, String)>,
    value: String,
}

/// Заголовок записи: `policy, name = Policy0, description = xkeen` или `Interface, name = "Bridge0"`.
fn parse_header(text: &str) -> Option<(String, Vec<(String, String)>)> {
    let mut parts = text.split(", ");
    let key = parts.next()?.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    let mut attrs = Vec::new();
    for part in parts {
        let (name, value) = part.split_once(" = ")?;
        attrs.push((name.trim().to_string(), value.trim().trim_matches('"').to_string()));
    }
    (!attrs.is_empty()).then(|| (key.to_string(), attrs))
}

/// Строка `ключ: значение`. Двоеточие должно стоять в конце или перед пробелом: в значениях
/// (MAC, время) двоеточия без пробела, и такие строки — продолжение переносов.
fn parse_line(line: &str) -> Option<Entry> {
    let indent = line.len() - line.trim_start().len();
    let text = line.trim();
    let (key_text, value, keyed) = match text.find(':') {
        Some(pos) if pos + 1 == text.len() || text[pos + 1..].starts_with(' ') => {
            (&text[..pos], text[pos + 1..].trim().to_string(), true)
        }
        // Заголовок без двоеточия (`Interface, name = "GigabitEthernet0"`) или перенос значения
        _ => (text.trim_end_matches(':'), String::new(), false),
    };
    let (key, attrs) = match parse_header(key_text) {
        Some(header) => header,
        None if keyed && !key_text.is_empty() && !key_text.contains(char::is_whitespace) => {
            (key_text.to_string(), Vec::new())
        }
        None => return None,
    };
    Some(Entry { col: indent + key.len(), key, attrs, value })
}

fn entries(text: &str) -> Vec<Entry> {
    let mut list: Vec<Entry> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match parse_line(line) {
            Some(entry) => list.push(entry),
            // Перенос длинного значения на следующую строку
            None => {
                if let Some(last) = list.last_mut() {
                    let more = line.trim();
                    if !(last.value.ends_with(',') || last.value.ends_with('-') || last.value.is_empty()) {
                        last.value.push(' ');
                    }
                    last.value.push_str(more);
                }
            }
        }
    }
    list
}

/// `yes`/`no` — логические, как в RCI. Числа остаются строками: метки политик бывают из одних
/// цифр, а читатели чисел принимают и строку.
fn scalar(value: &str) -> Value {
    match value {
        "yes" => Value::Bool(true),
        "no" => Value::Bool(false),
        _ => Value::String(value.to_string()),
    }
}

/// Повторный ключ превращает значение в список.
fn insert(map: &mut Map<String, Value>, key: String, value: Value) {
    match map.get_mut(&key) {
        Some(Value::Array(list)) => list.push(value),
        Some(existing) => {
            let first = existing.take();
            *existing = Value::Array(vec![first, value]);
        }
        None => {
            map.insert(key, value);
        }
    }
}

fn build(list: &[Entry], pos: &mut usize, parent_col: Option<usize>) -> Map<String, Value> {
    let mut map = Map::new();
    while *pos < list.len() && parent_col.is_none_or(|col| list[*pos].col > col) {
        let entry = &list[*pos];
        *pos += 1;
        let has_children = *pos < list.len() && list[*pos].col > entry.col;
        let value = if has_children && entry.value.is_empty() {
            let mut child = build(list, pos, Some(entry.col));
            for (name, value) in &entry.attrs {
                if name != "name" {
                    child.entry(name.clone()).or_insert_with(|| Value::String(value.clone()));
                }
            }
            Value::Object(child)
        } else if !entry.attrs.is_empty() {
            let mut child = Map::new();
            for (name, value) in &entry.attrs {
                if name != "name" {
                    child.insert(name.clone(), Value::String(value.clone()));
                }
            }
            Value::Object(child)
        } else {
            scalar(&entry.value)
        };
        // Запись с именем — ключ объекта, как в RCI: `show ip policy` → `{"Policy0": {…}}`. У
        // интерфейсов в заголовке их имя (`Home`), а RCI ключует их по id (`Bridge0`)
        let named = entry.attrs.iter().find(|(name, _)| name == "name").map(|(_, value)| value.clone());
        let key = match (&named, value.get("id").and_then(Value::as_str)) {
            (Some(_), Some(id)) => id.to_string(),
            (Some(name), None) => name.clone(),
            (None, _) => entry.key.clone(),
        };
        insert(&mut map, key, value);
    }
    map
}

/// Вывод `show …` в форме ответа RCI.
pub fn parse_show(text: &str) -> Value {
    let list = entries(&strip_ansi(text));
    let mut pos = 0;
    let mut map = Map::new();
    // Строки с колонкой меньше первой (редкость) начинают новый уровень, а не теряются
    while pos < list.len() {
        for (key, value) in build(&list, &mut pos, None) {
            insert(&mut map, key, value);
        }
    }
    Value::Object(map)
}

// --- Конфигурация из `show running-config` ---

/// Блоки конфигурации: строка без отступа и вложенные строки под ней.
fn config_blocks(text: &str) -> Vec<(&str, Vec<&str>)> {
    let mut blocks: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed == "!" {
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some((_, body)) = blocks.last_mut() {
                body.push(trimmed);
            }
        } else {
            blocks.push((trimmed, Vec::new()));
        }
    }
    blocks
}

/// В конфигурации сегменты записаны своими именами (`Home`), а панель знает их по id (`Bridge0`).
fn resolve<'a>(aliases: &'a HashMap<String, String>, name: &'a str) -> &'a str {
    aliases.get(name).map_or(name, String::as_str)
}

/// `ip/hotspot`: политики сегментов и устройств из блока `ip hotspot`. Строки
/// `policy Home permit` — доступ, а не политика: политика — любое другое слово.
fn parse_hotspot(config: &str, aliases: &HashMap<String, String>) -> Value {
    let mut policies = Vec::new();
    let mut hosts = Vec::new();
    for (head, body) in config_blocks(config) {
        if head != "ip hotspot" {
            continue;
        }
        for line in body {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["policy", interface, policy] if !matches!(*policy, "permit" | "deny") => {
                    policies.push(json!({ "interface": resolve(aliases, interface), "policy": policy }));
                }
                ["host", mac, "policy", policy] => hosts.push(json!({ "mac": mac, "policy": policy })),
                _ => {}
            }
        }
    }
    json!({ "policy": policies, "host": hosts })
}

/// Число из конфигурации — числом, как в RCI (`prefix length 64`).
fn config_value(text: &str) -> Value {
    text.parse::<u64>().map_or_else(|_| Value::String(text.to_string()), Value::from)
}

/// `ipv6/subnet`: блоки `ipv6 subnet <имя>`. `bind` — главное для панели; остальное — в форме RCI,
/// чтобы IPv6 можно было вернуть как было: `mode slaac` → `{"mode": {"slaac": true}}`,
/// `prefix length 64` → `{"prefix": {"length": 64}}`, `number 0` → `{"number": "0"}`.
fn parse_subnets(config: &str, aliases: &HashMap<String, String>) -> Value {
    let mut subnets = Map::new();
    for (head, body) in config_blocks(config) {
        let Some(name) = head.strip_prefix("ipv6 subnet ") else {
            continue;
        };
        let mut subnet = Map::new();
        for line in body {
            let words: Vec<&str> = line.split_whitespace().collect();
            match words.as_slice() {
                ["bind", interface] => {
                    subnet.insert("bind".into(), json!(resolve(aliases, interface)));
                }
                [key, value] if value.chars().all(|c| c.is_ascii_digit()) => {
                    subnet.insert((*key).into(), json!(value));
                }
                [key, value] => {
                    let entry = subnet.entry(*key).or_insert_with(|| json!({}));
                    if let Value::Object(map) = entry {
                        map.insert((*value).into(), json!(true));
                    }
                }
                [key, sub, value] => {
                    let entry = subnet.entry(*key).or_insert_with(|| json!({}));
                    if let Value::Object(map) = entry {
                        map.insert((*sub).into(), config_value(value));
                    }
                }
                _ => {}
            }
        }
        subnets.insert(name.trim().to_string(), Value::Object(subnet));
    }
    Value::Object(subnets)
}

/// Имена интерфейсов → id из `show interface` (`Home` → `Bridge0`).
fn parse_aliases(interfaces: &Value) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    if let Some(all) = interfaces.as_object() {
        for (id, interface) in all {
            if let Some(name) = interface.get("interface-name").and_then(Value::as_str)
                && name != id
            {
                aliases.insert(name.to_string(), id.clone());
            }
        }
    }
    aliases
}

static ALIASES: Mutex<Option<(Instant, HashMap<String, String>)>> = Mutex::new(None);

async fn aliases() -> HashMap<String, String> {
    if let Some((at, map)) = ALIASES.lock().unwrap().as_ref()
        && at.elapsed() < ALIASES_TTL
    {
        return map.clone();
    }
    // Достаточно основного сегмента; полный список — если он доступен
    let map = match run("show interface").await {
        Ok(text) => parse_aliases(&parse_show(&text)),
        Err(_) => HashMap::new(),
    };
    let mut map = map;
    if !map.values().any(|id| id == HOME_SEGMENT)
        && let Ok(text) = run(&format!("show interface {HOME_SEGMENT}")).await
        && let Some(name) = parse_show(&text).get("interface-name").and_then(Value::as_str)
    {
        map.insert(name.to_string(), HOME_SEGMENT.to_string());
    }
    *ALIASES.lock().unwrap() = Some((Instant::now(), map.clone()));
    map
}

/// Чтение RCI-пути через консоль: `show/ip/policy` → `show ip policy`, конфигурация — из
/// `show running-config`.
pub async fn get(path: &str) -> Result<Value, String> {
    let path = path.trim_matches('/');
    if path.starts_with("show/") {
        return Ok(parse_show(&run(&path.replace('/', " ")).await?));
    }
    let parse: fn(&str, &HashMap<String, String>) -> Value = match path {
        "ip/hotspot" => parse_hotspot,
        "ipv6/subnet" => parse_subnets,
        _ => return Err(format!("чтение «{path}» через консоль не поддерживается")),
    };
    let config = run("show running-config").await?;
    Ok(parse(&config, &aliases().await))
}

/// Значение как список: одна запись приходит объектом, несколько — списком (и в RCI, и здесь).
pub fn as_list(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(Value::Null) | None => vec![],
        Some(single) => vec![single],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYSTEM: &str = "\u{1b}[K\n         hostname: Netcraze-8408\n          cpuload: 0\n           memory: 378188/1048576\n         memtotal: 1048576\n\n\u{1b}[K";

    const VERSION: &str = "\u{1b}[K
          release: 5.01.C.9.0-3
            title: 5.1.9

              ndm:
                exact: 0-4e67534
                cdate: 13 Nov 2026

              ndw:
             features: dual_image,usb_3_conf,
                       wifi_button,wifi5ghz
           components: base,opkg-
                       kmod-netfilter
            model: Ultra (NC-1812)
      description: Netcraze Ultra (NC-1812)
";

    const POLICY: &str = "\u{1b}[K
           policy, name = Policy0, description = xkeen:
                 mark: ffffaaa
               table4: 4096

               route4:
                    route:
                  destination: 0.0.0.0/0
                    interface: PPPoE0
                     floating: no

                    route:
                  destination: 172.16.1.0/24
                    interface: iot
";

    const HOTSPOT: &str = "\u{1b}[K
             host:
                  mac: 90:09:d0:6a:4e:b0
                   ip: 192.168.1.138
             hostname: nas
                 name: 98:fd:b4:9e:43:85 - Home network - 2026-11-06
                       12:36

            interface:
                       id: Bridge0
                     name: Home

           registered: yes
               policy:
               active: yes

             host:
                  mac: 98:fd:b4:9e:43:85
            interface:
                       id: Bridge0
               policy: Policy0
               active: no
";

    #[test]
    fn strips_terminal_codes() {
        assert_eq!(strip_ansi("\u{1b}[Kabc\u{1b}[0;1mdef"), "abcdef");
    }

    #[test]
    fn reads_console_errors() {
        let out = "\u{1b}[KCommand::Base error[7405600]: no such command: authentication.\n";
        assert_eq!(console_error(&strip_ansi(out)).unwrap(), "no such command: authentication.");
        assert!(console_error("Network::Interface: created.\n").is_none());
    }

    #[test]
    fn parses_flat_show() {
        let v = parse_show(SYSTEM);
        assert_eq!(v["cpuload"], "0");
        assert_eq!(v["memory"], "378188/1048576");
        assert_eq!(v["memtotal"], "1048576");
    }

    #[test]
    fn parses_nested_and_wrapped_values() {
        let v = parse_show(VERSION);
        assert_eq!(v["title"], "5.1.9");
        assert_eq!(v["ndm"]["exact"], "0-4e67534");
        assert_eq!(v["ndw"]["features"], "dual_image,usb_3_conf,wifi_button,wifi5ghz");
        assert_eq!(v["ndw"]["components"], "base,opkg-kmod-netfilter");
        assert_eq!(v["model"], "Ultra (NC-1812)");
        assert_eq!(v["description"], "Netcraze Ultra (NC-1812)");
    }

    #[test]
    fn named_records_become_object_keys() {
        let v = parse_show(POLICY);
        let policy = &v["Policy0"];
        assert_eq!(policy["description"], "xkeen");
        assert_eq!(policy["mark"], "ffffaaa");
        let routes = as_list(policy.pointer("/route4/route"));
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0]["destination"], "0.0.0.0/0");
        assert_eq!(routes[0]["floating"], false);
        assert_eq!(routes[1]["interface"], "iot");
    }

    #[test]
    fn headers_without_colon() {
        // В заголовке — имя интерфейса, ключом в RCI служит id
        let text = "Interface, name = \"ISP\"\n               id: GigabitEthernet1\n   interface-name: ISP\n        defaultgw: no\nInterface, name = \"Home\"\n               id: Bridge0\n   interface-name: Home\n        defaultgw: yes\n";
        let v = parse_show(text);
        assert_eq!(v["Bridge0"]["interface-name"], "Home");
        assert_eq!(v["Bridge0"]["defaultgw"], true);
        assert_eq!(v["GigabitEthernet1"]["defaultgw"], false);
        let aliases = parse_aliases(&v);
        assert_eq!(aliases["Home"], "Bridge0");
        assert_eq!(aliases["ISP"], "GigabitEthernet1");
    }

    #[test]
    fn repeated_records_become_list() {
        let v = parse_show(HOTSPOT);
        let hosts = as_list(v.get("host"));
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0]["mac"], "90:09:d0:6a:4e:b0");
        assert_eq!(hosts[0]["name"], "98:fd:b4:9e:43:85 - Home network - 2026-11-06 12:36");
        assert_eq!(hosts[0]["interface"]["id"], "Bridge0");
        assert_eq!(hosts[0]["active"], true);
        assert_eq!(hosts[0]["policy"], "");
        assert_eq!(hosts[1]["policy"], "Policy0");
        assert_eq!(hosts[1]["active"], false);
    }

    const CONFIG: &str = "interface Bridge0\n    name Home\n!\nip policy Policy0\n    description xkeen\n!\nip hotspot\n    policy Home permit\n    policy Home Policy0\n    host 50:ff:20:ba:66:30 permit\n    host e6:be:eb:65:43:bc policy Policy0\n    host 70:f7:54:ac:31:57 conform\n!\nipv6 subnet Default\n    bind Home\n    number 0\n    mode slaac\n    prefix length 64\n!\n";

    fn home() -> HashMap<String, String> {
        HashMap::from([("Home".to_string(), "Bridge0".to_string())])
    }

    #[test]
    fn hotspot_config() {
        let v = parse_hotspot(CONFIG, &home());
        assert_eq!(v["policy"], json!([{ "interface": "Bridge0", "policy": "Policy0" }]));
        assert_eq!(v["host"], json!([{ "mac": "e6:be:eb:65:43:bc", "policy": "Policy0" }]));
        let none = parse_hotspot("ip hotspot\n    policy Home permit\n!\n", &home());
        assert_eq!(none["policy"], json!([]));
    }

    #[test]
    fn subnet_config() {
        let v = parse_subnets(CONFIG, &home());
        assert_eq!(
            v["Default"],
            json!({ "bind": "Bridge0", "number": "0", "mode": { "slaac": true }, "prefix": { "length": 64 } })
        );
        assert_eq!(parse_subnets("ip hotspot\n!\n", &home()), json!({}));
    }
}
