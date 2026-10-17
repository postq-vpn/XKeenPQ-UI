//! Выбор сервера подписки.

use super::*;

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
