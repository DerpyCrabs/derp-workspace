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
        crate::sidecar::terminate_sidecar(&mut self.session_services.osk_child);
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
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(target: "derp_osk", %error, "osk status failed");
                self.session_services.osk_child = None;
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
}
