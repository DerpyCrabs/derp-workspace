use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static COMPOSITOR_SCHEDULE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_IDLE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_ACTIVE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_FORCED: AtomicU64 = AtomicU64::new(0);
static CEF_UI_SEND: AtomicU64 = AtomicU64::new(0);
static DRM_RENDER_TICK: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_BATCH_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_MESSAGE_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_WINDOW_LIST_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_WINDOW_MAPPED_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_WINDOW_GEOMETRY_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_WINDOW_METADATA_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_WINDOW_STATE_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_DETAIL_FOCUS_CHANGED_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_REPLY_WINDOW_LIST_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_NOTIFY_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_READ_COUNT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(crate) enum CompositorScheduleKind {
    Idle,
    Active,
    Forced,
}

struct PacingLog {
    window_start: Instant,
    tick_at_start: u64,
    sched_at_start: u64,
    sched_idle_at_start: u64,
    sched_active_at_start: u64,
    sched_forced_at_start: u64,
    send_at_start: u64,
}

static PACING: Mutex<Option<PacingLog>> = Mutex::new(None);

#[derive(serde::Serialize)]
pub(crate) struct PerfCounterSnapshot {
    begin_frame: BeginFrameSnapshot,
    shell_updates: ShellUpdateSnapshot,
    shell_sync: ShellSyncSnapshot,
}

#[derive(serde::Serialize)]
struct BeginFrameSnapshot {
    compositor_schedules: u64,
    compositor_schedules_idle: u64,
    compositor_schedules_active: u64,
    compositor_schedules_forced: u64,
    cef_send_external_begin_frame: u64,
    drm_render_ticks: u64,
}

#[derive(serde::Serialize)]
struct ShellUpdateSnapshot {
    batch_count: u64,
    message_count: u64,
    window_list_messages: u64,
    window_mapped_messages: u64,
    window_geometry_messages: u64,
    window_metadata_messages: u64,
    window_state_messages: u64,
    focus_changed_messages: u64,
}

#[derive(serde::Serialize)]
struct ShellSyncSnapshot {
    full_window_list_replies: u64,
    snapshot_notifies: u64,
    snapshot_reads: u64,
}

pub(crate) fn note_schedule_from_compositor(kind: CompositorScheduleKind) {
    COMPOSITOR_SCHEDULE.fetch_add(1, Ordering::Relaxed);
    match kind {
        CompositorScheduleKind::Idle => {
            COMPOSITOR_SCHEDULE_IDLE.fetch_add(1, Ordering::Relaxed);
        }
        CompositorScheduleKind::Active => {
            COMPOSITOR_SCHEDULE_ACTIVE.fetch_add(1, Ordering::Relaxed);
        }
        CompositorScheduleKind::Forced => {
            COMPOSITOR_SCHEDULE_FORCED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(crate) fn note_cef_ui_send_external_begin_frame() {
    CEF_UI_SEND.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_drm_render_tick() {
    DRM_RENDER_TICK.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_batch(message_count: usize) {
    SHELL_DETAIL_BATCH_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_DETAIL_MESSAGE_COUNT.fetch_add(message_count as u64, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_window_list() {
    SHELL_DETAIL_WINDOW_LIST_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_window_mapped() {
    SHELL_DETAIL_WINDOW_MAPPED_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_window_geometry() {
    SHELL_DETAIL_WINDOW_GEOMETRY_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_window_metadata() {
    SHELL_DETAIL_WINDOW_METADATA_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_window_state() {
    SHELL_DETAIL_WINDOW_STATE_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_detail_focus_changed() {
    SHELL_DETAIL_FOCUS_CHANGED_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_reply_window_list() {
    SHELL_REPLY_WINDOW_LIST_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_snapshot_notify() {
    SHELL_SNAPSHOT_NOTIFY_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_snapshot_read() {
    SHELL_SNAPSHOT_READ_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn perf_counter_snapshot() -> PerfCounterSnapshot {
    PerfCounterSnapshot {
        begin_frame: BeginFrameSnapshot {
            compositor_schedules: COMPOSITOR_SCHEDULE.load(Ordering::Relaxed),
            compositor_schedules_idle: COMPOSITOR_SCHEDULE_IDLE.load(Ordering::Relaxed),
            compositor_schedules_active: COMPOSITOR_SCHEDULE_ACTIVE.load(Ordering::Relaxed),
            compositor_schedules_forced: COMPOSITOR_SCHEDULE_FORCED.load(Ordering::Relaxed),
            cef_send_external_begin_frame: CEF_UI_SEND.load(Ordering::Relaxed),
            drm_render_ticks: DRM_RENDER_TICK.load(Ordering::Relaxed),
        },
        shell_updates: ShellUpdateSnapshot {
            batch_count: SHELL_DETAIL_BATCH_COUNT.load(Ordering::Relaxed),
            message_count: SHELL_DETAIL_MESSAGE_COUNT.load(Ordering::Relaxed),
            window_list_messages: SHELL_DETAIL_WINDOW_LIST_COUNT.load(Ordering::Relaxed),
            window_mapped_messages: SHELL_DETAIL_WINDOW_MAPPED_COUNT.load(Ordering::Relaxed),
            window_geometry_messages: SHELL_DETAIL_WINDOW_GEOMETRY_COUNT.load(Ordering::Relaxed),
            window_metadata_messages: SHELL_DETAIL_WINDOW_METADATA_COUNT.load(Ordering::Relaxed),
            window_state_messages: SHELL_DETAIL_WINDOW_STATE_COUNT.load(Ordering::Relaxed),
            focus_changed_messages: SHELL_DETAIL_FOCUS_CHANGED_COUNT.load(Ordering::Relaxed),
        },
        shell_sync: ShellSyncSnapshot {
            full_window_list_replies: SHELL_REPLY_WINDOW_LIST_COUNT.load(Ordering::Relaxed),
            snapshot_notifies: SHELL_SNAPSHOT_NOTIFY_COUNT.load(Ordering::Relaxed),
            snapshot_reads: SHELL_SNAPSHOT_READ_COUNT.load(Ordering::Relaxed),
        },
    }
}

pub(crate) fn perf_counter_snapshot_json() -> Result<String, String> {
    serde_json::to_string(&perf_counter_snapshot())
        .map_err(|e| format!("serialize perf counter snapshot: {e}"))
}

pub(crate) fn reset_perf_counters() {
    COMPOSITOR_SCHEDULE.store(0, Ordering::Relaxed);
    COMPOSITOR_SCHEDULE_IDLE.store(0, Ordering::Relaxed);
    COMPOSITOR_SCHEDULE_ACTIVE.store(0, Ordering::Relaxed);
    COMPOSITOR_SCHEDULE_FORCED.store(0, Ordering::Relaxed);
    CEF_UI_SEND.store(0, Ordering::Relaxed);
    DRM_RENDER_TICK.store(0, Ordering::Relaxed);
    SHELL_DETAIL_BATCH_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_MESSAGE_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_WINDOW_LIST_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_WINDOW_MAPPED_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_WINDOW_GEOMETRY_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_WINDOW_METADATA_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_WINDOW_STATE_COUNT.store(0, Ordering::Relaxed);
    SHELL_DETAIL_FOCUS_CHANGED_COUNT.store(0, Ordering::Relaxed);
    SHELL_REPLY_WINDOW_LIST_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_NOTIFY_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_READ_COUNT.store(0, Ordering::Relaxed);
    if let Ok(mut pacing) = PACING.lock() {
        *pacing = None;
    }
}

pub(crate) fn maybe_log_cef_begin_frame_pacing() {
    let ticks = DRM_RENDER_TICK.load(Ordering::Relaxed);
    let sched = COMPOSITOR_SCHEDULE.load(Ordering::Relaxed);
    let sched_idle = COMPOSITOR_SCHEDULE_IDLE.load(Ordering::Relaxed);
    let sched_active = COMPOSITOR_SCHEDULE_ACTIVE.load(Ordering::Relaxed);
    let sched_forced = COMPOSITOR_SCHEDULE_FORCED.load(Ordering::Relaxed);
    let send = CEF_UI_SEND.load(Ordering::Relaxed);
    let now = Instant::now();
    let mut g = PACING.lock().expect("PACING");
    match *g {
        None => {
            *g = Some(PacingLog {
                window_start: now,
                tick_at_start: ticks,
                sched_at_start: sched,
                sched_idle_at_start: sched_idle,
                sched_active_at_start: sched_active,
                sched_forced_at_start: sched_forced,
                send_at_start: send,
            });
        }
        Some(ref mut e) => {
            if now.duration_since(e.window_start) < Duration::from_secs(1) {
                return;
            }
            let dt = ticks.saturating_sub(e.tick_at_start);
            let ds = sched.saturating_sub(e.sched_at_start);
            let dsi = sched_idle.saturating_sub(e.sched_idle_at_start);
            let dsa = sched_active.saturating_sub(e.sched_active_at_start);
            let dsf = sched_forced.saturating_sub(e.sched_forced_at_start);
            let du = send.saturating_sub(e.send_at_start);
            if dt > 0 || ds > 0 || dsi > 0 || dsa > 0 || dsf > 0 || du > 0 {
                tracing::debug!(
                    target: "derp_cef_begin_frame",
                    drm_render_ticks = dt,
                    compositor_schedules = ds,
                    compositor_schedules_idle = dsi,
                    compositor_schedules_active = dsa,
                    compositor_schedules_forced = dsf,
                    cef_send_external_begin_frame = du,
                    "CEF external BeginFrame pacing (1s)"
                );
            }
            e.window_start = now;
            e.tick_at_start = ticks;
            e.sched_at_start = sched;
            e.sched_idle_at_start = sched_idle;
            e.sched_active_at_start = sched_active;
            e.sched_forced_at_start = sched_forced;
            e.send_at_start = send;
        }
    }
}
