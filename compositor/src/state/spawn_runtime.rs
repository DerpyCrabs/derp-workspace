use super::*;

impl CompositorState {
    pub(crate) fn shell_consider_focus_spawned_toplevel(&mut self, window_id: u32) {
        if !self.shell_window_is_pending_spawn_focus_candidate(window_id) {
            return;
        }
        self.windows.shell_spawn_known_native_window_ids = None;
        self.windows.shell_spawn_target_output_name = None;
        self.shell_raise_and_focus_window(window_id);
        self.shell_reply_window_list();
    }

    pub(crate) fn shell_prepare_spawned_toplevel_stack(&mut self, window_id: u32) {
        if self.shell_window_is_pending_spawn_focus_candidate(window_id) {
            self.shell_window_stack_touch(window_id);
        }
    }

    pub(crate) fn shell_window_is_pending_spawn_focus_candidate(&self, window_id: u32) -> bool {
        let Some(known_window_ids) = self.windows.shell_spawn_known_native_window_ids.as_ref()
        else {
            return false;
        };
        if known_window_ids.contains(&window_id) {
            return false;
        }
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            return false;
        };
        !self.window_info_is_solid_shell_host(&info) && shell_window_row_should_show(&info)
    }

    pub fn try_spawn_wayland_client_sh(&mut self, shell_command: &str) -> Result<(), String> {
        let trimmed = shell_command.trim();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if trimmed.len() > shell_wire::MAX_SPAWN_COMMAND_BYTES as usize {
            return Err("command too long".into());
        }
        let display = self.core.socket_name.to_string_lossy().into_owned();
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR unset")?;
        let mut envs = vec![
            ("WAYLAND_DISPLAY".to_string(), display),
            ("XDG_RUNTIME_DIR".to_string(), runtime),
        ];
        let cursor_settings = self.input_routing.cursor_theme.settings();
        envs.push(("XCURSOR_THEME".to_string(), cursor_settings.theme));
        envs.push(("XCURSOR_SIZE".to_string(), cursor_settings.size.to_string()));
        self.xdg_activation_prune_stale_tokens();
        let activation_token = {
            let surface = self
                .input_routing
                .seat
                .get_keyboard()
                .and_then(|keyboard| keyboard.current_focus())
                .or_else(|| {
                    self.input_routing
                        .seat
                        .get_pointer()
                        .and_then(|pointer| pointer.current_focus())
                });
            let app_id = self
                .logical_focused_window_id()
                .or_else(|| self.keyboard_focused_window_id())
                .and_then(|window_id| self.windows.window_registry.window_info(window_id))
                .map(|info| info.app_id);
            let data = XdgActivationTokenData {
                app_id,
                surface,
                ..Default::default()
            };
            let (token, _) = self.xdg_activation_state.create_external_token(Some(data));
            String::from(token.clone())
        };
        envs.push(("XDG_ACTIVATION_TOKEN".to_string(), activation_token));
        for key in [
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_DESKTOP",
            "XDG_SESSION_TYPE",
            "DESKTOP_SESSION",
            "DISPLAY",
        ] {
            if let Ok(value) = std::env::var(key) {
                envs.push((key.to_string(), value));
            }
        }

        let mut unit_name = format!(
            "derp-spawn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        unit_name.retain(|c| c.is_ascii_alphanumeric() || c == '-');

        self.windows.shell_spawn_known_native_window_ids = Some(
            self.windows
                .window_registry
                .all_records()
                .into_iter()
                .filter(|record| record.kind == WindowKind::Native)
                .map(|record| record.info.window_id)
                .collect(),
        );

        let mut launched_via_systemd = false;
        let mut systemd_run = std::process::Command::new("systemd-run");
        systemd_run
            .arg("--user")
            .arg("--collect")
            .arg("--quiet")
            .arg("--service-type=exec")
            .arg(format!("--unit={unit_name}"));
        for (key, value) in &envs {
            systemd_run.arg(format!("--setenv={key}={value}"));
        }
        systemd_run
            .arg("/bin/sh")
            .arg("-c")
            .arg(trimmed)
            .stdin(Stdio::null());
        match systemd_run.status() {
            Ok(status) if status.success() => {
                launched_via_systemd = true;
                tracing::debug!(unit = %unit_name, "spawned Wayland client via systemd-run");
            }
            Ok(status) => {
                tracing::warn!(unit = %unit_name, code = status.code(), "systemd-run app spawn failed; falling back to direct spawn");
            }
            Err(error) => {
                tracing::warn!(%error, unit = %unit_name, "systemd-run unavailable for app spawn; falling back to direct spawn");
            }
        }

        if !launched_via_systemd {
            let mut cmd = std::process::Command::new("/bin/sh");
            cmd.arg("-c").arg(trimmed).stdin(Stdio::null());
            for (key, value) in &envs {
                cmd.env(key, value);
            }
            let child = match cmd.spawn() {
                Ok(child) => child,
                Err(error) => {
                    self.windows.shell_spawn_known_native_window_ids = None;
                    return Err(error.to_string());
                }
            };
            tracing::debug!(
                pid = child.id(),
                "spawned Wayland client via direct fallback"
            );
        }
        Ok(())
    }
}
