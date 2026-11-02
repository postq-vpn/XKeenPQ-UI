use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::types::{APP_CONFIG, ApiResponse, AppState};

const SESSION_COOKIE: &str = "session_id";
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 256;
/// Все запросы извне делят один счётчик попыток: адрес клиента за прокси ненадёжен.
const EXTERNAL_KEY: &str = "external";
/// Одна проверка пароля занимает около 19 МБ памяти.
const MAX_PASSWORD_JOBS: usize = 2;
/// Адреса роутера в его локальной сети.
const ROUTER_LAN_NAMES: [&str; 2] = ["my.keenetic.net", "my.netcraze.net"];

static BRUTE_CACHE: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PASSWORD_JOBS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(MAX_PASSWORD_JOBS)));

#[derive(Deserialize)]
pub struct PasswordReq {
    password: String,
    #[serde(default)]
    remember: bool,
}

fn now_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// Адрес клиента только для журнала: заголовки может подделать сам клиент.
fn get_client_ip(headers: &HeaderMap, addr: SocketAddr) -> String {
    headers
        .get("x-real-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| addr.ip().to_string())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// Имя из заголовка `Host` без порта и скобок IPv6.
pub fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    host.split(':').next().unwrap_or("")
}

fn is_local_host(host: &str) -> bool {
    let name = host_name(host).to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    if let Ok(ip) = name.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    !name.contains('.') || name.ends_with(".local") || ROUTER_LAN_NAMES.contains(&name.as_str())
}

/// Запрос из локальной сети: с частного адреса, без следов прокси и по локальному имени.
/// Прокси роутера (CrazeDNS, KeenDNS) подключается к панели с адреса самого роутера, поэтому
/// loopback локальным не считается. Что-то не сходится — запрос внешний.
pub fn is_local_request(headers: &HeaderMap, addr: SocketAddr) -> bool {
    const PROXY_HEADERS: [&str; 6] = [
        "forwarded",
        "via",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    ];
    is_private_ip(addr.ip())
        && !PROXY_HEADERS.iter().any(|h| headers.contains_key(*h))
        && headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(is_local_host)
}

fn error_response(status: StatusCode, error: impl Into<String>) -> Response {
    (
        status,
        Json(ApiResponse::<()> {
            success: false,
            error: Some(error.into()),
            data: None,
        }),
    )
        .into_response()
}

/// Запускает проверку или расчёт хеша пароля; `None` — уже заняты все слоты. Слот держит сама
/// задача: если клиент оборвал соединение, она всё равно занимает память, пока не закончит.
async fn password_job<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let slot = PASSWORD_JOBS.clone().try_acquire_owned().ok()?;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        job()
    })
    .await
    .ok()
}

/// Проверяет пароль с учётом лимита попыток; ответ — отказ клиенту. Попытка засчитывается
/// до проверки, иначе параллельные запросы обошли бы лимит.
async fn password_rejection(state: &AppState, headers: &HeaderMap, addr: SocketAddr, password: String) -> Option<Response> {
    let log_ip = get_client_ip(headers, addr);
    let key = if is_local_request(headers, addr) { addr.ip().to_string() } else { EXTERNAL_KEY.to_string() };
    let hash = state.settings.read().unwrap().auth.password_hash.clone();
    let Some(hash) = hash else {
        return Some(error_response(StatusCode::FORBIDDEN, "No password set"));
    };
    let attempt = {
        let mut cache = BRUTE_CACHE.lock().unwrap();
        cache.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(LOCKOUT_SECS * 2));
        let entry = cache.entry(key.clone()).or_insert((0, Instant::now()));
        if entry.1.elapsed() > Duration::from_secs(LOCKOUT_SECS) {
            entry.0 = 0;
        }
        if entry.0 >= MAX_ATTEMPTS {
            println!("{} [WARN] Authorization blocked [{}]", crate::logger::ts(), log_ip);
            return Some(error_response(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Слишком много попыток. Повторите через {} секунд", LOCKOUT_SECS),
            ));
        }
        entry.0 += 1;
        entry.1 = Instant::now();
        entry.0
    };

    let Some(is_valid) = password_job(move || verify_password(&password, &hash)).await else {
        return Some(error_response(StatusCode::TOO_MANY_REQUESTS, "Панель занята проверкой пароля. Повторите позже"));
    };
    if !is_valid {
        println!(
            "{} [WARN] Incorrect password attempt [{}] ({}/{})",
            crate::logger::ts(),
            log_ip,
            attempt,
            MAX_ATTEMPTS
        );
        return Some(error_response(StatusCode::UNAUTHORIZED, "Неверный пароль"));
    }
    BRUTE_CACHE.lock().unwrap().remove(&key);
    None
}

fn get_session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| pair.trim().strip_prefix("session_id="))
}

fn is_session_valid(session_ids: &[String], cookie: &str) -> bool {
    let ts = now_ts();
    session_ids.iter().any(|id| {
        if id == cookie {
            return true;
        }
        if let Some((uid, exp_str)) = id.split_once(':')
            && uid == cookie {
                return exp_str.parse::<u64>().unwrap_or(0) > ts;
            }
        false
    })
}

fn set_cookie_header(headers_in: &HeaderMap, value: String, max_age: u64) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let secure = if headers_in.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https") {
        "Secure; "
    } else {
        ""
    };
    let cookie = if max_age > 0 {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/; Max-Age={}",
            SESSION_COOKIE, value, secure, max_age
        )
    } else {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/",
            SESSION_COOKIE, value, secure
        )
    };
    headers.insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    headers
}

fn clear_cookie_header() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("session_id=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    headers
}

pub async fn get_login_info(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    let authenticated =
        get_session_cookie(&headers).is_some_and(|cookie| is_session_valid(&s.auth.session_ids, cookie));
    Json(serde_json::json!({
        "enabled": s.auth.enabled,
        "has_password": s.auth.password_hash.is_some(),
        "authenticated": authenticated,
        "local": is_local_request(&headers, addr)
    }))
}

pub async fn post_setup(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    if !is_local_request(&headers, addr) {
        return error_response(StatusCode::FORBIDDEN, "Пароль можно задать только из локальной сети");
    }
    if state.settings.read().unwrap().auth.password_hash.is_some() {
        return error_response(StatusCode::FORBIDDEN, "Password already set");
    }
    let chars = req.password.chars().count();
    if !(MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&chars) {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!("Длина пароля: от {MIN_PASSWORD_CHARS} до {MAX_PASSWORD_CHARS} символов"),
        );
    }

    let password = req.password;
    let Some(hash) = password_job(move || hash_password(&password)).await else {
        return error_response(StatusCode::TOO_MANY_REQUESTS, "Панель занята проверкой пароля. Повторите позже");
    };
    let session_id = Uuid::new_v4().to_string();
    let ttl = 86400;
    let session_val = format!("{}:{}", session_id, now_ts() + ttl);

    update_auth(&state, |auth| {
        auth.password_hash = Some(hash);
        auth.session_ids.push(session_val);
    })
    .await;

    (
        set_cookie_header(&headers, session_id, 0),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_login(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    let ip = get_client_ip(&headers, addr);
    if let Some(response) = password_rejection(&state, &headers, addr, req.password).await {
        return response;
    }
    println!("{} [INFO] Successful auth {}", crate::logger::ts(), ip);

    let max_age = if req.remember { 2592000 } else { 0 };
    let backend_ttl = if req.remember { 2592000 } else { 86400 };

    let session_id = Uuid::new_v4().to_string();
    let session_val = format!("{}:{}", session_id, now_ts() + backend_ttl);

    update_auth(&state, |auth| {
        auth.session_ids.push(session_val);
    })
    .await;

    (
        set_cookie_header(&headers, session_id, max_age),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_logout(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(cookie) = get_session_cookie(&headers) {
        let cookie = cookie.to_string();
        update_auth(&state, |auth| {
            auth.session_ids.retain(|id| !id.starts_with(&cookie) && id != &cookie)
        })
        .await;
    }
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
}

#[derive(Deserialize)]
pub struct ResetReq {
    password: String,
}

/// Новый пароль задаётся только из локальной сети, поэтому и сбросить его можно только оттуда:
/// чужая сессия не должна отрезать владельца от панели.
pub async fn post_auth_reset(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
    Json(req): Json<ResetReq>,
) -> Response {
    if !is_local_request(&headers, addr) {
        return error_response(StatusCode::FORBIDDEN, "Сбросить пароль можно только из локальной сети");
    }
    if let Some(response) = password_rejection(&state, &headers, addr, req.password).await {
        return response;
    }
    update_auth(&state, |auth| {
        auth.password_hash = None;
        auth.session_ids.clear();
    })
    .await;
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn auth_middleware(state: AppState, request: Request, next: Next) -> Response {
    let enabled = state.settings.read().unwrap().auth.enabled;
    if !enabled {
        // Без пароля панель открыта только локальной сети.
        let local = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .is_some_and(|c| is_local_request(request.headers(), c.0));
        return if local {
            next.run(request).await
        } else {
            error_response(StatusCode::FORBIDDEN, "Без пароля панель доступна только из локальной сети")
        };
    }
    let session_ids = state.settings.read().unwrap().auth.session_ids.clone();
    if session_ids.is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let is_valid = get_session_cookie(request.headers()).is_some_and(|c| is_session_valid(&session_ids, c));
    if !is_valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    next.run(request).await
}

fn hash_password(password: &str) -> String {
    Argon2::default()
        .hash_password(password.as_bytes())
        .unwrap()
        .to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

async fn update_auth(state: &AppState, modify: impl FnOnce(&mut crate::types::AuthSettings)) {
    {
        let mut s = state.settings.write().unwrap();
        modify(&mut s.auth);

        let ts = now_ts();
        s.auth.session_ids.retain(|id| {
            if let Some((_, exp)) = id.split_once(':') {
                exp.parse::<u64>().unwrap_or(0) > ts
            } else {
                true
            }
        });
    }
    save_auth_to_config(state).await;
}

async fn save_auth_to_config(state: &AppState) {
    let _guard = state.app_config_lock.lock().await;
    let auth = state.settings.read().unwrap().auth.clone();
    let mut file_json = match crate::settings::read_config(APP_CONFIG).await {
        Ok(json) => json,
        Err(e) => return crate::logger::log("ERROR", format!("Сессия не сохранена: {e}")),
    };
    file_json["auth"] = serde_json::to_value(auth).unwrap();
    let serialized = serde_json::to_string_pretty(&file_json).unwrap();
    let tmp = format!("{}.tmp", APP_CONFIG);
    if crate::private_file::write(&tmp, &serialized).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, APP_CONFIG).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(host: &str, extra: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        for (k, v) in extra {
            headers.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        headers
    }

    fn peer(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 50000)
    }

    #[test]
    fn lan_requests_are_local() {
        for host in ["192.168.1.1:1000", "my.netcraze.net:1000", "router:1000", "router.local", "[fd00::1]:1000"] {
            assert!(is_local_request(&request(host, &[]), peer("192.168.1.84")), "{host}");
        }
        assert!(is_local_request(&request("10.0.0.1:1000", &[]), peer("10.8.0.2")));
        assert!(is_local_request(&request("[fd00::1]:1000", &[]), peer("fd00::2")));
    }

    #[test]
    fn everything_else_is_external() {
        let lan = peer("192.168.1.84");
        // прокси роутера подключается с него самого
        assert!(!is_local_request(&request("127.0.0.1:1000", &[]), peer("127.0.0.1")));
        assert!(!is_local_request(&request("192.168.1.1:1000", &[]), peer("::1")));
        // проброс порта
        assert!(!is_local_request(&request("192.168.1.1:1000", &[]), peer("8.8.8.8")));
        assert!(!is_local_request(&request("192.168.1.1:1000", &[]), peer("100.64.0.1")));
        // имя из интернета, в том числе DNS rebinding
        assert!(!is_local_request(&request("kiloo.netcraze.pro", &[]), lan));
        assert!(!is_local_request(&request("8.8.8.8:1000", &[]), lan));
        assert!(!is_local_request(&request("", &[]), lan));
        assert!(!is_local_request(&HeaderMap::new(), lan));
        // следы прокси
        for h in ["forwarded", "via", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"] {
            assert!(!is_local_request(&request("192.168.1.1:1000", &[(h, "1.2.3.4")]), lan), "{h}");
        }
    }

    #[test]
    fn mapped_ipv4_peer_is_recognised() {
        assert!(is_private_ip("::ffff:192.168.1.84".parse().unwrap()));
        assert!(!is_private_ip("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn host_name_drops_port_and_brackets() {
        assert_eq!(host_name("a.b:443"), "a.b");
        assert_eq!(host_name("a.b"), "a.b");
        assert_eq!(host_name("[fd00::1]:1000"), "fd00::1");
    }
}
