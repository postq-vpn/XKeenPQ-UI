//! Модель роутера и версия ОС из RCI — для заголовков `x-device-model` и `x-ver-os`.

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
