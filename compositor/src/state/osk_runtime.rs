use super::*;

impl CompositorState {
    pub(crate) fn apply_osk_settings(
        &mut self,
        settings: crate::session::settings_config::OskSettingsFile,
    ) -> Result<(), String> {
        let settings = crate::session::settings_config::sanitize_osk_settings(settings);
        crate::session::settings_config::write_osk_settings(settings.clone())?;
        if settings.enabled {
            self.start_osk(&settings.provider);
        } else {
            self.stop_osk();
        }
        Ok(())
    }

    pub fn start_osk_from_settings(&mut self) {
        let settings = crate::session::settings_config::read_osk_settings();
        if settings.enabled {
            self.start_osk(&settings.provider);
        }
    }

    pub fn stop_osk(&mut self) {
        self.set_osk_visible(false);
        crate::sidecar::terminate_sidecar(&mut self.session_services.osk_child);
        self.session_services.osk_visible = None;
        self.session_services.osk_visibility_override = None;
        self.session_services.osk_last_text_input_active = false;
        self.session_services.osk_text_input_visibility_allowed = false;
    }

    pub(crate) fn toggle_osk_visible_from_shell(&mut self) {
        let settings = crate::session::settings_config::read_osk_settings();
        if !settings.enabled {
            return;
        }
        if let Some(pointer) = self.input_routing.seat.get_pointer() {
            self.set_osk_preferred_output_for_point(pointer.current_location());
        }
        self.start_osk(&settings.provider);
        let visible = !self.session_services.osk_visible.unwrap_or(false);
        self.session_services.osk_visibility_override = Some(visible);
        self.set_osk_visible(visible);
    }

    fn start_osk(&mut self, provider: &str) {
        self.reap_osk_child();
        if self.session_services.osk_child.is_some() {
            return;
        }
        if provider != "squeekboard" {
            tracing::warn!(target: "derp_osk", provider, "unsupported osk provider");
            return;
        }
        let runtime = match std::env::var("XDG_RUNTIME_DIR") {
            Ok(value) if !value.is_empty() => value,
            _ => {
                tracing::warn!(target: "derp_osk", "XDG_RUNTIME_DIR unset");
                return;
            }
        };
        let display = self.core.socket_name.to_string_lossy().into_owned();
        let mut command = std::process::Command::new("squeekboard");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .env("WAYLAND_DISPLAY", display)
            .env("XDG_RUNTIME_DIR", runtime)
            .env("XDG_SESSION_TYPE", "wayland");
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            let uid = unsafe { libc::geteuid() };
            let bus = format!("/run/user/{uid}/bus");
            if std::path::Path::new(&bus).exists() {
                command.env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={bus}"));
            }
        }
        match crate::sidecar::spawn_process_group(command) {
            Ok(child) => {
                self.session_services.osk_child = Some(child);
                self.arm_osk_monitor();
                self.arm_osk_visibility_monitor();
            }
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, "osk spawn failed");
            }
        }
    }

    fn reap_osk_child(&mut self) {
        let Some(child) = self.session_services.osk_child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                tracing::warn!(target: "derp_osk", ?status, "osk exited");
                self.session_services.osk_child = None;
                self.session_services.osk_visible = None;
                self.session_services.osk_visibility_override = None;
                self.session_services.osk_last_text_input_active = false;
                self.session_services.osk_text_input_visibility_allowed = false;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, "osk status failed");
                self.session_services.osk_child = None;
                self.session_services.osk_visible = None;
                self.session_services.osk_visibility_override = None;
                self.session_services.osk_last_text_input_active = false;
                self.session_services.osk_text_input_visibility_allowed = false;
            }
        }
    }

    fn arm_osk_monitor(&mut self) {
        if self.session_services.osk_monitor_active {
            return;
        }
        self.session_services.osk_monitor_active = true;
        let loop_handle = self.core.loop_handle.clone();
        if loop_handle
            .insert_source(
                Timer::from_duration(std::time::Duration::from_secs(2)),
                |_, _, d: &mut CalloopData| {
                    d.state.reap_osk_child();
                    if d.state.session_services.osk_child.is_some() {
                        TimeoutAction::ToDuration(std::time::Duration::from_secs(2))
                    } else {
                        d.state.session_services.osk_monitor_active = false;
                        TimeoutAction::Drop
                    }
                },
            )
            .is_err()
        {
            self.session_services.osk_monitor_active = false;
        }
    }

    fn arm_osk_visibility_monitor(&mut self) {
        if self.session_services.osk_visibility_monitor_active {
            return;
        }
        self.session_services.osk_visibility_monitor_active = true;
        let loop_handle = self.core.loop_handle.clone();
        if loop_handle
            .insert_source(
                Timer::from_duration(std::time::Duration::from_millis(100)),
                |_, _, d: &mut CalloopData| {
                    d.state.update_osk_visibility_from_text_input();
                    if d.state.session_services.osk_child.is_some() {
                        TimeoutAction::ToDuration(std::time::Duration::from_millis(100))
                    } else {
                        d.state.session_services.osk_visibility_monitor_active = false;
                        TimeoutAction::Drop
                    }
                },
            )
            .is_err()
        {
            self.session_services.osk_visibility_monitor_active = false;
        }
    }

    fn update_osk_visibility_from_text_input(&mut self) {
        let settings = crate::session::settings_config::read_osk_settings();
        if !settings.enabled || settings.provider != "squeekboard" {
            self.set_osk_visible(false);
            return;
        }
        self.reap_osk_child();
        if self.session_services.osk_child.is_none() {
            return;
        }
        let mut active = false;
        self.input_routing
            .seat
            .text_input()
            .with_active_text_input(|_, _| active = true);
        if active != self.session_services.osk_last_text_input_active {
            self.session_services.osk_last_text_input_active = active;
            self.session_services.osk_visibility_override = None;
        }
        if !active {
            self.session_services.osk_text_input_visibility_allowed = false;
        }
        let touch_visible = active && self.session_services.osk_text_input_visibility_allowed;
        self.set_osk_visible(
            self.session_services
                .osk_visibility_override
                .unwrap_or(touch_visible),
        );
    }

    fn set_osk_visible(&mut self, visible: bool) {
        if self.session_services.osk_visible == Some(visible) {
            return;
        }
        let settings = crate::session::settings_config::read_osk_settings();
        if settings.provider != "squeekboard" {
            return;
        }
        let mut command = std::process::Command::new("busctl");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .arg("--user")
            .arg("call")
            .arg("sm.puri.OSK0")
            .arg("/sm/puri/OSK0")
            .arg("sm.puri.OSK0")
            .arg("SetVisible")
            .arg("b")
            .arg(if visible { "true" } else { "false" });
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            let uid = unsafe { libc::geteuid() };
            let bus = format!("/run/user/{uid}/bus");
            if std::path::Path::new(&bus).exists() {
                command.env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={bus}"));
            }
        }
        match command.status() {
            Ok(status) if status.success() => {
                self.session_services.osk_visible = Some(visible);
                self.refresh_usable_area_dependent_window_layouts();
            }
            Ok(status) => {
                tracing::warn!(target: "derp_osk", ?status, visible, "osk visibility request failed");
                self.session_services.osk_visible = None;
            }
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, visible, "osk visibility request failed");
                self.session_services.osk_visible = None;
            }
        }
    }

    pub(crate) fn osk_layer_namespace(namespace: &str) -> bool {
        namespace.eq_ignore_ascii_case("squeekboard")
            || namespace.to_ascii_lowercase().contains("squeekboard")
    }

    pub(crate) fn register_osk_layer_surface(&mut self, layer: DesktopLayerSurface) {
        self.session_services.osk_layer_surfaces.push(layer.clone());
        self.remap_osk_layer_surfaces();
    }

    pub(crate) fn unregister_osk_layer_surface(&mut self, root: &WlSurface) {
        self.session_services
            .osk_layer_surfaces
            .retain(|layer| layer.wl_surface() != root);
        self.refresh_usable_area_dependent_window_layouts();
    }

    pub(crate) fn allow_osk_for_touch_text_input_at(&mut self, pos: Point<f64, Logical>) {
        self.session_services.osk_text_input_visibility_allowed = true;
        self.session_services.osk_visibility_override = None;
        self.set_osk_preferred_output_for_point(pos);
    }

    pub(crate) fn disallow_osk_for_pointer_text_input(&mut self) {
        if !self.session_services.osk_text_input_visibility_allowed
            && self.session_services.osk_visibility_override.is_none()
        {
            return;
        }
        self.session_services.osk_text_input_visibility_allowed = false;
        self.session_services.osk_visibility_override = None;
        self.update_osk_visibility_from_text_input();
    }

    fn set_osk_preferred_output_for_point(&mut self, pos: Point<f64, Logical>) {
        let Some(output) = self.output_containing_global_point(pos) else {
            return;
        };
        let name = output.name();
        if self.session_services.osk_preferred_output_name.as_deref() == Some(name.as_str()) {
            return;
        }
        self.session_services.osk_preferred_output_name = Some(name);
        self.remap_osk_layer_surfaces();
    }

    fn preferred_osk_output(&self) -> Option<Output> {
        self.session_services
            .osk_preferred_output_name
            .as_ref()
            .and_then(|name| {
                self.output_topology
                    .space
                    .outputs()
                    .find(|output| output.name() == *name)
                    .cloned()
            })
            .or_else(|| self.shell_effective_primary_output())
            .or_else(|| self.output_topology.space.outputs().next().cloned())
    }

    fn remap_osk_layer_surfaces(&mut self) {
        let Some(target) = self.preferred_osk_output() else {
            return;
        };
        let layers = self.session_services.osk_layer_surfaces.clone();
        if layers.is_empty() {
            return;
        }
        let outputs: Vec<_> = self.output_topology.space.outputs().cloned().collect();
        let mut changed = false;
        for layer in layers {
            for output in &outputs {
                if output == &target {
                    continue;
                }
                let mut map = layer_map_for_output(output);
                if map.layers().any(|candidate| candidate == &layer) {
                    map.unmap_layer(&layer);
                    changed = true;
                }
            }
            let mut map = layer_map_for_output(&target);
            if !map.layers().any(|candidate| candidate == &layer) {
                if map.map_layer(&layer).is_ok() {
                    changed = true;
                }
            }
        }
        if changed {
            layer_map_for_output(&target).arrange();
            self.refresh_usable_area_dependent_window_layouts();
        }
    }

    pub(crate) fn effective_layer_usable_area_global_for_output(
        &self,
        output: &Output,
    ) -> Option<Rectangle<i32, Logical>> {
        let base = self
            .output_topology
            .layer_usable_area_global_for_output(output)?;
        if self.session_services.osk_visible != Some(true) {
            return Some(base);
        }
        let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
            return Some(base);
        };
        let map = layer_map_for_output(output);
        let mut usable = base;
        for layer in map.layers() {
            if !Self::osk_layer_namespace(layer.namespace()) {
                continue;
            }
            let Some(geo) = map.layer_geometry(layer) else {
                continue;
            };
            if geo.size.w <= 0 || geo.size.h <= 0 {
                continue;
            }
            let global = Rectangle::new(output_geo.loc + geo.loc, geo.size);
            let Some(overlap) = global.intersection(output_geo) else {
                continue;
            };
            if overlap.size.w < output_geo.size.w / 2 {
                continue;
            }
            if overlap.loc.y > output_geo.loc.y + output_geo.size.h / 2 {
                let bottom = output_geo.loc.y + output_geo.size.h;
                let reserve = bottom.saturating_sub(overlap.loc.y).max(0);
                usable.size.h = usable.size.h.saturating_sub(reserve).max(1);
            } else if overlap.loc.y <= output_geo.loc.y {
                let reserve = overlap.size.h.max(0);
                usable.loc.y = usable.loc.y.saturating_add(reserve);
                usable.size.h = usable.size.h.saturating_sub(reserve).max(1);
            }
        }
        Some(usable)
    }
}
