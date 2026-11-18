//! Автовыпуск токена доступа к RCI (KeeneticOS 5.2+).
//!
//! Некоторые прошивки пускают к локальному RCI только с токеном из `xkeen.json`, общего с XKeen. Токен теряется
//! (сброс, переустановка, обновление со старой прошивки, где он не был нужен), поэтому при отказе
//! RCI панель выпускает его сама — той же командой консоли и с той же меткой, что `setup.sh`:
//! `authentication token generate XKeenPQ-UI`. Прежние токены с этой меткой снимаются, чужие не
//! трогаются. Новый токен записывается в `xkeen.json`: им пользуются и панель (сразу), и XKeen
//! (со следующего запуска).
//!
//! На прошивках без этой команды (до 5.2) выпуск не повторяется до перезапуска панели: после
//! обновления прошивки роутер перезагружается, и панель попробует снова.

use crate::console;
use crate::logger::log;
use crate::types::{AppState, XKEEN_CONF};
use regex_lite::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Метка токенов панели, как в `setup.sh` (`TOKEN_LABEL`).
const TOKEN_LABEL: &str = "XKeenPQ-UI";
/// Если выпущенный токен всё равно не приняли, следующий выпуск — не раньше чем через час:
/// иначе каждый запрос плодил бы токены.
const RETRY_AFTER: Duration = Duration::from_secs(3600);

/// Выпуск идёт по одному; время последней попытки — под этой же блокировкой.
static ISSUE_LOCK: Mutex<Option<Instant>> = Mutex::const_new(None);
/// Прошивка не умеет выпускать токены из консоли.
static UNSUPPORTED: AtomicBool = AtomicBool::new(false);

static TOKEN_VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""rci_token"\s*:\s*("[^"]*"|null)"#).unwrap());

/// Прошивка не умеет выпускать токены (до KeeneticOS 5.2).
pub fn unsupported() -> bool {
    UNSUPPORTED.load(Ordering::Relaxed)
}

/// Текущий токен панели.
pub fn current(state: &AppState) -> Option<String> {
    state.rci_token.read().unwrap().clone()
}

/// Токен из `xkeen.json` (при запуске панели).
pub fn load() -> Option<String> {
    let text = std::fs::read_to_string(XKEEN_CONF).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("xkeen")?.get("rci_token")?.as_str().map(String::from).filter(|t| !t.is_empty())
}

/// id и значение нового токена из ответа `authentication token generate`. Длинное значение консоль
/// переносит на следующие строки — без двоеточия.
fn parse_generated(output: &str) -> Option<(String, String)> {
    let (mut id, mut value) = (None, String::new());
    let mut in_value = false;
    for line in output.lines().map(str::trim) {
        if in_value {
            if line.is_empty() || line.contains(':') {
                in_value = false;
            } else {
                value.push_str(line);
                continue;
            }
        }
        if let Some(rest) = line.strip_prefix("id:") {
            id = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("value:")
            && value.is_empty()
        {
            value = rest.trim().to_string();
            in_value = true;
        }
    }
    let valid = value.len() >= 32 && value.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| (id.unwrap_or_default(), value))
}

/// id токенов с меткой панели из `show authentication token`, кроме `keep`.
fn own_token_ids(listing: &str, keep: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut id = String::new();
    for line in listing.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("id:") {
            id = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("user-data:")
            && rest.trim() == TOKEN_LABEL
            && !id.is_empty()
            && id != keep
        {
            ids.push(id.clone());
        }
    }
    ids
}

/// Безопасный id для команды консоли.
fn is_plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Снимает токены панели, кроме `keep`: на роутере не остаются лишние бессрочные токены admin.
async fn revoke_own(keep: &str) {
    let Ok(listing) = console::run("show authentication token").await else {
        return;
    };
    for id in own_token_ids(&listing, keep).into_iter().filter(|id| is_plain_id(id)) {
        if let Err(e) = console::run(&format!("authentication token delete {id}")).await {
            log("WARN", format!("Не удалось снять прежний токен панели {id}: {e}"));
        }
    }
}

/// `xkeen.json` с новым токеном. Значение заменяется на месте, чтобы сохранить комментарии и
/// порядок (XKeen допускает комментарии); иначе ключ добавляется в раздел `xkeen`.
fn with_token(config: Option<&str>, token: &str) -> Result<String, String> {
    let quoted = serde_json::to_string(token).unwrap();
    let Some(text) = config.filter(|t| !t.trim().is_empty()) else {
        return Ok(format!("{:#}\n", json!({ "xkeen": { "rci_token": token } })));
    };
    if TOKEN_VALUE.is_match(text) {
        return Ok(TOKEN_VALUE.replace(text, format!(r#""rci_token": {quoted}"#).as_str()).into_owned());
    }
    let mut json: Value =
        serde_json::from_str(text).map_err(|_| "в xkeen.json нет места для токена, а сам файл не читается как JSON")?;
    let root = json.as_object_mut().ok_or("xkeen.json — не объект")?;
    let section = root.entry("xkeen").or_insert_with(|| json!({}));
    section.as_object_mut().ok_or("раздел xkeen в xkeen.json — не объект")?.insert("rci_token".into(), json!(token));
    Ok(format!("{json:#}\n"))
}

async fn save(token: &str) -> Result<(), String> {
    let current = tokio::fs::read_to_string(XKEEN_CONF).await.ok();
    let updated = with_token(current.as_deref(), token)?;
    let path = std::path::Path::new(XKEEN_CONF);
    if let Some(dir) = path.parent() {
        _ = tokio::fs::create_dir_all(dir).await;
    }
    // Через временный файл: обрыв питания не оставит xkeen.json пустым
    let tmp = path.with_extension("json.tmp");
    crate::private_file::write(&tmp, updated).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())
}

fn unsupported_error(error: &str) -> bool {
    error.contains("no such command") || error.contains("not found")
}

async fn issue() -> Result<String, String> {
    // Поддержку проверяем чтением списка токенов: на 5.1 его нет, а сам выпуск там отвечает не
    // «no such command», а «argument parse error» — консоль принимает начало строки за другую команду
    if let Err(e) = console::run("show authentication token").await
        && unsupported_error(&e)
    {
        UNSUPPORTED.store(true, Ordering::Relaxed);
        return Err("прошивка не умеет выпускать токены из консоли (нужна KeeneticOS 5.2 или новее)".into());
    }
    let output = match console::run(&format!("authentication token generate {TOKEN_LABEL}")).await {
        Ok(output) => output,
        Err(e) if unsupported_error(&e) => {
            UNSUPPORTED.store(true, Ordering::Relaxed);
            return Err("прошивка не умеет выпускать токены из консоли (нужна KeeneticOS 5.2 или новее)".into());
        }
        Err(e) => return Err(e),
    };
    let Some((id, token)) = parse_generated(&output) else {
        // Выпущен, но не разобран — снимаем, чтобы не оставлять на роутере бессрочный токен admin
        revoke_own("").await;
        return Err("роутер выпустил токен в непонятном виде".into());
    };
    revoke_own(&id).await;
    if let Err(e) = console::run("system configuration save").await {
        log("WARN", format!("Не удалось сохранить настройки роутера после выпуска токена: {e}"));
    }
    Ok(token)
}

/// RCI отказал с токеном `rejected`: выпускает новый. `true` — токен сменился, запрос стоит
/// повторить (его мог выпустить и параллельный запрос, пока этот ждал).
pub async fn renew(state: &AppState, rejected: Option<&str>) -> bool {
    if UNSUPPORTED.load(Ordering::Relaxed) {
        return false;
    }
    let mut last = ISSUE_LOCK.lock().await;
    if current(state).as_deref() != rejected {
        return true;
    }
    if UNSUPPORTED.load(Ordering::Relaxed) || last.is_some_and(|at| at.elapsed() < RETRY_AFTER) {
        return false;
    }
    *last = Some(Instant::now());
    let token = match issue().await {
        Ok(token) => token,
        Err(e) => {
            log("WARN", format!("Токен доступа к RCI не выпущен: {e}"));
            return false;
        }
    };
    *state.rci_token.write().unwrap() = Some(token.clone());
    match save(&token).await {
        Ok(()) => log(
            "INFO",
            "Выпущен новый токен доступа к RCI и записан в xkeen.json. XKeen подхватит его при следующем перезапуске".into(),
        ),
        Err(e) => log("WARN", format!("Выпущен новый токен доступа к RCI, но в xkeen.json не записан ({e}): после перезапуска панель выпустит его снова")),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5F6a1B2";

    #[test]
    fn reads_generated_token() {
        let out = format!("\n               id: 7\n            value: {TOKEN}\n        user-data: XKeenPQ-UI\n");
        assert_eq!(parse_generated(&out), Some(("7".into(), TOKEN.into())));
        // Длинное значение перенесено на следующие строки
        let wrapped = format!("id: 3\nvalue: {}\n       {}\nuser-data: XKeenPQ-UI\n", &TOKEN[..20], &TOKEN[20..]);
        assert_eq!(parse_generated(&wrapped), Some(("3".into(), TOKEN.into())));
        assert_eq!(parse_generated("id: 1\nvalue: short\n"), None);
        assert_eq!(parse_generated(&format!("value: {TOKEN}!\n")), None);
    }

    #[test]
    fn finds_own_tokens_only() {
        let listing = "id: 1\nuser-data: XKeenPQ-UI\n\nid: 2\nuser-data: other\n\nid: 3\nuser-data: XKeenPQ-UI\n";
        assert_eq!(own_token_ids(listing, "3"), ["1"]);
        assert_eq!(own_token_ids(listing, ""), ["1", "3"]);
        assert!(is_plain_id("12"));
        assert!(!is_plain_id("1; reboot"));
    }

    #[test]
    fn writes_token_into_config() {
        let fresh = with_token(None, TOKEN).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fresh).unwrap()["xkeen"]["rci_token"], TOKEN);
        assert!(with_token(Some("{\n}\n"), TOKEN).unwrap().contains(TOKEN));
        // Комментарии и остальные настройки остаются как были
        let commented = "{\n  // XKeen\n  \"xkeen\": { \"rci_token\": \"old\", \"killswitch\": \"on\" }\n}\n";
        let updated = with_token(Some(commented), TOKEN).unwrap();
        assert!(updated.contains("// XKeen") && updated.contains("\"killswitch\": \"on\""));
        assert!(updated.contains(&format!("\"rci_token\": \"{TOKEN}\"")) && !updated.contains("old"));
        assert!(with_token(Some("{ \"xkeen\": { \"rci_token\": null } }"), TOKEN).unwrap().contains(TOKEN));
        let other = with_token(Some("{ \"xkeen\": { \"killswitch\": \"on\" } }"), TOKEN).unwrap();
        let other: Value = serde_json::from_str(&other).unwrap();
        assert_eq!(other["xkeen"]["killswitch"], "on");
        assert_eq!(other["xkeen"]["rci_token"], TOKEN);
        assert!(with_token(Some("{ // без ключа\n }"), TOKEN).is_err());
    }
}
