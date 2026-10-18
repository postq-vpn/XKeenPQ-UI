//! Модель роутера и версия ОС из RCI — для заголовков `x-device-model` и `x-ver-os`,
//! и постоянный `x-hwid` новых подписок, привязанный к роутеру.

use super::*;

#[derive(Clone, Serialize, Default, PartialEq, Debug)]
pub struct DeviceInfo {
    pub model: String,
    pub os_version: String,
}

/// Запоминается только удачный ответ: если RCI был недоступен, спросим снова в следующий раз.
static DEVICE: tokio::sync::OnceCell<DeviceInfo> = tokio::sync::OnceCell::const_new();

fn parse_version(info: &Value) -> DeviceInfo {
    let field = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let model = Some(field("description"))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| field("model"));
    let os_version = Some(field("title"))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| field("release"));
    DeviceInfo { model, os_version }
}

async fn query_rci(state: &AppState) -> Result<DeviceInfo, String> {
    let mut req = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/version")
        .timeout(Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        req = req.header("X-Ndma-Tkn", token);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("RCI вернул {}", resp.status()));
    }
    let info: Value = resp.json().await.map_err(|e| e.to_string())?;
    let device = parse_version(&info);
    if device.model.is_empty() && device.os_version.is_empty() {
        return Err("RCI не вернул модель и версию ОС".into());
    }
    Ok(device)
}

/// Модель и версия ОС роутера; `None`, если RCI недоступен.
pub async fn router_device(state: &AppState) -> Option<DeviceInfo> {
    DEVICE.get_or_try_init(|| query_rci(state)).await.ok().cloned()
}

pub async fn get_device(State(state): State<AppState>) -> impl IntoResponse {
    match DEVICE.get_or_try_init(|| query_rci(&state)).await {
        Ok(device) => Json(json!({ "success": true, "model": device.model, "os_version": device.os_version })),
        Err(e) => fail(format!("Не удалось определить модель роутера: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_fields() {
        let info = json!({ "description": "Keenetic Giga (KN-1012)", "model": "Giga", "title": "4.2.1", "release": "4.02.C.1.0-0" });
        assert_eq!(
            parse_version(&info),
            DeviceInfo {
                model: "Keenetic Giga (KN-1012)".into(),
                os_version: "4.2.1".into()
            }
        );
        let fallback = json!({ "model": "Ultra", "release": "4.03.C.0.0-1" });
        assert_eq!(
            parse_version(&fallback),
            DeviceInfo {
                model: "Ultra".into(),
                os_version: "4.03.C.0.0-1".into()
            }
        );
        assert_eq!(parse_version(&json!({})), DeviceInfo::default());
    }
}

// --- Постоянный x-hwid новых подписок ---
//
// Ключ роутера вычисляется один раз и сохраняется в файл: по цепочке серийный номер (RCI
// `show defaults`) → MAC домашнего моста `br0` → случайное значение. Дальше он всегда берётся
// из файла, поэтому сбой RCI не меняет HWID. В файле — хеш, а не сам серийный номер; если файл
// пропадёт (переустановка Entware), ключ пересчитается из того же источника и совпадёт.
// Провайдеру уходит SHA-256 от ключа: один HWID на роутер, он не меняется ни при повторном
// добавлении подписки, ни при переезде провайдера на другой домен — новый слот не занимается.

const ROUTER_MAC_FILE: &str = "/sys/class/net/br0/address";
const ROUTER_KEY_FILE: &str = "/opt/etc/xkeen/xkeen-ui-hwid";

/// Ключ роутера и признак привязки к железу (серийный номер или MAC, а не случайное значение).
#[derive(Clone)]
struct RouterKey {
    key: String,
    bound: bool,
}

/// Ключ на время работы панели: одновременные первые запросы не создадут два разных.
static ROUTER_KEY: tokio::sync::OnceCell<RouterKey> = tokio::sync::OnceCell::const_new();

fn parse_serial(defaults: &Value) -> Option<String> {
    let serial = defaults.get("serial")?.as_str()?.trim();
    (serial.len() >= 6 && serial.chars().all(|c| c.is_ascii_alphanumeric())).then(|| serial.to_ascii_uppercase())
}

async fn query_serial(state: &AppState) -> Option<String> {
    let mut req = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/defaults")
        .timeout(Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        req = req.header("X-Ndma-Tkn", token);
    }
    let resp = req.send().await.ok().filter(|r| r.status().is_success())?;
    parse_serial(&resp.json::<Value>().await.ok()?)
}

fn parse_mac(raw: &str) -> Option<String> {
    let mac = raw.trim().to_ascii_lowercase();
    let valid = mac.len() == 17 && mac.split(':').all(|b| b.len() == 2 && b.chars().all(|c| c.is_ascii_hexdigit()));
    (valid && mac != "00:00:00:00:00:00").then_some(mac)
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(input.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Источник ключа: «serial», «mac» или «random».
type KeySource = &'static str;

/// Ключ роутера из первого доступного источника; префикс не даёт источникам совпасть.
fn key_from(serial: Option<String>, mac: Option<String>) -> (String, KeySource) {
    let (identity, source) = match (serial, mac) {
        (Some(serial), _) => (format!("serial:{serial}"), "serial"),
        (None, Some(mac)) => (format!("mac:{mac}"), "mac"),
        (None, None) => (format!("random:{}", uuid::Uuid::new_v4().simple()), "random"),
    };
    (sha256_hex(&format!("xkeen-ui-router:{identity}")), source)
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Содержимое файла ключа: «источник ключ». В v1.1.19 был только ключ — источник тогда `None`.
fn parse_key_file(content: &str) -> Option<(String, Option<String>)> {
    let mut parts = content.split_whitespace();
    let (first, second) = (parts.next()?, parts.next());
    match second {
        Some(key) if valid_key(key) => Some((key.to_string(), Some(first.to_string()))),
        None if valid_key(first) => Some((first.to_string(), None)),
        _ => None,
    }
}

/// Сохраняет ключ (только для root, как xkeen.json).
fn save_key(path: &std::path::Path, key: &str, source: &str) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut f| f.write_all(format!("{source} {key}\n").as_bytes()));
    if let Err(e) = written {
        log("WARN", format!("Не удалось сохранить {}: {e}", path.display()));
    }
}

async fn router_key(state: &AppState) -> RouterKey {
    ROUTER_KEY
        .get_or_init(|| async {
            let path = std::path::Path::new(ROUTER_KEY_FILE);
            let saved = std::fs::read_to_string(path).ok().and_then(|c| parse_key_file(&c));
            if let Some((key, Some(source))) = &saved {
                return RouterKey { key: key.clone(), bound: source != "random" };
            }
            let serial = query_serial(state).await;
            let mac = std::fs::read_to_string(ROUTER_MAC_FILE).ok().and_then(|m| parse_mac(&m));
            if let Some((key, None)) = saved {
                // файл из v1.1.19 без источника: ключ тот же, привязка — если железо определяется
                return RouterKey { key, bound: serial.is_some() || mac.is_some() };
            }
            let (key, source) = key_from(serial, mac);
            save_key(path, &key, source);
            RouterKey { key, bound: source != "random" }
        })
        .await
        .clone()
}

/// Ключ готов к синхронным проверкам `is_locked` (вызывается до отдачи списка подписок).
pub async fn init_router_key(state: &AppState) {
    router_key(state).await;
}

/// HWID привязан к роутеру: ключ из серийного номера или MAC и HWID совпадает с вычисленным
/// (или с формулой v1.1.19, где учитывался домен провайдера). Такой HWID нельзя заменить вручную.
pub fn is_locked(hwid: &str, url: &str) -> bool {
    ROUTER_KEY
        .get()
        .is_some_and(|k| k.bound && (derive_hwid(&k.key) == hwid || derive_hwid_v1_1_19(&k.key, url) == hwid))
}

/// HWID, обязательный для новых подписок: `Some`, если ключ привязан к железу.
pub async fn bound_hwid(state: &AppState) -> Option<String> {
    let key = router_key(state).await;
    key.bound.then(|| derive_hwid(&key.key))
}

/// SHA-256 от ключа роутера: первые 12 hex-символов, как MAC без двоеточий.
fn derive_hwid(key: &str) -> String {
    sha256_hex(&format!("xkeen-ui-hwid:{key}"))[..12].to_ascii_uppercase()
}

/// Формула v1.1.19 (ключ + домен провайдера) — только чтобы узнавать подписки, добавленные тогда.
fn derive_hwid_v1_1_19(key: &str, url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    sha256_hex(&format!("xkeen-ui-hwid:{key}:{host}"))[..12].to_ascii_uppercase()
}

/// HWID для новой подписки — один на роутер.
pub async fn new_hwid(state: &AppState) -> String {
    derive_hwid(&router_key(state).await.key)
}

#[cfg(test)]
mod hwid_tests {
    use super::*;

    #[test]
    fn one_hwid_per_router() {
        let (key, source) = key_from(Some("S0000TEST001".into()), None);
        assert_eq!(source, "serial");
        let a = derive_hwid(&key);
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
        // другой роутер — другой HWID
        let (other, _) = key_from(Some("S0000TEST002".into()), None);
        assert_ne!(a, derive_hwid(&other));
    }

    #[tokio::test]
    async fn locked_survives_domain_change_and_v1_1_19() {
        let (key, _) = key_from(Some("S0000TEST001".into()), None);
        _ = ROUTER_KEY.set(RouterKey { key: key.clone(), bound: true });
        // один HWID для любых ссылок и доменов
        assert!(is_locked(&derive_hwid(&key), "https://sub.example.com/abc"));
        assert!(is_locked(&derive_hwid(&key), "https://new-domain.example.org/xyz"));
        // подписки v1.1.19 (формула с доменом) тоже считаются привязанными
        assert!(is_locked(&derive_hwid_v1_1_19(&key, "https://sub.example.com/abc"), "https://sub.example.com/abc"));
        // случайный HWID, введённый вручную, — нет
        assert!(!is_locked("A1B2C3D4E5F6", "https://sub.example.com/abc"));
    }

    #[test]
    fn key_sources() {
        let mac = parse_mac("50:FF:20:12:34:56\n");
        // серийный номер важнее MAC; один источник — всегда один ключ
        assert_eq!(key_from(Some("S1".into()), mac.clone()), key_from(Some("S1".into()), None));
        assert_eq!(key_from(None, mac.clone()), key_from(None, mac.clone()));
        assert_eq!(key_from(None, mac.clone()).1, "mac");
        assert_ne!(key_from(Some("S1".into()), None).0, key_from(None, mac).0);
        // без источников — случайный и не привязанный
        let (random, source) = key_from(None, None);
        assert_eq!(source, "random");
        assert!(valid_key(&random));
        assert_ne!(random, key_from(None, None).0);
        // в ключе нет исходного серийного номера
        assert!(!key_from(Some("S2547TEST01".into()), None).0.to_uppercase().contains("S2547TEST01"));
    }

    #[test]
    fn key_file_formats() {
        let key = "a".repeat(64);
        assert_eq!(parse_key_file(&format!("serial {key}\n")), Some((key.clone(), Some("serial".into()))));
        assert_eq!(parse_key_file(&format!("random {key}")), Some((key.clone(), Some("random".into()))));
        // формат v1.1.19: только ключ
        assert_eq!(parse_key_file(&format!("{key}\n")), Some((key.clone(), None)));
        assert_eq!(parse_key_file("мусор"), None);
        assert_eq!(parse_key_file("serial короткий"), None);
        assert_eq!(parse_key_file(""), None);
    }

    #[test]
    fn key_is_saved_for_root_only() {
        let dir = std::env::temp_dir().join(format!("hwid-key-{}", std::process::id()));
        _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xkeen-ui-hwid");
        let (key, source) = key_from(Some("S1".into()), None);
        save_key(&path, &key, source);
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(parse_key_file(&content), Some((key, Some("serial".into()))));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parsing() {
        assert_eq!(parse_serial(&json!({ "serial": " s2547test01 " })).as_deref(), Some("S2547TEST01"));
        assert!(parse_serial(&json!({ "serial": "" })).is_none());
        assert!(parse_serial(&json!({ "serial": "***" })).is_none());
        assert!(parse_serial(&json!({})).is_none());
        assert!(parse_mac("00:00:00:00:00:00").is_none());
        assert!(parse_mac("garbage").is_none());
    }
}
