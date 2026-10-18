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
// Провайдеру уходит SHA-256 от ключа и домена провайдера: у разных провайдеров HWID разный,
// а повторное добавление подписки того же провайдера даёт тот же HWID и не занимает новый слот.

const ROUTER_MAC_FILE: &str = "/sys/class/net/br0/address";
const ROUTER_KEY_FILE: &str = "/opt/etc/xkeen/xkeen-ui-hwid";

/// Ключ роутера на время работы панели: одновременные первые запросы не создадут два разных.
static ROUTER_KEY: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

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

/// Ключ роутера из первого доступного источника; префикс не даёт источникам совпасть.
fn key_from(serial: Option<String>, mac: Option<String>) -> String {
    let identity = match (serial, mac) {
        (Some(serial), _) => format!("serial:{serial}"),
        (None, Some(mac)) => format!("mac:{mac}"),
        (None, None) => format!("random:{}", uuid::Uuid::new_v4().simple()),
    };
    sha256_hex(&format!("xkeen-ui-router:{identity}"))
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Ключ из файла; если его нет — `compute`, результат сохраняется (только для root, как xkeen.json).
fn load_or_save_key(path: &std::path::Path, compute: impl FnOnce() -> String) -> String {
    if let Ok(saved) = std::fs::read_to_string(path)
        && valid_key(saved.trim())
    {
        return saved.trim().to_string();
    }
    let key = compute();
    let written = {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .and_then(|mut f| f.write_all(key.as_bytes()))
    };
    if let Err(e) = written {
        log("WARN", format!("Не удалось сохранить {}: {e}", path.display()));
    }
    key
}

async fn router_key(state: &AppState) -> String {
    ROUTER_KEY
        .get_or_init(|| async {
            let path = std::path::Path::new(ROUTER_KEY_FILE);
            if let Ok(saved) = std::fs::read_to_string(path)
                && valid_key(saved.trim())
            {
                return saved.trim().to_string();
            }
            let serial = query_serial(state).await;
            let mac = std::fs::read_to_string(ROUTER_MAC_FILE).ok().and_then(|m| parse_mac(&m));
            load_or_save_key(path, || key_from(serial, mac))
        })
        .await
        .clone()
}

/// SHA-256 от ключа роутера и домена провайдера: первые 12 hex-символов, как MAC без двоеточий.
fn derive_hwid(key: &str, url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    sha256_hex(&format!("xkeen-ui-hwid:{key}:{host}"))[..12].to_ascii_uppercase()
}

/// HWID для новой подписки — постоянный для пары роутер + провайдер.
pub async fn new_hwid(state: &AppState, url: &str) -> String {
    derive_hwid(&router_key(state).await, url)
}

#[cfg(test)]
mod hwid_tests {
    use super::*;

    #[test]
    fn stable_per_router_and_provider() {
        let key = key_from(Some("S0000TEST001".into()), None);
        let a = derive_hwid(&key, "https://sub.example.com/abc");
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
        // тот же роутер и провайдер — тот же HWID, даже с другой ссылкой и регистром домена
        assert_eq!(a, derive_hwid(&key, "https://SUB.example.com/other?x=1"));
        // другой провайдер или другой роутер — другой HWID
        assert_ne!(a, derive_hwid(&key, "https://other.example.org/abc"));
        let other = key_from(Some("S0000TEST002".into()), None);
        assert_ne!(a, derive_hwid(&other, "https://sub.example.com/abc"));
    }

    #[test]
    fn key_sources() {
        let mac = parse_mac("50:FF:20:12:34:56\n");
        // серийный номер важнее MAC; один источник — всегда один ключ
        assert_eq!(key_from(Some("S1".into()), mac.clone()), key_from(Some("S1".into()), None));
        assert_eq!(key_from(None, mac.clone()), key_from(None, mac.clone()));
        assert_ne!(key_from(Some("S1".into()), None), key_from(None, mac));
        // без источников — случайный
        assert_ne!(key_from(None, None), key_from(None, None));
        assert!(valid_key(&key_from(None, None)));
        // в ключе нет исходного серийного номера
        assert!(!key_from(Some("S2547TEST01".into()), None).to_uppercase().contains("S2547TEST01"));
    }

    #[test]
    fn key_is_saved_once() {
        let dir = std::env::temp_dir().join(format!("hwid-key-{}", std::process::id()));
        _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("xkeen-ui-hwid");

        let first = load_or_save_key(&path, || key_from(None, None));
        // при следующем запуске ключ берётся из файла, а не вычисляется заново
        let second = load_or_save_key(&path, || panic!("ключ уже сохранён"));
        assert_eq!(first, second);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // повреждённый файл — ключ вычисляется и перезаписывается
        std::fs::write(&path, "мусор").unwrap();
        let fresh = load_or_save_key(&path, || key_from(Some("S1".into()), None));
        assert_eq!(fresh, key_from(Some("S1".into()), None));
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
