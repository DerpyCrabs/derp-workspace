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

    pub(crate) fn apply_theme_settings(
        &mut self,
        settings: crate::session::settings_config::ThemeSettingsFile,
    ) -> Result<(), String> {
        let settings = crate::session::settings_config::sanitize_theme_settings(settings);
        let previous = crate::session::settings_config::read_theme_settings();
        if previous == settings {
            return Ok(());
        }
        crate::session::settings_config::write_theme_settings(settings.clone())?;
        self.refresh_osk_theme(&settings);
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
        Self::set_squeekboard_a11y_enabled(false);
        crate::sidecar::terminate_sidecar(&mut self.session_services.osk_child);
        self.session_services.osk_gtk_theme = None;
        self.session_services.osk_visible = None;
        self.session_services.osk_visibility_override = None;
        self.session_services.osk_last_text_input_active = false;
        self.session_services.osk_text_input_visibility_allowed = false;
        self.session_services.osk_shell_text_input_active = false;
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
        let visible = !self.osk_layer_surface_visible_now();
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
        self.session_services.osk_visible = None;
        let runtime = match std::env::var("XDG_RUNTIME_DIR") {
            Ok(value) if !value.is_empty() => value,
            _ => {
                tracing::warn!(target: "derp_osk", "XDG_RUNTIME_DIR unset");
                return;
            }
        };
        self.sync_squeekboard_input_sources();
        let display = self.core.socket_name.to_string_lossy().into_owned();
        let gtk_theme = crate::session::settings_config::squeekboard_gtk_theme_for_theme(
            &crate::session::settings_config::read_theme_settings(),
        );
        let mut command = std::process::Command::new("squeekboard");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .env("WAYLAND_DISPLAY", display)
            .env("XDG_RUNTIME_DIR", runtime)
            .env("XDG_SESSION_TYPE", "wayland")
            .env("GDK_BACKEND", "wayland")
            .env("GSK_RENDERER", "cairo")
            .env("GTK_THEME", &gtk_theme);
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
                self.session_services.osk_gtk_theme = Some(gtk_theme);
                Self::set_squeekboard_a11y_enabled(true);
                self.arm_osk_monitor();
                self.arm_osk_visibility_monitor();
            }
            Err(error) => {
                self.session_services.osk_gtk_theme = None;
                tracing::warn!(target: "derp_osk", %error, "osk spawn failed");
            }
        }
    }

    fn refresh_osk_theme(&mut self, theme: &crate::session::settings_config::ThemeSettingsFile) {
        let settings = crate::session::settings_config::read_osk_settings();
        if !settings.enabled || settings.provider != "squeekboard" {
            return;
        }
        self.reap_osk_child();
        if self.session_services.osk_child.is_none() {
            self.session_services.osk_gtk_theme = None;
            return;
        }
        let next = crate::session::settings_config::squeekboard_gtk_theme_for_theme(theme);
        if self.session_services.osk_gtk_theme.as_deref() == Some(next.as_str()) {
            return;
        }
        let visible =
            self.session_services.osk_visible == Some(true) || self.osk_layer_surface_visible_now();
        crate::sidecar::terminate_sidecar(&mut self.session_services.osk_child);
        self.session_services.osk_gtk_theme = None;
        self.session_services.osk_visible = None;
        self.session_services.osk_layer_surfaces.clear();
        self.start_osk(&settings.provider);
        if visible {
            self.set_osk_visible(true);
        }
    }

    pub(crate) fn sync_squeekboard_input_sources(&self) {
        let settings = crate::session::settings_config::read_keyboard_settings();
        if settings.layouts.is_empty() {
            return;
        }
        let sources = settings
            .layouts
            .iter()
            .map(|entry| {
                let id = if entry.variant.is_empty() {
                    entry.layout.clone()
                } else {
                    format!("{}+{}", entry.layout, entry.variant)
                };
                format!("('xkb', '{id}')")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let value = format!("[{sources}]");
        let mut command = std::process::Command::new("gsettings");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .arg("set")
            .arg("org.gnome.desktop.input-sources")
            .arg("sources")
            .arg(&value);
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            let uid = unsafe { libc::geteuid() };
            let bus = format!("/run/user/{uid}/bus");
            if std::path::Path::new(&bus).exists() {
                command.env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={bus}"));
            }
        }
        match command.status() {
            Ok(status) if status.success() => {}
            Ok(status) => {
                tracing::warn!(target: "derp_osk", ?status, %value, "squeekboard input sources sync failed");
            }
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, %value, "squeekboard input sources sync failed");
            }
        }
    }

    pub(crate) fn refresh_osk_keyboard_layouts(&mut self) {
        self.sync_squeekboard_input_sources();
        let settings = crate::session::settings_config::read_osk_settings();
        if !settings.enabled
            || settings.provider != "squeekboard"
            || self.session_services.osk_child.is_none()
        {
            return;
        }
        let visible =
            self.session_services.osk_visible == Some(true) || self.osk_layer_surface_visible_now();
        crate::sidecar::terminate_sidecar(&mut self.session_services.osk_child);
        self.session_services.osk_gtk_theme = None;
        self.session_services.osk_visible = None;
        self.session_services.osk_layer_surfaces.clear();
        self.start_osk(&settings.provider);
        if visible {
            self.set_osk_visible(true);
        }
    }

    fn set_squeekboard_a11y_enabled(enabled: bool) {
        let mut command = std::process::Command::new("gsettings");
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .arg("set")
            .arg("org.gnome.desktop.a11y.applications")
            .arg("screen-keyboard-enabled")
            .arg(if enabled { "true" } else { "false" });
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            let uid = unsafe { libc::geteuid() };
            let bus = format!("/run/user/{uid}/bus");
            if std::path::Path::new(&bus).exists() {
                command.env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={bus}"));
            }
        }
        match command.status() {
            Ok(status) if status.success() => {}
            Ok(status) => {
                tracing::warn!(target: "derp_osk", ?status, enabled, "osk a11y setting failed");
            }
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, enabled, "osk a11y setting failed");
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
                self.session_services.osk_gtk_theme = None;
                Self::set_squeekboard_a11y_enabled(false);
                self.unmap_osk_layer_surfaces();
                self.session_services.osk_visible = None;
                self.session_services.osk_visibility_override = None;
                self.session_services.osk_last_text_input_active = false;
                self.session_services.osk_text_input_visibility_allowed = false;
                self.session_services.osk_shell_text_input_active = false;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, "osk status failed");
                self.session_services.osk_child = None;
                self.session_services.osk_gtk_theme = None;
                Self::set_squeekboard_a11y_enabled(false);
                self.unmap_osk_layer_surfaces();
                self.session_services.osk_visible = None;
                self.session_services.osk_visibility_override = None;
                self.session_services.osk_last_text_input_active = false;
                self.session_services.osk_text_input_visibility_allowed = false;
                self.session_services.osk_shell_text_input_active = false;
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
            self.unmap_osk_layer_surfaces();
            return;
        }
        let active = self.osk_native_text_input_active_now();
        if active != self.session_services.osk_last_text_input_active {
            self.session_services.osk_last_text_input_active = active;
            if self.session_services.osk_visibility_override != Some(true) {
                self.session_services.osk_visibility_override = None;
            }
        }
        if !active {
            self.session_services.osk_text_input_visibility_allowed = false;
        }
        let touch_visible = active && self.session_services.osk_text_input_visibility_allowed;
        let shell_visible = self.session_services.osk_shell_text_input_active;
        self.set_osk_visible(
            self.session_services
                .osk_visibility_override
                .unwrap_or(touch_visible || shell_visible),
        );
    }

    fn set_osk_visible(&mut self, visible: bool) {
        if self.session_services.osk_visible == Some(visible) {
            if visible {
                if self.osk_layer_surface_visible_on_preferred_output_now() {
                    return;
                }
            } else if !self.osk_layer_surface_visible_now() {
                return;
            }
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
            .arg("--timeout=1s")
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
        match command.spawn() {
            Ok(mut child) => {
                self.session_services.osk_visible = Some(visible);
                if visible {
                    self.remap_osk_layer_surfaces();
                } else {
                    self.unmap_osk_layer_surfaces();
                }
                self.refresh_usable_area_dependent_window_layouts();
                std::thread::spawn(move || match child.wait() {
                    Ok(status) if status.success() => {}
                    Ok(status) => {
                        tracing::warn!(target: "derp_osk", ?status, visible, "osk visibility request failed");
                    }
                    Err(error) => {
                        tracing::warn!(target: "derp_osk", %error, visible, "osk visibility request wait failed");
                    }
                });
            }
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, visible, "osk visibility request failed");
                self.session_services.osk_visible = if visible { None } else { Some(false) };
                if !visible {
                    self.unmap_osk_layer_surfaces();
                    self.refresh_usable_area_dependent_window_layouts();
                }
            }
        }
    }

    pub(crate) fn osk_layer_namespace(namespace: &str) -> bool {
        let namespace = namespace.to_ascii_lowercase();
        namespace == "squeekboard"
            || namespace.contains("squeekboard")
            || namespace == "osk"
            || namespace.contains("keyboard")
    }

    fn unmap_osk_layer_surfaces(&mut self) {
        let outputs: Vec<_> = self.output_topology.space.outputs().cloned().collect();
        let mut layers = self.session_services.osk_layer_surfaces.clone();
        for output in &outputs {
            let map = layer_map_for_output(output);
            for layer in map.layers() {
                if !Self::osk_layer_namespace(layer.namespace()) {
                    continue;
                }
                if !layers
                    .iter()
                    .any(|existing| existing.wl_surface() == layer.wl_surface())
                {
                    layers.push(layer.clone());
                }
            }
        }
        self.session_services.osk_layer_surfaces = layers.clone();
        let mut changed_outputs = Vec::new();
        for output in &outputs {
            let mut map = layer_map_for_output(output);
            let mut changed = false;
            for layer in &layers {
                if map.layers().any(|candidate| candidate == layer) {
                    map.unmap_layer(layer);
                    changed = true;
                }
            }
            if changed {
                changed_outputs.push(output.clone());
            }
        }
        if !changed_outputs.is_empty() {
            for output in changed_outputs {
                layer_map_for_output(&output).arrange();
            }
            self.refresh_usable_area_dependent_window_layouts();
        }
    }

    pub(crate) fn register_osk_layer_surface(&mut self, layer: DesktopLayerSurface) {
        if !self
            .session_services
            .osk_layer_surfaces
            .iter()
            .any(|existing| existing.wl_surface() == layer.wl_surface())
        {
            self.session_services.osk_layer_surfaces.push(layer.clone());
        }
        if self.session_services.osk_visible == Some(true) {
            self.remap_osk_layer_surfaces();
        }
    }

    pub(crate) fn unregister_osk_layer_surface(&mut self, root: &WlSurface) {
        self.session_services
            .osk_layer_surfaces
            .retain(|layer| layer.wl_surface() != root);
        self.refresh_usable_area_dependent_window_layouts();
    }

    pub(crate) fn reconcile_hidden_osk_layer_surfaces(&mut self) {
        if self.session_services.osk_visible != Some(true) && self.osk_layer_surface_visible_now() {
            self.unmap_osk_layer_surfaces();
        }
    }

    pub(crate) fn layer_surface_visible_during_render(&self, namespace: &str) -> bool {
        !Self::osk_layer_namespace(namespace) || self.session_services.osk_visible == Some(true)
    }

    pub(crate) fn osk_layer_surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        let pos_i = pos.to_i32_round();
        for output in self.output_topology.space.outputs() {
            let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
                continue;
            };
            let local = pos - output_geo.loc.to_f64();
            let map = layer_map_for_output(output);
            for layer in map.layers() {
                if !Self::osk_layer_namespace(layer.namespace()) {
                    continue;
                }
                let Some(geometry) = map.layer_geometry(layer) else {
                    continue;
                };
                let geometry = self.osk_visual_layer_geometry_for_output(output, layer, geometry);
                let bbox = layer.bbox_with_popups();
                let global = Rectangle::new(output_geo.loc + geometry.loc + bbox.loc, bbox.size);
                if !global.contains(pos_i) {
                    continue;
                }
                let hit_local = local - geometry.loc.to_f64();
                if let Some((wl_surface, surface_loc)) =
                    layer.surface_under(hit_local, WindowSurfaceType::ALL)
                {
                    return Some((
                        wl_surface,
                        (surface_loc + geometry.loc + output_geo.loc).to_f64(),
                    ));
                }
                return Some((
                    layer.wl_surface().clone(),
                    (geometry.loc + output_geo.loc).to_f64(),
                ));
            }
        }
        None
    }

    pub(crate) fn osk_visual_layer_geometry_for_output(
        &self,
        output: &Output,
        layer: &DesktopLayerSurface,
        mut geometry: Rectangle<i32, Logical>,
    ) -> Rectangle<i32, Logical> {
        if !Self::osk_layer_namespace(layer.namespace()) {
            return geometry;
        }
        let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
            return geometry;
        };
        if geometry.size.w > output_geo.size.w {
            geometry.loc.x = (output_geo.size.w - geometry.size.w) / 2;
        }
        if geometry.size.h > output_geo.size.h {
            geometry.loc.y = output_geo.size.h.saturating_sub(geometry.size.h);
        }
        geometry
    }

    pub(crate) fn osk_visual_exclusion_rects_for_output(
        &self,
        output: &Output,
    ) -> Vec<Rectangle<i32, Logical>> {
        let Some(output_geo) = self.output_topology.space.output_geometry(output) else {
            return Vec::new();
        };
        let map = layer_map_for_output(output);
        map.layers()
            .filter(|layer| {
                Self::osk_layer_namespace(layer.namespace())
                    && self.layer_surface_visible_during_render(layer.namespace())
            })
            .filter_map(|layer| {
                let geometry = map.layer_geometry(layer)?;
                let geometry = self.osk_visual_layer_geometry_for_output(output, layer, geometry);
                let bbox = layer.bbox_with_popups();
                Some(Rectangle::new(
                    output_geo.loc + geometry.loc + bbox.loc,
                    bbox.size,
                ))
            })
            .collect()
    }

    pub(crate) fn osk_layer_surface_visible_now(&self) -> bool {
        for output in self.output_topology.space.outputs() {
            if Self::osk_layer_surface_visible_on_output(output) {
                return true;
            }
        }
        false
    }

    pub(crate) fn osk_layer_surface_visible_on_preferred_output_now(&self) -> bool {
        let Some(output) = self.preferred_osk_output() else {
            return false;
        };
        Self::osk_layer_surface_visible_on_output(&output)
    }

    fn osk_layer_surface_visible_on_output(output: &Output) -> bool {
        let map = layer_map_for_output(output);
        for layer in map.layers() {
            if !Self::osk_layer_namespace(layer.namespace()) {
                continue;
            }
            let Some(geo) = map.layer_geometry(layer) else {
                continue;
            };
            if geo.size.w > 0 && geo.size.h > 0 {
                return true;
            }
        }
        false
    }

    pub(crate) fn allow_osk_for_touch_text_input_at(&mut self, pos: Point<f64, Logical>) {
        self.session_services.osk_text_input_visibility_allowed = true;
        if self.session_services.osk_visibility_override != Some(true) {
            self.session_services.osk_visibility_override = None;
        }
        self.set_osk_preferred_output_for_point(pos);
        self.update_osk_visibility_from_text_input();
    }

    pub(crate) fn disallow_osk_for_pointer_text_input(&mut self) {
        if self.session_services.osk_text_input_visibility_allowed
            && self.osk_native_text_input_active_now()
        {
            return;
        }
        if !self.session_services.osk_text_input_visibility_allowed
            && self.session_services.osk_visibility_override.is_none()
        {
            return;
        }
        self.session_services.osk_text_input_visibility_allowed = false;
        if self.session_services.osk_visibility_override != Some(true) {
            self.session_services.osk_visibility_override = None;
        }
        self.update_osk_visibility_from_text_input();
    }

    fn osk_native_text_input_active_now(&self) -> bool {
        let mut active = false;
        self.input_routing
            .seat
            .text_input()
            .with_active_text_input(|_, _| active = true);
        active
    }

    pub(crate) fn shell_editable_focus_from_shell(
        &mut self,
        active: bool,
        touch: bool,
        shell_x: i32,
        shell_y: i32,
    ) {
        if active && !touch {
            self.session_services.osk_shell_text_input_active = false;
            self.input_routing
                .seat
                .deactivate_input_method_without_text_input();
            if self.session_services.osk_visibility_override != Some(true) {
                self.session_services.osk_visibility_override = Some(false);
                self.set_osk_visible(false);
            }
            self.update_osk_visibility_from_text_input();
            return;
        }
        if active && touch {
            self.session_services.osk_shell_text_input_active = true;
            if self.session_services.osk_visibility_override != Some(true) {
                self.session_services.osk_visibility_override = None;
            }
            let pos = Point::from((
                self.output_topology.shell_canvas_logical_origin.0 as f64 + shell_x as f64,
                self.output_topology.shell_canvas_logical_origin.1 as f64 + shell_y as f64,
            ));
            self.set_osk_preferred_output_for_point(pos);
            let settings = crate::session::settings_config::read_osk_settings();
            if settings.enabled {
                self.start_osk(&settings.provider);
            }
            if !self.shell_keyboard_capture_active() {
                self.shell_keyboard_capture_shell_ui();
            }
            self.input_routing
                .seat
                .activate_input_method_without_text_input();
            self.update_osk_visibility_from_text_input();
            self.refresh_osk_exclusion_damage();
            return;
        }
        if !active {
            self.session_services.osk_shell_text_input_active = false;
            self.input_routing
                .seat
                .deactivate_input_method_without_text_input();
            if self.session_services.osk_visibility_override != Some(true) {
                self.session_services.osk_visibility_override = None;
            }
            self.update_osk_visibility_from_text_input();
        }
    }

    pub(crate) fn clear_shell_osk_text_input_for_window(&mut self, window_id: u32) {
        if self.session_services.osk_shell_text_input_active
            && self.shell_osr.shell_focused_ui_window_id == Some(window_id)
        {
            self.clear_shell_osk_text_input();
        }
    }

    pub(crate) fn clear_shell_osk_text_input_if_no_shell_focus(&mut self) {
        if self.session_services.osk_shell_text_input_active
            && self.shell_osr.shell_focused_ui_window_id.is_none()
        {
            self.clear_shell_osk_text_input();
        }
    }

    fn clear_shell_osk_text_input(&mut self) {
        self.session_services.osk_shell_text_input_active = false;
        self.input_routing
            .seat
            .deactivate_input_method_without_text_input();
        if self.session_services.osk_visibility_override != Some(true) {
            self.session_services.osk_visibility_override = None;
        }
        self.update_osk_visibility_from_text_input();
    }

    fn set_osk_preferred_output_for_point(&mut self, pos: Point<f64, Logical>) {
        let Some(output) = self.output_containing_global_point(pos) else {
            return;
        };
        let name = output.name();
        if self.session_services.osk_preferred_output_name.as_deref() == Some(name.as_str()) {
            if self.session_services.osk_visible == Some(true) {
                self.set_osk_visible(true);
            }
            return;
        }
        self.session_services.osk_preferred_output_name = Some(name);
        self.remap_osk_layer_surfaces();
        if self.session_services.osk_visible == Some(true) {
            self.set_osk_visible(true);
        }
    }

    pub(crate) fn refresh_osk_exclusion_damage(&mut self) {
        if self.session_services.osk_visible != Some(true) {
            return;
        }
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
    }

    pub(crate) fn preferred_osk_output(&self) -> Option<Output> {
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
        let outputs: Vec<_> = self.output_topology.space.outputs().cloned().collect();
        let mut layers = self.session_services.osk_layer_surfaces.clone();
        for output in &outputs {
            let map = layer_map_for_output(output);
            for layer in map.layers() {
                if !Self::osk_layer_namespace(layer.namespace()) {
                    continue;
                }
                if !layers
                    .iter()
                    .any(|existing| existing.wl_surface() == layer.wl_surface())
                {
                    layers.push(layer.clone());
                }
            }
        }
        self.session_services.osk_layer_surfaces = layers.clone();
        if layers.is_empty() {
            return;
        }
        let mut changed_outputs = Vec::new();
        for layer in layers {
            for output in &outputs {
                if output == &target {
                    continue;
                }
                let mut map = layer_map_for_output(output);
                if map.layers().any(|candidate| candidate == &layer) {
                    map.unmap_layer(&layer);
                    changed_outputs.push(output.clone());
                }
            }
            let mut map = layer_map_for_output(&target);
            if !map.layers().any(|candidate| candidate == &layer) {
                if map.map_layer(&layer).is_ok() {
                    changed_outputs.push(target.clone());
                }
            }
        }
        if !changed_outputs.is_empty() {
            for output in changed_outputs {
                layer_map_for_output(&output).arrange();
            }
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
            let geo = self.osk_visual_layer_geometry_for_output(output, layer, geo);
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
                let bottom = usable.loc.y.saturating_add(usable.size.h);
                let reserve = bottom.saturating_sub(overlap.loc.y).max(0);
                usable.size.h = usable.size.h.saturating_sub(reserve).max(1);
            } else if overlap.loc.y <= output_geo.loc.y {
                let overlap_bottom = overlap.loc.y.saturating_add(overlap.size.h);
                let reserve = overlap_bottom.saturating_sub(usable.loc.y).max(0);
                usable.loc.y = usable.loc.y.saturating_add(reserve);
                usable.size.h = usable.size.h.saturating_sub(reserve).max(1);
            }
        }
        Some(usable)
    }
}
