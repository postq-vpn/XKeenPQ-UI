//! Автоматическое направление проксируемых правил routing на подписку «Для прокси».
//!
//! Проксируемое правило — `outboundTag`, указывающий на собственный outbound пользователя не типа
//! freedom/blackhole/dns/loopback/wireguard, либо на тег, которого уже нет (например, удалённый
//! сервер). Не трогаются: правила direct, block, с `balancerTag`, на WireGuard (обычно WARP для
//! отдельных сайтов) и на существующие серверы подписок (другая подписка или конкретный сервер,
//! выбранные пользователем вручную). Файл правится точечно: заменяются только значения
//! `"outboundTag"`, поэтому комментарии и форматирование сохраняются.

use super::*;
use std::collections::HashSet;

/// Outbounds пользователя, правила на которые не переводятся на подписку.
const KEEP_PROTOCOLS: [&str; 5] = ["freedom", "blackhole", "dns", "loopback", "wireguard"];
/// Стандартные теги XKeen: правила на них не переводятся на подписку, даже если outbound не найден.
const KEEP_TAGS: [&str; 2] = ["direct", "block"];

/// Убирает `//` и `/* */` комментарии вне строк (конфиги Xray их допускают, serde_json — нет).
pub fn strip_jsonc(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let (mut in_string, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while chars.peek().is_some_and(|&n| n != '\n') {
                    chars.next();
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    if n == '\n' {
                        out.push('\n');
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

pub(super) struct ConfFile {
    pub path: PathBuf,
    pub text: String,
    pub json: Option<Value>,
}

impl ConfFile {
    /// Файл outbounds подписки, который пишет панель.
    pub fn is_subscription(&self) -> bool {
        self.path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("04_outbounds_sub."))
    }
}

/// Теги outbounds из конфигов; `Some(file)` — в каком файле объявлен.
pub(super) fn outbound_tags(files: &[ConfFile]) -> Vec<(String, &ConfFile)> {
    files
        .iter()
        .filter_map(|f| Some((f.json.as_ref()?.get("outbounds")?.as_array()?, f)))
        .flat_map(|(outbounds, f)| {
            outbounds
                .iter()
                .filter_map(move |o| Some((o.get("tag")?.as_str()?.to_string(), f)))
        })
        .collect()
}

pub(super) async fn read_conf_files() -> Vec<ConfFile> {
    read_conf_files_in(std::path::Path::new(XRAY_CONF_DIR)).await
}

async fn read_conf_files_in(dir: &std::path::Path) -> Vec<ConfFile> {
    let Ok(mut dir) = tokio::fs::read_dir(dir).await else {
        return vec![];
    };
    let mut files = vec![];
    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        if let Ok(text) = tokio::fs::read_to_string(&path).await {
            let json = serde_json::from_str(&strip_jsonc(&text)).ok();
            files.push(ConfFile { path, text, json });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// Теги из `outboundTag` проксируемых правил, которые нужно перевести на `target`.
/// `configs` — разобранные конфиги и признак «файл подписки».
fn proxy_rule_tags(configs: &[(&Value, bool)], target: &str) -> HashSet<String> {
    // tag → (протокол, объявлен в файле подписки)
    let outbounds: HashMap<&str, (&str, bool)> = configs
        .iter()
        .filter_map(|(c, is_sub)| Some((c.get("outbounds")?.as_array()?, *is_sub)))
        .flat_map(|(list, is_sub)| {
            list.iter().filter_map(move |o| {
                Some((
                    o.get("tag")?.as_str()?,
                    (o.get("protocol")?.as_str().unwrap_or(""), is_sub),
                ))
            })
        })
        .collect();
    configs
        .iter()
        .filter_map(|(c, _)| c.pointer("/routing/rules")?.as_array())
        .flatten()
        .filter_map(|rule| rule.get("outboundTag")?.as_str())
        .filter(|tag| *tag != target && !KEEP_TAGS.contains(tag))
        .filter(|tag| match outbounds.get(tag) {
            None => true,             // тега больше нет
            Some((_, true)) => false, // существующий сервер подписки — выбор пользователя
            Some((protocol, false)) => !KEEP_PROTOCOLS.contains(protocol),
        })
        .map(String::from)
        .collect()
}

/// Заменяет значения `"outboundTag": "<tag>"` для указанных тегов, не трогая остальной текст.
fn replace_rule_tags(text: &str, tags: &HashSet<String>, target: &str) -> String {
    let target = serde_json::to_string(target).unwrap();
    let mut out = text.to_string();
    for tag in tags {
        let quoted = serde_json::to_string(tag).unwrap();
        let re = Regex::new(&format!(r#"("outboundTag"\s*:\s*){}"#, regex_lite::escape(&quoted))).unwrap();
        out = re
            .replace_all(&out, |caps: &regex_lite::Captures| format!("{}{}", &caps[1], target))
            .into_owned();
    }
    out
}

/// Routing по умолчанию: правила на тег `DEFAULT_ROUTING_TAG` направляются на подписку «Для прокси».
const DEFAULT_ROUTING: &str = include_str!("default_routing.json");
const DEFAULT_ROUTING_TAG: &str = "subscription_1";
const DEFAULT_ROUTING_FILE: &str = "05_routing.json";

/// Шаблон routing по умолчанию с правилами, направленными на `target`.
pub fn default_routing(target: &str) -> String {
    replace_rule_tags(DEFAULT_ROUTING, &HashSet::from([DEFAULT_ROUTING_TAG.to_string()]), target)
}

/// Geo-файлы, на которые ссылается шаблон (`ext:<файл>:<тег>`).
fn default_routing_assets() -> Vec<String> {
    let re = Regex::new(r#""ext:([^:"]+):"#).unwrap();
    let mut files: Vec<String> = re.captures_iter(DEFAULT_ROUTING).map(|c| c[1].to_string()).collect();
    files.sort();
    files.dedup();
    files
}

/// Записывает routing по умолчанию в `05_routing.json`, если ни в одном конфиге нет правил.
/// Не трогает конфиги, если какой-то из них не разобрался: в нём могут быть правила.
pub async fn ensure_default(target: &str) -> Result<bool, String> {
    let files = read_conf_files().await;
    if files.iter().any(|f| f.json.is_none()) {
        return Ok(false);
    }
    let has_rules = files.iter().any(|f| {
        f.json
            .as_ref()
            .and_then(|j| j.pointer("/routing/rules")?.as_array())
            .is_some_and(|rules| !rules.is_empty())
    });
    if has_rules {
        return Ok(false);
    }

    // Без geo-файлов или outbound'ов direct/block Xray не запустится с этим шаблоном.
    let assets = std::path::Path::new(XRAY_ASSET_DIR);
    let missing: Vec<String> = default_routing_assets()
        .into_iter()
        .filter(|f| !assets.join(f).exists())
        .collect();
    if !missing.is_empty() {
        log(
            "WARN",
            format!("Маршрутизация по умолчанию не создана: нет файлов {} в {}", missing.join(", "), XRAY_ASSET_DIR),
        );
        return Ok(false);
    }
    let tags: HashSet<String> = outbound_tags(&files).into_iter().map(|(t, _)| t).collect();
    if let Some(tag) = KEEP_TAGS.iter().find(|t| !tags.contains(**t)) {
        log("WARN", format!("Маршрутизация по умолчанию не создана: нет outbound «{tag}»"));
        return Ok(false);
    }

    let path = std::path::Path::new(XRAY_CONF_DIR).join(DEFAULT_ROUTING_FILE);
    if path.exists() {
        let backup = path.with_extension("json.bak");
        tokio::fs::copy(&path, &backup)
            .await
            .map_err(|e| format!("ошибка записи {}: {}", backup.display(), e))?;
    }
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, default_routing(target))
        .await
        .map_err(|e| format!("ошибка записи {}: {}", tmp.display(), e))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("ошибка записи {}: {}", path.display(), e))?;
    log(
        "INFO",
        format!("Маршрутизация: создан {} по умолчанию для подписки «{}»", path.display(), target),
    );
    Ok(true)
}

/// Переименовывает тег подписки в конфигах (кроме файлов подписок): `"old"` и серверы `"old--…"`
/// в правилах и балансировщиках. Правка точечная, комментарии и форматирование сохраняются.
fn rename_in_text(text: &str, old: &str, new: &str) -> String {
    let exact = Regex::new(&format!(r#""{}(--[^"]*)?""#, regex_lite::escape(old))).unwrap();
    exact
        .replace_all(text, |caps: &regex_lite::Captures| format!("\"{new}{}\"", caps.get(1).map_or("", |m| m.as_str())))
        .into_owned()
}

pub async fn rename_tag(old: &str, new: &str) -> Result<(), String> {
    for file in read_conf_files().await.iter().filter(|f| !f.is_subscription()) {
        let updated = rename_in_text(&file.text, old, new);
        if updated == file.text {
            continue;
        }
        let tmp = file.path.with_extension("tmp");
        tokio::fs::write(&tmp, &updated)
            .await
            .map_err(|e| format!("ошибка записи {}: {}", tmp.display(), e))?;
        tokio::fs::rename(&tmp, &file.path)
            .await
            .map_err(|e| format!("ошибка записи {}: {}", file.path.display(), e))?;
        log("INFO", format!("Маршрутизация: тег «{old}» заменён на «{new}» ({})", file.path.display()));
    }
    Ok(())
}

/// Направляет проксируемые правила на `target`. Возвращает true, если routing изменился.
pub async fn sync(target: &str) -> Result<bool, String> {
    let files = read_conf_files().await;
    let configs: Vec<(&Value, bool)> = files
        .iter()
        .filter_map(|f| Some((f.json.as_ref()?, f.is_subscription())))
        .collect();
    let tags = proxy_rule_tags(&configs, target);
    if tags.is_empty() {
        return Ok(false);
    }

    let mut changed = false;
    for file in files
        .iter()
        .filter(|f| f.json.as_ref().is_some_and(|j| j.pointer("/routing/rules").is_some()))
    {
        let updated = replace_rule_tags(&file.text, &tags, target);
        if updated == file.text {
            continue;
        }
        // Без расширения .json, чтобы Xray не подхватил недописанный файл.
        let tmp = file.path.with_extension("tmp");
        tokio::fs::write(&tmp, &updated)
            .await
            .map_err(|e| format!("ошибка записи {}: {}", tmp.display(), e))?;
        tokio::fs::rename(&tmp, &file.path)
            .await
            .map_err(|e| format!("ошибка записи {}: {}", file.path.display(), e))?;
        let mut moved: Vec<&str> = tags.iter().map(String::as_str).collect();
        moved.sort();
        log(
            "INFO",
            format!(
                "Маршрутизация: правила с {} направлены на подписку «{}» ({})",
                moved.join(", "),
                target,
                file.path.display()
            ),
        );
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_in_text_renames_tag_and_servers_only() {
        let text = r#"{ // правило
  "outboundTag": "subscription_1",
  "selector": ["subscription_1--NL", "subscription_10", "x-subscription_1"],
  "domain": ["subscription_1.example"]
}"#;
        let out = rename_in_text(text, "subscription_1", "postq_vpn");
        assert!(out.contains(r#""outboundTag": "postq_vpn""#));
        assert!(out.contains(r#""postq_vpn--NL""#));
        assert!(out.contains(r#""subscription_10""#));
        assert!(out.contains(r#""x-subscription_1""#));
        assert!(out.contains(r#""subscription_1.example""#));
        assert!(out.contains("// правило"));
    }

    #[test]
    fn default_routing_targets_subscription() {
        let text = default_routing("moi_vpn");
        assert!(!text.contains("subscription_1"));
        let json: Value = serde_json::from_str(&text).unwrap();
        let tags: Vec<&str> = json["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["outboundTag"].as_str().unwrap())
            .collect();
        assert_eq!(tags, ["block", "direct", "direct", "moi_vpn", "moi_vpn", "direct"]);
        assert_eq!(default_routing_assets(), ["geosite_v2fly.dat", "zkeen.dat", "zkeenip.dat"]);
    }

    #[test]
    fn strips_comments_outside_strings() {
        let src = "{\n  // line\n  \"a\": \"http://x/*y*/\", /* block\n  */ \"b\": 1\n}";
        let parsed: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(parsed, json!({ "a": "http://x/*y*/", "b": 1 }));
        assert_eq!(strip_jsonc(r#"{"a":"\"//"}"#), r#"{"a":"\"//"}"#);
    }

    #[test]
    fn picks_proxy_rules_only() {
        let user = json!({ "outbounds": [
            { "tag": "direct", "protocol": "freedom" },
            { "tag": "block", "protocol": "blackhole" },
            { "tag": "dns-out", "protocol": "dns" },
            { "tag": "vless-reality", "protocol": "vless" },
            { "tag": "warp", "protocol": "wireguard" },
        ] });
        let neon = json!({ "outbounds": [
            { "tag": "neonvpn", "protocol": "vless" },
            { "tag": "neonvpn--NL", "protocol": "vless" },
        ] });
        let work = json!({ "outbounds": [{ "tag": "work", "protocol": "trojan" }] });
        let routing = json!({ "routing": { "rules": [
            { "outboundTag": "block" },
            { "outboundTag": "direct" },
            { "outboundTag": "dns-out" },
            { "outboundTag": "vless-reality" },
            { "outboundTag": "warp" },
            { "outboundTag": "neonvpn" },
            { "outboundTag": "neonvpn--NL" },
            { "outboundTag": "work" },
            { "outboundTag": "oldsub--Removed" },
            { "balancerTag": "proxy" },
        ] } });
        let configs = [(&user, false), (&neon, true), (&work, true), (&routing, false)];
        let mut tags: Vec<_> = proxy_rule_tags(&configs, "neonvpn").into_iter().collect();
        tags.sort();
        assert_eq!(tags, ["oldsub--Removed", "vless-reality"]);
    }

    #[test]
    fn replaces_values_keeping_comments() {
        let text = r#"{
  "routing": {
    "rules": [
      // ютуб через прокси
      { "domain": ["geosite:youtube"], "outboundTag" : "vless-reality" },
      { "domain": ["geosite:ru"], "outboundTag": "direct" }, /* "outboundTag": "direct" */
      { "ip": ["1.1.1.1"], "outboundTag":"vless-reality" }
    ]
  }
}"#;
        let tags = HashSet::from(["vless-reality".to_string()]);
        let out = replace_rule_tags(text, &tags, "neonvpn");
        assert!(out.contains("// ютуб через прокси"));
        assert!(out.contains(r#""outboundTag" : "neonvpn""#));
        assert!(out.contains(r#""outboundTag":"neonvpn""#));
        assert!(out.contains(r#""outboundTag": "direct" }, /* "outboundTag": "direct" */"#));
        assert!(!out.contains("vless-reality"));
    }

    #[tokio::test]
    async fn reads_real_files() {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("04_outbounds.json"),
            "{\n  // свои\n  \"outbounds\": [{ \"tag\": \"direct\", \"protocol\": \"freedom\" }]\n}",
        )
        .unwrap();
        std::fs::write(
            dir.join("04_outbounds_sub.neon.json"),
            r#"{"outbounds":[{"tag":"neon","protocol":"vless"}]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "{}").unwrap();

        let files = read_conf_files_in(&dir).await;
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(files.len(), 2);
        let tags: Vec<_> = outbound_tags(&files)
            .into_iter()
            .map(|(tag, f)| (tag, f.is_subscription()))
            .collect();
        assert_eq!(tags, [("direct".to_string(), false), ("neon".to_string(), true)]);
    }

    #[test]
    fn regex_special_tags() {
        let tags = HashSet::from(["sub--a.b (1)".to_string()]);
        let out = replace_rule_tags(r#"{"outboundTag": "sub--a.b (1)", "x": "sub--aXb (1)"}"#, &tags, "t");
        assert_eq!(out, r#"{"outboundTag": "t", "x": "sub--aXb (1)"}"#);
    }
}
