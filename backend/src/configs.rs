use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct DeleteReq {
    file: String,
}
#[derive(Deserialize)]
pub struct RenameReq {
    file: String,
    new_file: String,
}

async fn collect_configs(paths: &[String]) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        if path.is_dir() {
            match tokio::fs::read_dir(path).await {
                Err(e) => {
                    log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e));
                }
                Ok(mut entries) => {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let entry_path = entry.path();
                        if entry_path.extension().is_some_and(|e| e == "json") {
                            match tokio::fs::read_to_string(&entry_path).await {
                                Ok(content) => results.push(ConfigItem {
                                    file: entry_path.to_string_lossy().into(),
                                    content,
                                }),
                                Err(e) => {
                                    log(
                                        "ERROR",
                                        format!("Не удалось прочитать файл {}: {}", entry_path.display(), e),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        } else if path.exists() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem {
                    file: path_str.clone(),
                    content,
                }),
                Err(e) => {
                    log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e));
                }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(State(state): State<AppState>) -> impl IntoResponse {
    let core_paths = {
        let settings = state.settings.read().unwrap();
        let mut paths = vec![XRAY_CONF_DIR.to_string()];
        paths.extend(settings.append_config_paths.xray.clone());
        paths
    };

    let mut core_configs = collect_configs(&core_paths).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if (path.extension().is_some_and(|e| e == "lst") || name == "xkeen.json")
                && let Ok(content) = tokio::fs::read_to_string(&path).await {
                    lst_configs.push(ConfigItem {
                        file: path.to_string_lossy().into(),
                        content,
                    });
                }
        }
    }

    lst_configs.sort_by(|a, b| a.file.cmp(&b.file));
    core_configs.append(&mut lst_configs);

    Json(serde_json::json!({ "success": true, "configs": core_configs }))
}

fn get_allowed_prefixes(state: &AppState, is_lst: bool) -> Vec<String> {
    if is_lst {
        return vec![XKEEN_CONF_DIR.to_string()];
    }
    let settings = state.settings.read().unwrap();
    let mut paths = vec![XRAY_CONF_DIR.to_string()];
    paths.extend(settings.append_config_paths.xray.clone());
    paths
}

fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        let prefix_path = Path::new(prefix.as_str());
        let file_path = Path::new(file);
        if prefix_path.is_dir() {
            file_path.starts_with(prefix_path)
        } else {
            file == prefix
        }
    })
}

fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let is_xkeen = file.ends_with(".lst") || (file.ends_with(".json") && file.starts_with(XKEEN_CONF_DIR));
    let prefixes = get_allowed_prefixes(state, is_xkeen);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

pub async fn put_config(
    State(state): State<AppState>, Query(params): Query<HashMap<String, String>>,
    Json(req): Json<ConfigReq>,
) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(error) => return api_error(error)
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };

    if let Some(core_type) = params.get("validate")
        && core_type == "xray" {
            let mut validate_files = Vec::new();
            if let Ok(mut entries) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
                let mut found_current = false;
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let path = entry.path();
                    if path.extension().is_some_and(|e| e == "json") {
                        let path_str = path.to_string_lossy().into_owned();
                        let file_content = if path_str == req.file {
                            found_current = true;
                            content.clone()
                        } else {
                            tokio::fs::read_to_string(&path).await.unwrap_or_default()
                        };
                        validate_files.push(ConfigReq {
                            file: path_str,
                            content: file_content,
                        });
                    }
                }
                if !found_current {
                    validate_files.push(ConfigReq {
                        file: req.file.clone(),
                        content: content.clone(),
                    });
                }
            } else {
                validate_files.push(ConfigReq {
                    file: req.file.clone(),
                    content: content.clone(),
                });
            }

            if let Err(err_msg) = validate_core(&validate_files).await {
                log("ERROR", err_msg);
                return api_error("Validation failed");
            }
        }

    if fs::write(&req.file, &content).is_err() {
        return api_error("Write error");
    }
    api_ok()
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(error) => return api_error(error)
    };
    if Path::new(&req.file).exists() {
        return api_error("File already exists");
    }
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    if fs::write(&req.file, content).is_err() {
        return api_error("Write error");
    }
    api_ok()
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return api_error(e);
    }
    if fs::remove_file(&req.file).is_err() {
        return api_error("Delete error");
    }
    api_ok()
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return api_error(e);
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return api_error(e);
    }
    if Path::new(&req.new_file).exists() {
        return api_error("File already exists");
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return api_error("Rename error");
    }
    api_ok()
}

async fn validate_core(files: &[ConfigReq]) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "xkeen-ui-validation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| e.to_string())?;

    for item in files {
        let Some(name) = Path::new(&item.file).file_name() else {
            continue;
        };
        if let Err(e) = tokio::fs::write(temp_dir.join(name), &item.content).await {
            _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(e.to_string());
        }
    }

    let mut cmd = tokio::process::Command::new("xray");
    cmd.args(["-test", "-confdir"]).arg(&temp_dir);
    cmd.env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);

    let output = cmd.output().await;
    _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let output = output.map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(combined)
}

fn api_ok() -> Json<ApiResponse<()>> {
    Json(ApiResponse { success: true, error: None, data: None })
}

fn api_error(error: impl Into<String>) -> Json<ApiResponse<()>> {
    Json(ApiResponse { success: false, error: Some(error.into()), data: None })
}
