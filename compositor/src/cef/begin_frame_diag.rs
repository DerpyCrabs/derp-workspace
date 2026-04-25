use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static COMPOSITOR_SCHEDULE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_IDLE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_ACTIVE: AtomicU64 = AtomicU64::new(0);
static COMPOSITOR_SCHEDULE_FORCED: AtomicU64 = AtomicU64::new(0);
static CEF_UI_SEND: AtomicU64 = AtomicU64::new(0);
static DRM_RENDER_TICK: AtomicU64 = AtomicU64::new(0);
static DRM_RENDER_LATE_TIMER: AtomicU64 = AtomicU64::new(0);
static DRM_FULLSCREEN_SHELL_BYPASS: AtomicU64 = AtomicU64::new(0);
static CEF_ACCELERATED_PAINT: AtomicU64 = AtomicU64::new(0);
static CEF_SOFTWARE_PAINT: AtomicU64 = AtomicU64::new(0);
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
static SHELL_SNAPSHOT_FULL_BYTES: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_DIRTY_READ_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_DIRTY_UNCHANGED_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_DIRTY_FALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_DIRTY_BYTES: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_ENCODE_COUNT: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_ENCODE_US: AtomicU64 = AtomicU64::new(0);
static SHELL_SNAPSHOT_ENCODE_MESSAGES: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_UI_WINDOW_WRITES: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_UI_WINDOW_BYTES: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_UI_WINDOW_ROWS: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_EXCLUSION_WRITES: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_EXCLUSION_BYTES: AtomicU64 = AtomicU64::new(0);
static SHELL_SHARED_STATE_EXCLUSION_RECTS: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_SAMPLES: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_SCHEDULE_TO_BEGIN_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_BEGIN_TO_PAINT_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_PAINT_TO_DMABUF_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_DMABUF_TO_RENDER_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_SCHEDULE_TO_DMABUF_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_SCHEDULE_TO_RENDER_US: AtomicU64 = AtomicU64::new(0);
static SHELL_LATENCY_SCHEDULE_TO_RENDER_MAX_US: AtomicU64 = AtomicU64::new(0);
static LATENCY: Mutex<LatencyTrace> = Mutex::new(LatencyTrace::new());

#[derive(Clone, Copy, Debug)]
pub(crate) enum CompositorScheduleKind {
    Idle,
    Active,
    Forced,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ShellViewInvalidateReason {
    MoveEnd,
    ResizeDelta,
    ResizeEnd,
    ResizeShellGrabEnd,
    FocusChanged,
    OutputResize,
    BrowserLoad,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum DirtyRectKind {
    Missing,
    Empty,
    Provided,
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

struct LatencyTrace {
    message_pump_at: Option<Instant>,
    message_pump_delay_ms: i64,
    compositor_schedule_at: Option<Instant>,
    compositor_schedule_kind: Option<CompositorScheduleKind>,
    view_invalidate_at: Option<Instant>,
    view_invalidate_reason: Option<ShellViewInvalidateReason>,
    cef_begin_frame_at: Option<Instant>,
    accelerated_paint_at: Option<Instant>,
    accelerated_paint_size: Option<(u32, u32)>,
    dirty_rect_kind: Option<DirtyRectKind>,
    dirty_rect_count: Option<usize>,
    dirty_rect_coverage_per_mille: Option<u16>,
    dirty_rect_bbox_full: Option<bool>,
    dmabuf_rx_at: Option<Instant>,
    dmabuf_rx_size: Option<(u32, u32)>,
    last_logged_dmabuf_rx_at: Option<Instant>,
}

impl LatencyTrace {
    const fn new() -> Self {
        Self {
            message_pump_at: None,
            message_pump_delay_ms: 0,
            compositor_schedule_at: None,
            compositor_schedule_kind: None,
            view_invalidate_at: None,
            view_invalidate_reason: None,
            cef_begin_frame_at: None,
            accelerated_paint_at: None,
            accelerated_paint_size: None,
            dirty_rect_kind: None,
            dirty_rect_count: None,
            dirty_rect_coverage_per_mille: None,
            dirty_rect_bbox_full: None,
            dmabuf_rx_at: None,
            dmabuf_rx_size: None,
            last_logged_dmabuf_rx_at: None,
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct PerfCounterSnapshot {
    begin_frame: BeginFrameSnapshot,
    shell_updates: ShellUpdateSnapshot,
    shell_sync: ShellSyncSnapshot,
    latency: ShellLatencySnapshot,
}

#[derive(serde::Serialize)]
struct BeginFrameSnapshot {
    compositor_schedules: u64,
    compositor_schedules_idle: u64,
    compositor_schedules_active: u64,
    compositor_schedules_forced: u64,
    cef_send_external_begin_frame: u64,
    drm_render_ticks: u64,
    drm_render_late_timers: u64,
    drm_fullscreen_shell_bypasses: u64,
    cef_accelerated_paints: u64,
    cef_software_paints: u64,
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
    snapshot_full_bytes: u64,
    snapshot_dirty_reads: u64,
    snapshot_dirty_unchanged: u64,
    snapshot_dirty_fallbacks: u64,
    snapshot_dirty_bytes: u64,
    snapshot_encode_count: u64,
    snapshot_encode_us: u64,
    snapshot_encode_messages: u64,
    shared_state_ui_window_writes: u64,
    shared_state_ui_window_bytes: u64,
    shared_state_ui_window_rows: u64,
    shared_state_exclusion_writes: u64,
    shared_state_exclusion_bytes: u64,
    shared_state_exclusion_rects: u64,
}

#[derive(serde::Serialize)]
struct ShellLatencySnapshot {
    samples: u64,
    schedule_to_begin_us: u64,
    begin_to_paint_us: u64,
    paint_to_dmabuf_us: u64,
    dmabuf_to_render_us: u64,
    schedule_to_dmabuf_us: u64,
    schedule_to_render_us: u64,
    schedule_to_render_max_us: u64,
}

pub(crate) fn note_schedule_from_compositor(kind: CompositorScheduleKind) {
    COMPOSITOR_SCHEDULE.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut latency) = LATENCY.lock() {
        latency.compositor_schedule_at = Some(Instant::now());
        latency.compositor_schedule_kind = Some(kind);
    }
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
    if let Ok(mut latency) = LATENCY.lock() {
        latency.cef_begin_frame_at = Some(Instant::now());
    }
}

pub(crate) fn note_shell_view_invalidate(reason: ShellViewInvalidateReason) {
    if let Ok(mut latency) = LATENCY.lock() {
        latency.view_invalidate_at = Some(Instant::now());
        latency.view_invalidate_reason = Some(reason);
    }
}

pub(crate) fn note_drm_render_tick() {
    DRM_RENDER_TICK.fetch_add(1, Ordering::Relaxed);
    maybe_log_shell_latency();
}

pub(crate) fn note_drm_render_late_timer() {
    DRM_RENDER_LATE_TIMER.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_drm_fullscreen_shell_bypass() {
    DRM_FULLSCREEN_SHELL_BYPASS.fetch_add(1, Ordering::Relaxed);
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

pub(crate) fn note_shell_snapshot_read(payload_len: usize) {
    SHELL_SNAPSHOT_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_FULL_BYTES.fetch_add(payload_len as u64, Ordering::Relaxed);
}

pub(crate) fn note_shell_dirty_snapshot_read(payload_len: usize) {
    SHELL_SNAPSHOT_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_BYTES.fetch_add(payload_len as u64, Ordering::Relaxed);
}

pub(crate) fn note_shell_dirty_snapshot_unchanged() {
    SHELL_SNAPSHOT_DIRTY_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_UNCHANGED_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_dirty_snapshot_fallback(payload_len: usize) {
    SHELL_SNAPSHOT_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_READ_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_FALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_FULL_BYTES.fetch_add(payload_len as u64, Ordering::Relaxed);
}

pub(crate) fn note_shell_snapshot_encode(duration: Duration, message_count: usize) {
    SHELL_SNAPSHOT_ENCODE_COUNT.fetch_add(1, Ordering::Relaxed);
    SHELL_SNAPSHOT_ENCODE_US.fetch_add(duration.as_micros() as u64, Ordering::Relaxed);
    SHELL_SNAPSHOT_ENCODE_MESSAGES.fetch_add(message_count as u64, Ordering::Relaxed);
}

pub(crate) fn note_shell_shared_state_write(kind: u32, payload_len: usize, row_count: u64) {
    match kind {
        1 => {
            SHELL_SHARED_STATE_EXCLUSION_WRITES.fetch_add(1, Ordering::Relaxed);
            SHELL_SHARED_STATE_EXCLUSION_BYTES.fetch_add(payload_len as u64, Ordering::Relaxed);
            SHELL_SHARED_STATE_EXCLUSION_RECTS.fetch_add(row_count, Ordering::Relaxed);
        }
        2 => {
            SHELL_SHARED_STATE_UI_WINDOW_WRITES.fetch_add(1, Ordering::Relaxed);
            SHELL_SHARED_STATE_UI_WINDOW_BYTES.fetch_add(payload_len as u64, Ordering::Relaxed);
            SHELL_SHARED_STATE_UI_WINDOW_ROWS.fetch_add(row_count, Ordering::Relaxed);
        }
        _ => {}
    }
}

pub(crate) fn note_cef_message_pump_scheduled(delay_ms: i64) {
    if let Ok(mut latency) = LATENCY.lock() {
        latency.message_pump_at = Some(Instant::now());
        latency.message_pump_delay_ms = delay_ms;
    }
}

pub(crate) fn note_cef_accelerated_paint(
    width: u32,
    height: u32,
    dirty_rect_kind: DirtyRectKind,
    dirty_rect_count: usize,
    dirty_rect_coverage_per_mille: u16,
    dirty_rect_bbox_full: bool,
) {
    CEF_ACCELERATED_PAINT.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut latency) = LATENCY.lock() {
        latency.accelerated_paint_at = Some(Instant::now());
        latency.accelerated_paint_size = Some((width, height));
        latency.dirty_rect_kind = Some(dirty_rect_kind);
        latency.dirty_rect_count = Some(dirty_rect_count);
        latency.dirty_rect_coverage_per_mille = Some(dirty_rect_coverage_per_mille);
        latency.dirty_rect_bbox_full = Some(dirty_rect_bbox_full);
    }
}

pub(crate) fn note_cef_software_paint() {
    CEF_SOFTWARE_PAINT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn note_shell_dmabuf_rx(width: u32, height: u32) {
    if let Ok(mut latency) = LATENCY.lock() {
        latency.dmabuf_rx_at = Some(Instant::now());
        latency.dmabuf_rx_size = Some((width, height));
    }
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
            drm_render_late_timers: DRM_RENDER_LATE_TIMER.load(Ordering::Relaxed),
            drm_fullscreen_shell_bypasses: DRM_FULLSCREEN_SHELL_BYPASS.load(Ordering::Relaxed),
            cef_accelerated_paints: CEF_ACCELERATED_PAINT.load(Ordering::Relaxed),
            cef_software_paints: CEF_SOFTWARE_PAINT.load(Ordering::Relaxed),
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
            snapshot_full_bytes: SHELL_SNAPSHOT_FULL_BYTES.load(Ordering::Relaxed),
            snapshot_dirty_reads: SHELL_SNAPSHOT_DIRTY_READ_COUNT.load(Ordering::Relaxed),
            snapshot_dirty_unchanged: SHELL_SNAPSHOT_DIRTY_UNCHANGED_COUNT.load(Ordering::Relaxed),
            snapshot_dirty_fallbacks: SHELL_SNAPSHOT_DIRTY_FALLBACK_COUNT.load(Ordering::Relaxed),
            snapshot_dirty_bytes: SHELL_SNAPSHOT_DIRTY_BYTES.load(Ordering::Relaxed),
            snapshot_encode_count: SHELL_SNAPSHOT_ENCODE_COUNT.load(Ordering::Relaxed),
            snapshot_encode_us: SHELL_SNAPSHOT_ENCODE_US.load(Ordering::Relaxed),
            snapshot_encode_messages: SHELL_SNAPSHOT_ENCODE_MESSAGES.load(Ordering::Relaxed),
            shared_state_ui_window_writes: SHELL_SHARED_STATE_UI_WINDOW_WRITES
                .load(Ordering::Relaxed),
            shared_state_ui_window_bytes: SHELL_SHARED_STATE_UI_WINDOW_BYTES
                .load(Ordering::Relaxed),
            shared_state_ui_window_rows: SHELL_SHARED_STATE_UI_WINDOW_ROWS.load(Ordering::Relaxed),
            shared_state_exclusion_writes: SHELL_SHARED_STATE_EXCLUSION_WRITES
                .load(Ordering::Relaxed),
            shared_state_exclusion_bytes: SHELL_SHARED_STATE_EXCLUSION_BYTES
                .load(Ordering::Relaxed),
            shared_state_exclusion_rects: SHELL_SHARED_STATE_EXCLUSION_RECTS
                .load(Ordering::Relaxed),
        },
        latency: ShellLatencySnapshot {
            samples: SHELL_LATENCY_SAMPLES.load(Ordering::Relaxed),
            schedule_to_begin_us: SHELL_LATENCY_SCHEDULE_TO_BEGIN_US.load(Ordering::Relaxed),
            begin_to_paint_us: SHELL_LATENCY_BEGIN_TO_PAINT_US.load(Ordering::Relaxed),
            paint_to_dmabuf_us: SHELL_LATENCY_PAINT_TO_DMABUF_US.load(Ordering::Relaxed),
            dmabuf_to_render_us: SHELL_LATENCY_DMABUF_TO_RENDER_US.load(Ordering::Relaxed),
            schedule_to_dmabuf_us: SHELL_LATENCY_SCHEDULE_TO_DMABUF_US.load(Ordering::Relaxed),
            schedule_to_render_us: SHELL_LATENCY_SCHEDULE_TO_RENDER_US.load(Ordering::Relaxed),
            schedule_to_render_max_us: SHELL_LATENCY_SCHEDULE_TO_RENDER_MAX_US
                .load(Ordering::Relaxed),
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
    DRM_RENDER_LATE_TIMER.store(0, Ordering::Relaxed);
    DRM_FULLSCREEN_SHELL_BYPASS.store(0, Ordering::Relaxed);
    CEF_ACCELERATED_PAINT.store(0, Ordering::Relaxed);
    CEF_SOFTWARE_PAINT.store(0, Ordering::Relaxed);
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
    SHELL_SNAPSHOT_FULL_BYTES.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_READ_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_UNCHANGED_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_FALLBACK_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_DIRTY_BYTES.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_ENCODE_COUNT.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_ENCODE_US.store(0, Ordering::Relaxed);
    SHELL_SNAPSHOT_ENCODE_MESSAGES.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_UI_WINDOW_WRITES.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_UI_WINDOW_BYTES.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_UI_WINDOW_ROWS.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_EXCLUSION_WRITES.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_EXCLUSION_BYTES.store(0, Ordering::Relaxed);
    SHELL_SHARED_STATE_EXCLUSION_RECTS.store(0, Ordering::Relaxed);
    SHELL_LATENCY_SAMPLES.store(0, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_BEGIN_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_BEGIN_TO_PAINT_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_PAINT_TO_DMABUF_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_DMABUF_TO_RENDER_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_DMABUF_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_RENDER_US.store(0, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_RENDER_MAX_US.store(0, Ordering::Relaxed);
    if let Ok(mut latency) = LATENCY.lock() {
        *latency = LatencyTrace::new();
    }
    if let Ok(mut pacing) = PACING.lock() {
        *pacing = None;
    }
}

fn maybe_log_shell_latency() {
    let Ok(mut latency) = LATENCY.lock() else {
        return;
    };
    let Some(dmabuf_rx_at) = latency.dmabuf_rx_at else {
        return;
    };
    if latency.last_logged_dmabuf_rx_at == Some(dmabuf_rx_at) {
        return;
    }
    if Instant::now().duration_since(dmabuf_rx_at) > Duration::from_secs(1) {
        return;
    }
    latency.last_logged_dmabuf_rx_at = Some(dmabuf_rx_at);
    let render_at = Instant::now();
    let Some(schedule_at) = latency
        .compositor_schedule_at
        .or(latency.view_invalidate_at)
        .or(latency.message_pump_at)
    else {
        return;
    };
    let Some(begin_at) = latency.cef_begin_frame_at else {
        return;
    };
    let Some(paint_at) = latency.accelerated_paint_at else {
        return;
    };
    if schedule_at > begin_at || begin_at > paint_at || paint_at > dmabuf_rx_at {
        return;
    }
    let schedule_to_begin = begin_at.duration_since(schedule_at).as_micros() as u64;
    let begin_to_paint = paint_at.duration_since(begin_at).as_micros() as u64;
    let paint_to_dmabuf = dmabuf_rx_at.duration_since(paint_at).as_micros() as u64;
    let dmabuf_to_render = render_at.duration_since(dmabuf_rx_at).as_micros() as u64;
    let schedule_to_dmabuf = dmabuf_rx_at.duration_since(schedule_at).as_micros() as u64;
    let schedule_to_render = render_at.duration_since(schedule_at).as_micros() as u64;
    SHELL_LATENCY_SAMPLES.fetch_add(1, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_BEGIN_US.fetch_add(schedule_to_begin, Ordering::Relaxed);
    SHELL_LATENCY_BEGIN_TO_PAINT_US.fetch_add(begin_to_paint, Ordering::Relaxed);
    SHELL_LATENCY_PAINT_TO_DMABUF_US.fetch_add(paint_to_dmabuf, Ordering::Relaxed);
    SHELL_LATENCY_DMABUF_TO_RENDER_US.fetch_add(dmabuf_to_render, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_DMABUF_US.fetch_add(schedule_to_dmabuf, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_RENDER_US.fetch_add(schedule_to_render, Ordering::Relaxed);
    SHELL_LATENCY_SCHEDULE_TO_RENDER_MAX_US.fetch_max(schedule_to_render, Ordering::Relaxed);
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
