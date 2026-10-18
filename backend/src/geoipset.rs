//! Исключение российских IP-подсетей из проксирования (GeoIPSET XKeen).
//!
//! Тот же пункт, что XKeen предлагает при установке: файрвол XKeen всегда пропускает мимо прокси
//! адреса из ipset `geo_exclude`/`geo_exclude6`, а наполняют их списки `ru_exclude_ipv*.lst`.
//! Включение и выключение — штатные `xkeen -gips` / `xkeen -dgips`: перезапуск не нужен,
//! списки обновляет задача XKeen `-ug` вместе с геобазами.

use crate::logger::log;
use axum::Json;
use axum::response::IntoResponse;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const XKEEN_BIN: &str = "/opt/sbin/xkeen";
const RU_EXCLUDE_IPV4: &str = "/opt/etc/xkeen/ipset/ru_exclude_ipv4.lst";
const RU_EXCLUDE_IPV6: &str = "/opt/etc/xkeen/ipset/ru_exclude_ipv6.lst";
/// Загрузка списков идёт через зеркала GitHub с повторами — даём с запасом.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

/// Одна операция за раз: `-gips` и `-dgips` работают с одними файлами и ipset.
static BUSY: Mutex<()> = Mutex::const_new(());

fn enabled() -> bool {
    Path::new(RU_EXCLUDE_IPV4).exists() || Path::new(RU_EXCLUDE_IPV6).exists()
}

pub async fn get_geoipset() -> impl IntoResponse {
    Json(json!({ "success": true, "enabled": enabled(), "available": Path::new(XKEEN_BIN).exists() }))
}

#[derive(Deserialize)]
pub struct GeoIpSetRequest {
    enabled: bool,
}

/// Запускает `xkeen <arg>`; `answer` уходит на stdin (без TTY XKeen читает выбор оттуда).
async fn run_xkeen(arg: &str, answer: &str) -> Result<(), String> {
    run_command(XKEEN_BIN, arg, answer, COMMAND_TIMEOUT).await
}

async fn run_command(bin: &str, arg: &str, answer: &str, timeout: Duration) -> Result<(), String> {
    let mut child = tokio::process::Command::new(bin)
        .arg(arg)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Своя группа процессов: по тайм-ауту завершаем и запущенные XKeen загрузки (curl и т.п.)
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        _ = stdin.write_all(answer.as_bytes()).await;
    }
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("xkeen {arg}: {e}")),
        Err(_) => {
            if let Some(pid) = child.id() {
                _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
            _ = child.wait().await;
            Err(format!("xkeen {arg}: превышено время ожидания"))
        }
    }
}

pub async fn post_geoipset(Json(req): Json<GeoIpSetRequest>) -> Json<Value> {
    let Ok(_guard) = BUSY.try_lock() else {
        return Json(json!({ "success": false, "error": "Операция уже выполняется", "enabled": enabled() }));
    };
    let result = if req.enabled {
        // «1» — «Загрузить и установить»: новые версии XKeen без TTY выбирают его сами,
        // старые ждут ответа на stdin
        run_xkeen("-gips", "1\n").await
    } else {
        // `-dgips` спрашивает подтверждение: «1» — удалить
        run_xkeen("-dgips", "1\n").await
    };
    let now = enabled();
    let error = match result {
        Err(e) => Some(e),
        // Код возврата XKeen не отражает неудачную загрузку списков — проверяем по файлам
        Ok(()) if now != req.enabled && req.enabled => Some("Не удалось загрузить списки IP-подсетей России".into()),
        Ok(()) if now != req.enabled => Some("Не удалось удалить списки IP-подсетей России".into()),
        Ok(()) => None,
    };
    match &error {
        Some(e) => log("ERROR", format!("GeoIPSET: {e}")),
        None => log(
            "INFO",
            format!("Российские IP-подсети {} проксирования", if now { "исключены из" } else { "возвращены в" }),
        ),
    }
    Json(json!({ "success": error.is_none(), "error": error, "enabled": now }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(dir: &Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("xkeen");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn answer_reaches_stdin() {
        let dir = std::env::temp_dir().join(format!("geoipset-answer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out");
        let bin = script(&dir, &format!("read -r choice; echo \"$1 $choice\" > {}", out.display()));
        run_command(&bin, "-dgips", "1\n", Duration::from_secs(5)).await.unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "-dgips 1");
        _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn hung_command_times_out() {
        let dir = std::env::temp_dir().join(format!("geoipset-hang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = script(&dir, "sh -c 'sleep 30' \"$0\" & wait");
        let started = std::time::Instant::now();
        let err = run_command(&bin, "-gips", "", Duration::from_millis(300)).await.unwrap_err();
        assert!(err.contains("превышено время ожидания"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
        // Дочерние процессы скрипта тоже завершены
        std::thread::sleep(Duration::from_millis(100));
        let left = std::process::Command::new("pgrep").args(["-f", &bin]).output().unwrap();
        assert!(left.stdout.is_empty(), "остались процессы: {}", String::from_utf8_lossy(&left.stdout));
        _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_binary_is_error() {
        assert!(run_command("/nonexistent/xkeen", "-gips", "", Duration::from_secs(1)).await.is_err());
    }
}
