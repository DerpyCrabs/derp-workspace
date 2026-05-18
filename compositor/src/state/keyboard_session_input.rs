use super::*;

impl CompositorState {
    pub(crate) fn keyboard_clear_per_window_layout_map(&mut self) {
        self.input_routing.keyboard_clear_per_window_layout_map();
    }

    pub(crate) fn keyboard_apply_settings(
        &mut self,
        settings: &crate::session::settings_config::KeyboardSettingsFile,
    ) -> Result<(), String> {
        if settings.layouts.is_empty() {
            return Err("keyboard layouts cannot be empty".into());
        }
        let Some(handle) = self.input_routing.seat.get_keyboard() else {
            return Err("missing keyboard handle".into());
        };
        let base =
            crate::controls::display_config::read_keyboard_from_display_file().unwrap_or_default();
        let layout = settings
            .layouts
            .iter()
            .map(|entry| entry.layout.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let variant = settings
            .layouts
            .iter()
            .map(|entry| entry.variant.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let xkb_cfg = XkbConfig {
            rules: base.rules.as_str(),
            model: base.model.as_str(),
            layout: layout.as_str(),
            variant: variant.as_str(),
            options: base.options.clone(),
        };
        handle
            .set_xkb_config(self, xkb_cfg)
            .map_err(|e| format!("set_xkb_config: {e:?}"))?;
        handle.change_repeat_info(
            i32::try_from(settings.repeat_rate)
                .map_err(|_| "repeat_rate out of range".to_string())?,
            i32::try_from(settings.repeat_delay_ms)
                .map_err(|_| "repeat_delay_ms out of range".to_string())?,
        );
        self.keyboard_clear_per_window_layout_map();
        let session_default_layout_index = self.keyboard_layout_index_current();
        self.workspace_layout
            .set_session_default_layout_index(session_default_layout_index);
        self.refresh_osk_keyboard_layouts();
        self.emit_keyboard_layout_to_shell();
        Ok(())
    }
}

impl CompositorState {
    fn keyboard_layout_should_track_window(&self, wid: u32) -> bool {
        self.windows
            .window_registry
            .window_info(wid)
            .map(|i| !self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false)
    }

    pub(crate) fn keyboard_layout_index_current(&mut self) -> u32 {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
            return 0;
        };
        kbd.with_xkb_state(self, |ctx| match ctx.xkb().lock() {
            Ok(xkb) => xkb.active_layout().0,
            Err(_) => 0,
        })
    }

    fn keyboard_layout_set_index(&mut self, idx: u32) {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
            return;
        };
        kbd.with_xkb_state(self, |mut ctx| {
            let nl = {
                let xkb = ctx.xkb().lock().unwrap();
                xkb.layouts().count()
            };
            if nl == 0 {
                return;
            }
            let max_v = u32::try_from(nl.saturating_sub(1)).unwrap_or(u32::MAX);
            let li = idx.min(max_v);
            ctx.set_layout(Layout(li));
        });
    }

    fn keyboard_layout_active_name_raw(&mut self) -> String {
        let kbd = self.input_routing.seat.get_keyboard().unwrap();
        kbd.with_xkb_state(self, |ctx| {
            let xkb = ctx.xkb().lock().unwrap();
            let layout = xkb.active_layout();
            xkb.layout_name(layout).to_string()
        })
    }

    pub(crate) fn emit_keyboard_layout_to_shell(&mut self) {
        let raw = self.keyboard_layout_active_name_raw();
        let label = InputRoutingState::keyboard_layout_label_short(&raw);
        self.input_routing.shell_keyboard_layout_label = label.clone();
        self.shell_emit_chrome_event(ChromeEvent::KeyboardLayout { label });
    }

    pub(crate) fn keyboard_on_focus_surface_changed(&mut self, focused: Option<&WlSurface>) {
        let new_wid =
            focused.and_then(|s| self.windows.window_registry.window_id_for_wl_surface(s));
        let shell_host = new_wid
            .and_then(|w| self.windows.window_registry.window_info(w))
            .map(|i| self.window_info_is_solid_shell_host(&i))
            .unwrap_or(false);
        let tracked: HashSet<u32> = self
            .windows
            .window_registry
            .all_infos()
            .into_iter()
            .filter(|info| !self.window_info_is_solid_shell_host(info))
            .map(|info| info.window_id)
            .collect();
        self.input_routing
            .queue_keyboard_focus_change(new_wid, shell_host, |window_id| {
                tracked.contains(&window_id)
            });
        let tx = self.shell_osr.cef_to_compositor_tx.clone();
        let _ = tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(
            |state| {
                state.keyboard_drain_focus_layout_queue();
            },
        )));
    }

    fn keyboard_drain_focus_layout_queue(&mut self) {
        while let Some(op) = self.input_routing.keyboard_layout_focus_queue.pop_front() {
            if let Some(w) = op.save_from {
                let idx = self.keyboard_layout_index_current();
                self.input_routing.keyboard_save_layout_for_window(w, idx);
            }
            if let Some(w) = op.restore_for {
                let idx = self.input_routing.keyboard_layout_for_window_or_default(
                    w,
                    self.workspace_layout.session_default_layout_index,
                );
                self.keyboard_layout_set_index(idx);
            } else if op.shell_host || op.save_from.is_some() {
                self.keyboard_layout_set_index(self.workspace_layout.session_default_layout_index);
            }
            self.emit_keyboard_layout_to_shell();
        }
    }

    pub(crate) fn keyboard_cycle_layout_for_shortcut(&mut self) {
        let Some(kbd) = self.input_routing.seat.get_keyboard() else {
            return;
        };
        let idx = kbd.with_xkb_state(self, |mut ctx| {
            ctx.cycle_next_layout();
            let xkb = ctx.xkb().lock().unwrap();
            xkb.active_layout().0
        });
        if let Some(wid) = self.keyboard_focused_window_id() {
            if self.keyboard_layout_should_track_window(wid) {
                self.input_routing.keyboard_save_layout_for_window(wid, idx);
            }
        }
        self.emit_keyboard_layout_to_shell();
    }
}
