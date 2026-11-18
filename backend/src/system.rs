//! Загрузка процессора и памяти роутера — для блока «Роутер», который опрашивает её раз в 3 секунды.
//!
//! Читается из `/proc`, а не из RCI: панель работает на самом роутере, и `/proc` доступен на любой
//! прошивке — без токена доступа и без вызовов консоли, которые при таком опросе засоряли бы
//! журнал роутера. Память считается как в роутере: занято = всего − свободно − буферы − кеш, где
//! «всего» — физический объём из `show system` (его роутер спрашивается один раз). В `/proc`
//! MemTotal меньше на память, которую забрало ядро: 991 МБ вместо 1024.

use crate::rci;
use crate::types::AppState;
use axum::extract::State;
use axum::response::Json;
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Последний замер процессора: загрузка — разница между двумя замерами.
#[derive(Clone, Copy)]
struct CpuSample {
    at: Instant,
    total: u64,
    idle: u64,
}

static LAST_CPU: Mutex<Option<CpuSample>> = Mutex::new(None);
/// Прошлый замер старше этого (блок «Роутер» давно не открывали) — замеряем заново.
const SAMPLE_MAX_AGE: Duration = Duration::from_secs(30);
/// Пауза между двумя замерами, если прошлого нет.
const SAMPLE_GAP: Duration = Duration::from_millis(300);

/// Счётчики первой строки `/proc/stat`: всего и простой (idle + iowait), в тиках.
fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let values: Vec<u64> = line.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    // guest и guest_nice уже входят в user и nice
    let total = values.iter().take(8).sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

fn cpu_percent(from: CpuSample, to: CpuSample) -> Option<f64> {
    let total = to.total.checked_sub(from.total)?;
    let idle = to.idle.checked_sub(from.idle)?;
    if total == 0 {
        return None;
    }
    Some(((total - idle.min(total)) as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
}

fn sample_cpu() -> Option<CpuSample> {
    let (total, idle) = parse_cpu(&std::fs::read_to_string("/proc/stat").ok()?)?;
    Some(CpuSample { at: Instant::now(), total, idle })
}

async fn cpu_usage() -> Option<f64> {
    let previous = *LAST_CPU.lock().unwrap();
    let previous = match previous {
        Some(sample) if sample.at.elapsed() < SAMPLE_MAX_AGE && sample.at.elapsed() >= SAMPLE_GAP => sample,
        // Нет свежего замера или он только что сделан (два окна панели): меряем на коротком отрезке
        _ => {
            let first = sample_cpu()?;
            tokio::time::sleep(SAMPLE_GAP).await;
            first
        }
    };
    let current = sample_cpu()?;
    *LAST_CPU.lock().unwrap() = Some(current);
    cpu_percent(previous, current)
}

/// Физический объём памяти в КБ из `show system`; `Some(None)` — роутер не ответил, берём `/proc`.
static PHYSICAL_KB: tokio::sync::Mutex<Option<Option<u64>>> = tokio::sync::Mutex::const_new(None);

/// `memtotal` из `show system`: RCI отдаёт число, консоль — строку.
fn read_memtotal(system: &Value) -> Option<u64> {
    let value = system.get("memtotal")?;
    value.as_u64().or_else(|| value.as_str()?.trim().parse().ok()).filter(|kb| *kb > 0)
}

async fn physical_kb(state: &AppState) -> Option<u64> {
    let mut cached = PHYSICAL_KB.lock().await;
    if cached.is_none() {
        *cached = Some(rci::get(state, "show/system").await.ok().as_ref().and_then(read_memtotal));
    }
    cached.flatten()
}

/// Занято и всего памяти в байтах из `/proc/meminfo`; `physical` — объём из роутера, в КБ.
fn parse_memory(meminfo: &str, physical: Option<u64>) -> Option<(u64, u64)> {
    let field = |name: &str| -> Option<u64> {
        let line = meminfo.lines().find(|l| l.split(':').next() == Some(name))?;
        line.split_whitespace().nth(1)?.parse().ok()
    };
    let free = field("MemFree")?;
    let total = physical.filter(|kb| *kb >= free).or(field("MemTotal"))?;
    let used = total.saturating_sub(free + field("Buffers").unwrap_or(0) + field("Cached").unwrap_or(0));
    Some((used * 1024, total * 1024))
}

pub async fn get_system_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let physical = physical_kb(&state).await;
    let memory = tokio::fs::read_to_string("/proc/meminfo").await.ok().and_then(|text| parse_memory(&text, physical));
    match (memory, cpu_usage().await) {
        (Some((memory_used, memory_total)), Some(cpu_usage)) => Json(serde_json::json!({
            "success": true,
            "memoryUsed": memory_used,
            "memoryTotal": memory_total,
            "cpuUsage": cpu_usage,
        })),
        _ => Json(serde_json::json!({ "success": false, "error": "Не удалось прочитать загрузку роутера" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_like_the_router_counts_it() {
        // Цифры с роутера: show system — memory 380608/1048576, а MemTotal в /proc меньше
        let meminfo = "MemTotal:        1015072 kB\nMemFree:          512552 kB\nMemAvailable:     600000 kB\nBuffers:           41872 kB\nCached:           113544 kB\nSwapCached:            0 kB\n";
        assert_eq!(parse_memory(meminfo, Some(1048576)), Some((380608 * 1024, 1048576 * 1024)));
        // Роутер не ответил — объём из /proc
        assert_eq!(parse_memory(meminfo, None), Some(((1015072 - 512552 - 41872 - 113544) * 1024, 1015072 * 1024)));
        assert_eq!(parse_memory("MemTotal: 1 kB\n", None), None);
        assert_eq!(read_memtotal(&serde_json::json!({ "memtotal": 1048576 })), Some(1048576));
        assert_eq!(read_memtotal(&serde_json::json!({ "memtotal": "1048576" })), Some(1048576));
    }

    #[test]
    fn cpu_load_between_samples() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n";
        assert_eq!(parse_cpu(stat), Some((1000, 850)));
        let at = Instant::now();
        let from = CpuSample { at, total: 1000, idle: 850 };
        let to = CpuSample { at, total: 1200, idle: 900 };
        assert_eq!(cpu_percent(from, to), Some(75.0));
        assert_eq!(cpu_percent(to, to), None);
        assert_eq!(cpu_percent(to, from), None);
    }
}
