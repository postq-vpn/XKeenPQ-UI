//! Название подписки из ответа провайдера и тег, построенный из него.
//!
//! Провайдеры (Remnawave, Marzban, 3x-ui и др.) отдают название в заголовке `profile-title`
//! (часто как `base64:<...>`), реже — строкой `#profile-title: ...` в теле подписки или именем
//! файла в `content-disposition`. Если ничего нет, берём домен из ссылки.

use super::parser::{decode_base64, percent_decode};
use std::collections::HashSet;

const MAX_TITLE: usize = 100;
const MAX_TAG: usize = 40;

/// `base64:<...>` или обычный текст (в т.ч. percent-encoded).
fn decode_title(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_matches('"');
    let text = match raw.strip_prefix("base64:") {
        Some(b64) => String::from_utf8(decode_base64(b64.trim())?).ok()?,
        None => percent_decode(raw),
    };
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then(|| text.chars().take(MAX_TITLE).collect())
}

/// `#profile-title: ...` в теле: как есть или внутри base64-тела.
fn title_from_body(body: &str) -> Option<String> {
    let find = |text: &str| {
        text.lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix("#profile-title:").and_then(decode_title))
    };
    find(body).or_else(|| {
        // Заголовок стоит в начале списка — декодируем только первые ~4 КБ base64 (кратно 4 символам).
        let mut head: String = body.split_whitespace().flat_map(str::chars).take(4096).collect();
        head.truncate(head.len() / 4 * 4);
        let decoded = decode_base64(&head)?;
        find(&String::from_utf8_lossy(&decoded))
    })
}

/// `attachment; filename*=UTF-8''Name` или `filename="Name.txt"`.
fn title_from_disposition(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.rsplit("''").next().unwrap_or(v);
            return decode_title(v).map(strip_extension);
        }
        if let Some(v) = part.strip_prefix("filename=") {
            plain = decode_title(v).map(strip_extension);
        }
    }
    plain
}

fn strip_extension(name: String) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 4 => stem.to_string(),
        _ => name,
    }
}

/// Заголовки ответа, из которых берётся название (как UTF-8: часть провайдеров шлёт кириллицу как есть).
#[derive(Default)]
pub struct TitleHeaders {
    profile_title: Option<String>,
    disposition: Option<String>,
}

impl TitleHeaders {
    pub fn from_headers(headers: &reqwest::header::HeaderMap) -> Self {
        let get = |name: &str| headers.get(name).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        Self {
            profile_title: get("profile-title"),
            disposition: get("content-disposition"),
        }
    }
}

/// Название подписки из заголовков и тела ответа.
pub fn from_response(headers: &TitleHeaders, body: &str) -> Option<String> {
    headers
        .profile_title
        .as_deref()
        .and_then(decode_title)
        .or_else(|| title_from_body(body))
        .or_else(|| headers.disposition.as_deref().and_then(title_from_disposition))
}

fn transliterate(c: char) -> &'static str {
    match c.to_lowercase().next().unwrap_or(c) {
        'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'ё' | 'э' => "e",
        'ж' => "zh", 'з' => "z", 'и' | 'й' => "i", 'к' => "k", 'л' => "l", 'м' => "m",
        'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t", 'у' => "u",
        'ф' => "f", 'х' => "h", 'ц' => "ts", 'ч' => "ch", 'ш' => "sh", 'щ' => "sch",
        'ы' => "y", 'ю' => "yu", 'я' => "ya", 'ь' | 'ъ' => "",
        _ => "_",
    }
}

/// Тег из названия: латиница в нижнем регистре, цифры и «_» (без «--», см. `Subscription::validate`).
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push_str(transliterate(c));
        }
    }
    let collapsed = out
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    collapsed.chars().take(MAX_TAG).collect::<String>().trim_end_matches('_').to_string()
}

/// Первая значимая часть домена ссылки: `https://sub.example.com/...` → `example`.
pub fn from_url(url: &str) -> Option<String> {
    let host = reqwest::Url::parse(url).ok()?.host_str()?.to_string();
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    let name = match parts.len() {
        0 => return None,
        1 => parts[0],
        n => parts[n - 2],
    };
    (!name.chars().all(|c| c.is_ascii_digit())).then(|| name.to_string())
}

/// Тег из названия (или домена ссылки), не совпадающий с занятыми.
pub fn suggest_tag(title: Option<&str>, url: &str, taken: &HashSet<String>) -> String {
    let base = title
        .map(slugify)
        .filter(|s| !s.is_empty())
        .or_else(|| from_url(url).map(|h| slugify(&h)).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "subscription".into());
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}_{n}"))
        .find(|t| !taken.contains(t))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn header_plain_and_base64() {
        let mut h = HeaderMap::new();
        h.insert("profile-title", HeaderValue::from_static("base64:0JzQvtC5IFZQTg=="));
        assert_eq!(from_response(&TitleHeaders::from_headers(&h), "").as_deref(), Some("Мой VPN"));
        h.insert("profile-title", HeaderValue::from_static("Super%20VPN"));
        assert_eq!(from_response(&TitleHeaders::from_headers(&h), "").as_deref(), Some("Super VPN"));
        h.insert("profile-title", HeaderValue::from_bytes("Мой VPN".as_bytes()).unwrap());
        assert_eq!(from_response(&TitleHeaders::from_headers(&h), "").as_deref(), Some("Мой VPN"));
    }

    #[test]
    fn body_and_disposition() {
        let h = TitleHeaders::default();
        assert_eq!(
            from_response(&h, "#profile-title: Home\nvless://x").as_deref(),
            Some("Home")
        );
        // То же внутри base64-тела.
        let b64 = "I3Byb2ZpbGUtdGl0bGU6IEhvbWUKdmxlc3M6Ly94";
        assert_eq!(from_response(&h, b64).as_deref(), Some("Home"));
        let mut h = HeaderMap::new();
        h.insert(
            "content-disposition",
            HeaderValue::from_static("attachment; filename=\"MyProvider.txt\""),
        );
        assert_eq!(from_response(&TitleHeaders::from_headers(&h), "vless://x").as_deref(), Some("MyProvider"));
    }

    #[test]
    fn tags() {
        assert_eq!(slugify("Мой VPN 🇳🇱"), "moi_vpn");
        assert_eq!(slugify("Super--Fast VPN!"), "super_fast_vpn");
        let taken: HashSet<String> = ["moi_vpn".to_string()].into();
        assert_eq!(suggest_tag(Some("Мой VPN"), "", &taken), "moi_vpn_2");
        assert_eq!(suggest_tag(None, "https://sub.example.com/abc", &HashSet::new()), "example");
        assert_eq!(suggest_tag(Some("🔥"), "https://1.2.3.4/x", &HashSet::new()), "subscription");
    }
}
