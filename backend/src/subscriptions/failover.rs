//! Уход с выбранного вручную сервера, который перестал работать.
//!
//! В ручном режиме балансировщика нет, поэтому раз в минуту панель проверяет выбранный сервер
//! реальным запросом через него (см. `ping`). Не отвечает `FAILS_TO_SWITCH` проверок подряд —
//! подписка переходит в «Авто». Обратно панель не возвращается: сервер снова выбирает пользователь.
//! Если не отвечают и остальные серверы (например, пропал интернет), выбор не меняется.

use super::*;

const CHECK_INTERVAL: Duration = Duration::from_secs(60);
const FAILS_TO_SWITCH: u32 = 2;

#[derive(Default)]
struct Health {
    fails: u32,
    /// О том, что других рабочих серверов нет, пишем в журнал один раз за сбой.
    no_others_logged: bool,
    /// Проверка не запускается — тоже один раз, иначе подстраховка не работала бы молча.
    check_error_logged: bool,
}

/// Результаты проверки серверов. Xray не запустился — это не ответ сервера, такая проверка не считается.
async fn run_check(sub: &Subscription, targets: &[Value], health: &mut Health) -> Option<Vec<Result<u64, String>>> {
    match ping::check_outbounds(targets).await {
        Ok(results) => {
            health.check_error_logged = false;
            Some(results)
        }
        Err(e) => {
            if !health.check_error_logged {
                log("ERROR", format!("Подписка «{}»: не удалось проверить серверы: {e}", sub.tag));
                health.check_error_logged = true;
            }
            None
        }
    }
}

/// Переводит подписку в «Авто» и перезапускает Xray.
async fn switch_to_auto(sub: &Subscription) {
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store().await;
    // Пока шла проверка, пользователь мог выбрать другой сервер или удалить подписку.
    let Some(current) = store
        .subscriptions
        .iter_mut()
        .find(|s| s.tag == sub.tag && s.primary == sub.primary)
    else {
        return;
    };
    let mut updated = current.clone();
    updated.primary.clear();
    let changed = match apply_cached(&mut updated).await {
        Ok(changed) => changed,
        Err(e) => return log("ERROR", format!("Подписка «{}»: не удалось перейти в «Авто»: {e}", sub.tag)),
    };
    *current = updated;
    if let Err(e) = save_store(&store).await {
        return log("ERROR", format!("Ошибка записи {}: {}", SUBSCRIPTIONS_FILE, e));
    }
    log("WARN", format!("Подписка «{}»: сервер «{}» не отвечает, включён режим «Авто»", sub.tag, sub.primary));
    if let Some(e) = finish_change(&mut store, changed).await {
        log("ERROR", e);
    }
}

async fn check(sub: &Subscription, health: &mut Health) {
    let Ok(enabled) = enabled_outbounds(sub, &sub.cached_outbounds) else {
        return;
    };
    // Выбранного сервера больше нет в подписке: под тегом работает сервер по умолчанию.
    let Some(primary) = enabled.iter().find(|o| o["tag"] == sub.primary).cloned() else {
        return;
    };
    let Some(results) = run_check(sub, &[primary], health).await else {
        return;
    };
    if results[0].is_ok() {
        *health = Health::default();
        return;
    }
    health.fails += 1;
    if health.fails < FAILS_TO_SWITCH {
        return;
    }
    let others: Vec<Value> = balancer::pool(sub)
        .iter()
        .filter(|tag| **tag != sub.primary)
        .filter_map(|tag| enabled.iter().find(|o| o["tag"] == **tag).cloned())
        .collect();
    let Some(results) = run_check(sub, &others, health).await else {
        return;
    };
    if results.iter().any(Result::is_ok) {
        *health = Health::default();
        switch_to_auto(sub).await;
    } else if !health.no_others_logged {
        log("WARN", format!("Подписка «{}»: выбранный сервер не отвечает, других рабочих серверов нет", sub.tag));
        health.no_others_logged = true;
    }
}

async fn check_all(health: &mut HashMap<String, Health>) {
    // Xray остановлен пользователем — проверять и перезапускать нечего.
    if store_problem(SUBSCRIPTIONS_FILE).await.is_some() || crate::controller::get_pid("xray").is_empty() {
        health.clear();
        return;
    }
    let subs: Vec<Subscription> = load_store()
        .await
        .subscriptions
        .into_iter()
        .filter(|s| !s.primary.is_empty())
        .collect();
    let key = |s: &Subscription| format!("{}\n{}", s.tag, s.primary);
    health.retain(|k, _| subs.iter().any(|s| key(s) == *k));
    for sub in &subs {
        check(sub, health.entry(key(sub)).or_default()).await;
    }
}

pub fn start_watch() {
    tokio::spawn(async {
        let mut health = HashMap::new();
        loop {
            tokio::time::sleep(CHECK_INTERVAL).await;
            check_all(&mut health).await;
        }
    });
}
