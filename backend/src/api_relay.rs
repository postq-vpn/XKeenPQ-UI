use axum::extract::State;
use axum::response::{IntoResponse, Json};
use std::time::Duration;

use crate::types::AppState;

pub async fn get_device_list(State(state): State<AppState>) -> impl IntoResponse {
    let mut req = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/device-list")
        .timeout(Duration::from_secs(5));
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }
    let response = match req.send().await {
        Ok(response) => response,
        Err(e) => return Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    };

    if !response.status().is_success() {
        return Json(serde_json::json!({
            "success": false,
            "error": format!("Ошибка RCI: {}", response.status()),
        }));
    }

    match response.json::<serde_json::Value>().await {
        Ok(data) => Json(serde_json::json!({
            "success": true,
            "host": data.get("host").cloned().unwrap_or_else(|| serde_json::json!([])),
        })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}
