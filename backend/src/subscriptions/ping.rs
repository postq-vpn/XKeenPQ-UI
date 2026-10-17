//! Пинг серверов подписок реальным запросом через сервер (как «URL test» в v2rayN/Clash).
//!
//! Панель запускает временный Xray: для каждого сервера — свой HTTP-прокси на 127.0.0.1, ведущий
//! через этот сервер. Через каждый прокси делается запрос к `PING_URL`; время ответа — это пинг.
//! Так проверяется, что VPN реально работает (ключи, Reality/TLS, Hysteria2 по UDP), а не только то,
//! что порт открыт. Серверы, которых нет в сохранённых подписках, проверяются TCP-соединением.

use super::*;
use futures_util::stream::{self, StreamExt};
use std::process::Stdio;
use std::time::Instant;

const PING_URL: &str = "https://www.gstatic.com/generate_204";
/// Таймаут запроса через сервер (включая TLS-рукопожатие с сервером и с PING_URL).
const PING_TIMEOUT: Duration = Duration::from_secs(6);
/// Сколько ждём, пока временный Xray поднимет локальные прокси.
const XRAY_START_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PING_TARGETS: usize = 256;
/// Одновременных запросов через временный Xray — не перегружаем роутер.
const CONCURRENCY: usize = 16;

/// Проверки не идут параллельно: каждая запускает свой временный Xray.
static PING_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Deserialize)]
pub struct PingTarget {
    tag: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    port: u16,
}

#[derive(Deserialize)]
pub struct PingReq {
    servers: Vec<PingTarget>,
}

/// Время установки TCP-соединения с сервером (включая DNS), мс.
pub async fn tcp_ping(address: &str, port: u16) -> Result<u64, String> {
    let start = Instant::now();
    match tokio::time::timeout(TCP_TIMEOUT, tokio::net::TcpStream::connect((address, port))).await {
        Ok(Ok(_)) => Ok(start.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("таймаут".into()),
    }
}

/// Свободные локальные порты для прокси временного Xray.
fn free_ports(count: usize) -> Result<Vec<u16>, String> {
    let listeners = (0..count)
        .map(|_| std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    listeners
        .iter()
        .map(|l| l.local_addr().map(|a| a.port()).map_err(|e| e.to_string()))
        .collect()
}

/// Конфиг временного Xray: HTTP-прокси `in-N` на `ports[N]` ведёт в outbound `out-N` (сервер N).
fn build_config(outbounds: &[Value], ports: &[u16]) -> Value {
    let inbounds: Vec<Value> = ports
        .iter()
        .enumerate()
        .map(|(i, port)| json!({ "tag": format!("in-{i}"), "listen": "127.0.0.1", "port": port, "protocol": "http" }))
        .collect();
    let outbounds: Vec<Value> = outbounds
        .iter()
        .enumerate()
        .map(|(i, o)| {
            let mut o = o.clone();
            o["tag"] = json!(format!("out-{i}"));
            o
        })
        .collect();
    let rules: Vec<Value> = (0..ports.len())
        .map(|i| json!({ "inboundTag": [format!("in-{i}")], "outboundTag": format!("out-{i}") }))
        .collect();
    json!({
        "log": { "loglevel": "none" },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": { "rules": rules },
    })
}

/// Ждёт, пока временный Xray начнёт слушать порт; false — если он завершился или не успел.
async fn wait_listening(child: &mut tokio::process::Child, port: u16, deadline: tokio::time::Instant) -> bool {
    while tokio::time::Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return true;
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Один запрос к PING_URL через локальный прокси, мс.
async fn url_ping(port: u16) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?)
        .timeout(PING_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    match client.get(PING_URL).send().await {
        Ok(resp) if resp.status().is_success() => Ok(start.elapsed().as_millis() as u64),
        Ok(resp) => Err(format!("HTTP {}", resp.status().as_u16())),
        Err(e) if e.is_timeout() => Err("таймаут".into()),
        Err(_) => Err("сервер не отвечает".into()),
    }
}

/// Проверяет outbounds через временный Xray. Ошибка — если Xray не удалось запустить.
async fn ping_through_xray(outbounds: &[Value]) -> Result<Vec<Result<u64, String>>, String> {
    let ports = free_ports(outbounds.len())?;
    let config = build_config(outbounds, &ports);
    let path = std::env::temp_dir().join(format!("xkeen-ui-ping-{}.json", std::process::id()));
    tokio::fs::write(&path, serde_json::to_vec(&config).unwrap())
        .await
        .map_err(|e| format!("ошибка записи {}: {e}", path.display()))?;

    let mut cmd = tokio::process::Command::new("xray");
    cmd.args(["run", "-c"])
        .arg(&path)
        .env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Как основной Xray (controller::soft_restart): трафик группы 11111 XKeen не заворачивает
    // обратно в прокси, иначе проверка ушла бы по кругу.
    unsafe {
        cmd.pre_exec(|| {
            nix::unistd::setgid(nix::unistd::Gid::from_raw(11111))?;
            Ok(())
        });
    }
    let child = cmd.spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            _ = tokio::fs::remove_file(&path).await;
            return Err(format!("не удалось запустить Xray: {e}"));
        }
    };

    let deadline = tokio::time::Instant::now() + XRAY_START_TIMEOUT;
    let ready = wait_listening(&mut child, ports[0], deadline).await;
    _ = tokio::fs::remove_file(&path).await;
    if !ready {
        _ = child.kill().await;
        let mut stderr = String::new();
        if let Some(mut err) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            _ = tokio::time::timeout(Duration::from_millis(300), err.read_to_string(&mut stderr)).await;
        }
        let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("нет ответа");
        return Err(format!("временный Xray не запустился: {detail}"));
    }

    let results = stream::iter(ports.iter().copied())
        .map(url_ping)
        .buffered(CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    _ = child.kill().await;
    Ok(results)
}

/// Пинг серверов: `{ results: { tag: { ms, error } } }`.
pub async fn post_ping(Json(req): Json<PingReq>) -> impl IntoResponse {
    if req.servers.len() > MAX_PING_TARGETS {
        return fail(format!("Слишком много серверов для проверки (максимум {MAX_PING_TARGETS})"));
    }
    let _guard = PING_LOCK.lock().await;

    // Outbounds серверов из сохранённых подписок.
    let store = load_store().await;
    let known: HashMap<&str, &Value> = store
        .subscriptions
        .iter()
        .flat_map(|s| s.cached_outbounds.iter())
        .filter_map(|o| Some((o["tag"].as_str()?, o)))
        .collect();
    let (via_xray, via_tcp): (Vec<&PingTarget>, Vec<&PingTarget>) =
        req.servers.iter().partition(|t| known.contains_key(t.tag.as_str()));

    let mut results = serde_json::Map::new();
    if !via_xray.is_empty() {
        let outbounds: Vec<Value> = via_xray.iter().map(|t| known[t.tag.as_str()].clone()).collect();
        match ping_through_xray(&outbounds).await {
            Ok(list) => {
                for (t, r) in via_xray.iter().zip(list) {
                    results.insert(t.tag.clone(), ping_json(r));
                }
            }
            Err(e) => {
                log("ERROR", format!("Пинг серверов: {e}"));
                for t in &via_xray {
                    results.insert(t.tag.clone(), json!({ "ms": null, "error": e }));
                }
            }
        }
    }
    let tcp_targets: Vec<(String, String, u16)> =
        via_tcp.iter().map(|t| (t.tag.clone(), t.address.clone(), t.port)).collect();
    let tcp = futures_util::future::join_all(tcp_targets.into_iter().map(|(tag, address, port)| async move {
        let r = tcp_ping(&address, port).await;
        (tag, r)
    }))
    .await;
    for (tag, r) in tcp {
        results.insert(tag, ping_json(r));
    }
    Json(json!({ "success": true, "results": results }))
}

fn ping_json(r: Result<u64, String>) -> Value {
    match r {
        Ok(ms) => json!({ "ms": ms }),
        Err(e) => json!({ "ms": null, "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ping_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(tcp_ping("127.0.0.1", port).await.is_ok());
        drop(listener);
        assert!(tcp_ping("127.0.0.1", port).await.is_err());
    }

    #[test]
    fn config_maps_each_proxy_to_its_server() {
        let outbounds = vec![
            json!({ "tag": "sub--NL", "protocol": "vless" }),
            json!({ "tag": "sub--DE", "protocol": "trojan" }),
        ];
        let config = build_config(&outbounds, &[20001, 20002]);
        assert_eq!(config["inbounds"][1]["port"], 20002);
        assert_eq!(config["inbounds"][1]["protocol"], "http");
        assert_eq!(config["outbounds"][1]["tag"], "out-1");
        assert_eq!(config["outbounds"][1]["protocol"], "trojan");
        assert_eq!(config["routing"]["rules"][1]["inboundTag"][0], "in-1");
        assert_eq!(config["routing"]["rules"][1]["outboundTag"], "out-1");
    }
}
