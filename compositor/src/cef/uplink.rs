use smithay::reexports::calloop::channel::Sender;

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

    pub fn spawn_wayland_client(&self, command: String) {
        self.run(move |s| {
            if let Err(e) = s.try_spawn_wayland_client_sh(&command) {
                tracing::warn!(%e, "shell uplink: spawn");
            }
        });
    }

    pub fn shell_close(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_close_window(window_id);
        });
    }

    pub fn shell_move_begin(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_move_begin(window_id);
        });
    }

    pub fn shell_move_delta(&self, dx: i32, dy: i32) {
        self.run(move |s| {
            s.shell_move_delta(dx, dy);
        });
    }

    pub fn shell_move_end(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_move_end(window_id);
        });
    }

    pub fn shell_resize_begin(&self, window_id: u32, edges: u32) {
        self.run(move |s| {
            s.shell_resize_begin(window_id, edges);
        });
    }

    pub fn shell_resize_delta(&self, dx: i32, dy: i32) {
        self.run(move |s| {
            s.shell_resize_delta(dx, dy);
        });
    }

    pub fn shell_resize_end(&self, window_id: u32) {
        self.run(move |s| {
            s.shell_resize_end(window_id);
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
            s.shell_minimize_window(window_id);
        });
    }

    pub fn shell_set_fullscreen(&self, window_id: u32, enabled: bool) {
        self.run(move |s| {
            s.shell_set_window_fullscreen(window_id, enabled);
        });
    }

    pub fn shell_set_maximized(&self, window_id: u32, enabled: bool) {
        self.run(move |s| {
            s.shell_set_window_maximized(window_id, enabled);
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
            s.shell_set_window_geometry(window_id, vx, vy, vw, vh, layout);
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

    pub fn shell_set_exclusion_zones_json(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_exclusion_zones_json(&json);
        });
    }

    pub fn shell_set_ui_windows_json(&self, json: String) {
        self.run(move |s| {
            s.apply_shell_ui_windows_json(&json);
        });
    }

    pub fn shell_context_menu(
        &self,
        visible: bool,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        gx: i32,
        gy: i32,
        gw: u32,
        gh: u32,
    ) {
        self.run(move |s| {
            s.apply_shell_context_menu(visible, bx, by, bw, bh, gx, gy, gw, gh);
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

    pub fn shell_backed_window_open(&self, json: String) {
        self.run(move |s| {
            s.shell_backed_try_open_json(&json);
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
}
