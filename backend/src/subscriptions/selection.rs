//! Выбор сервера подписки и TCP-пинг серверов.

use super::*;
use futures_util::future::join_all;
use std::time::Instant;

const PING_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PING_TARGETS: usize = 256;

/// Время установки TCP-соединения с сервером (включая DNS), мс.
pub async fn tcp_ping(address: &str, port: u16) -> Result<u64, String> {
    let start = Instant::now();
    match tokio::time::timeout(PING_TIMEOUT, tokio::net::TcpStream::connect((address, port))).await {
        Ok(Ok(_)) => Ok(start.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("таймаут".into()),
    }
}

#[derive(Deserialize)]
pub struct PingTarget {
    tag: String,
    address: String,
    port: u16,
    #[serde(default)]
    protocol: String,
}

#[derive(Deserialize)]
pub struct PingReq {
    servers: Vec<PingTarget>,
}

/// Параллельный TCP-пинг списка серверов: `{ results: { tag: { ms, error } } }`.
pub async fn post_ping(Json(req): Json<PingReq>) -> impl IntoResponse {
    if req.servers.len() > MAX_PING_TARGETS {
        return fail(format!(
            "Слишком много серверов для проверки (максимум {MAX_PING_TARGETS})"
        ));
    }
    let results = join_all(req.servers.into_iter().map(|t| async move {
        // Hysteria работает по UDP — TCP-пингом её не проверить.
        let value = if t.protocol == "hysteria" {
            json!({ "ms": null, "error": "UDP — TCP-пинг недоступен" })
        } else {
            match tcp_ping(&t.address, t.port).await {
                Ok(ms) => json!({ "ms": ms }),
                Err(e) => json!({ "ms": null, "error": e }),
            }
        };
        (t.tag, value)
    }))
    .await;
    Json(json!({ "success": true, "results": results.into_iter().collect::<serde_json::Map<_, _>>() }))
}

#[derive(Deserialize)]
pub struct PrimaryReq {
    tag: String,
    /// Пусто — автоматически первый включённый сервер.
    #[serde(default)]
    primary: String,
}

/// Выбирает сервер, который будет работать под тегом подписки.
pub async fn post_primary(Json(req): Json<PrimaryReq>) -> impl IntoResponse {
    let primary = req.primary.trim().to_string();
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    let Some(sub) = store.subscriptions.iter_mut().find(|s| s.tag == req.tag) else {
        return fail(format!("Подписка «{}» не найдена", req.tag));
    };
    if !primary.is_empty() && !sub.cached_outbounds.iter().any(|o| o["tag"] == primary) {
        return fail("Сервер не найден в подписке");
    }

    let mut updated = sub.clone();
    // Выбранный сервер не может быть отключён.
    updated.disabled_servers.retain(|t| *t != primary);
    updated.primary = primary;
    let changed = match apply_cached(&mut updated).await {
        Ok(changed) => changed,
        Err(e) => return fail(e),
    };
    *sub = updated.clone();
    if let Err(e) = save_store(&store).await {
        return fail(e);
    }
    log(
        "INFO",
        if updated.primary.is_empty() {
            format!("Подписка «{}»: сервер выбирается автоматически", updated.tag)
        } else {
            format!("Подписка «{}»: выбран сервер «{}»", updated.tag, updated.primary)
        },
    );
    let restart_error = finish_change(&mut store, changed).await;
    Json(json!({ "success": true, "subscription": to_api(&updated), "restart_error": restart_error }))
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
}
