use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use smithay::backend::input::{Axis, AxisSource, ButtonState, KeyState};
use smithay::desktop::layer_map_for_output;
use smithay::input::pointer::AxisFrame;
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{Logical, Point, Rectangle, SERIAL_COUNTER};

use crate::derp_space::DerpSpaceElem;
use crate::window_registry::{WindowBackend, WindowKind, WindowLifecycle};
use crate::CompositorState;

static NEXT_SCREENSHOT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
pub(crate) struct E2eScreenshotResult {
    pub request_id: u64,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: u128,
}

struct ScreenshotWaitState {
    results: HashMap<u64, Result<E2eScreenshotResult, String>>,
}

fn screenshot_wait_state() -> &'static (Mutex<ScreenshotWaitState>, Condvar) {
    static STATE: OnceLock<(Mutex<ScreenshotWaitState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| {
        (
            Mutex::new(ScreenshotWaitState {
                results: HashMap::new(),
            }),
            Condvar::new(),
        )
    })
}

fn next_screenshot_request_id() -> u64 {
    NEXT_SCREENSHOT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn wait_for_screenshot_result(
    request_id: u64,
    timeout: Duration,
) -> Result<E2eScreenshotResult, String> {
    let deadline = std::time::Instant::now() + timeout;
    let (lock, condvar) = screenshot_wait_state();
    let mut state = lock
        .lock()
        .map_err(|_| "screenshot wait state poisoned".to_string())?;
    loop {
        if let Some(result) = state.results.remove(&request_id) {
            return result;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for screenshot {request_id}"));
        }
        let remaining = deadline.saturating_duration_since(now);
        let (next_state, wait_result) = condvar
            .wait_timeout(state, remaining)
            .map_err(|_| "screenshot wait poisoned".to_string())?;
        state = next_state;
        if wait_result.timed_out() && !state.results.contains_key(&request_id) {
            return Err(format!("timed out waiting for screenshot {request_id}"));
        }
    }
}

pub(crate) fn publish_screenshot_result(
    request_id: u64,
    result: Result<E2eScreenshotResult, String>,
) {
    let (lock, condvar) = screenshot_wait_state();
    let mut state = lock.lock().expect("screenshot wait state");
    state.results.insert(request_id, result);
    condvar.notify_all();
}

fn e2e_state_root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path).join("derp").join("e2e"));
    }
    let home = dirs::home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    Ok(home.join(".local").join("state").join("derp").join("e2e"))
}

pub(crate) fn e2e_artifact_dir() -> Result<PathBuf, String> {
    let path = e2e_state_root()?.join("artifacts");
    std::fs::create_dir_all(&path).map_err(|e| format!("create e2e artifact dir: {e}"))?;
    Ok(path)
}

fn next_artifact_path(stem: &str, ext: &str) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock before epoch: {e}"))?
        .as_millis();
    Ok(e2e_artifact_dir()?.join(format!("{stem}-{stamp}.{ext}")))
}

#[derive(Serialize)]
struct E2ePointSnapshot {
    x: f64,
    y: f64,
}

#[derive(Serialize)]
struct E2eRectSnapshot {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
struct E2eOutputSnapshot {
    name: String,
    identity: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    usable_x: i32,
    usable_y: i32,
    usable_width: i32,
    usable_height: i32,
    physical_width: i32,
    physical_height: i32,
    scale: f64,
    transform: String,
    refresh_milli_hz: u32,
    vrr_supported: bool,
    vrr_enabled: bool,
    last_flip_mode: String,
    last_flip_fallback_reason: Option<String>,
}

#[derive(Serialize)]
struct E2eWindowSnapshot {
    window_id: u32,
    surface_id: u32,
    stack_z: u32,
    title: String,
    app_id: String,
    icon_name: String,
    icon_buffers: Vec<E2eWindowIconBufferSnapshot>,
    xwayland_scale: Option<f64>,
    output_name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    minimized: bool,
    maximized: bool,
    fullscreen: bool,
    client_side_decoration: bool,
    shell_hosted: bool,
    backend: String,
    lifecycle: String,
    wayland_client_pid: Option<i32>,
    content_type: String,
    tearing_hint: String,
    render_alpha: f32,
    workspace_visible: bool,
    mapped_x: Option<i32>,
    mapped_y: Option<i32>,
    mapped_width: Option<i32>,
    mapped_height: Option<i32>,
}

#[derive(Serialize)]
struct E2eWindowIconBufferSnapshot {
    width: i32,
    height: i32,
    scale: i32,
}

#[derive(Serialize)]
struct E2eShellUiWindowSnapshot {
    id: u32,
    z: u32,
    global: E2eRectSnapshot,
    buffer: E2eRectSnapshot,
}

#[derive(Serialize)]
struct E2eOutputWindowStackSnapshot {
    output_name: String,
    window_ids: Vec<u32>,
}

#[derive(Serialize)]
struct E2eOskLayerSnapshot {
    surface_id: u32,
    output_name: String,
    namespace: String,
    global: E2eRectSnapshot,
    bbox_global: E2eRectSnapshot,
}

#[derive(Serialize)]
struct E2eLayerSurfaceSnapshot {
    surface_id: u32,
    output_name: String,
    namespace: String,
    global: Option<E2eRectSnapshot>,
    bbox_global: Option<E2eRectSnapshot>,
}

#[derive(Serialize)]
struct E2eInteractionVisualSnapshot {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Serialize)]
struct E2eCompositorSnapshot {
    captured_at_ms: u128,
    pointer: E2ePointSnapshot,
    pointer_pressed_button_count: usize,
    cursor_theme: String,
    cursor_size: u32,
    cursor_shape: String,
    cursor_name: Option<String>,
    cursor_source_path: Option<String>,
    focused_window_id: Option<u32>,
    focused_shell_ui_window_id: Option<u32>,
    session_power_action: Option<String>,
    session_power_requested_at_ms: Option<u128>,
    osk_visible: Option<bool>,
    osk_text_input_visibility_allowed: bool,
    osk_shell_text_input_active: bool,
    osk_gtk_theme: Option<String>,
    osk_preferred_output_name: Option<String>,
    osk_layer_visible_on_preferred_output: bool,
    osk_layer_surfaces: Vec<E2eOskLayerSnapshot>,
    layer_surfaces: Vec<E2eLayerSurfaceSnapshot>,
    shell_keyboard_focus: bool,
    screenshot_selection_active: bool,
    shell_context_menu_visible: bool,
    shell_context_menu_global: Option<E2eRectSnapshot>,
    shell_floating_layers: Vec<E2eFloatingLayerSnapshot>,
    shell_pointer_grab_window_id: Option<u32>,
    shell_move_window_id: Option<u32>,
    shell_resize_window_id: Option<u32>,
    shell_move_visual: Option<E2eInteractionVisualSnapshot>,
    shell_move_proxy_window_id: Option<u32>,
    shell_move_proxy_global: Option<E2eRectSnapshot>,
    shell_move_proxy_capture_global: Option<E2eRectSnapshot>,
    shell_move_proxy_visible_rects: Vec<E2eRectSnapshot>,
    shell_move_proxy_alpha: Option<f32>,
    shell_move_proxy_decor_only: bool,
    shell_resize_visual: Option<E2eInteractionVisualSnapshot>,
    shell_canvas_origin_x: i32,
    shell_canvas_origin_y: i32,
    shell_canvas_width: u32,
    shell_canvas_height: u32,
    workspace: Option<E2eRectSnapshot>,
    outputs: Vec<E2eOutputSnapshot>,
    windows: Vec<E2eWindowSnapshot>,
    window_stack_order: Vec<u32>,
    ordered_window_ids_by_output: Vec<E2eOutputWindowStackSnapshot>,
    shell_ui_windows_generation: u32,
    shell_ui_windows: Vec<E2eShellUiWindowSnapshot>,
    shell_window_frames: Vec<E2eShellUiWindowSnapshot>,
    shell_exclusion_global: Vec<E2eRectSnapshot>,
    shell_native_drag_preview_window_id: Option<u32>,
    shell_native_drag_preview_generation: Option<u32>,
    shell_native_drag_preview_shell_ready: bool,
    shell_native_drag_preview_image_path: Option<String>,
    shell_native_drag_preview_clip_rect: Option<E2eRectSnapshot>,
    pending_deferred_window_ids: Vec<u32>,
    orphaned_wayland_surface_protocol_ids: Vec<u32>,
    explicit_sync: crate::state::ExplicitSyncSnapshot,
}

#[derive(Serialize)]
struct E2eFloatingLayerSnapshot {
    id: u32,
    z: u32,
    global: E2eRectSnapshot,
}

impl CompositorState {
    fn e2e_window_backend_label(backend: WindowBackend) -> &'static str {
        match backend {
            WindowBackend::WaylandXdg => "wayland_xdg",
            WindowBackend::X11 => "x11",
            WindowBackend::ShellHosted => "shell_hosted",
        }
    }

    fn e2e_window_lifecycle_label(lifecycle: WindowLifecycle) -> &'static str {
        match lifecycle {
            WindowLifecycle::Registered => "registered",
            WindowLifecycle::DeferredInitialMap => "deferred_initial_map",
            WindowLifecycle::Mapped => "mapped",
            WindowLifecycle::Minimized => "minimized",
            WindowLifecycle::TrayHidden => "tray_hidden",
            WindowLifecycle::CloseRequested => "close_requested",
        }
    }

    fn e2e_interaction_visual_snapshot(
        &self,
        window_id: Option<u32>,
    ) -> Option<E2eInteractionVisualSnapshot> {
        let window_id = window_id?;
        let info = if self.input_routing.shell_resize_window_id == Some(window_id) {
            self.shell_resize_interaction_info()?
        } else {
            self.windows.window_registry.window_info(window_id)?
        };
        Some(E2eInteractionVisualSnapshot {
            x: info.x,
            y: info.y,
            width: info.width.max(1),
            height: info.height.max(1),
            maximized: info.maximized,
            fullscreen: info.fullscreen,
        })
    }

    fn e2e_rect_snapshot<N>(rect: Rectangle<i32, N>) -> E2eRectSnapshot {
        E2eRectSnapshot {
            x: rect.loc.x,
            y: rect.loc.y,
            width: rect.size.w,
            height: rect.size.h,
        }
    }

    fn e2e_now_ms(&self) -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }

    fn e2e_clamp_global_point(&self, pos: Point<f64, Logical>) -> Option<Point<f64, Logical>> {
        let ws = self.workspace_logical_bounds()?;
        let min_x = ws.loc.x as f64;
        let min_y = ws.loc.y as f64;
        let max_x = (min_x + ws.size.w.max(0) as f64 - 1.0e-4).max(min_x);
        let max_y = (min_y + ws.size.h.max(0) as f64 - 1.0e-4).max(min_y);
        Some(Point::from((
            pos.x.clamp(min_x, max_x),
            pos.y.clamp(min_y, max_y),
        )))
    }

    fn e2e_pointer_move_global_with_sync(
        &mut self,
        x: f64,
        y: f64,
        sync_before_input: bool,
    ) -> Result<(), String> {
        let pos = self
            .e2e_clamp_global_point(Point::from((x, y)))
            .ok_or_else(|| "no workspace bounds available".to_string())?;
        let output = self
            .output_containing_global_point(pos)
            .or_else(|| self.leftmost_output())
            .ok_or_else(|| "no output available for pointer move".to_string())?;
        let output_geo = self
            .output_topology
            .space
            .output_geometry(&output)
            .ok_or_else(|| "missing output geometry for pointer move".to_string())?;
        let local = pos - output_geo.loc.to_f64();
        if sync_before_input {
            self.sync_shell_shared_state_for_input();
        }
        self.pointer_cursor_touch_reveal_for_pointer_motion();
        self.pointer_motion_output_local(output_geo, local, self.e2e_now_ms() as u32);
        Ok(())
    }

    pub(crate) fn e2e_pointer_move_global(&mut self, x: f64, y: f64) -> Result<(), String> {
        self.e2e_pointer_move_global_with_sync(x, y, true)
    }

    pub(crate) fn e2e_pointer_move_globals(&mut self, points: &[(f64, f64)]) -> Result<(), String> {
        self.sync_shell_shared_state_for_input();
        for (x, y) in points {
            self.e2e_pointer_move_global_with_sync(*x, *y, false)?;
        }
        Ok(())
    }

    pub(crate) fn e2e_pointer_move_relative(&mut self, dx: f64, dy: f64) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        self.sync_shell_shared_state_for_input();
        self.pointer_motion_relative(
            Point::<f64, Logical>::from((dx, dy)),
            Point::<f64, Logical>::from((dx, dy)),
            (self.e2e_now_ms() * 1000) as u64,
            self.e2e_now_ms() as u32,
        );
        Ok(())
    }

    pub(crate) fn e2e_pointer_button(&mut self, button: u32, pressed: bool) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        self.sync_shell_shared_state_for_input();
        self.process_pointer_button(
            button,
            if pressed {
                ButtonState::Pressed
            } else {
                ButtonState::Released
            },
            self.e2e_now_ms() as u32,
        );
        Ok(())
    }

    pub(crate) fn e2e_pointer_click(&mut self, x: f64, y: f64, button: u32) -> Result<(), String> {
        self.e2e_pointer_move_global(x, y)?;
        self.e2e_pointer_button(button, true)?;
        self.e2e_pointer_button(button, false)?;
        Ok(())
    }

    pub(crate) fn e2e_touch(
        &mut self,
        action: &str,
        slot_id: i32,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        let slot_u32 = u32::try_from(slot_id).map_err(|_| "touch id must be >= 0".to_string())?;
        let slot = smithay::backend::input::TouchSlot::from(Some(slot_u32));
        let time = self.e2e_now_ms() as u32;
        match action {
            "down" | "motion" => {
                let x = x.ok_or_else(|| "touch: x required for down/motion".to_string())?;
                let y = y.ok_or_else(|| "touch: y required for down/motion".to_string())?;
                let pos = self
                    .e2e_clamp_global_point(Point::from((x, y)))
                    .ok_or_else(|| "no workspace bounds available".to_string())?;
                if action == "down" {
                    self.process_touch_down(slot, pos, time);
                } else {
                    self.process_touch_motion(slot, pos, time);
                }
            }
            "up" => self.process_touch_up(slot, time),
            "cancel" => self.process_touch_cancel(Some(slot), time),
            "frame" => self.process_touch_frame(),
            _ => return Err("touch: action must be down, motion, up, cancel, or frame".to_string()),
        }
        Ok(())
    }

    pub(crate) fn e2e_pointer_drag(
        &mut self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        button: u32,
        steps: u32,
    ) -> Result<(), String> {
        let steps = steps.max(1);
        self.e2e_pointer_move_global(x0, y0)?;
        self.e2e_pointer_button(button, true)?;
        for idx in 1..=steps {
            let t = idx as f64 / steps as f64;
            let x = x0 + (x1 - x0) * t;
            let y = y0 + (y1 - y0) * t;
            self.e2e_pointer_move_global(x, y)?;
        }
        self.e2e_pointer_button(button, false)?;
        Ok(())
    }

    pub(crate) fn e2e_pointer_wheel(&mut self, delta_x: i32, delta_y: i32) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        let time = self.e2e_now_ms() as u32;
        let mut frame = AxisFrame::new(time).source(AxisSource::Wheel);
        if delta_x != 0 {
            frame = frame.value(Axis::Horizontal, -(f64::from(delta_x)));
        }
        if delta_y != 0 {
            frame = frame.value(Axis::Vertical, -(f64::from(delta_y)));
        }
        self.shell_ipc_maybe_forward_pointer_axis(delta_x, delta_y);
        if let Some(pointer) = self.input_routing.seat.get_pointer() {
            pointer.axis(self, frame);
            pointer.frame(self);
        }
        Ok(())
    }

    pub(crate) fn e2e_keyboard_key(
        &mut self,
        keycode: u32,
        key_state: KeyState,
    ) -> Result<(), String> {
        let serial = SERIAL_COUNTER.next_serial();
        let time = self.e2e_now_ms() as u32;
        let keycode = keycode.saturating_add(8);
        self.keyboard_input_from_source(
            "e2e",
            keycode.into(),
            key_state,
            serial,
            time,
            &self.core.loop_handle.clone(),
        )
    }

    pub(crate) fn e2e_crash_window_client(&mut self, window_id: u32) -> Result<(), String> {
        let info = self
            .windows
            .window_registry
            .window_info(window_id)
            .ok_or_else(|| format!("window {window_id} not found"))?;
        if self.windows.window_registry.is_shell_hosted(window_id) {
            return Err(format!("window {window_id} is shell hosted"));
        }
        let pid = info
            .wayland_client_pid
            .ok_or_else(|| format!("window {window_id} has no client pid"))?;
        if pid <= 0 {
            return Err(format!("window {window_id} has invalid client pid {pid}"));
        }
        let rc = unsafe { libc::kill(pid, libc::SIGKILL) };
        if rc != 0 {
            return Err(format!(
                "kill pid {pid} failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub(crate) fn e2e_pointer_gesture_swipe(&mut self) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        let time = self.e2e_now_ms() as u32;
        self.pointer_gesture_swipe_begin(3, time);
        self.pointer_gesture_swipe_update(Point::from((24.0, 0.0)), time);
        self.pointer_gesture_swipe_end(false, time);
        Ok(())
    }

    pub(crate) fn e2e_pointer_gesture_pinch(&mut self) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        let time = self.e2e_now_ms() as u32;
        self.pointer_gesture_pinch_begin(2, time);
        self.pointer_gesture_pinch_update(Point::from((0.0, 0.0)), 1.25, 15.0, time);
        self.pointer_gesture_pinch_end(false, time);
        Ok(())
    }

    pub(crate) fn e2e_pointer_gesture_hold(&mut self) -> Result<(), String> {
        if self.workspace_logical_bounds().is_none() {
            return Err("no workspace bounds available".to_string());
        }
        let time = self.e2e_now_ms() as u32;
        self.pointer_gesture_hold_begin(3, time);
        self.pointer_gesture_hold_end(false, time);
        Ok(())
    }

    pub(crate) fn e2e_set_xdg_activation_token_max_age(
        &mut self,
        max_age: Option<Duration>,
    ) -> Result<(), String> {
        self.xdg_activation_token_max_age_override = max_age;
        self.xdg_activation_prune_stale_tokens();
        Ok(())
    }

    pub(crate) fn e2e_compositor_snapshot_json(&mut self) -> Result<String, String> {
        self.handle_pending_wayland_client_disconnects();
        self.reconcile_hidden_osk_layer_surfaces();
        self.sync_shell_shared_state_for_input();
        let pointer = self
            .input_routing
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location())
            .unwrap_or_else(|| Point::from((0.0, 0.0)));
        let cursor_settings = self.input_routing.cursor_theme.settings();
        let mut cursor_shape = "hidden".to_string();
        let mut cursor_name = None;
        let mut cursor_source_path = None;
        if self.input_routing.pointer_cursor_hidden_after_touch {
            cursor_shape = "hidden".to_string();
        } else if let smithay::input::pointer::CursorImageStatus::Named(icon) =
            &self.input_routing.pointer_cursor_image
        {
            let _ = self
                .input_routing
                .cursor_theme
                .with_cursor(icon, 1.0, |cursor, _, key| {
                    cursor_shape = key.label().to_string();
                    cursor_name = Some(cursor.name.clone());
                    cursor_source_path = cursor
                        .source_path
                        .as_ref()
                        .map(|path| path.display().to_string());
                });
        } else if matches!(
            &self.input_routing.pointer_cursor_image,
            smithay::input::pointer::CursorImageStatus::Surface(_)
        ) {
            cursor_shape = "surface".to_string();
        }
        let workspace = self.workspace_logical_bounds().map(|rect| E2eRectSnapshot {
            x: rect.loc.x,
            y: rect.loc.y,
            width: rect.size.w,
            height: rect.size.h,
        });
        let mut outputs: Vec<E2eOutputSnapshot> = self
            .output_topology
            .space
            .outputs()
            .filter_map(|output| {
                let geometry = self.output_topology.space.output_geometry(&output)?;
                let refresh_milli_hz = output
                    .current_mode()
                    .map(|mode| mode.refresh)
                    .unwrap_or_default()
                    .max(0) as u32;
                let (physical_width, physical_height) = output
                    .current_mode()
                    .map(|mode| (mode.size.w.max(1), mode.size.h.max(1)))
                    .unwrap_or_else(|| {
                        let scale = output.current_scale().fractional_scale();
                        (
                            ((geometry.size.w.max(1) as f64) * scale).round().max(1.0) as i32,
                            ((geometry.size.h.max(1) as f64) * scale).round().max(1.0) as i32,
                        )
                    });
                let (vrr_supported, vrr_enabled) = self.output_vrr_state(output.name().as_str());
                let (last_flip_mode, last_flip_fallback_reason) =
                    self.output_flip_state(output.name().as_str());
                let usable = self
                    .effective_layer_usable_area_global_for_output(&output)
                    .unwrap_or(geometry);
                Some(E2eOutputSnapshot {
                    name: output.name(),
                    identity: Self::shell_output_identity(output),
                    x: geometry.loc.x,
                    y: geometry.loc.y,
                    width: geometry.size.w,
                    height: geometry.size.h,
                    usable_x: usable.loc.x,
                    usable_y: usable.loc.y,
                    usable_width: usable.size.w,
                    usable_height: usable.size.h,
                    physical_width,
                    physical_height,
                    scale: output.current_scale().fractional_scale(),
                    transform: format!("{:?}", output.current_transform()),
                    refresh_milli_hz,
                    vrr_supported,
                    vrr_enabled,
                    last_flip_mode,
                    last_flip_fallback_reason,
                })
            })
            .collect();
        outputs.sort_by(|a, b| a.name.cmp(&b.name));
        let stack_z_by_window_id = self.stack_z_by_window_id();
        let mut windows: Vec<E2eWindowSnapshot> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .map(|record| {
                let render_alpha = self.workspace_window_render_alpha(record.info.window_id);
                let workspace_visible =
                    self.workspace_window_is_visible_during_render(record.info.window_id);
                let mapped_rect = self.mapped_native_window_content_rect(record.info.window_id);
                E2eWindowSnapshot {
                    window_id: record.info.window_id,
                    surface_id: record.info.surface_id,
                    stack_z: stack_z_by_window_id
                        .get(&record.info.window_id)
                        .copied()
                        .unwrap_or(0),
                    title: record.info.title,
                    app_id: record.info.app_id,
                    icon_name: record.info.icon.name,
                    icon_buffers: record
                        .info
                        .icon
                        .buffers
                        .into_iter()
                        .map(|buffer| E2eWindowIconBufferSnapshot {
                            width: buffer.width,
                            height: buffer.height,
                            scale: buffer.scale,
                        })
                        .collect(),
                    xwayland_scale: self.xwayland_scale_for_window_id(record.info.window_id),
                    output_name: record.info.output_name,
                    x: record.info.x,
                    y: record.info.y,
                    width: record.info.width,
                    height: record.info.height,
                    minimized: record.info.minimized,
                    maximized: record.info.maximized,
                    fullscreen: record.info.fullscreen,
                    client_side_decoration: record.info.client_side_decoration,
                    shell_hosted: record.kind == WindowKind::ShellHosted,
                    backend: Self::e2e_window_backend_label(record.backend).to_string(),
                    lifecycle: Self::e2e_window_lifecycle_label(record.lifecycle).to_string(),
                    wayland_client_pid: record.info.wayland_client_pid,
                    content_type: self.content_type_label_for_window_id(record.info.window_id),
                    tearing_hint: self.tearing_hint_label_for_window_id(record.info.window_id),
                    render_alpha,
                    workspace_visible,
                    mapped_x: mapped_rect.map(|rect| rect.loc.x),
                    mapped_y: mapped_rect.map(|rect| rect.loc.y),
                    mapped_width: mapped_rect.map(|rect| rect.size.w),
                    mapped_height: mapped_rect.map(|rect| rect.size.h),
                }
            })
            .collect();
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        let mut ordered_window_ids_by_output: Vec<E2eOutputWindowStackSnapshot> = self
            .output_topology
            .space
            .outputs()
            .map(|output| E2eOutputWindowStackSnapshot {
                output_name: output.name(),
                window_ids: self.ordered_window_ids_on_output(&output),
            })
            .collect();
        ordered_window_ids_by_output.sort_by(|a, b| a.output_name.cmp(&b.output_name));
        let shell_ui_windows = self
            .shell_osr
            .shell_ui_windows
            .iter()
            .map(|window| E2eShellUiWindowSnapshot {
                id: window.id,
                z: window.z,
                global: Self::e2e_rect_snapshot(window.global_rect),
                buffer: Self::e2e_rect_snapshot(window.buffer_rect),
            })
            .collect();
        let shell_window_frames = self
            .shell_window_frame_placements()
            .iter()
            .map(|window| E2eShellUiWindowSnapshot {
                id: window.id,
                z: window.z,
                global: Self::e2e_rect_snapshot(window.global_rect),
                buffer: Self::e2e_rect_snapshot(window.buffer_rect),
            })
            .collect();
        let shell_exclusion_global = self
            .shell_osr
            .shell_exclusion_global
            .iter()
            .copied()
            .map(Self::e2e_rect_snapshot)
            .collect();
        let mut pending_deferred_window_ids: Vec<u32> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.lifecycle == WindowLifecycle::DeferredInitialMap)
            .map(|record| record.info.window_id)
            .collect();
        pending_deferred_window_ids.sort_unstable();
        pending_deferred_window_ids.dedup();
        let mut orphaned_wayland_surface_protocol_ids: Vec<u32> = self
            .output_topology
            .space
            .elements()
            .filter_map(|elem| match elem {
                DerpSpaceElem::Wayland(window) => {
                    let toplevel = window.toplevel()?;
                    let wl_surface = toplevel.wl_surface();
                    self.windows
                        .window_registry
                        .window_id_for_wl_surface(wl_surface)
                        .is_none()
                        .then_some(wl_surface.id().protocol_id())
                }
                _ => None,
            })
            .collect();
        orphaned_wayland_surface_protocol_ids.sort_unstable();
        orphaned_wayland_surface_protocol_ids.dedup();
        let shell_floating_layers: Vec<E2eFloatingLayerSnapshot> = self
            .shell_osr
            .shell_exclusion_floating
            .iter()
            .enumerate()
            .map(|(index, rect)| E2eFloatingLayerSnapshot {
                id: index as u32 + 1,
                z: index as u32 + 1,
                global: Self::e2e_rect_snapshot(*rect),
            })
            .collect();
        let mut osk_layer_surfaces = Vec::new();
        let mut layer_surfaces = Vec::new();
        for output in self.output_topology.space.outputs() {
            let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
                continue;
            };
            let output_name = output.name();
            let map = layer_map_for_output(output);
            for layer in map.layers() {
                let geo = map.layer_geometry(layer);
                let bbox = geo.map(|geo| {
                    let geo = self.osk_visual_layer_geometry_for_output(output, layer, geo);
                    let bbox = layer.bbox_with_popups();
                    Rectangle::new(output_geo.loc + geo.loc + bbox.loc, bbox.size)
                });
                layer_surfaces.push(E2eLayerSurfaceSnapshot {
                    surface_id: layer.wl_surface().id().protocol_id(),
                    output_name: output_name.clone(),
                    namespace: layer.namespace().to_string(),
                    global: geo.map(|geo| {
                        let geo = self.osk_visual_layer_geometry_for_output(output, layer, geo);
                        Self::e2e_rect_snapshot(Rectangle::new(output_geo.loc + geo.loc, geo.size))
                    }),
                    bbox_global: bbox.map(Self::e2e_rect_snapshot),
                });
                if !Self::osk_layer_namespace(layer.namespace()) {
                    continue;
                }
                let Some(geo) = geo else {
                    continue;
                };
                let geo = self.osk_visual_layer_geometry_for_output(output, layer, geo);
                osk_layer_surfaces.push(E2eOskLayerSnapshot {
                    surface_id: layer.wl_surface().id().protocol_id(),
                    output_name: output_name.clone(),
                    namespace: layer.namespace().to_string(),
                    global: Self::e2e_rect_snapshot(Rectangle::new(
                        output_geo.loc + geo.loc,
                        geo.size,
                    )),
                    bbox_global: {
                        let bbox = layer.bbox_with_popups();
                        Self::e2e_rect_snapshot(Rectangle::new(
                            output_geo.loc + geo.loc + bbox.loc,
                            bbox.size,
                        ))
                    },
                });
            }
        }
        let shell_context_menu_global = if shell_floating_layers.is_empty() {
            None
        } else {
            let min_x = shell_floating_layers
                .iter()
                .map(|layer| layer.global.x)
                .min()
                .unwrap_or(0);
            let min_y = shell_floating_layers
                .iter()
                .map(|layer| layer.global.y)
                .min()
                .unwrap_or(0);
            let max_x = shell_floating_layers
                .iter()
                .map(|layer| layer.global.x + layer.global.width)
                .max()
                .unwrap_or(min_x);
            let max_y = shell_floating_layers
                .iter()
                .map(|layer| layer.global.y + layer.global.height)
                .max()
                .unwrap_or(min_y);
            Some(E2eRectSnapshot {
                x: min_x,
                y: min_y,
                width: max_x - min_x,
                height: max_y - min_y,
            })
        };
        serde_json::to_string(&E2eCompositorSnapshot {
            captured_at_ms: self.e2e_now_ms(),
            pointer: E2ePointSnapshot {
                x: pointer.x,
                y: pointer.y,
            },
            pointer_pressed_button_count: self.input_routing.pointer_pressed_buttons.len(),
            cursor_theme: cursor_settings.theme,
            cursor_size: cursor_settings.size,
            cursor_shape,
            cursor_name,
            cursor_source_path,
            focused_window_id: self.keyboard_focused_window_id(),
            focused_shell_ui_window_id: self.shell_osr.shell_focused_ui_window_id,
            session_power_action: self.session_services.last_session_power_action(),
            session_power_requested_at_ms: self
                .session_services
                .last_session_power_requested_at_ms(),
            osk_visible: self.session_services.osk_visible,
            osk_text_input_visibility_allowed: self
                .session_services
                .osk_text_input_visibility_allowed,
            osk_shell_text_input_active: self.session_services.osk_shell_text_input_active,
            osk_gtk_theme: self.session_services.osk_gtk_theme.clone(),
            osk_preferred_output_name: self.session_services.osk_preferred_output_name.clone(),
            osk_layer_visible_on_preferred_output: self
                .osk_layer_surface_visible_on_preferred_output_now(),
            osk_layer_surfaces,
            layer_surfaces,
            shell_keyboard_focus: self.shell_keyboard_capture_active(),
            screenshot_selection_active: self.capture.screenshot_selection_active(),
            shell_context_menu_visible: self.shell_osr.shell_exclusion_overlay_open
                && !self.shell_osr.shell_exclusion_floating.is_empty(),
            shell_context_menu_global,
            shell_floating_layers,
            shell_pointer_grab_window_id: self.input_routing.shell_ui_pointer_grab,
            shell_move_window_id: self.input_routing.shell_move_window_id,
            shell_resize_window_id: self.input_routing.shell_resize_window_id,
            shell_move_visual: self
                .e2e_interaction_visual_snapshot(self.input_routing.shell_move_window_id),
            shell_move_proxy_window_id: self
                .input_routing
                .shell_move_proxy
                .as_ref()
                .and_then(|proxy| proxy.texture.as_ref().map(|_| proxy.window_id)),
            shell_move_proxy_global: self
                .input_routing
                .shell_move_proxy
                .as_ref()
                .and_then(|proxy| proxy.texture.as_ref().map(|_| ()))
                .and_then(|_| self.shell_move_proxy_target_global_rect())
                .map(Self::e2e_rect_snapshot),
            shell_move_proxy_capture_global: self
                .input_routing
                .shell_move_proxy
                .as_ref()
                .and_then(|proxy| proxy.texture.as_ref().map(|_| ()))
                .and_then(|_| {
                    self.input_routing
                        .shell_move_proxy
                        .as_ref()
                        .and_then(|proxy| proxy.texture_global_rect)
                })
                .map(Self::e2e_rect_snapshot),
            shell_move_proxy_visible_rects: self
                .output_topology
                .space
                .outputs()
                .flat_map(|output| {
                    crate::render::shell_render::shell_move_proxy_visible_rects_for_output(
                        self, output,
                    )
                })
                .map(Self::e2e_rect_snapshot)
                .collect(),
            shell_move_proxy_alpha: self.input_routing.shell_move_proxy.as_ref().and_then(
                |proxy| {
                    proxy
                        .texture
                        .as_ref()
                        .map(|_| crate::state::SHELL_DRAG_WINDOW_ALPHA)
                },
            ),
            shell_move_proxy_decor_only: self.input_routing.shell_move_proxy.as_ref().is_some_and(
                |proxy| {
                    !self
                        .windows
                        .window_registry
                        .is_shell_hosted(proxy.window_id)
                },
            ),
            shell_resize_visual: self
                .e2e_interaction_visual_snapshot(self.input_routing.shell_resize_window_id),
            shell_canvas_origin_x: self.output_topology.shell_canvas_logical_origin.0,
            shell_canvas_origin_y: self.output_topology.shell_canvas_logical_origin.1,
            shell_canvas_width: self.output_topology.shell_canvas_logical_size.0,
            shell_canvas_height: self.output_topology.shell_canvas_logical_size.1,
            workspace,
            outputs,
            windows,
            window_stack_order: self.shell_window_stack_ids().into_iter().rev().collect(),
            ordered_window_ids_by_output,
            shell_ui_windows_generation: self.shell_osr.shell_ui_windows_generation,
            shell_ui_windows,
            shell_window_frames,
            shell_exclusion_global,
            shell_native_drag_preview_window_id: self
                .input_routing
                .shell_native_drag_preview
                .as_ref()
                .map(|preview| preview.window_id),
            shell_native_drag_preview_generation: self
                .input_routing
                .shell_native_drag_preview
                .as_ref()
                .map(|preview| preview.generation),
            shell_native_drag_preview_shell_ready: self
                .input_routing
                .shell_native_drag_preview
                .as_ref()
                .is_some_and(|preview| preview.shell_ready),
            shell_native_drag_preview_image_path: self
                .input_routing
                .shell_native_drag_preview
                .as_ref()
                .and_then(|preview| preview.image_path.clone()),
            shell_native_drag_preview_clip_rect: self
                .shell_native_drag_preview_clip_rect()
                .map(Self::e2e_rect_snapshot),
            pending_deferred_window_ids,
            orphaned_wayland_surface_protocol_ids,
            explicit_sync: self.explicit_sync_snapshot(),
        })
        .map_err(|e| format!("serialize compositor snapshot: {e}"))
    }

    pub(crate) fn e2e_request_screenshot(
        &mut self,
        rect: Option<Rectangle<i32, Logical>>,
    ) -> Result<u64, String> {
        let logical_rect = rect
            .or_else(|| self.workspace_logical_bounds())
            .ok_or_else(|| "no workspace bounds available for screenshot".to_string())?;
        if logical_rect.size.w <= 0 || logical_rect.size.h <= 0 {
            return Err("screenshot region must be non-empty".to_string());
        }
        let outputs: Vec<String> = self
            .output_topology
            .space
            .outputs()
            .filter_map(|output| {
                let geo = self.output_topology.space.output_geometry(&output)?;
                geo.intersection(logical_rect).map(|_| output.name())
            })
            .collect();
        let request_id = next_screenshot_request_id();
        let save_path = next_artifact_path("screenshot", "png")?;
        self.capture.set_screenshot_request(
            crate::render::screenshot::PendingScreenshotRequest::for_region_e2e(
                logical_rect,
                outputs,
                request_id,
                save_path,
            )?,
        );
        self.core.loop_signal.wakeup();
        Ok(request_id)
    }
}
