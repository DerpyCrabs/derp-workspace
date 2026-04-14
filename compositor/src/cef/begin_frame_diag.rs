use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static COMPOSITOR_SCHEDULE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_IDLE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_ACTIVE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_FORCED: AtomicU64 = AtomicU64::new(0);
static CEF_UI_SEND: AtomicU64 = AtomicU64::new(0);
static DRM_RENDER_TICK: AtomicU64 = AtomicU64::new(0);

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
