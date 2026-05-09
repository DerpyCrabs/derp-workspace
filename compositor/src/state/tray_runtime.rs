use super::*;

impl CompositorState {
    pub(crate) fn sync_tray_hints_to_shell(&mut self) {
        self.shell_send_to_cef(self.shell_tray_hints_message());
    }

    pub(crate) fn on_notifications_state_updated(&mut self, state_json: String) {
        let state_json = self
            .tray_notifications
            .update_notifications_state_json(state_json);
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::NotificationsState { state_json },
        );
    }

    pub(crate) fn on_notification_event(
        &mut self,
        event: crate::notifications::NotificationEventPayload,
    ) {
        self.shell_send_to_cef(
            shell_wire::DecodedCompositorToShellMessage::NotificationEvent {
                notification_id: event.notification_id,
                event_type: event.event_type,
                action_key: event.action_key,
                close_reason: event.close_reason,
                source: event.source,
            },
        );
    }

    pub(crate) fn notifications_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        self.tray_notifications.notifications_state_message()
    }

    pub(crate) fn notifications_state_json(&self) -> String {
        self.tray_notifications.notifications_state_json()
    }

    pub(crate) fn notifications_set_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.tray_notifications.notifications_set_enabled(enabled)
    }

    pub(crate) fn notifications_shell_notify(
        &mut self,
        request: crate::notifications::ShellNotificationRequest,
    ) -> Result<u32, String> {
        self.tray_notifications.notifications_shell_notify(request)
    }

    pub(crate) fn notifications_close(&mut self, id: u32, reason: u32, source: String) {
        self.tray_notifications
            .notifications_close(id, reason, source);
    }

    pub(crate) fn notifications_invoke_action(
        &mut self,
        id: u32,
        action_key: String,
        source: String,
    ) {
        self.tray_notifications
            .notifications_invoke_action(id, action_key, source);
    }

    pub(crate) fn tray_hidden_x11_window_id_for_sni_item(&self, id: &str) -> Option<u32> {
        let records: Vec<WindowInfo> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.kind == WindowKind::Native)
            .map(|record| record.info)
            .collect();
        self.tray_notifications
            .hidden_x11_window_id_for_sni_item(id, records.iter())
    }

    pub(crate) fn on_sni_tray_items_updated(&mut self, items: Vec<shell_wire::TraySniItemWire>) {
        let live_pids: HashSet<i32> = self
            .windows
            .window_registry
            .all_records()
            .into_iter()
            .filter(|record| record.kind == WindowKind::Native)
            .filter_map(|record| record.info.wayland_client_pid)
            .collect();
        let items = self
            .tray_notifications
            .update_sni_tray_items(items, &live_pids);
        self.refresh_tray_hidden_x11_notifier_window_ids();
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySni { items });
        self.sync_tray_hints_to_shell();
    }

    pub(crate) fn on_sni_tray_menu_updated(&mut self, menu: shell_wire::TraySniMenuWire) {
        self.shell_send_to_cef(shell_wire::DecodedCompositorToShellMessage::TraySniMenu { menu });
    }

    pub(crate) fn sni_tray_activate_clicked(&mut self, id: String) {
        self.tray_notifications
            .sni_tray_activate_clicked(id.clone());
        let fallback_window_id = self.tray_notifications.single_hidden_x11_window_id();
        if let Some(window_id) = self
            .tray_hidden_x11_window_id_for_sni_item(&id)
            .or(fallback_window_id)
        {
            let _ = self.shell_restore_tray_hidden_x11_window_to_space(window_id);
        }
    }

    pub(crate) fn sni_tray_open_menu(&mut self, id: String, request_serial: u32) {
        self.tray_notifications
            .sni_tray_open_menu(id, request_serial);
    }

    pub(crate) fn sni_tray_menu_event(&mut self, id: String, menu_path: String, item_id: i32) {
        self.tray_notifications
            .sni_tray_menu_event(id, menu_path, item_id);
    }
}
