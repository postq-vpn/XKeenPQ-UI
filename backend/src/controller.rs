use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use nix::sys::resource::{Resource, setrlimit};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Gid, Pid, setgid, setsid};
use serde::Deserialize;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tokio::fs;
use tokio::process::Command;

const CORE_NAME: &str = "xray";
const XKEEN_POLICY: &str = "xkeen";
const XKEEN_PROXY_SCRIPT: &str = "/opt/etc/ndm/netfilter.d/proxy.sh";

#[derive(Deserialize)]
pub struct ControlReq {
    action: String,
}

pub fn find_init_file(log_enabled: bool) -> Option<String> {
    let (mut path, mut source) = (None, "fallback");

    if let Ok(content) = std::fs::read_to_string("/opt/sbin/.xkeen/01_info/01_info_variable.sh") {
        let (mut dir, mut file) = (None, None);
        for line in content.lines() {
            let clean = line.split('#').next().unwrap_or("").trim();
            if let Some(v) = clean.strip_prefix("initd_dir=") {
                dir = Some(v.trim_matches(&['"', '\''][..]));
            } else if let Some(v) = clean.strip_prefix("initd_file=") {
                file = Some(v.trim_matches(&['"', '\''][..]));
            }
        }
        if let (Some(d), Some(f)) = (dir, file) {
            path = Some(f.replace("$initd_dir", d));
            source = "var";
        }
    }

    let final_path = path.or_else(|| {
        [S99XKEEN, S24XRAY]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .map(String::from)
    });

    if log_enabled
        && let Some(p) = &final_path {
            println!("{} [INFO] Defined initd_file ({}): {}", crate::logger::ts(), source, p);
        }

    final_path
}

/// Панель работает только с Xray: если init-скрипт XKeen остался на Mihomo (`name_client="mihomo"`
/// после прошлых версий), переводим его на Xray, иначе XKeen продолжит запускать Mihomo.
pub fn migrate_init_to_xray(path: &str) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    if !content.contains("name_client=\"mihomo\"") {
        return;
    }
    let updated = content.replace("name_client=\"mihomo\"", "name_client=\"xray\"");
    match std::fs::write(path, updated) {
        Ok(()) => {
            _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
            log("WARN", format!("{path}: ядро XKeen переключено с Mihomo на Xray"));
        }
        Err(e) => log("ERROR", format!("Не удалось переключить {path} на Xray: {e}")),
    }
}

async fn resolve_init_file(state: &AppState) -> Result<String, String> {
    if let Some(path) = state.init_file.read().unwrap().clone()
        && Path::new(&path).exists() {
            return Ok(path);
        }
    let new_path = tokio::task::spawn_blocking(|| find_init_file(false))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не найден init файл XKeen".to_string())?;
    println!("{} [INFO] Updated initd_file: {}", crate::logger::ts(), new_path);
    *state.init_file.write().unwrap() = Some(new_path.clone());
    Ok(new_path)
}

pub async fn run_init_command(state: &AppState, args: &[&str]) -> Result<(), String> {
    let path = resolve_init_file(state).await?;
    let mut command = Command::new(&path);
    command.args(args);
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(error_log_path())
    {
        command.stdout(file.try_clone().unwrap()).stderr(file);
    }
    match command.status().await {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{}: {}", path, status)),
        Err(error) => {
            *state.init_file.write().unwrap() = None;
            Err(format!("{}: {}", path, error))
        }
    }
}

/// Запуск XKeen, как кнопка ▶: проверка конфига Xray, затем `start on` (заодно включает автозапуск).
pub async fn start_xkeen(state: &AppState) -> Result<(), String> {
    if let Err(e) = check_core_config().await {
        log("ERROR", e);
        return Err("Не удалось запустить Xray".into());
    }
    run_init_command(state, &["start", "on"]).await
}

pub fn get_pid(name: &str) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let pid = path.file_name()?.to_str()?.parse::<i32>().ok()?;
            let comm = std::fs::read_to_string(path.join("comm")).ok()?;
            (comm.trim_end_matches('\n') == name).then_some(pid)
        })
        .collect()
}

fn core_running() -> bool {
    !get_pid(CORE_NAME).is_empty()
}

pub async fn soft_restart(core: &str) -> Result<(), String> {
    for pid in get_pid(core) {
        _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }

    let mut cmd = Command::new(core);
    cmd.envs([
        ("XRAY_LOCATION_CONFDIR", XRAY_CONF_DIR),
        ("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR),
    ]);

    let lim = if cfg!(target_arch = "aarch64") { 40000 } else { 10000 };
    unsafe {
        cmd.pre_exec(move || {
            setsid()?;
            setgid(Gid::from_raw(11111))?;
            setrlimit(Resource::RLIMIT_NOFILE, lim, lim)?;
            Ok(())
        });
    }

    if let Ok(f) = std::fs::File::options()
        .append(true)
        .create(true)
        .open(error_log_path())
    {
        cmd.stdout(f.try_clone().unwrap()).stderr(f);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    match child.try_wait() {
        Ok(Some(status)) if !status.success() => {
            return Err(format!("Не удалось перезапустить {}: {}", core, status));
        }
        _ => {
            tokio::spawn(async move {
                _ = child.wait().await;
            });
        }
    }

    Ok(())
}

pub async fn get_control() -> impl IntoResponse {
    let running = tokio::task::spawn_blocking(core_running).await.unwrap_or_default();
    let installed = fs::metadata(format!("/opt/sbin/{CORE_NAME}")).await.is_ok();
    let cores: Vec<&str> = if installed { vec![CORE_NAME] } else { Vec::new() };

    Json(
        serde_json::json!({ "success": true, "cores": cores, "currentCore": CORE_NAME, "running": installed && running }),
    )
}

async fn check_core_config() -> Result<(), String> {
    fs::create_dir_all(XRAY_CONF_DIR).await.ok();
    let has_json = std::fs::read_dir(XRAY_CONF_DIR)
        .map(|dir| {
            dir.flatten()
                .any(|e| e.path().extension().is_some_and(|x| x == "json"))
        })
        .unwrap_or(false);
    if !has_json {
        return Err("Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском".into());
    }
    Ok(())
}

/// Метка политики, с которой запущен XKeen (строка `policy_mark='…'` его скрипта файрвола).
/// Пустая строка — запущен без политики, `None` — скрипта или строки нет.
fn applied_policy_mark(script: &str) -> Option<&str> {
    script.lines().find_map(|line| line.strip_prefix("policy_mark='")?.strip_suffix('\''))
}

/// Текущая метка политики XKeen в роутере: ищется по описанию, как в самом XKeen.
fn router_policy_mark(policies: &serde_json::Value) -> Option<String> {
    policies.as_object()?.values().find_map(|policy| {
        let description = policy.get("description")?.as_str()?;
        description
            .eq_ignore_ascii_case(XKEEN_POLICY)
            .then(|| Some(format!("0x{}", policy.get("mark")?.as_str()?)))?
    })
}

/// XKeen читает метку только при запуске: политика, созданная или изменённая позже,
/// заработает после его перезапуска. Метка из кеша XKeen (политику удалили) перезапуском
/// не исправляется, поэтому такой случай сюда не входит.
fn policy_outdated(script: &str, policies: &serde_json::Value) -> bool {
    match (applied_policy_mark(script), router_policy_mark(policies)) {
        (Some(applied), Some(current)) => !applied.eq_ignore_ascii_case(&current),
        _ => false,
    }
}

/// Нужно ли перезапустить XKeen, чтобы применить политику. Ошибки чтения — не повод для
/// предупреждения: интерфейс показывает его, только когда уверен в расхождении.
pub async fn get_policy_status(State(state): State<AppState>) -> impl IntoResponse {
    let script = fs::read_to_string(XKEEN_PROXY_SCRIPT).await.unwrap_or_default();
    let mut request = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/ip/policy")
        .timeout(std::time::Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        request = request.header("X-Ndma-Tkn", token);
    }
    let policies = match request.send().await {
        Ok(response) if response.status().is_success() => response.json().await.ok(),
        _ => None,
    };
    let outdated = policies.is_some_and(|policies| policy_outdated(&script, &policies));
    Json(serde_json::json!({ "success": true, "outdated": outdated }))
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<ControlReq>) -> impl IntoResponse {
    match req.action.as_str() {
        "softRestart" => {
            if let Err(e) = soft_restart("xray").await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        a if ["start", "stop", "hardRestart"].contains(&a) => {
            let arg = match a {
                "start" => "start",
                "stop" => "stop",
                _ => "restart",
            };

            if (a == "start" || a == "hardRestart")
                && let Err(e) = check_core_config().await {
                    log("ERROR", e);
                    return Json(ApiResponse {
                        success: false,
                        error: Some("Не удалось запустить Xray".into()),
                        data: None,
                    });
                }

            let args: &[&str] = match a {
                "start" => &["start", "on"],
                "hardRestart" => &["restart", "on"],
                _ => &[arg],
            };

            if let Err(e) = run_init_command(&state, args).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        _ => {
            return Json(ApiResponse {
                success: false,
                error: Some("Bad action".into()),
                data: None,
            });
        }
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policies() -> serde_json::Value {
        json!({
            "Policy1": { "description": "other", "mark": "aaa" },
            "Policy0": { "description": "XKeen", "mark": "ffffaaa" },
        })
    }

    #[test]
    fn policy_created_after_start_is_outdated() {
        assert!(policy_outdated("mode_proxy='Hybrid'\npolicy_mark=''\n", &policies()));
    }

    #[test]
    fn changed_mark_is_outdated() {
        assert!(policy_outdated("policy_mark='0xbbb'\n", &policies()));
    }

    #[test]
    fn applied_mark_is_not_outdated() {
        assert!(!policy_outdated("policy_mark='0xFFFFAAA'\n", &policies()));
    }

    #[test]
    fn nothing_to_compare_is_not_outdated() {
        let no_policy = json!({ "Policy1": { "description": "other", "mark": "aaa" } });
        assert!(!policy_outdated("policy_mark=''\n", &no_policy));
        assert!(!policy_outdated("policy_mark='0xffffaaa'\n", &no_policy));
        assert!(!policy_outdated("", &policies()));
        assert!(!policy_outdated("policy_mark_full=''\n", &policies()));
        assert!(!policy_outdated("policy_mark=''\n", &json!({ "Policy0": { "description": "xkeen" } })));
    }
}
