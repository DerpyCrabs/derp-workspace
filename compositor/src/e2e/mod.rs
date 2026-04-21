use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use smithay::backend::input::{Axis, AxisSource, ButtonState, KeyState};
use smithay::input::keyboard::FilterResult;
use smithay::input::pointer::AxisFrame;
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{Logical, Point, Rectangle, SERIAL_COUNTER};
use smithay::wayland::keyboard_shortcuts_inhibit::KeyboardShortcutsInhibitorSeat;

use crate::derp_space::DerpSpaceElem;
use crate::window_registry::WindowKind;
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
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
    transform: String,
    refresh_milli_hz: u32,
}

#[derive(Serialize)]
struct E2eWindowSnapshot {
    window_id: u32,
    surface_id: u32,
    stack_z: u32,
    title: String,
    app_id: String,
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
    wayland_client_pid: Option<i32>,
    render_alpha: f32,
    workspace_visible: bool,
}

#[derive(Serialize)]
struct E2eShellUiWindowSnapshot {
    id: u32,
    z: u32,
    global: E2eRectSnapshot,
    buffer: E2eRectSnapshot,
}

#[derive(Serialize)]
struct E2eWindowRectsSnapshot {
    window_id: u32,
    rects: Vec<E2eRectSnapshot>,
}

#[derive(Serialize)]
struct E2eOutputWindowStackSnapshot {
    output_name: String,
    window_ids: Vec<u32>,
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
    focused_window_id: Option<u32>,
    focused_shell_ui_window_id: Option<u32>,
    session_power_action: Option<String>,
    session_power_requested_at_ms: Option<u128>,
    shell_keyboard_focus: bool,
    screenshot_selection_active: bool,
    shell_context_menu_visible: bool,
    shell_context_menu_global: Option<E2eRectSnapshot>,
    shell_floating_layers: Vec<E2eFloatingLayerSnapshot>,
    shell_pointer_grab_window_id: Option<u32>,
    shell_move_window_id: Option<u32>,
    shell_resize_window_id: Option<u32>,
    shell_move_visual: Option<E2eInteractionVisualSnapshot>,
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
    shell_exclusion_global: Vec<E2eRectSnapshot>,
    shell_exclusion_decor: Vec<E2eWindowRectsSnapshot>,
    pending_deferred_window_ids: Vec<u32>,
    orphaned_wayland_surface_protocol_ids: Vec<u32>,
}

#[derive(Serialize)]
struct E2eFloatingLayerSnapshot {
    id: u32,
    z: u32,
    global: E2eRectSnapshot,
}

impl CompositorState {
    fn e2e_interaction_visual_snapshot(
        &self,
        window_id: Option<u32>,
    ) -> Option<E2eInteractionVisualSnapshot> {
        let info = self.window_registry.window_info(window_id?)?;
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

    pub(crate) fn e2e_pointer_move_global(&mut self, x: f64, y: f64) -> Result<(), String> {
        let prev = self
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location())
            .unwrap_or_else(|| Point::from((x, y)));
        let pos = self
            .e2e_clamp_global_point(Point::from((x, y)))
            .ok_or_else(|| "no workspace bounds available".to_string())?;
        let output = self
            .output_containing_global_point(pos)
            .or_else(|| self.leftmost_output())
            .ok_or_else(|| "no output available for pointer move".to_string())?;
        let output_geo = self
            .space
            .output_geometry(&output)
            .ok_or_else(|| "missing output geometry for pointer move".to_string())?;
        let local = pos - output_geo.loc.to_f64();
        self.sync_shell_shared_state_for_input();
        self.pointer_motion_output_local(output_geo, local, self.e2e_now_ms() as u32);
        let dx = (pos.x - prev.x).round() as i32;
        let dy = (pos.y - prev.y).round() as i32;
        if dx != 0 || dy != 0 {
            if self.shell_move_is_active() {
                self.shell_move_delta(dx, dy);
            }
            if self.shell_resize_is_active() {
                self.shell_resize_delta(dx, dy);
            }
            if self.shell_move_is_active() || self.shell_resize_is_active() {
                self.shell_send_interaction_state();
            }
        }
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
        if let Some(pointer) = self.seat.get_pointer() {
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
        let Some(keyboard) = self.seat.get_keyboard() else {
            return Err("keyboard is unavailable".to_string());
        };
        let serial = SERIAL_COUNTER.next_serial();
        let time = self.e2e_now_ms() as u32;
        let keycode = keycode.saturating_add(8);
        keyboard.input::<(), _>(
            self,
            keycode.into(),
            key_state,
            serial,
            time,
            move |state, mods, keysym| {
                let raw_sym = keysym.modified_sym().raw();
                let is_super = crate::input::keysym_is_super(&keysym);
                if state.screenshot_selection_active() {
                    if key_state == KeyState::Pressed
                        && matches!(raw_sym, smithay::input::keyboard::keysyms::KEY_Escape)
                    {
                        state.cancel_screenshot_selection_mode();
                    }
                    return FilterResult::Intercept(());
                }
                if key_state == KeyState::Pressed {
                    if is_super && !state.seat.keyboard_shortcuts_inhibited() {
                        tracing::warn!(
                            target: "derp_shell_menu",
                            source = "e2e",
                            key_state = "pressed",
                            raw_sym,
                            shell_cef_active = state.shell_cef_active(),
                            shell_has_frame = state.shell_has_frame,
                            shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                            pending_toggle = state.programs_menu_super_pending_toggle,
                            "super key pressed"
                        );
                        state.programs_menu_super_armed = true;
                        state.programs_menu_super_chord = false;
                        return FilterResult::Intercept(());
                    }
                    if state.programs_menu_super_armed
                        && !is_super
                        && !state.seat.keyboard_shortcuts_inhibited()
                    {
                        if let Some(action) =
                            crate::input::super_keybind_action(raw_sym, mods.ctrl, mods.shift)
                        {
                            tracing::warn!(
                                target: "derp_shell_menu",
                                source = "e2e",
                                %action,
                                raw_sym,
                                shell_cef_active = state.shell_cef_active(),
                                shell_has_frame = state.shell_has_frame,
                                shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                                pending_toggle = state.programs_menu_super_pending_toggle,
                                "super chord matched action"
                            );
                            state.programs_menu_super_chord = true;
                            if state.shell_cef_active() {
                                state.handle_super_keybind(action);
                            }
                            return FilterResult::Intercept(());
                        }
                        state.programs_menu_super_chord = true;
                        return FilterResult::Intercept(());
                    }
                } else if key_state == KeyState::Released
                    && is_super
                    && !state.seat.keyboard_shortcuts_inhibited()
                {
                    let armed = state.programs_menu_super_armed;
                    let chord = state.programs_menu_super_chord;
                    tracing::warn!(
                        target: "derp_shell_menu",
                        source = "e2e",
                        key_state = "released",
                        raw_sym,
                        armed,
                        chord,
                        shell_cef_active = state.shell_cef_active(),
                        shell_has_frame = state.shell_has_frame,
                        shell_ipc_keyboard_to_cef = state.shell_ipc_keyboard_to_cef,
                        pending_toggle = state.programs_menu_super_pending_toggle,
                        "super key released"
                    );
                    state.programs_menu_super_armed = false;
                    state.programs_menu_super_chord = false;
                    if armed && !chord {
                        if state.shell_cef_active() {
                            state.programs_menu_toggle_from_super(serial);
                        } else {
                            tracing::warn!(
                                target: "derp_shell_menu",
                                source = "e2e",
                                "queue pending launcher toggle until shell load success"
                            );
                            state.programs_menu_super_pending_toggle = true;
                        }
                        return FilterResult::Intercept(());
                    }
                }
                if state.shell_ipc_keyboard_to_cef
                    && state.shell_cef_active()
                    && state.shell_has_frame
                {
                    state.shell_ipc_forward_keyboard_to_cef(key_state, mods, &keysym, false);
                    state.shell_ipc_refresh_pointer_modifiers();
                    return FilterResult::Intercept(());
                }
                FilterResult::Forward
            },
        );
        Ok(())
    }

    pub(crate) fn e2e_crash_window_client(&mut self, window_id: u32) -> Result<(), String> {
        let info = self
            .window_registry
            .window_info(window_id)
            .ok_or_else(|| format!("window {window_id} not found"))?;
        if self.window_registry.is_shell_hosted(window_id) {
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

    pub(crate) fn e2e_compositor_snapshot_json(&mut self) -> Result<String, String> {
        self.sync_shell_shared_state_for_input();
        let pointer = self
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location())
            .unwrap_or_else(|| Point::from((0.0, 0.0)));
        let workspace = self.workspace_logical_bounds().map(|rect| E2eRectSnapshot {
            x: rect.loc.x,
            y: rect.loc.y,
            width: rect.size.w,
            height: rect.size.h,
        });
        let mut outputs: Vec<E2eOutputSnapshot> = self
            .space
            .outputs()
            .filter_map(|output| {
                let geometry = self.space.output_geometry(&output)?;
                let refresh_milli_hz = output
                    .current_mode()
                    .map(|mode| mode.refresh)
                    .unwrap_or_default()
                    .max(0) as u32;
                Some(E2eOutputSnapshot {
                    name: output.name(),
                    x: geometry.loc.x,
                    y: geometry.loc.y,
                    width: geometry.size.w,
                    height: geometry.size.h,
                    scale: output.current_scale().fractional_scale(),
                    transform: format!("{:?}", output.current_transform()),
                    refresh_milli_hz,
                })
            })
            .collect();
        outputs.sort_by(|a, b| a.name.cmp(&b.name));
        let mut windows: Vec<E2eWindowSnapshot> = self
            .window_registry
            .all_records()
            .into_iter()
            .map(|record| {
                let render_alpha = self.workspace_window_render_alpha(record.info.window_id);
                let workspace_visible =
                    self.workspace_window_is_visible_during_render(record.info.window_id);
                E2eWindowSnapshot {
                    window_id: record.info.window_id,
                    surface_id: record.info.surface_id,
                    stack_z: self.shell_window_stack_z(record.info.window_id),
                    title: record.info.title,
                    app_id: record.info.app_id,
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
                    wayland_client_pid: record.info.wayland_client_pid,
                    render_alpha,
                    workspace_visible,
                }
            })
            .collect();
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        let mut ordered_window_ids_by_output: Vec<E2eOutputWindowStackSnapshot> = self
            .space
            .outputs()
            .map(|output| E2eOutputWindowStackSnapshot {
                output_name: output.name(),
                window_ids: self.ordered_window_ids_on_output(&output),
            })
            .collect();
        ordered_window_ids_by_output.sort_by(|a, b| a.output_name.cmp(&b.output_name));
        let shell_ui_windows = self
            .shell_ui_windows
            .iter()
            .map(|window| E2eShellUiWindowSnapshot {
                id: window.id,
                z: window.z,
                global: Self::e2e_rect_snapshot(window.global_rect),
                buffer: Self::e2e_rect_snapshot(window.buffer_rect),
            })
            .collect();
        let shell_exclusion_global = self
            .shell_exclusion_global
            .iter()
            .copied()
            .map(Self::e2e_rect_snapshot)
            .collect();
        let mut shell_exclusion_decor: Vec<E2eWindowRectsSnapshot> = self
            .shell_exclusion_decor
            .iter()
            .map(|(window_id, rects)| E2eWindowRectsSnapshot {
                window_id: *window_id,
                rects: rects.iter().copied().map(Self::e2e_rect_snapshot).collect(),
            })
            .collect();
        shell_exclusion_decor.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        let mut pending_deferred_window_ids: Vec<u32> = self
            .pending_deferred_toplevels
            .values()
            .filter_map(|pending| {
                pending.window.toplevel().and_then(|toplevel| {
                    self.window_registry
                        .window_id_for_wl_surface(toplevel.wl_surface())
                })
            })
            .collect();
        pending_deferred_window_ids.sort_unstable();
        pending_deferred_window_ids.dedup();
        let mut orphaned_wayland_surface_protocol_ids: Vec<u32> = self
            .space
            .elements()
            .filter_map(|elem| match elem {
                DerpSpaceElem::Wayland(window) => {
                    let toplevel = window.toplevel()?;
                    let wl_surface = toplevel.wl_surface();
                    self.window_registry
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
            .shell_exclusion_floating
            .iter()
            .enumerate()
            .map(|(index, rect)| E2eFloatingLayerSnapshot {
                id: index as u32 + 1,
                z: index as u32 + 1,
                global: Self::e2e_rect_snapshot(*rect),
            })
            .collect();
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
            focused_window_id: self.keyboard_focused_window_id(),
            focused_shell_ui_window_id: self.shell_focused_ui_window_id,
            session_power_action: self.e2e_last_session_power_action.clone(),
            session_power_requested_at_ms: self.e2e_last_session_power_requested_at_ms,
            shell_keyboard_focus: self.shell_ipc_keyboard_to_cef,
            screenshot_selection_active: self.screenshot_selection_active,
            shell_context_menu_visible: self.shell_exclusion_overlay_open
                && !self.shell_exclusion_floating.is_empty(),
            shell_context_menu_global,
            shell_floating_layers,
            shell_pointer_grab_window_id: self.shell_ui_pointer_grab,
            shell_move_window_id: self.shell_move_window_id,
            shell_resize_window_id: self.shell_resize_window_id,
            shell_move_visual: self.e2e_interaction_visual_snapshot(self.shell_move_window_id),
            shell_resize_visual: self.e2e_interaction_visual_snapshot(self.shell_resize_window_id),
            shell_canvas_origin_x: self.shell_canvas_logical_origin.0,
            shell_canvas_origin_y: self.shell_canvas_logical_origin.1,
            shell_canvas_width: self.shell_canvas_logical_size.0,
            shell_canvas_height: self.shell_canvas_logical_size.1,
            workspace,
            outputs,
            windows,
            window_stack_order: self.shell_window_stack_ids().into_iter().rev().collect(),
            ordered_window_ids_by_output,
            shell_ui_windows_generation: self.shell_ui_windows_generation,
            shell_ui_windows,
            shell_exclusion_global,
            shell_exclusion_decor,
            pending_deferred_window_ids,
            orphaned_wayland_surface_protocol_ids,
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
            .space
            .outputs()
            .filter_map(|output| {
                let geo = self.space.output_geometry(&output)?;
                geo.intersection(logical_rect).map(|_| output.name())
            })
            .collect();
        let request_id = next_screenshot_request_id();
        let save_path = next_artifact_path("screenshot", "png")?;
        self.screenshot_request = Some(
            crate::render::screenshot::PendingScreenshotRequest::for_region_e2e(
                logical_rect,
                outputs,
                request_id,
                save_path,
            )?,
        );
        self.loop_signal.wakeup();
        Ok(request_id)
    }
}
