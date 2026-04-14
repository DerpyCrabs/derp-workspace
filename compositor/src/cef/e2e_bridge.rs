use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

struct PendingShellResponseState {
    shell_snapshots: HashMap<u64, String>,
    shell_html: HashMap<u64, String>,
}

fn response_state() -> &'static (Mutex<PendingShellResponseState>, Condvar) {
    static STATE: OnceLock<(Mutex<PendingShellResponseState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| {
        (
            Mutex::new(PendingShellResponseState {
                shell_snapshots: HashMap::new(),
                shell_html: HashMap::new(),
            }),
            Condvar::new(),
        )
    })
}

pub(crate) fn next_request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn publish_shell_snapshot(request_id: u64, json: String) {
    let (lock, condvar) = response_state();
    let mut state = lock.lock().expect("e2e shell response state");
    state.shell_snapshots.insert(request_id, json);
    condvar.notify_all();
}

pub(crate) fn publish_shell_html(request_id: u64, html: String) {
    let (lock, condvar) = response_state();
    let mut state = lock.lock().expect("e2e shell response state");
    state.shell_html.insert(request_id, html);
    condvar.notify_all();
}

pub(crate) fn wait_for_shell_snapshot(
    request_id: u64,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let (lock, condvar) = response_state();
    let mut state = lock
        .lock()
        .map_err(|_| "shell snapshot state poisoned".to_string())?;
    loop {
        if let Some(json) = state.shell_snapshots.remove(&request_id) {
            return Ok(json);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for shell snapshot {request_id}"));
        }
        let remaining = deadline.saturating_duration_since(now);
        let (next_state, wait_result) = condvar
            .wait_timeout(state, remaining)
            .map_err(|_| "shell snapshot wait poisoned".to_string())?;
        state = next_state;
        if wait_result.timed_out() && !state.shell_snapshots.contains_key(&request_id) {
            return Err(format!("timed out waiting for shell snapshot {request_id}"));
        }
    }
}

pub(crate) fn wait_for_shell_html(request_id: u64, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let (lock, condvar) = response_state();
    let mut state = lock
        .lock()
        .map_err(|_| "shell html state poisoned".to_string())?;
    loop {
        if let Some(html) = state.shell_html.remove(&request_id) {
            return Ok(html);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for shell html {request_id}"));
        }
        let remaining = deadline.saturating_duration_since(now);
        let (next_state, wait_result) = condvar
            .wait_timeout(state, remaining)
            .map_err(|_| "shell html wait poisoned".to_string())?;
        state = next_state;
        if wait_result.timed_out() && !state.shell_html.contains_key(&request_id) {
            return Err(format!("timed out waiting for shell html {request_id}"));
        }
    }
}
