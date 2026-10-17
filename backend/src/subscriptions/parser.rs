//! Разбор ответа подписки и ссылок `protocol://` в outbounds Xray.
//!
//! Формат outbound повторяет `frontend/src/lib/outboundParser.js`, чтобы серверы из подписки
//! выглядели так же, как добавленные вручную через «Добавить подключение».

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use reqwest::Url;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

const PROXY_PROTOCOLS: [&str; 5] = ["vless", "vmess", "trojan", "shadowsocks", "hysteria"];
const LINK_PREFIXES: [&str; 6] = ["vless://", "vmess://", "trojan://", "ss://", "hysteria2://", "hy2://"];

/// Сервер из подписки: исходное имя (для фильтров и тега) и готовый outbound без тега.
pub struct ParsedProxy {
    pub name: String,
    pub outbound: Value,
}

pub struct ParseResult {
    pub proxies: Vec<ParsedProxy>,
    pub errors: Vec<String>,
}

/// Разбирает тело ответа подписки: список ссылок (в т.ч. в base64) или JSON-конфиг(и) Xray.
pub fn parse_subscription(body: &str) -> ParseResult {
    let body = body.trim().trim_start_matches('\u{feff}');

    if (body.starts_with('[') || body.starts_with('{'))
        && let Ok(json) = serde_json::from_str::<Value>(body) {
            return ParseResult {
                proxies: parse_xray_json(&json),
                errors: vec![],
            };
        }

    let decoded = decode_base64(&body.split_whitespace().collect::<String>())
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|s| LINK_PREFIXES.iter().any(|p| s.contains(p)));
    let text = decoded.as_deref().unwrap_or(body);

    let mut result = ParseResult {
        proxies: vec![],
        errors: vec![],
    };
    for line in text.lines().map(str::trim) {
        if !LINK_PREFIXES.iter().any(|p| line.starts_with(p)) {
            continue;
        }
        match parse_link(line) {
            Ok(proxy) => result.proxies.push(proxy),
            Err(e) => result.errors.push(format!("{}: {}", short_link(line), e)),
        }
    }
    result
}

fn short_link(link: &str) -> String {
    let scheme = link.split("://").next().unwrap_or("");
    let name = link
        .rsplit_once('#')
        .map(|(_, n)| percent_decode(n))
        .unwrap_or_default();
    if name.is_empty() {
        format!("{scheme}://…")
    } else {
        format!("{scheme}://… ({name})")
    }
}

/// JSON-подписки (Happ, v2rayN и т.п.) отдают массив полных конфигов Xray.
/// Из каждого берём прокси-outbounds, имя — `remarks` конфига.
fn parse_xray_json(json: &Value) -> Vec<ParsedProxy> {
    let configs: Vec<&Value> = match json {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };

    let mut proxies = vec![];
    for config in configs {
        let remarks = config.get("remarks").and_then(Value::as_str).unwrap_or("").trim();
        let Some(outbounds) = config.get("outbounds").and_then(Value::as_array) else {
            continue;
        };
        let candidates: Vec<&Value> = outbounds
            .iter()
            .filter(|o| {
                o.get("protocol")
                    .and_then(Value::as_str)
                    .is_some_and(|p| PROXY_PROTOCOLS.contains(&p))
            })
            .collect();
        let single = candidates.len() == 1;
        for outbound in candidates {
            let tag = outbound.get("tag").and_then(Value::as_str).unwrap_or("");
            let name = match (remarks.is_empty(), single) {
                (false, true) => remarks.to_string(),
                (false, false) => format!("{remarks} {tag}").trim().to_string(),
                (true, _) => tag.to_string(),
            };
            let mut outbound = outbound.clone();
            if let Some(obj) = outbound.as_object_mut() {
                obj.remove("tag");
                // dialerProxy/mux ссылаются на теги исходного конфига, которых у нас нет.
                if let Some(sockopt) = obj.get_mut("streamSettings").and_then(|s| s.get_mut("sockopt"))
                    && let Some(sockopt) = sockopt.as_object_mut() {
                        sockopt.remove("dialerProxy");
                    }
            }
            proxies.push(ParsedProxy { name, outbound });
        }
    }
    proxies
}

pub fn parse_link(link: &str) -> Result<ParsedProxy, String> {
    let scheme = link.split("://").next().unwrap_or("");
    match scheme {
        "vless" | "trojan" => parse_standard(link, scheme),
        "vmess" => parse_vmess(link),
        "ss" => parse_shadowsocks(link),
        "hysteria2" | "hy2" => parse_hysteria2(link),
        _ => Err(format!("неподдерживаемая схема: {scheme}")),
    }
}

type Params = HashMap<String, String>;

fn query_params(url: &Url) -> Params {
    url.query_pairs()
        .map(|(k, v)| (k.to_lowercase(), v.into_owned()))
        .collect()
}

fn param<'a>(params: &'a Params, key: &str) -> Option<&'a str> {
    params.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn parse_url(link: &str) -> Result<(Url, String, u16, Params, String), String> {
    let url = Url::parse(link).map_err(|e| format!("ошибка парсинга URL: {e}"))?;
    let host = url
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string())
        .filter(|h| !h.is_empty())
        .ok_or("не указан адрес сервера")?;
    let port = url.port().unwrap_or(443);
    let params = query_params(&url);
    let name = url.fragment().map(percent_decode).unwrap_or_default();
    Ok((url, host, port, params, name))
}

fn parse_standard(link: &str, scheme: &str) -> Result<ParsedProxy, String> {
    let (url, address, port, mut params, name) = parse_url(link)?;
    let user = percent_decode(url.username());
    if user.is_empty() {
        return Err(if scheme == "vless" {
            "не указан UUID"
        } else {
            "не указан пароль"
        }
        .into());
    }

    let mut settings = Map::new();
    settings.insert("address".into(), json!(address));
    settings.insert("port".into(), json!(port));
    let protocol = if scheme == "vless" {
        settings.insert("id".into(), json!(user));
        settings.insert(
            "encryption".into(),
            json!(param(&params, "encryption").unwrap_or("none")),
        );
        if let Some(flow) = param(&params, "flow") {
            settings.insert("flow".into(), json!(flow));
        }
        "vless"
    } else {
        settings.insert("password".into(), json!(user));
        "trojan"
    };

    // Trojan без TLS не бывает, а провайдеры часто не пишут security в ссылке.
    if protocol == "trojan" && param(&params, "security").is_none() {
        params.insert("security".into(), "tls".into());
    }
    let network = param(&params, "type").unwrap_or("tcp");
    Ok(ParsedProxy {
        name,
        outbound: json!({
            "protocol": protocol,
            "settings": settings,
            "streamSettings": stream_settings(network, &params),
        }),
    })
}

fn parse_vmess(link: &str) -> Result<ParsedProxy, String> {
    let payload = link.trim_start_matches("vmess://");
    let payload = payload.split('#').next().unwrap_or("").trim();
    let decoded = decode_base64(payload).ok_or("не удалось декодировать base64")?;
    let data: Value = serde_json::from_slice(&decoded).map_err(|e| format!("ошибка парсинга JSON: {e}"))?;

    // В vmess-ссылках числа бывают и строками, и числами.
    let field = |key: &str| -> String {
        match data.get(key) {
            Some(Value::String(s)) => s.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        }
    };

    let address = field("add");
    if address.is_empty() {
        return Err("не указан адрес сервера".into());
    }
    let id = field("id");
    if id.is_empty() {
        return Err("не указан UUID".into());
    }

    let mut params: Params = [
        "path",
        "host",
        "sni",
        "fp",
        "alpn",
        "mode",
        "servicename",
        "authority",
        "headertype",
    ]
    .into_iter()
    .filter_map(|k| {
        let v = field(if k == "headertype" { "type" } else { k });
        (!v.is_empty()).then(|| (k.to_string(), v))
    })
    .collect();
    // `type` в vmess — тип обфускации заголовка; "none" ничего не меняет.
    if params.get("headertype").is_some_and(|t| t == "none") {
        params.remove("headertype");
    }
    if field("tls") == "tls" {
        params.insert("security".into(), "tls".into());
        if !params.contains_key("sni")
            && let Some(host) = params.get("host").cloned() {
                params.insert("sni".into(), host);
            }
    }

    let network = Some(field("net"))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "tcp".into());
    let security = Some(field("scy"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".into());
    Ok(ParsedProxy {
        name: field("ps"),
        outbound: json!({
            "protocol": "vmess",
            "settings": {
                "address": address,
                "port": field("port").parse::<u16>().unwrap_or(443),
                "id": id,
                "alterId": field("aid").parse::<u32>().unwrap_or(0),
                "security": security,
            },
            "streamSettings": stream_settings(&network, &params),
        }),
    })
}

fn parse_shadowsocks(link: &str) -> Result<ParsedProxy, String> {
    let rest = link.trim_start_matches("ss://");
    let (rest, name) = match rest.split_once('#') {
        Some((head, name)) => (head, percent_decode(name)),
        None => (rest, String::new()),
    };
    // Отрезаем только query и завершающий «/» (SIP002: host:port/?plugin=…): сам «/» входит
    // в алфавит base64, и резать по нему нельзя.
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let rest = rest.trim_end_matches('/');
    if query
        .split('&')
        .any(|kv| kv.starts_with("plugin=") && kv.len() > "plugin=".len())
    {
        return Err("плагины Shadowsocks (obfs, v2ray-plugin) не поддерживаются Xray".into());
    }

    let (method, password, server) = match rest.rsplit_once('@') {
        // SIP002: base64(method:password)@host:port или method:password в percent-encoding (2022-blake3)
        Some((userinfo, server)) => {
            let plain = percent_decode(userinfo);
            let creds = if plain.contains(':') {
                plain
            } else {
                decode_base64(userinfo)
                    .and_then(|b| String::from_utf8(b).ok())
                    .ok_or("не удалось декодировать учётные данные")?
            };
            let (m, p) = creds.split_once(':').ok_or("неверный формат учётных данных")?;
            (m.to_string(), p.to_string(), server.to_string())
        }
        // Legacy: base64(method:password@host:port)
        None => {
            let decoded = decode_base64(rest)
                .and_then(|b| String::from_utf8(b).ok())
                .ok_or("не удалось декодировать base64")?;
            let (creds, server) = decoded.rsplit_once('@').ok_or("неверный формат ссылки")?;
            let (m, p) = creds.split_once(':').ok_or("неверный формат учётных данных")?;
            (m.to_string(), p.to_string(), server.to_string())
        }
    };

    let (host, port) = server.rsplit_once(':').ok_or("не указан порт")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Err("не указан адрес сервера".into());
    }
    let port: u16 = port.parse().map_err(|_| format!("неверный порт: {port}"))?;

    Ok(ParsedProxy {
        name,
        outbound: json!({
            "protocol": "shadowsocks",
            "settings": { "address": host, "port": port, "method": method, "password": password },
        }),
    })
}

fn parse_hysteria2(link: &str) -> Result<ParsedProxy, String> {
    let (url, address, port, mut params, name) = parse_url(link)?;
    let user = percent_decode(url.username());
    let auth = match url.password() {
        Some(pass) => format!("{}:{}", user, percent_decode(pass)),
        None => user,
    };

    if param(&params, "security").is_none() {
        params.insert("security".into(), "tls".into());
    }
    let mut stream = stream_settings("hysteria", &params);
    let obj = stream.as_object_mut().unwrap();
    obj.insert("hysteriaSettings".into(), json!({ "auth": auth, "version": 2 }));
    if let Some(tls) = obj.get_mut("tlsSettings").and_then(Value::as_object_mut) {
        tls.entry("alpn").or_insert_with(|| json!(["h3"]));
    }
    let mut finalmask = obj
        .remove("finalmask")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut quic = json!({ "congestion": "bbr", "bbrProfile": "standard" });
    if let Some(user_quic) = finalmask.get("quicParams").and_then(Value::as_object) {
        for (k, v) in user_quic {
            quic[k] = v.clone();
        }
    }
    finalmask.insert("quicParams".into(), quic);
    obj.insert("finalmask".into(), Value::Object(finalmask));

    Ok(ParsedProxy {
        name,
        outbound: json!({
            "protocol": "hysteria",
            "settings": { "address": address, "port": port, "version": 2 },
            "streamSettings": stream,
        }),
    })
}

/// Порт `getStreamSettings` из outboundParser.js.
fn stream_settings(network: &str, p: &Params) -> Value {
    let s = |k: &str| param(p, k).map(|v| json!(v));
    let n = |k: &str| param(p, k).and_then(|v| v.parse::<i64>().ok()).map(|v| json!(v));
    let b = |k: &str| param(p, k).filter(|v| matches!(*v, "true" | "1")).map(|_| json!(true));
    let json_param = |k: &str| {
        param(p, k).and_then(|v| {
            serde_json::from_str::<Value>(v)
                .or_else(|_| serde_json::from_str(&percent_decode(v)))
                .ok()
        })
    };

    let mut out = Map::new();
    out.insert("network".into(), json!(network));
    let security = param(p, "security");
    if let Some(sec) = security {
        out.insert("security".into(), json!(sec));
    }

    match security {
        Some("tls") => {
            let tls = compact([
                ("fingerprint", Some(json!(param(p, "fp").unwrap_or("chrome")))),
                ("serverName", s("sni")),
                (
                    "alpn",
                    param(p, "alpn").map(|v| json!(v.split(',').map(str::trim).collect::<Vec<_>>())),
                ),
                ("allowInsecure", b("allowinsecure").or_else(|| b("insecure"))),
            ]);
            out.insert("tlsSettings".into(), tls);
        }
        Some("reality") => {
            let reality = compact([
                ("fingerprint", Some(json!(param(p, "fp").unwrap_or("chrome")))),
                ("serverName", s("sni")),
                ("publicKey", s("pbk")),
                ("shortId", s("sid")),
                ("spiderX", s("spx")),
                ("mldsa65Verify", s("pqv")),
            ]);
            out.insert("realitySettings".into(), reality);
        }
        _ => {}
    }

    if let Some(fm) = json_param("fm") {
        out.insert("finalmask".into(), fm);
    }

    let header = || param(p, "headertype").map(|t| json!({ "type": t }));
    let path = || json!(param(p, "path").unwrap_or("/"));
    let transport = match network {
        "tcp" | "raw" => header().map(|h| (format!("{network}Settings"), json!({ "header": h }))),
        "xhttp" => Some((
            "xhttpSettings".into(),
            compact([
                ("host", s("host")),
                ("path", Some(path())),
                ("mode", Some(json!(param(p, "mode").unwrap_or("auto")))),
                ("extra", json_param("extra")),
            ]),
        )),
        "kcp" | "mkcp" => Some((
            "kcpSettings".into(),
            compact([
                ("mtu", n("mtu")),
                ("tti", n("tti")),
                ("uplinkCapacity", n("uplinkcapacity")),
                ("downlinkCapacity", n("downlinkcapacity")),
                ("congestion", b("congestion")),
                ("readBufferSize", n("readbuffersize")),
                ("writeBufferSize", n("writebuffersize")),
                ("header", header()),
                ("seed", s("seed")),
            ]),
        )),
        "grpc" => Some((
            "grpcSettings".into(),
            compact([
                ("serviceName", s("servicename").or_else(|| s("path"))),
                ("authority", s("authority")),
                ("multiMode", Some(json!(param(p, "mode") == Some("multi")))),
                ("user_agent", s("user_agent")),
                ("idle_timeout", n("idle_timeout")),
                ("health_check_timeout", n("health_check_timeout")),
                ("permit_without_stream", b("permit_without_stream")),
                ("initial_windows_size", n("initial_windows_size")),
            ]),
        )),
        "ws" => Some((
            "wsSettings".into(),
            compact([
                ("path", Some(path())),
                ("host", s("host")),
                ("heartbeatPeriod", n("heartbeatperiod")),
            ]),
        )),
        "httpupgrade" => Some((
            "httpupgradeSettings".into(),
            compact([("path", Some(path())), ("host", s("host"))]),
        )),
        _ => None,
    };
    if let Some((key, value)) = transport {
        out.insert(key, value);
    }

    Value::Object(out)
}

fn compact<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    Value::Object(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v)))
            .collect(),
    )
}

/// base64 в любом алфавите, с паддингом или без.
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(input).ok())
}

pub fn percent_decode(input: &str) -> String {
    urlencoding::decode(input)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| input.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vless_reality() {
        let p = parse_link(
            "vless://uuid-1@example.com:8443?type=tcp&security=reality&sni=yahoo.com&fp=firefox&pbk=KEY&sid=ab&flow=xtls-rprx-vision#%F0%9F%87%B3%F0%9F%87%B1%20NL",
        )
        .unwrap();
        assert_eq!(p.name, "🇳🇱 NL");
        assert_eq!(
            p.outbound,
            json!({
                "protocol": "vless",
                "settings": { "address": "example.com", "port": 8443, "id": "uuid-1", "encryption": "none", "flow": "xtls-rprx-vision" },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": { "fingerprint": "firefox", "serverName": "yahoo.com", "publicKey": "KEY", "shortId": "ab" },
                },
            })
        );
    }

    #[test]
    fn vless_xhttp_defaults_and_ipv6() {
        let p = parse_link("vless://u@[2001:db8::1]?type=xhttp&security=tls&sni=a.com&path=%2Fx").unwrap();
        assert_eq!(p.outbound["settings"]["address"], "2001:db8::1");
        assert_eq!(p.outbound["settings"]["port"], 443);
        assert_eq!(
            p.outbound["streamSettings"]["xhttpSettings"],
            json!({ "path": "/x", "mode": "auto" })
        );
        assert_eq!(
            p.outbound["streamSettings"]["tlsSettings"],
            json!({ "fingerprint": "chrome", "serverName": "a.com" })
        );
    }

    #[test]
    fn trojan_default_tls() {
        let p = parse_link("trojan://pw@t.com:443?sni=s.com#T").unwrap();
        assert_eq!(p.outbound["streamSettings"]["security"], "tls");
        assert_eq!(p.outbound["streamSettings"]["tlsSettings"]["serverName"], "s.com");
        let none = parse_link("trojan://pw@t.com:443?security=none#T").unwrap();
        assert_eq!(none.outbound["streamSettings"]["security"], "none");
    }

    #[test]
    fn trojan_ws() {
        let p = parse_link("trojan://p%40ss@t.com:443?type=ws&security=tls&host=h.com&path=%2Fws#T").unwrap();
        assert_eq!(p.outbound["protocol"], "trojan");
        assert_eq!(p.outbound["settings"]["password"], "p@ss");
        assert_eq!(
            p.outbound["streamSettings"]["wsSettings"],
            json!({ "path": "/ws", "host": "h.com" })
        );
    }

    #[test]
    fn vmess_grpc_tls() {
        let payload = STANDARD.encode(
            r#"{"v":"2","ps":"VM","add":"v.com","port":"8443","id":"uuid","aid":0,"net":"grpc","type":"none","host":"h.com","path":"svc","tls":"tls"}"#,
        );
        let p = parse_link(&format!("vmess://{payload}")).unwrap();
        assert_eq!(p.name, "VM");
        assert_eq!(p.outbound["settings"]["port"], 8443);
        assert_eq!(p.outbound["settings"]["security"], "auto");
        let ss = &p.outbound["streamSettings"];
        assert_eq!(ss["security"], "tls");
        assert_eq!(ss["tlsSettings"]["serverName"], "h.com");
        assert_eq!(ss["grpcSettings"]["serviceName"], "svc");
        assert!(ss.get("tcpSettings").is_none());
    }

    #[test]
    fn shadowsocks_variants() {
        let sip002 = format!("ss://{}@1.2.3.4:8388#SS", URL_SAFE_NO_PAD.encode("aes-256-gcm:pa:ss"));
        let p = parse_link(&sip002).unwrap();
        assert_eq!(
            p.outbound["settings"],
            json!({ "address": "1.2.3.4", "port": 8388, "method": "aes-256-gcm", "password": "pa:ss" })
        );

        let plain = parse_link("ss://2022-blake3-aes-128-gcm:a%2Bb%3D@s.com:443/?outline=1#P").unwrap();
        assert_eq!(plain.outbound["settings"]["password"], "a+b=");
        assert!(parse_link("ss://YWVzLTI1Ni1nY206cHc@s.com:443/?plugin=obfs-local%3Bobfs%3Dhttp#O").is_err());

        // «/» внутри base64 не должен обрезать ссылку
        let creds = (0..)
            .map(|i| format!("aes-256-gcm:pw?{i}?@9.9.9.9:443"))
            .find(|c| STANDARD.encode(c).contains('/'))
            .unwrap();
        let p = parse_link(&format!("ss://{}#S", STANDARD.encode(&creds))).unwrap();
        assert_eq!(p.outbound["settings"]["address"], "9.9.9.9");

        let legacy = format!("ss://{}#L", STANDARD.encode("chacha20-ietf-poly1305:pw@[::1]:80"));
        let p = parse_link(&legacy).unwrap();
        assert_eq!(p.outbound["settings"]["address"], "::1");
        assert_eq!(p.name, "L");
    }

    #[test]
    fn hysteria2() {
        let p = parse_link("hy2://secret@h.com:4443?sni=s.com&insecure=1#HY").unwrap();
        assert_eq!(p.outbound["protocol"], "hysteria");
        let ss = &p.outbound["streamSettings"];
        assert_eq!(ss["network"], "hysteria");
        assert_eq!(ss["security"], "tls");
        assert_eq!(ss["tlsSettings"]["alpn"], json!(["h3"]));
        assert_eq!(ss["tlsSettings"]["allowInsecure"], true);
        assert_eq!(ss["hysteriaSettings"], json!({ "auth": "secret", "version": 2 }));
        assert_eq!(ss["finalmask"]["quicParams"]["congestion"], "bbr");
    }

    #[test]
    fn subscription_base64_and_errors() {
        let body = STANDARD.encode("vless://u@a.com:443#A\nvless://@broken\ntrojan://p@b.com:443#B\n");
        let r = parse_subscription(&body);
        assert_eq!(
            r.proxies.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["A", "B"]
        );
        assert_eq!(r.errors.len(), 1);
    }

    #[test]
    fn subscription_plain_text() {
        let r = parse_subscription("  vless://u@a.com:443#A\r\n# comment\n\n");
        assert_eq!(r.proxies.len(), 1);
    }

    #[test]
    fn subscription_xray_json() {
        let body = r#"[{"remarks":"🇩🇪 DE","outbounds":[
            {"tag":"proxy","protocol":"vless","settings":{},"streamSettings":{"sockopt":{"dialerProxy":"x"}}},
            {"tag":"direct","protocol":"freedom"}]}]"#;
        let r = parse_subscription(body);
        assert_eq!(r.proxies.len(), 1);
        assert_eq!(r.proxies[0].name, "🇩🇪 DE");
        assert!(r.proxies[0].outbound.get("tag").is_none());
        assert_eq!(r.proxies[0].outbound["streamSettings"]["sockopt"], json!({}));
    }
}
