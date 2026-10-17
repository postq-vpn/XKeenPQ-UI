//! Подписки для Xray: аналог proxy-providers Mihomo.
//!
//! Подписка периодически скачивается (с User-Agent и HWID-заголовками), ссылки превращаются
//! в outbounds и пишутся в `04_outbounds_sub.<tag>.json`. Теги серверов: `<tag>--<имя>`;
//! под чистым тегом `<tag>` работает выбранный пользователем сервер — на него ссылаются правила.

mod device;
mod parser;
mod routing;
mod selection;

pub use device::get_device;
pub use selection::{post_ping, post_primary};

use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::Mutex;

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Фиксированный User-Agent запроса подписки, клиентом не меняется.
pub const USER_AGENT: &str = "Netcraze";
const SCHEDULER_TICK: Duration = Duration::from_secs(60);
const MAX_RETRY_DELAY: i64 = 900;
const MIN_INTERVAL: u64 = 60;

/// Сериализует все изменения хранилища и файлов outbounds (API и планировщик).
static STORE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct UserInfo {
    pub upload: u64,
    pub download: u64,
    pub total: u64,
    pub expire: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Subscription {
    pub tag: String,
    pub url: String,
    /// Интервал автообновления в секундах, 0 — только вручную.
    pub interval: u64,
    /// Обязателен: без x-hwid панели с лимитом устройств (Remnawave и др.) не отдают подписку.
    pub hwid: String,
    /// Регулярные выражения по имени сервера.
    pub filter: String,
    pub exclude_filter: String,
    /// Типы через «|» (vless|vmess|trojan|ss|hysteria2), как `exclude-type` в Mihomo.
    pub exclude_type: String,
    /// Переопределение uTLS fingerprint для TLS/Reality.
    pub fingerprint: String,
    /// Теги серверов, отключённых пользователем. Тег строится из имени сервера, поэтому
    /// отключение переживает обновления и смену порядка серверов в подписке.
    pub disabled_servers: Vec<String>,
    /// Выбранный сервер (тег). В файл добавляется outbound с тегом подписки — его копия;
    /// на него ссылаются правила маршрутизации. Пусто — первый включённый сервер.
    pub primary: String,

    // Состояние, клиентом не задаётся.
    /// Подписка «Для прокси»: проксируемые правила routing направляются на её тег.
    /// Ровно одна у всех подписок; меняется только через `/api/subscriptions/proxy`.
    pub proxy: bool,
    pub last_update: i64,
    pub last_attempt: i64,
    pub last_error: Option<String>,
    /// Включённых серверов (записано в файл) и всего в подписке после фильтров.
    pub servers: usize,
    pub total_servers: usize,
    pub userinfo: Option<UserInfo>,
    /// Последний полученный список серверов (включая отключённые): позволяет включать и
    /// отключать серверы без повторного запроса подписки. Клиенту не отдаётся, см. `to_api`.
    pub cached_outbounds: Vec<Value>,
}

impl Default for Subscription {
    fn default() -> Self {
        Self {
            tag: String::new(),
            url: String::new(),
            interval: 43200,
            hwid: String::new(),
            filter: String::new(),
            exclude_filter: String::new(),
            exclude_type: String::new(),
            fingerprint: String::new(),
            disabled_servers: vec![],
            primary: String::new(),
            proxy: false,
            last_update: 0,
            last_attempt: 0,
            last_error: None,
            servers: 0,
            total_servers: 0,
            userinfo: None,
            cached_outbounds: vec![],
        }
    }
}

impl Subscription {
    fn normalize(&mut self) {
        for field in [
            &mut self.tag,
            &mut self.url,
            &mut self.hwid,
            &mut self.filter,
            &mut self.exclude_filter,
            &mut self.exclude_type,
            &mut self.fingerprint,
        ] {
            *field = field.trim().to_string();
        }
        for tag in &mut self.disabled_servers {
            *tag = tag.trim().to_string();
        }
        self.disabled_servers.retain(|t| !t.is_empty());
        self.disabled_servers.sort();
        self.disabled_servers.dedup();
    }

    fn validate(&self) -> Result<(), String> {
        if !TAG_RE.is_match(&self.tag) {
            return Err("Название подписки: только латиница, цифры, «-» и «_» (до 64 символов)".into());
        }
        // «--» отделяет имя сервера в теге: «a--b» совпал бы с сервером «b» подписки «a».
        if self.tag.contains("--") {
            return Err("Название подписки не должно содержать «--»".into());
        }
        if !self.url.starts_with("http://") && !self.url.starts_with("https://") {
            return Err("URL подписки должен начинаться с http:// или https://".into());
        }
        if self.interval != 0 && self.interval < MIN_INTERVAL {
            return Err(format!("Интервал обновления должен быть не меньше {MIN_INTERVAL} сек"));
        }
        if self.hwid.is_empty() {
            return Err("Не указан x-hwid: без него панель не отдаст подписку".into());
        }
        for (label, re) in [("включения", &self.filter), ("исключения", &self.exclude_filter)] {
            if !re.is_empty() {
                Regex::new(re).map_err(|e| format!("Неверное регулярное выражение {label}: {e}"))?;
            }
        }
        Ok(())
    }

    /// Переносит состояние из сохранённой версии при редактировании.
    fn keep_status(&mut self, from: &Subscription) {
        self.last_update = from.last_update;
        self.last_attempt = from.last_attempt;
        self.last_error = from.last_error.clone();
        self.servers = from.servers;
        self.total_servers = from.total_servers;
        self.userinfo = from.userinfo.clone();
        self.cached_outbounds = from.cached_outbounds.clone();
        self.proxy = from.proxy;
    }

    fn reset_status(&mut self) {
        self.keep_status(&Subscription::default());
    }

    fn is_due(&self, now: i64) -> bool {
        if self.interval == 0 {
            return false;
        }
        let interval = self.interval as i64;
        if self.last_error.is_some() {
            now - self.last_attempt >= interval.min(MAX_RETRY_DELAY)
        } else {
            now - self.last_update >= interval
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Store {
    subscriptions: Vec<Subscription>,
}

async fn load_store() -> Store {
    match tokio::fs::read_to_string(SUBSCRIPTIONS_FILE).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log("ERROR", format!("Ошибка парсинга {}: {}", SUBSCRIPTIONS_FILE, e));
            Store::default()
        }),
        Err(_) => Store::default(),
    }
}

async fn save_store(store: &Store) -> Result<(), String> {
    tokio::fs::create_dir_all(XKEEN_CONF_DIR)
        .await
        .map_err(|e| e.to_string())?;
    let tmp = format!("{}.tmp", SUBSCRIPTIONS_FILE);
    tokio::fs::write(&tmp, serde_json::to_string_pretty(store).unwrap())
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, SUBSCRIPTIONS_FILE)
        .await
        .map_err(|e| e.to_string())
}

/// `04_outbounds_sub.*` всегда сортируется после `04_outbounds.json` ('.' < '_'), поэтому
/// первым outbound (outbound по умолчанию) остаётся outbound пользователя.
fn outbounds_path(tag: &str) -> PathBuf {
    PathBuf::from(XRAY_CONF_DIR).join(format!("04_outbounds_sub.{tag}.json"))
}

/// Прежнее имя файла: при записи удаляется, чтобы серверы не дублировались.
fn legacy_outbounds_path(tag: &str) -> PathBuf {
    PathBuf::from(XRAY_CONF_DIR).join(format!("04_outbounds.{tag}.json"))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

// ---------- загрузка и сборка outbounds ----------

struct Fetched {
    /// Все серверы после фильтров, включая отключённые пользователем.
    outbounds: Vec<Value>,
    errors: Vec<String>,
    userinfo: Option<UserInfo>,
}

fn is_disabled(sub: &Subscription, outbound: &Value) -> bool {
    outbound["tag"]
        .as_str()
        .is_some_and(|tag| sub.disabled_servers.iter().any(|d| d == tag))
}

/// Сервер, который работает под тегом подписки: выбранный пользователем, а если он не выбран,
/// отключён или пропал из подписки — первый включённый. Так тег подписки, на который
/// ссылаются правила routing, существует всегда.
fn active_server<'a>(sub: &Subscription, enabled: &'a [Value]) -> Option<&'a Value> {
    enabled
        .iter()
        .find(|o| !sub.primary.is_empty() && o["tag"] == sub.primary)
        .or_else(|| enabled.first())
}

/// Добавляет в начало outbound с тегом подписки — копию активного сервера.
fn with_active_alias(sub: &Subscription, mut enabled: Vec<Value>) -> Vec<Value> {
    if let Some(mut alias) = active_server(sub, &enabled).cloned() {
        alias["tag"] = json!(sub.tag);
        enabled.insert(0, alias);
    }
    enabled
}

/// Пересобирает файл outbounds из последнего полученного списка (без запроса подписки).
async fn apply_cached(sub: &mut Subscription) -> Result<bool, String> {
    if sub.cached_outbounds.is_empty() {
        return Err("Список серверов ещё не получен, обновите подписку".into());
    }
    let enabled = enabled_outbounds(sub, &sub.cached_outbounds)?;
    sub.servers = enabled.len();
    write_outbounds(&sub.tag, &with_active_alias(sub, enabled)).await
}

/// Серверы для записи в файл: без отключённых пользователем.
fn enabled_outbounds(sub: &Subscription, outbounds: &[Value]) -> Result<Vec<Value>, String> {
    let enabled: Vec<Value> = outbounds.iter().filter(|o| !is_disabled(sub, o)).cloned().collect();
    if enabled.is_empty() {
        return Err("все серверы подписки отключены, включите хотя бы один".into());
    }
    Ok(enabled)
}

async fn fetch_subscription(state: &AppState, sub: &Subscription) -> Result<Fetched, String> {
    let mut req = state
        .http_client
        .get(&sub.url)
        .timeout(FETCH_TIMEOUT)
        .header("Accept", "*/*")
        .header(reqwest::header::USER_AGENT, USER_AGENT);
    // Модель и версия ОС — только с самого роутера (RCI), вручную не задаются.
    let device = device::router_device(state).await.unwrap_or_default();
    for (name, value) in [
        ("x-hwid", &sub.hwid),
        ("x-ver-os", &device.os_version),
        ("x-device-model", &device.model),
    ] {
        if !value.is_empty() {
            req = req.header(name, value);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("ошибка запроса: {}", without_url(&e)))?;
    let status = resp.status();
    let userinfo = resp
        .headers()
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .map(parse_userinfo);
    let body = resp
        .text()
        .await
        .map_err(|e| format!("ошибка чтения ответа: {}", without_url(&e)))?;
    if !status.is_success() {
        let snippet: String = body.trim().chars().take(200).collect();
        return Err(format!(
            "HTTP {}{}",
            status.as_u16(),
            if snippet.is_empty() {
                String::new()
            } else {
                format!(": {snippet}")
            }
        ));
    }

    let parsed = parser::parse_subscription(&body);
    if parsed.proxies.is_empty() {
        let hint = parsed.errors.first().map(|e| format!(" ({e})")).unwrap_or_default();
        return Err(format!("в ответе не найдено ни одного сервера{hint}"));
    }
    let outbounds = build_outbounds(sub, parsed.proxies)?;
    if outbounds.is_empty() {
        return Err("после применения фильтров не осталось ни одного сервера".into());
    }
    Ok(Fetched {
        outbounds,
        errors: parsed.errors,
        userinfo,
    })
}

/// reqwest вставляет URL в текст ошибки, а в URL подписки обычно токен.
/// Корневая причина (connection refused, dns error…) лежит в цепочке source.
fn without_url(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    if let Some(start) = msg.find(" for url (") {
        if let Some(end) = msg[start..].find(')') {
            msg.replace_range(start..start + end + 1, "");
        }
    }
    let mut source = std::error::Error::source(e);
    let mut root = None;
    while let Some(s) = source {
        root = Some(s.to_string());
        source = s.source();
    }
    match root {
        Some(root) if !msg.contains(&root) => format!("{msg}: {root}"),
        _ => msg,
    }
}

fn parse_userinfo(header: &str) -> UserInfo {
    let mut info = UserInfo::default();
    for part in header.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let v = v.trim().parse::<f64>().unwrap_or(0.0).max(0.0) as u64;
        match k.trim().to_lowercase().as_str() {
            "upload" => info.upload = v,
            "download" => info.download = v,
            "total" => info.total = v,
            "expire" => info.expire = v,
            _ => {}
        }
    }
    info
}

fn build_outbounds(sub: &Subscription, proxies: Vec<parser::ParsedProxy>) -> Result<Vec<Value>, String> {
    let compile = |re: &str| {
        (!re.is_empty())
            .then(|| Regex::new(re))
            .transpose()
            .map_err(|e| e.to_string())
    };
    let include = compile(&sub.filter)?;
    let exclude = compile(&sub.exclude_filter)?;
    let excluded_types: Vec<String> = sub
        .exclude_type
        .split('|')
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();

    let mut counters: HashMap<String, usize> = HashMap::new();
    let mut used = std::collections::HashSet::new();
    let mut result = vec![];
    for proxy in proxies {
        if include.as_ref().is_some_and(|re| !re.is_match(&proxy.name))
            || exclude.as_ref().is_some_and(|re| re.is_match(&proxy.name))
            || protocol_names(&proxy.outbound)
                .iter()
                .any(|p| excluded_types.iter().any(|t| t == p))
        {
            continue;
        }

        let name = sanitize_name(&proxy.name);
        // Чистый тег подписки занят outbound'ом активного сервера (см. `with_active_alias`).
        let mut tag = if name.is_empty() {
            format!("{}--server", sub.tag)
        } else {
            format!("{}--{}", sub.tag, name)
        };
        // Нумеруем повторы, пока тег не станет уникальным (имя сервера само может быть «NL--2»).
        let base = tag.clone();
        while used.contains(&tag) {
            let count = counters.entry(base.clone()).or_insert(1);
            *count += 1;
            tag = format!("{base}--{count}");
        }
        used.insert(tag.clone());

        let mut outbound = serde_json::Map::new();
        outbound.insert("tag".into(), json!(tag));
        if let Value::Object(fields) = proxy.outbound {
            outbound.extend(fields);
        }
        let mut outbound = Value::Object(outbound);
        if !sub.fingerprint.is_empty() {
            for key in ["tlsSettings", "realitySettings"] {
                if let Some(obj) = outbound
                    .pointer_mut(&format!("/streamSettings/{key}"))
                    .and_then(Value::as_object_mut)
                {
                    obj.insert("fingerprint".into(), json!(sub.fingerprint));
                }
            }
        }
        result.push(outbound);
    }
    Ok(result)
}

/// Имя протокола в Xray и его название в Mihomo (для `exclude_type`).
fn protocol_names(outbound: &Value) -> [&str; 2] {
    let protocol = outbound.get("protocol").and_then(Value::as_str).unwrap_or("");
    let alias = match protocol {
        "shadowsocks" => "ss",
        "hysteria" => "hysteria2",
        other => other,
    };
    [protocol, alias]
}

/// Как в xkeen-subscription-watcher: буквы, цифры, пробел, «-» и «_» (эмодзи-флаги отбрасываются).
fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// serde_json без `preserve_order` сортирует ключи, а `tag` и `protocol` удобнее видеть первыми.
#[derive(Serialize)]
struct OrderedOutbound<'a> {
    tag: &'a Value,
    protocol: &'a Value,
    #[serde(flatten)]
    rest: std::collections::BTreeMap<&'a str, &'a Value>,
}

#[derive(Serialize)]
struct OutboundsFile<'a> {
    outbounds: Vec<OrderedOutbound<'a>>,
}

fn render_outbounds(outbounds: &[Value]) -> String {
    let file = OutboundsFile {
        outbounds: outbounds
            .iter()
            .filter_map(Value::as_object)
            .map(|o| OrderedOutbound {
                tag: &o["tag"],
                protocol: &o["protocol"],
                rest: o
                    .iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "tag" | "protocol"))
                    .map(|(k, v)| (k.as_str(), v))
                    .collect(),
            })
            .collect(),
    };
    let mut content = serde_json::to_string_pretty(&file).unwrap();
    content.push('\n');
    content
}

/// Записывает outbounds, если содержимое изменилось. Возвращает true при изменении.
async fn write_outbounds(tag: &str, outbounds: &[Value]) -> Result<bool, String> {
    let path = outbounds_path(tag);
    let content = render_outbounds(outbounds);
    let legacy_removed = tokio::fs::remove_file(legacy_outbounds_path(tag)).await.is_ok();
    if tokio::fs::read(&path)
        .await
        .is_ok_and(|existing| existing == content.as_bytes())
    {
        return Ok(legacy_removed);
    }
    tokio::fs::create_dir_all(XRAY_CONF_DIR)
        .await
        .map_err(|e| e.to_string())?;
    // Без расширения .json, чтобы Xray не подхватил недописанный файл.
    let tmp = PathBuf::from(XRAY_CONF_DIR).join(format!(".04_outbounds_sub.{tag}.tmp"));
    tokio::fs::write(&tmp, content)
        .await
        .map_err(|e| format!("ошибка записи {}: {}", tmp.display(), e))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("ошибка записи {}: {}", path.display(), e))?;
    Ok(true)
}

/// Обновляет подписку и её статус. Возвращает true, если файл outbounds изменился.
async fn refresh(state: &AppState, sub: &mut Subscription) -> Result<bool, String> {
    sub.last_attempt = now();
    let result = async {
        let fetched = fetch_subscription(state, sub).await?;
        let enabled = enabled_outbounds(sub, &fetched.outbounds)?;
        let count = enabled.len();
        let changed = write_outbounds(&sub.tag, &with_active_alias(sub, enabled)).await?;
        Ok::<_, String>((fetched, count, changed))
    }
    .await;

    match result {
        Ok((fetched, enabled, changed)) => {
            sub.last_update = sub.last_attempt;
            sub.last_error = None;
            sub.servers = enabled;
            sub.total_servers = fetched.outbounds.len();
            sub.cached_outbounds = fetched.outbounds.clone();
            sub.userinfo = fetched.userinfo;
            let skipped = if fetched.errors.is_empty() {
                String::new()
            } else {
                for e in &fetched.errors {
                    log("WARN", format!("Подписка «{}»: пропущен сервер {}", sub.tag, e));
                }
                format!(", пропущено: {}", fetched.errors.len())
            };
            log(
                "INFO",
                format!(
                    "Подписка «{}» обновлена: серверов {} из {}{}{}",
                    sub.tag,
                    sub.servers,
                    sub.total_servers,
                    skipped,
                    if changed { "" } else { ", без изменений" }
                ),
            );
            Ok(changed)
        }
        Err(e) => {
            log("ERROR", format!("Не удалось обновить подписку «{}»: {}", sub.tag, e));
            sub.last_error = Some(e.clone());
            Err(e)
        }
    }
}

/// Перезапускает Xray, если он сейчас активное и запущенное ядро.
async fn restart_xray_if_running(state: &AppState) -> Option<String> {
    if state.core.read().unwrap().name != "xray" || crate::controller::get_pid("xray").is_empty() {
        return None;
    }
    log("INFO", "Перезапуск Xray после обновления подписок".into());
    crate::controller::soft_restart("xray").await.err()
}

/// Завершение любого изменения: при необходимости назначает подписку «Для прокси»,
/// направляет на неё проксируемые правила routing и перезапускает Xray, если что-то изменилось.
async fn finish_change(state: &AppState, store: &mut Store, mut changed: bool) -> Option<String> {
    if !store.subscriptions.iter().any(|s| s.proxy) {
        if let Some(first) = store.subscriptions.first_mut() {
            first.proxy = true;
            log(
                "INFO",
                format!("Подписка «{}» назначена для проксируемого трафика", first.tag),
            );
            if let Err(e) = save_store(store).await {
                log("ERROR", format!("Ошибка записи {}: {}", SUBSCRIPTIONS_FILE, e));
            }
        }
    }
    if let Some(target) = store.subscriptions.iter().find(|s| s.proxy) {
        match routing::sync(&target.tag).await {
            Ok(routing_changed) => changed |= routing_changed,
            Err(e) => log("ERROR", format!("Не удалось обновить маршрутизацию: {e}")),
        }
    }
    if changed {
        restart_xray_if_running(state).await
    } else {
        None
    }
}

// ---------- планировщик ----------

pub fn start_scheduler(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_TICK).await;
            if state.core.read().unwrap().name != "xray" {
                continue;
            }
            let _guard = STORE_LOCK.lock().await;
            let mut store = load_store().await;
            let now = now();
            let mut touched = false;
            let mut changed = false;
            for sub in store.subscriptions.iter_mut().filter(|s| s.is_due(now)) {
                touched = true;
                changed |= refresh(&state, sub).await.unwrap_or(false);
            }
            if !touched {
                continue;
            }
            if let Err(e) = save_store(&store).await {
                log("ERROR", format!("Ошибка записи {}: {}", SUBSCRIPTIONS_FILE, e));
            }
            if let Some(e) = finish_change(&state, &mut store, changed).await {
                log("ERROR", e);
            }
        }
    });
}

// ---------- API ----------

fn fail(error: impl Into<String>) -> Json<Value> {
    Json(json!({ "success": false, "error": error.into() }))
}

fn server_summary(sub: &Subscription, outbound: &Value) -> Value {
    let settings = &outbound["settings"];
    // Плоский формат, vnext (vless/vmess) или servers (trojan/ss из JSON-подписок).
    let field = |key: &str| {
        settings
            .get(key)
            .or_else(|| settings.pointer(&format!("/vnext/0/{key}")))
            .or_else(|| settings.pointer(&format!("/servers/0/{key}")))
    };
    let (address, port) = (field("address"), field("port"));
    json!({
        "tag": outbound["tag"],
        "protocol": outbound["protocol"],
        "address": address,
        "port": port,
        "disabled": is_disabled(sub, outbound),
    })
}

/// Подписка для клиента: вместо полных outbounds — краткий список серверов.
fn to_api(sub: &Subscription) -> Value {
    let mut value = serde_json::to_value(sub).unwrap();
    if let Some(obj) = value.as_object_mut() {
        obj.remove("cached_outbounds");
        let servers: Vec<Value> = sub.cached_outbounds.iter().map(|o| server_summary(sub, o)).collect();
        obj.insert("server_list".into(), json!(servers));
    }
    value
}

fn list_to_api(subs: &[Subscription]) -> Vec<Value> {
    subs.iter().map(to_api).collect()
}

pub async fn get_subscriptions() -> impl IntoResponse {
    Json(json!({ "success": true, "subscriptions": list_to_api(&load_store().await.subscriptions) }))
}

/// Скачивает подписку и показывает, какие серверы получатся, ничего не сохраняя.
pub async fn post_preview(State(state): State<AppState>, Json(mut sub): Json<Subscription>) -> impl IntoResponse {
    sub.normalize();
    if sub.tag.is_empty() {
        sub.tag = "preview".into();
    }
    if let Err(e) = sub.validate() {
        return fail(e);
    }
    match fetch_subscription(&state, &sub).await {
        Ok(fetched) => {
            let servers: Vec<Value> = fetched.outbounds.iter().map(|o| server_summary(&sub, o)).collect();
            Json(
                json!({ "success": true, "servers": servers, "skipped": fetched.errors, "userinfo": fetched.userinfo }),
            )
        }
        Err(e) => fail(e),
    }
}

pub async fn post_subscription(State(state): State<AppState>, Json(mut sub): Json<Subscription>) -> impl IntoResponse {
    sub.normalize();
    sub.reset_status();
    if let Err(e) = sub.validate() {
        return fail(e);
    }

    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    if store.subscriptions.iter().any(|s| s.tag == sub.tag) {
        return fail(format!("Подписка «{}» уже существует", sub.tag));
    }
    // Тег подписки станет тегом outbound: совпадение с существующим (например, «direct»)
    // заменило бы его при склейке конфигов Xray.
    let conf_files = routing::read_conf_files().await;
    if let Some((_, file)) = routing::outbound_tags(&conf_files)
        .into_iter()
        .find(|(tag, _)| *tag == sub.tag)
    {
        return fail(format!(
            "Тег «{}» уже используется outbound'ом в {}, выберите другое название",
            sub.tag,
            file.path.display()
        ));
    }
    if let Some(path) = [outbounds_path(&sub.tag), legacy_outbounds_path(&sub.tag)]
        .into_iter()
        .find(|p| p.exists())
    {
        return fail(format!(
            "Файл {} уже существует, выберите другое название",
            path.display()
        ));
    }

    if let Err(e) = refresh(&state, &mut sub).await {
        return fail(e);
    }
    store.subscriptions.push(sub.clone());
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    let restart_error = finish_change(&state, &mut store, true).await;
    // finish_change мог назначить подписку «Для прокси» — отдаём актуальную версию.
    let saved = store.subscriptions.iter().find(|s| s.tag == sub.tag).unwrap_or(&sub);
    Json(json!({ "success": true, "subscription": to_api(saved), "restart_error": restart_error }))
}

pub async fn patch_subscription(State(state): State<AppState>, Json(mut sub): Json<Subscription>) -> impl IntoResponse {
    sub.normalize();
    if let Err(e) = sub.validate() {
        return fail(e);
    }

    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    let Some(existing) = store.subscriptions.iter_mut().find(|s| s.tag == sub.tag) else {
        return fail(format!("Подписка «{}» не найдена", sub.tag));
    };
    sub.keep_status(existing);
    let result = refresh(&state, &mut sub).await;
    *existing = sub.clone();
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    match result {
        Ok(changed) => {
            let restart_error = finish_change(&state, &mut store, changed).await;
            Json(json!({ "success": true, "subscription": to_api(&sub), "restart_error": restart_error }))
        }
        Err(e) => fail(format!("Настройки сохранены, но обновить подписку не удалось: {e}")),
    }
}

#[derive(Deserialize)]
pub struct TagQuery {
    tag: String,
}

pub async fn delete_subscription(State(state): State<AppState>, Query(q): Query<TagQuery>) -> impl IntoResponse {
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    let before = store.subscriptions.len();
    store.subscriptions.retain(|s| s.tag != q.tag);
    if store.subscriptions.len() == before {
        return fail(format!("Подписка «{}» не найдена", q.tag));
    }
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    let removed = tokio::fs::remove_file(outbounds_path(&q.tag)).await.is_ok();
    let legacy_removed = tokio::fs::remove_file(legacy_outbounds_path(&q.tag)).await.is_ok();
    log("INFO", format!("Подписка «{}» удалена", q.tag));
    // Если удалили подписку «Для прокси», флаг перейдёт к первой оставшейся вместе с правилами.
    let restart_error = finish_change(&state, &mut store, removed || legacy_removed).await;
    Json(json!({ "success": true, "restart_error": restart_error }))
}

#[derive(Deserialize)]
pub struct ServersReq {
    tag: String,
    disabled_servers: Vec<String>,
}

/// Включает/отключает серверы по последнему полученному списку, без запроса подписки.
pub async fn post_servers(State(state): State<AppState>, Json(req): Json<ServersReq>) -> impl IntoResponse {
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    let Some(sub) = store.subscriptions.iter_mut().find(|s| s.tag == req.tag) else {
        return fail(format!("Подписка «{}» не найдена", req.tag));
    };
    let mut updated = sub.clone();
    updated.disabled_servers = req.disabled_servers;
    updated.normalize();
    let changed = match apply_cached(&mut updated).await {
        Ok(changed) => changed,
        Err(e) => return fail(e),
    };
    *sub = updated.clone();
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    let restart_error = finish_change(&state, &mut store, changed).await;
    Json(json!({ "success": true, "subscription": to_api(&updated), "restart_error": restart_error }))
}

#[derive(Deserialize)]
pub struct ProxyReq {
    tag: String,
}

/// Назначает подписку «Для прокси» и направляет на неё проксируемые правила routing.
pub async fn post_proxy(State(state): State<AppState>, Json(req): Json<ProxyReq>) -> impl IntoResponse {
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    if !store.subscriptions.iter().any(|s| s.tag == req.tag) {
        return fail(format!("Подписка «{}» не найдена", req.tag));
    }
    for sub in &mut store.subscriptions {
        sub.proxy = sub.tag == req.tag;
    }
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    log(
        "INFO",
        format!("Подписка «{}» назначена для проксируемого трафика", req.tag),
    );
    let restart_error = finish_change(&state, &mut store, false).await;
    Json(json!({ "success": true, "subscriptions": list_to_api(&store.subscriptions), "restart_error": restart_error }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RefreshReq {
    /// Не указан — обновить все.
    tag: Option<String>,
}

pub async fn post_refresh(State(state): State<AppState>, Json(req): Json<RefreshReq>) -> impl IntoResponse {
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    let mut changed = false;
    let mut errors = vec![];
    let mut found = false;
    for sub in store
        .subscriptions
        .iter_mut()
        .filter(|s| req.tag.as_ref().is_none_or(|t| *t == s.tag))
    {
        found = true;
        match refresh(&state, sub).await {
            Ok(c) => changed |= c,
            Err(e) => errors.push(format!("{}: {}", sub.tag, e)),
        }
    }
    if !found {
        return fail(match req.tag {
            Some(tag) => format!("Подписка «{tag}» не найдена"),
            None => "Нет подписок".into(),
        });
    }
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    let restart_error = finish_change(&state, &mut store, changed).await;
    Json(json!({
        "success": errors.is_empty(),
        "error": (!errors.is_empty()).then(|| errors.join("\n")),
        "changed": changed,
        "subscriptions": list_to_api(&store.subscriptions),
        "restart_error": restart_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(name: &str) -> parser::ParsedProxy {
        parser::ParsedProxy {
            name: name.into(),
            outbound: json!({ "protocol": "vless", "streamSettings": { "realitySettings": { "fingerprint": "chrome" } } }),
        }
    }

    #[test]
    fn tags_filters_and_fingerprint() {
        let sub = Subscription {
            tag: "sub".into(),
            exclude_filter: "(?i)expire".into(),
            exclude_type: "trojan | SS".into(),
            fingerprint: "safari".into(),
            ..Default::default()
        };
        let out = build_outbounds(
            &sub,
            vec![
                proxy("🇳🇱 NL #1"),
                proxy("🇳🇱 NL #1"),
                proxy(""),
                proxy("Expires soon"),
                parser::ParsedProxy {
                    name: "SS".into(),
                    outbound: json!({ "protocol": "shadowsocks" }),
                },
            ],
        )
        .unwrap();
        let tags: Vec<_> = out.iter().map(|o| o["tag"].as_str().unwrap()).collect();
        assert_eq!(tags, ["sub--NL 1", "sub--NL 1--2", "sub--server"]);

        // имя сервера совпадает с автонумерацией повтора
        let dup = build_outbounds(&sub, vec![proxy("A"), proxy("A--2"), proxy("A")]).unwrap();
        let dup_tags: Vec<_> = dup.iter().map(|o| o["tag"].as_str().unwrap()).collect();
        assert_eq!(dup_tags, ["sub--A", "sub--A--2", "sub--A--3"]);
        assert_eq!(out[0]["streamSettings"]["realitySettings"]["fingerprint"], "safari");
        let rendered = render_outbounds(&out[..1]);
        assert!(rendered.starts_with(
            "{\n  \"outbounds\": [\n    {\n      \"tag\": \"sub--NL 1\",\n      \"protocol\": \"vless\","
        ));
    }

    #[test]
    fn disabled_servers() {
        let all = vec![json!({ "tag": "sub--NL" }), json!({ "tag": "sub--DE" })];
        let mut sub = Subscription {
            tag: "sub".into(),
            disabled_servers: vec![" sub--NL ".into(), "".into(), "sub--gone".into()],
            ..Default::default()
        };
        sub.normalize();
        assert_eq!(sub.disabled_servers, ["sub--NL", "sub--gone"]);
        let enabled = enabled_outbounds(&sub, &all).unwrap();
        assert_eq!(enabled, vec![json!({ "tag": "sub--DE" })]);
        sub.disabled_servers.push("sub--DE".into());
        assert!(enabled_outbounds(&sub, &all).is_err());
    }

    #[test]
    fn api_hides_outbounds() {
        let sub = Subscription {
            tag: "sub".into(),
            disabled_servers: vec!["sub--DE".into()],
            cached_outbounds: vec![
                json!({ "tag": "sub--NL", "protocol": "vless", "settings": { "address": "a", "port": 1, "id": "secret" } }),
                json!({ "tag": "sub--DE", "protocol": "trojan", "settings": { "address": "b", "port": 2, "password": "secret" } }),
            ],
            ..Default::default()
        };
        let ss = json!({ "tag": "sub--SS", "protocol": "shadowsocks", "settings": { "servers": [{ "address": "c", "port": 3 }] } });
        assert_eq!(server_summary(&sub, &ss)["address"], "c");
        let api = to_api(&sub);
        assert!(api.get("cached_outbounds").is_none());
        assert!(!api.to_string().contains("secret"));
        assert_eq!(
            api["server_list"],
            json!([
                { "tag": "sub--NL", "protocol": "vless", "address": "a", "port": 1, "disabled": false },
                { "tag": "sub--DE", "protocol": "trojan", "address": "b", "port": 2, "disabled": true },
            ])
        );
    }

    #[test]
    fn active_alias() {
        let enabled = vec![
            json!({ "tag": "s--A", "protocol": "vless" }),
            json!({ "tag": "s--B", "protocol": "trojan" }),
        ];
        let mut sub = Subscription {
            tag: "s".into(),
            ..Default::default()
        };
        // без выбора под тегом подписки — первый сервер
        let out = with_active_alias(&sub, enabled.clone());
        assert_eq!((out.len(), &out[0]), (3, &json!({ "tag": "s", "protocol": "vless" })));

        sub.primary = "s--B".into();
        let out = with_active_alias(&sub, enabled.clone());
        assert_eq!((out.len(), &out[0]), (3, &json!({ "tag": "s", "protocol": "trojan" })));

        // выбранный отключён — под тегом первый включённый
        assert_eq!(with_active_alias(&sub, enabled[..1].to_vec())[0]["protocol"], "vless");
    }

    #[test]
    fn userinfo_header() {
        let info = parse_userinfo("upload=10; download=2.5e3; total=1000000; expire=1767225600");
        assert_eq!(
            (info.upload, info.download, info.total, info.expire),
            (10, 2500, 1000000, 1767225600)
        );
    }

    #[test]
    fn due_logic() {
        let mut sub = Subscription {
            interval: 3600,
            last_update: 1000,
            last_attempt: 1000,
            ..Default::default()
        };
        assert!(!sub.is_due(4000));
        assert!(sub.is_due(4600));
        sub.last_error = Some("x".into());
        sub.last_attempt = 4600;
        assert!(!sub.is_due(5000));
        assert!(sub.is_due(4600 + MAX_RETRY_DELAY));
        sub.interval = 0;
        assert!(!sub.is_due(i64::MAX));
    }

    #[test]
    fn validation() {
        let ok = Subscription {
            tag: "my_sub-1".into(),
            url: "https://x".into(),
            hwid: "AB".into(),
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
        assert!(
            Subscription {
                tag: "a--b".into(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Subscription {
                hwid: String::new(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Subscription {
                tag: "bad tag".into(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Subscription {
                tag: "../x".into(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Subscription {
                interval: 10,
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
        assert!(
            Subscription {
                filter: "(".into(),
                ..ok.clone()
            }
            .validate()
            .is_err()
        );
    }
}
