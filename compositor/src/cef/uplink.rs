use smithay::reexports::calloop::channel::Sender;
use smithay::utils::{Logical, Rectangle};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::cef::compositor_tx::CefToCompositor;

#[derive(Clone)]
pub struct UplinkToCompositor {
    cef_tx: Sender<CefToCompositor>,
}

impl UplinkToCompositor {
    pub fn new(cef_tx: Sender<CefToCompositor>) -> Self {
        Self { cef_tx }
    }

    fn run(&self, f: impl FnOnce(&mut crate::state::CompositorState) + Send + 'static) {
        let _ = self.cef_tx.send(CefToCompositor::Run(Box::new(move |s| {
            s.shell_note_shell_ipc_rx();
            f(s);
        })));
    }

    fn run_result<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut crate::state::CompositorState) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.cef_tx
            .send(CefToCompositor::Run(Box::new(move |s| {
                s.shell_note_shell_ipc_rx();
                let _ = tx.send(f(s));
            })))
            .map_err(|_| "failed to queue compositor task".to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "timed out waiting for compositor task".to_string())?
    }

    pub fn quit_compositor(&self) {
        self.run(move |s| {
            s.stop_event_loop();
        });
    }

    pub fn shell_ipc_pong(&self) {
        self.run(move |s| {
            s.shell_ipc_on_pong();
        });
    }

    pub fn session_power_systemctl(&self, verb: String) {
        let state_verb = verb.clone();
        self.run(move |s| {
            s.e2e_last_session_power_action = Some(state_verb);
            s.e2e_last_session_power_requested_at_ms = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            );
        });
        std::thread::spawn(move || {
            match std::process::Command::new("systemctl").arg(&verb).output() {
                Ok(out) if out.status.success() => {}
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    tracing::warn!(
                        %verb,
                        code=?out.status,
                        %stderr,
                        "session_power: systemctl failed"
                    );
                }
                Err(e) => tracing::warn!(%verb, %e, "session_power: systemctl spawn failed"),
            }
        });
    }

    pub fn settings_keyboard_apply(
        &self,
        settings: crate::session::settings_config::KeyboardSettingsFile,
    ) -> Result<(), String> {
        self.run_result(move |s| {
            s.keyboard_apply_settings(&settings)?;
            crate::session::settings_config::write_keyboard_settings(settings.clone())
        })
    }

    pub fn settings_scratchpads_apply(
        &self,
        settings: crate::session::settings_config::ScratchpadSettingsFile,
    ) -> Result<(), String> {
        self.run_result(move |s| s.apply_scratchpad_settings(settings))
    }

    pub fn settings_hotkeys_apply(
        &self,
        settings: crate::session::settings_config::HotkeySettingsFile,
    ) -> Result<(), String> {
        self.run_result(move |s| s.apply_hotkey_settings(settings))
    }

    pub fn spawn_wayland_client(&self, command: String) {
        self.run(move |s| {
            if let Err(e) = s.try_spawn_wayland_client_sh(&command) {
                tracing::warn!(%e, "shell uplink: spawn");
            }
        });
    }

    pub fn command_palette_activate(&self, json: String) {
        self.run(move |s| {
            let value = match serde_json::from_str::<serde_json::Value>(&json) {
                Ok(value) => value,
                Err(_) => return,
            };
            let Some(owner) = value.get("owner").and_then(|value| value.as_str()) else {
                return;
            };
            let Some(id) = value.get("id").and_then(|value| value.as_str()) else {
                return;
            };
            let _ = s.control_palette_activate(owner, id);
        });
    }

    pub fn shell_close(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_close(window_id);
        });
    }

    pub fn shell_move_begin(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_begin_move(window_id);
        });
    }

    pub fn shell_move_delta(&self, dx: i32, dy: i32) {
        self.run(move |s| {
            s.window_op_move_delta(dx, dy);
        });
    }

    pub fn shell_move_end(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_end_move(window_id);
        });
    }

    pub fn shell_native_drag_preview_begin(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_native_drag_preview_begin(window_id);
        });
    }

    pub fn shell_native_drag_preview_cancel(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_native_drag_preview_cancel(Some(window_id));
        });
    }

    pub fn shell_native_drag_preview_ready(&self, window_id: u32, generation: u32) {
        self.run(move |s| {
            s.shell_native_drag_preview_mark_ready(window_id, generation);
        });
    }

    pub fn shell_resize_begin(&self, window_id: u32, edges: u32) {
        self.run(move |s| {
            s.window_op_begin_resize(window_id, edges);
        });
    }

    pub fn shell_resize_delta(&self, dx: i32, dy: i32) {
        self.run(move |s| {
            s.window_op_resize_delta(dx, dy);
        });
    }

    pub fn shell_resize_end(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_end_resize(window_id);
        });
    }

    pub fn shell_resize_shell_grab_begin(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_resize_shell_grab_begin(window_id);
        });
    }

    pub fn shell_resize_shell_grab_end(&self) {
        self.run(move |s| {
            s.shell_resize_shell_grab_end();
        });
    }

    pub fn shell_taskbar_activate(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_taskbar_activate(window_id);
        });
    }

    pub fn shell_activate_window(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_focus(window_id);
        });
    }

    pub fn shell_focus_shell_ui_window(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_focus_shell_ui_window(window_id);
        });
    }

    pub fn shell_blur_shell_ui_focus(&self) {
        self.run(move |s| {
            s.shell_blur_shell_ui_focus();
        });
    }

    pub fn programs_menu_opened(&self, restore_window_id: u32) {
        self.run(move |s| {
            s.programs_menu_opened_from_shell(restore_window_id);
        });
    }

    pub fn programs_menu_closed(&self) {
        self.run(move |s| {
            s.programs_menu_closed_from_shell();
        });
    }

    pub fn shell_ui_pointer_grab_begin(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_ui_pointer_grab_begin(window_id);
        });
    }

    pub fn shell_ui_pointer_grab_end(&self) {
        self.run(move |s| {
            s.shell_ui_pointer_grab_end();
        });
    }

    pub fn shell_minimize(&self, window_id: u32) {
        self.run(move |s| {
            s.window_op_minimize(window_id);
        });
    }

    pub fn shell_set_fullscreen(&self, window_id: u32, enabled: bool) {
        self.run(move |s| {
            s.window_op_set_fullscreen(window_id, enabled);
        });
    }

    pub fn shell_set_maximized(&self, window_id: u32, enabled: bool) {
        self.run(move |s| {
            s.window_op_set_maximized(window_id, enabled);
        });
    }

    pub fn shell_set_geometry(
        &self,
        window_id: u32,
        vx: i32,
        vy: i32,
        vw: i32,
        vh: i32,
        layout: u32,
    ) {
        self.run(move |s| {
            let mode = if layout == 1 {
                crate::window_ops::WindowLayoutMode::Maximized
            } else {
                crate::window_ops::WindowLayoutMode::Floating
            };
            s.window_op_set_geometry(window_id, vx, vy, vw, vh, mode);
        });
    }

    pub fn shell_set_presentation_fullscreen(&self, enabled: bool) {
        self.run(move |s| {
            s.shell_set_presentation_fullscreen(enabled);
        });
    }

    pub fn shell_apply_output_layout(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_output_layout_json(&json);
        });
    }

    pub fn shell_window_intent(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_window_intent_json(&json);
        });
    }

    pub fn shell_set_desktop_background(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_desktop_background_json(&json);
        });
    }

    pub fn shell_set_ui_scale(&self, scale: f64) {
        self.run(move |s| {
            s.set_shell_ui_scale(scale);
        });
    }

    pub fn shell_set_shell_primary(&self, name: String) {
        self.run(move |s| {
            s.set_shell_primary_output_name(name);
        });
    }

    pub fn shell_set_output_vrr(&self, name: String, enabled: bool) {
        let _ = self
            .cef_tx
            .send(CefToCompositor::SetOutputVrr { name, enabled });
    }

    pub fn shell_shared_state_sync(&self, kind: u32) {
        self.run(move |s| {
            s.sync_shell_shared_state(kind);
        });
    }

    pub fn shell_tile_preview_canvas(&self, visible: bool, lx: i32, ly: i32, lw: i32, lh: i32) {
        self.run(move |s| {
            s.apply_shell_tile_preview_canvas(visible, lx, ly, lw, lh);
        });
    }

    pub fn shell_chrome_metrics(&self, titlebar_h: i32, border_w: i32) {
        self.run(move |s| {
            s.apply_shell_chrome_metrics(titlebar_h, border_w);
        });
    }

    pub fn shell_request_compositor_sync(&self) {
        self.run(move |s| {
            s.shell_on_shell_client_connected();
        });
    }

    pub fn shell_force_next_dmabuf_full_damage(&self) {
        let _ = self.run_result(move |s| {
            s.shell_force_next_dmabuf_full_damage();
            Ok(())
        });
    }

    pub fn shell_backed_window_open(&self, json: String) {
        self.run(move |s| {
            s.shell_backed_try_open_json(&json);
        });
    }

    pub fn shell_hosted_window_open(&self, json: String) {
        self.run(move |s| {
            s.shell_backed_try_open_json(&json);
        });
    }

    pub fn shell_workspace_mutation(&self, json: String) {
        self.run(move |s| {
            s.apply_workspace_mutation_json(&json);
        });
    }

    pub fn taskbar_pin_add(&self, json: String) {
        self.run(move |s| {
            s.apply_taskbar_pin_add_json(&json);
        });
    }

    pub fn taskbar_pin_remove(&self, json: String) {
        self.run(move |s| {
            s.apply_taskbar_pin_remove_json(&json);
        });
    }

    pub fn taskbar_pin_launch(&self, json: String) {
        self.run(move |s| {
            s.launch_taskbar_pin_json(&json);
        });
    }

    pub fn shell_hosted_window_state(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_hosted_window_state_json(&json);
        });
    }

    pub fn shell_hosted_window_title(&self, json: String) {
        self.run(move |s| {
            s.shell_backed_set_title_json(&json);
        });
    }

    pub fn write_session_state_json_with_merge(
        &self,
        mut v: serde_json::Value,
    ) -> Result<String, String> {
        self.run_result(move |s| {
            crate::session::session_state::merge_shell_hosted_into_session_value(
                &mut v,
                &s.shell_hosted_app_state,
            );
            crate::session::session_state::write_session_state_json(v)
        })
    }

    pub fn write_shell_session_json_with_merge(
        &self,
        mut shell: serde_json::Value,
    ) -> Result<String, String> {
        self.run_result(move |s| {
            crate::session::session_state::merge_shell_hosted_window_state_into_shell_snapshot(
                &mut shell,
                &s.shell_hosted_app_state,
            );
            crate::session::session_state::write_shell_session_json(shell)
        })
    }

    pub fn sni_tray_activate(&self, id: String) {
        self.run(move |s| {
            s.sni_tray_activate_clicked(id);
        });
    }

    pub fn sni_tray_open_menu(&self, id: String, request_serial: u32) {
        self.run(move |s| {
            s.sni_tray_open_menu(id, request_serial);
        });
    }

    pub fn sni_tray_menu_event(&self, id: String, menu_path: String, item_id: i32) {
        self.run(move |s| {
            s.sni_tray_menu_event(id, menu_path, item_id);
        });
    }

    pub fn notifications_state_json(&self) -> Result<String, String> {
        self.run_result(move |s| Ok(s.notifications_state_json()))
    }

    pub fn notifications_set_enabled(&self, enabled: bool) -> Result<(), String> {
        self.run_result(move |s| {
            s.notifications_set_enabled(enabled)?;
            crate::session::settings_config::write_notifications_settings(
                crate::session::settings_config::NotificationsSettingsFile { enabled },
            )
        })
    }

    pub fn notifications_shell_notify(
        &self,
        request: crate::notifications::ShellNotificationRequest,
    ) -> Result<u32, String> {
        self.run_result(move |s| s.notifications_shell_notify(request))
    }

    pub fn notifications_close(&self, id: u32, reason: u32, source: String) {
        self.run(move |s| {
            s.notifications_close(id, reason, source);
        });
    }

    pub fn notifications_invoke_action(&self, id: u32, action_key: String, source: String) {
        self.run(move |s| {
            s.notifications_invoke_action(id, action_key, source);
        });
    }

    pub fn screenshot_region(&self, x: i32, y: i32, width: i32, height: i32) {
        self.run(move |s| {
            if let Err(error) = s.request_screenshot_region(smithay::utils::Rectangle::new(
                (x, y).into(),
                (width, height).into(),
            )) {
                tracing::warn!(%error, "shell uplink: screenshot_region");
            }
        });
    }

    pub fn screenshot_begin_region_mode(&self) {
        self.run(move |s| {
            s.begin_screenshot_selection_mode();
        });
    }

    pub fn screenshot_cancel(&self) {
        self.run(move |s| {
            s.cancel_screenshot_selection_mode();
        });
    }

    pub fn test_pointer_move(&self, x: f64, y: f64) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_move_global(x, y))
    }

    pub fn test_pointer_move_relative(&self, dx: f64, dy: f64) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_move_relative(dx, dy))
    }

    pub fn test_pointer_button(&self, button: u32, pressed: bool) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_button(button, pressed))
    }

    pub fn test_pointer_click(&self, x: f64, y: f64, button: u32) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_click(x, y, button))
    }

    pub fn test_pointer_drag(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        button: u32,
        steps: u32,
    ) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_drag(x0, y0, x1, y1, button, steps))
    }

    pub fn test_pointer_wheel(&self, delta_x: i32, delta_y: i32) -> Result<(), String> {
        self.run_result(move |s| s.e2e_pointer_wheel(delta_x, delta_y))
    }

    pub fn test_key(&self, keycode: u32, pressed: bool) -> Result<(), String> {
        self.run_result(move |s| {
            s.e2e_keyboard_key(
                keycode,
                if pressed {
                    smithay::backend::input::KeyState::Pressed
                } else {
                    smithay::backend::input::KeyState::Released
                },
            )
        })
    }

    pub fn test_super_keybind(
        &self,
        action: String,
        target_window_id: Option<u32>,
    ) -> Result<(), String> {
        self.run_result(move |s| {
            match (action.as_str(), target_window_id) {
                ("move_monitor_left" | "move_monitor_right", Some(wid)) => {
                    let move_right = action == "move_monitor_right";
                    s.super_move_window_to_adjacent_monitor(wid, move_right)?;
                }
                (
                    "tile_left" | "tile_right" | "tile_up" | "tile_down" | "toggle_fullscreen"
                    | "toggle_maximize",
                    Some(wid),
                ) => {
                    s.shell_send_keybind_ex(&action, Some(wid));
                }
                _ => {
                    s.handle_super_keybind(&action);
                }
            }
            Ok(())
        })
    }

    pub fn test_crash_window(&self, window_id: u32) -> Result<(), String> {
        self.run_result(move |s| s.e2e_crash_window_client(window_id))
    }

    pub fn test_compositor_snapshot_json(&self) -> Result<String, String> {
        self.run_result(move |s| s.e2e_compositor_snapshot_json())
    }

    pub fn test_sync_json(&self) -> Result<String, String> {
        self.run_result(move |s| {
            let compositor =
                serde_json::from_str::<serde_json::Value>(&s.e2e_compositor_snapshot_json()?)
                    .map_err(|e| format!("parse compositor sync snapshot: {e}"))?;
            Ok(serde_json::json!({
                "ok": true,
                "compositor": compositor,
            })
            .to_string())
        })
    }

    pub fn test_request_screenshot(
        &self,
        rect: Option<Rectangle<i32, Logical>>,
    ) -> Result<u64, String> {
        self.run_result(move |s| s.e2e_request_screenshot(rect))
    }
}
