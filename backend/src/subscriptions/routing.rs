//! Автоматическое направление проксируемых правил routing на подписку «Для прокси».
//!
//! Проксируемое правило — `outboundTag`, указывающий на outbound не типа freedom/blackhole/
//! dns/loopback, либо на тег, которого уже нет (например, удалённый сервер). Правила direct,
//! block и с `balancerTag` не трогаются. Файл правится точечно: заменяются только значения
//! `"outboundTag"`, поэтому комментарии и форматирование сохраняются.

use super::*;
use std::collections::HashSet;

const NON_PROXY_PROTOCOLS: [&str; 4] = ["freedom", "blackhole", "dns", "loopback"];

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

struct ConfFile {
    path: PathBuf,
    text: String,
    json: Option<Value>,
}

async fn read_conf_files() -> Vec<ConfFile> {
    let Ok(mut dir) = tokio::fs::read_dir(XRAY_CONF_DIR).await else {
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
fn proxy_rule_tags(configs: &[Value], target: &str) -> HashSet<String> {
    let protocols: HashMap<&str, &str> = configs
        .iter()
        .filter_map(|c| c.get("outbounds")?.as_array())
        .flatten()
        .filter_map(|o| Some((o.get("tag")?.as_str()?, o.get("protocol")?.as_str().unwrap_or(""))))
        .collect();
    configs
        .iter()
        .filter_map(|c| c.pointer("/routing/rules")?.as_array())
        .flatten()
        .filter_map(|rule| rule.get("outboundTag")?.as_str())
        .filter(|tag| *tag != target)
        .filter(|tag| protocols.get(tag).is_none_or(|p| !NON_PROXY_PROTOCOLS.contains(p)))
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

/// Направляет проксируемые правила на `target`. Возвращает true, если routing изменился.
pub async fn sync(target: &str) -> Result<bool, String> {
    let files = read_conf_files().await;
    let configs: Vec<Value> = files.iter().filter_map(|f| f.json.clone()).collect();
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
    fn strips_comments_outside_strings() {
        let src = "{\n  // line\n  \"a\": \"http://x/*y*/\", /* block\n  */ \"b\": 1\n}";
        let parsed: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(parsed, json!({ "a": "http://x/*y*/", "b": 1 }));
        assert_eq!(strip_jsonc(r#"{"a":"\"//"}"#), r#"{"a":"\"//"}"#);
    }

    #[test]
    fn picks_proxy_rules_only() {
        let configs = vec![
            json!({ "outbounds": [
                { "tag": "direct", "protocol": "freedom" },
                { "tag": "block", "protocol": "blackhole" },
                { "tag": "dns-out", "protocol": "dns" },
                { "tag": "vless-reality", "protocol": "vless" },
                { "tag": "neonvpn", "protocol": "vless" },
            ] }),
            json!({ "routing": { "rules": [
                { "outboundTag": "block" },
                { "outboundTag": "direct" },
                { "outboundTag": "dns-out" },
                { "outboundTag": "vless-reality" },
                { "outboundTag": "neonvpn" },
                { "outboundTag": "oldsub--Removed" },
                { "balancerTag": "proxy" },
            ] } }),
        ];
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

    #[test]
    fn regex_special_tags() {
        let tags = HashSet::from(["sub--a.b (1)".to_string()]);
        let out = replace_rule_tags(r#"{"outboundTag": "sub--a.b (1)", "x": "sub--aXb (1)"}"#, &tags, "t");
        assert_eq!(out, r#"{"outboundTag": "t", "x": "sub--aXb (1)"}"#);
    }
}
