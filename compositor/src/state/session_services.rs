use super::*;

pub(crate) struct SessionServicesState {
    pub(crate) vt_session: Option<LibSeatSession>,
    pub(crate) osk_child: Option<std::process::Child>,
    pub(crate) osk_gtk_theme: Option<String>,
    pub(crate) osk_monitor_active: bool,
    pub(crate) osk_visibility_monitor_active: bool,
    pub(crate) osk_visible: Option<bool>,
    pub(crate) osk_visibility_override: Option<bool>,
    pub(crate) osk_last_text_input_active: bool,
    pub(crate) osk_text_input_visibility_allowed: bool,
    pub(crate) osk_shell_text_input_active: bool,
    pub(crate) osk_preferred_output_name: Option<String>,
    pub(crate) osk_layer_surfaces: Vec<DesktopLayerSurface>,
    e2e_last_session_power_action: Option<String>,
    e2e_last_session_power_requested_at_ms: Option<u128>,
    pub(crate) control_event_hub: crate::control::ControlEventHub,
    pub(crate) command_palette_registry: crate::control::CommandPaletteRegistry,
    command_palette_revision: u64,
    control_settings_revision: u64,
}

impl SessionServicesState {
    pub(crate) fn new() -> Self {
        Self {
            vt_session: None,
            osk_child: None,
            osk_gtk_theme: None,
            osk_monitor_active: false,
            osk_visibility_monitor_active: false,
            osk_visible: None,
            osk_visibility_override: None,
            osk_last_text_input_active: false,
            osk_text_input_visibility_allowed: false,
            osk_shell_text_input_active: false,
            osk_preferred_output_name: None,
            osk_layer_surfaces: Vec::new(),
            e2e_last_session_power_action: None,
            e2e_last_session_power_requested_at_ms: None,
            control_event_hub: crate::control::ControlEventHub::default(),
            command_palette_registry: crate::control::CommandPaletteRegistry::default(),
            command_palette_revision: 0,
            control_settings_revision: 0,
        }
    }

    pub(crate) fn set_vt_session(&mut self, session: Option<LibSeatSession>) {
        self.vt_session = session;
    }

    pub(crate) fn record_session_power_action(&mut self, action: String) {
        self.e2e_last_session_power_action = Some(action);
        self.e2e_last_session_power_requested_at_ms = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        );
    }

    pub(crate) fn last_session_power_action(&self) -> Option<String> {
        self.e2e_last_session_power_action.clone()
    }

    pub(crate) fn last_session_power_requested_at_ms(&self) -> Option<u128> {
        self.e2e_last_session_power_requested_at_ms
    }

    pub(crate) fn command_palette_revision(&self) -> u64 {
        self.command_palette_revision
    }

    pub(crate) fn control_settings_revision(&self) -> u64 {
        self.control_settings_revision
    }

    pub(crate) fn command_palette_state_value(&self) -> serde_json::Value {
        let mut state = self.command_palette_registry.state_value();
        if let Some(object) = state.as_object_mut() {
            object.insert(
                "revision".into(),
                serde_json::json!(self.command_palette_revision),
            );
        }
        state
    }

    pub(crate) fn bump_command_palette_revision(&mut self) -> u64 {
        self.command_palette_revision = self.command_palette_revision.wrapping_add(1).max(1);
        self.command_palette_revision
    }

    pub(crate) fn bump_control_settings_revision(&mut self) {
        self.control_settings_revision = self.control_settings_revision.wrapping_add(1).max(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_palette_revision_bumps_from_zero() {
        let mut state = SessionServicesState::new();

        assert_eq!(state.command_palette_revision(), 0);
        assert_eq!(state.bump_command_palette_revision(), 1);
        assert_eq!(state.bump_command_palette_revision(), 2);
        assert_eq!(state.command_palette_revision(), 2);
    }

    #[test]
    fn control_settings_revision_bumps_from_zero() {
        let mut state = SessionServicesState::new();

        assert_eq!(state.control_settings_revision(), 0);
        state.bump_control_settings_revision();
        assert_eq!(state.control_settings_revision(), 1);
        state.bump_control_settings_revision();
        assert_eq!(state.control_settings_revision(), 2);
    }

    #[test]
    fn record_session_power_action_stores_action_and_timestamp() {
        let mut state = SessionServicesState::new();

        state.record_session_power_action("logout".into());

        assert_eq!(state.last_session_power_action().as_deref(), Some("logout"));
        assert!(state.last_session_power_requested_at_ms().is_some());
    }
}
