use super::*;
use serde::Serialize;
use smithay::wayland::session_lock::{
    LockSurfaceConfigure, SessionLockHandler, SessionLockManagerState,
};

#[derive(Serialize)]
struct LockScreenSnapshot {
    enabled: bool,
    locked: bool,
    phase: &'static str,
    origin: Option<&'static str>,
    authenticating: bool,
    failed_attempts: u32,
    error: String,
}

impl CompositorState {
    pub(crate) fn lock_screen_active(&self) -> bool {
        !matches!(self.lock_screen.phase, LockScreenPhase::Unlocked)
    }

    pub(crate) fn lock_screen_locked(&self) -> bool {
        matches!(
            self.lock_screen.phase,
            LockScreenPhase::Locked | LockScreenPhase::Unlocking
        )
    }

    fn lock_screen_phase_label(&self) -> &'static str {
        match self.lock_screen.phase {
            LockScreenPhase::Unlocked => "unlocked",
            LockScreenPhase::Locking => "locking",
            LockScreenPhase::Locked => "locked",
            LockScreenPhase::Unlocking => "unlocking",
        }
    }

    fn lock_screen_origin_label(&self) -> Option<&'static str> {
        match self.lock_screen.origin {
            Some(LockScreenOrigin::BuiltinShell) => Some("builtin_shell"),
            Some(LockScreenOrigin::ExternalProtocol) => Some("external_protocol"),
            None => None,
        }
    }

    pub(crate) fn lock_screen_snapshot_json(&self) -> Result<String, String> {
        serde_json::to_string(&LockScreenSnapshot {
            enabled: self.lock_screen.settings.enabled,
            locked: self.lock_screen_locked(),
            phase: self.lock_screen_phase_label(),
            origin: self.lock_screen_origin_label(),
            authenticating: self.lock_screen.authenticating,
            failed_attempts: self.lock_screen.failed_attempts,
            error: self.lock_screen.error.clone(),
        })
        .map_err(|e| e.to_string())
    }

    pub(crate) fn apply_lock_screen_settings(
        &mut self,
        settings: crate::session::settings_config::LockScreenSettingsFile,
    ) -> Result<(), String> {
        let settings = crate::session::settings_config::sanitize_lock_screen_settings(settings);
        if !settings.enabled && self.lock_screen_active() {
            return Err("lock screen cannot be disabled while locked".into());
        }
        crate::session::settings_config::write_lock_screen_settings(settings.clone())?;
        self.lock_screen.settings = settings;
        self.shell_send_lock_state();
        Ok(())
    }

    pub(crate) fn lock_screen_request_builtin(&mut self) -> Result<(), String> {
        if !self.lock_screen.settings.enabled {
            return Err("lock screen is disabled".into());
        }
        if self.lock_screen_active() {
            return Err("session is already locked".into());
        }
        self.lock_screen.phase = LockScreenPhase::Locking;
        self.lock_screen.origin = Some(LockScreenOrigin::BuiltinShell);
        self.lock_screen.authenticating = false;
        self.lock_screen.failed_attempts = 0;
        self.lock_screen.error.clear();
        self.lock_screen.phase = LockScreenPhase::Locked;
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.shell_send_lock_state();
        Ok(())
    }

    pub(crate) fn lock_screen_submit_password(&mut self, password: String) -> Result<(), String> {
        if !self.lock_screen_locked() {
            return Err("session is not locked".into());
        }
        if self.lock_screen.origin != Some(LockScreenOrigin::BuiltinShell) {
            return Err("active lock is not controlled by shell".into());
        }
        if self.lock_screen.authenticating {
            return Err("authentication already running".into());
        }
        self.lock_screen.phase = LockScreenPhase::Unlocking;
        self.lock_screen.authenticating = true;
        self.lock_screen.error.clear();
        self.shell_send_lock_state();
        let tx = self.shell_osr.cef_to_compositor_tx.clone();
        std::thread::spawn(move || {
            let ok = authenticate_lock_password(&password);
            let _ = tx.send(crate::cef::compositor_tx::CefToCompositor::Run(Box::new(
                move |s| {
                    s.lock_screen_finish_auth(ok);
                },
            )));
        });
        Ok(())
    }

    pub(crate) fn lock_screen_finish_auth(&mut self, ok: bool) {
        self.lock_screen.authenticating = false;
        if ok {
            self.lock_screen.phase = LockScreenPhase::Unlocked;
            self.lock_screen.origin = None;
            self.lock_screen.error.clear();
            self.lock_screen.external_locker = None;
            self.lock_screen.external_surfaces.clear();
        } else {
            self.lock_screen.phase = LockScreenPhase::Locked;
            self.lock_screen.failed_attempts = self.lock_screen.failed_attempts.saturating_add(1);
            self.lock_screen.error = "Authentication failed".into();
        }
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.shell_send_lock_state();
    }

    pub(crate) fn shell_send_lock_state(&mut self) {
        let Ok(state_json) = self.lock_screen_snapshot_json() else {
            return;
        };
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::LockState {
            state_json,
        });
    }
}

fn authenticate_lock_password(password: &str) -> bool {
    if let Ok(expected) = std::env::var("DERP_E2E_LOCK_PASSWORD") {
        return password == expected;
    }
    let Some(user) = std::env::var("USER").ok().filter(|value| {
        !value.is_empty()
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    }) else {
        return false;
    };
    let Ok(mut child) = std::process::Command::new("su")
        .arg("-s")
        .arg("/bin/sh")
        .arg("-c")
        .arg("true")
        .arg(user)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{password}");
    }
    child.wait().is_ok_and(|status| status.success())
}

impl SessionLockHandler for CompositorState {
    fn lock_state(&mut self) -> &mut SessionLockManagerState {
        &mut self.session_lock_state
    }

    fn lock(&mut self, confirmation: SessionLocker) {
        if !self.lock_screen.settings.enabled || self.lock_screen_active() {
            drop(confirmation);
            return;
        }
        self.lock_screen.phase = LockScreenPhase::Locking;
        self.lock_screen.origin = Some(LockScreenOrigin::ExternalProtocol);
        self.lock_screen.authenticating = false;
        self.lock_screen.failed_attempts = 0;
        self.lock_screen.error.clear();
        confirmation.lock();
        self.lock_screen.phase = LockScreenPhase::Locked;
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.shell_send_lock_state();
    }

    fn unlock(&mut self) {
        self.lock_screen.phase = LockScreenPhase::Unlocked;
        self.lock_screen.origin = None;
        self.lock_screen.authenticating = false;
        self.lock_screen.failed_attempts = 0;
        self.lock_screen.error.clear();
        self.lock_screen.external_locker = None;
        self.lock_screen.external_surfaces.clear();
        self.shell_osr.shell_exclusion_zones_need_full_damage = true;
        self.shell_osr.shell_dmabuf_dirty_force_full = true;
        self.shell_send_lock_state();
    }

    fn new_surface(&mut self, surface: LockSurface, output: WlOutput) {
        let Some(output_name) = self
            .output_topology
            .space
            .outputs()
            .find(|candidate| candidate.owns(&output))
            .map(|output| output.name())
        else {
            return;
        };
        if let Some(geo) = self
            .output_topology
            .space
            .outputs()
            .find(|candidate| candidate.name() == output_name)
            .and_then(|output| self.output_topology.space.output_geometry(output))
        {
            surface.with_pending_state(|state| {
                state.size = Some(Size::from((
                    u32::try_from(geo.size.w.max(1)).unwrap_or(1),
                    u32::try_from(geo.size.h.max(1)).unwrap_or(1),
                )));
            });
            surface.send_configure();
        }
        self.lock_screen
            .external_surfaces
            .insert(output_name, surface);
    }

    fn ack_configure(&mut self, _surface: WlSurface, _configure: LockSurfaceConfigure) {}
}

smithay::delegate_session_lock!(crate::CompositorState);
