use super::*;

pub(crate) struct TrayNotificationsState {
    shell_tray_strip_global: Option<Rectangle<i32, Logical>>,
    sni_tray_cmd_tx: Option<std::sync::mpsc::Sender<crate::tray::sni_tray::SniTrayCmd>>,
    sni_tray_slot_count: u32,
    sni_tray_items: Vec<shell_wire::TraySniItemWire>,
    notifications_cmd_tx:
        Option<std::sync::mpsc::Sender<crate::notifications::NotificationsCmd>>,
    notifications_state_json: String,
    pub(crate) shell_tray_hidden_x11_windows: HashMap<u32, X11Surface>,
    pub(crate) shell_tray_hidden_x11_window_ids: HashSet<u32>,
    shell_tray_hidden_x11_notifier_window_ids: HashMap<String, u32>,
}

impl TrayNotificationsState {
    pub(crate) fn new(
        sni_tray_cmd_tx: std::sync::mpsc::Sender<crate::tray::sni_tray::SniTrayCmd>,
        notifications_cmd_tx: std::sync::mpsc::Sender<crate::notifications::NotificationsCmd>,
        notifications_enabled: bool,
    ) -> Self {
        Self {
            shell_tray_strip_global: None,
            sni_tray_cmd_tx: Some(sni_tray_cmd_tx),
            sni_tray_slot_count: 0,
            sni_tray_items: Vec::new(),
            notifications_cmd_tx: Some(notifications_cmd_tx),
            notifications_state_json: crate::notifications::initial_state_json(
                notifications_enabled,
            ),
            shell_tray_hidden_x11_windows: HashMap::new(),
            shell_tray_hidden_x11_window_ids: HashSet::new(),
            shell_tray_hidden_x11_notifier_window_ids: HashMap::new(),
        }
    }

    pub(crate) fn update_notifications_state_json(&mut self, state_json: String) -> String {
        self.notifications_state_json = state_json.clone();
        state_json
    }

    pub(crate) fn shell_tray_strip_global(&self) -> Option<Rectangle<i32, Logical>> {
        self.shell_tray_strip_global
    }

    pub(crate) fn set_shell_tray_strip_global(
        &mut self,
        rect: Option<Rectangle<i32, Logical>>,
    ) {
        self.shell_tray_strip_global = rect;
    }

    pub(crate) fn sni_tray_slot_count(&self) -> u32 {
        self.sni_tray_slot_count
    }

    pub(crate) fn sni_tray_items(&self) -> Vec<shell_wire::TraySniItemWire> {
        self.sni_tray_items.clone()
    }

    pub(crate) fn notifications_state_message(
        &self,
    ) -> shell_wire::DecodedCompositorToShellMessage {
        shell_wire::DecodedCompositorToShellMessage::NotificationsState {
            state_json: self.notifications_state_json.clone(),
        }
    }

    pub(crate) fn notifications_state_json(&self) -> String {
        if let Some(tx) = &self.notifications_cmd_tx {
            let (reply_tx, reply_rx) = std::sync::mpsc::channel();
            if tx
                .send(crate::notifications::NotificationsCmd::GetState { reply: reply_tx })
                .is_ok()
            {
                if let Ok(state_json) = reply_rx.recv_timeout(Duration::from_secs(2)) {
                    return state_json;
                }
            }
        }
        self.notifications_state_json.clone()
    }

    pub(crate) fn notifications_set_enabled(&self, enabled: bool) -> Result<(), String> {
        let Some(tx) = &self.notifications_cmd_tx else {
            return Err("notifications thread unavailable".into());
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        tx.send(crate::notifications::NotificationsCmd::SetEnabled {
            enabled,
            reply: reply_tx,
        })
        .map_err(|_| "notifications thread unavailable".to_string())?;
        reply_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "timed out waiting for notifications".to_string())?
    }

    pub(crate) fn notifications_shell_notify(
        &self,
        request: crate::notifications::ShellNotificationRequest,
    ) -> Result<u32, String> {
        let Some(tx) = &self.notifications_cmd_tx else {
            return Err("notifications thread unavailable".into());
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        tx.send(crate::notifications::NotificationsCmd::ShellNotify {
            request,
            reply: reply_tx,
        })
        .map_err(|_| "notifications thread unavailable".to_string())?;
        reply_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "timed out waiting for notifications".to_string())?
    }

    pub(crate) fn notifications_close(&self, id: u32, reason: u32, source: String) {
        if let Some(tx) = &self.notifications_cmd_tx {
            let _ = tx.send(crate::notifications::NotificationsCmd::Close { id, reason, source });
        }
    }

    pub(crate) fn notifications_invoke_action(
        &self,
        id: u32,
        action_key: String,
        source: String,
    ) {
        if let Some(tx) = &self.notifications_cmd_tx {
            let _ = tx.send(crate::notifications::NotificationsCmd::InvokeAction {
                id,
                action_key,
                source,
            });
        }
    }

    pub(crate) fn sni_item_pid(id: &str) -> Option<i32> {
        let rest = id.strip_prefix("org.kde.StatusNotifierItem-")?;
        let raw = rest.split('-').next()?;
        raw.parse::<i32>().ok()
    }

    pub(crate) fn deduplicate_sni_tray_items(
        items: Vec<shell_wire::TraySniItemWire>,
        live_pids: &HashSet<i32>,
    ) -> Vec<shell_wire::TraySniItemWire> {
        let mut out: Vec<shell_wire::TraySniItemWire> = Vec::new();
        for item in items {
            let key = Self::tray_match_token(&item.title);
            if key.is_empty() {
                out.push(item);
                continue;
            }
            if let Some(pos) = out
                .iter()
                .position(|existing| Self::tray_match_token(&existing.title) == key)
            {
                let current_live = Self::sni_item_pid(&out[pos].id)
                    .map(|pid| live_pids.contains(&pid))
                    .unwrap_or(false);
                let next_live = Self::sni_item_pid(&item.id)
                    .map(|pid| live_pids.contains(&pid))
                    .unwrap_or(false);
                if next_live || !current_live {
                    out[pos] = item;
                }
            } else {
                out.push(item);
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub(crate) fn update_sni_tray_items(
        &mut self,
        items: Vec<shell_wire::TraySniItemWire>,
        live_pids: &HashSet<i32>,
    ) -> Vec<shell_wire::TraySniItemWire> {
        let items = Self::deduplicate_sni_tray_items(items, live_pids);
        self.sni_tray_slot_count = items.len() as u32;
        self.sni_tray_items = items.clone();
        items
    }

    pub(crate) fn sni_tray_activate_clicked(&self, id: String) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::Activate { id });
        }
    }

    pub(crate) fn sni_tray_open_menu(&self, id: String, request_serial: u32) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::OpenMenu { id, request_serial });
        }
    }

    pub(crate) fn sni_tray_menu_event(&self, id: String, menu_path: String, item_id: i32) {
        if let Some(tx) = &self.sni_tray_cmd_tx {
            let _ = tx.send(crate::tray::sni_tray::SniTrayCmd::MenuEvent {
                id,
                menu_path,
                item_id,
            });
        }
    }

    pub(crate) fn tray_match_token(value: &str) -> String {
        let mut out = String::new();
        for c in value.chars() {
            if c.is_ascii_alphanumeric() {
                out.push(c.to_ascii_lowercase());
            }
        }
        out
    }

    pub(crate) fn sni_item_matches_window_info(
        item: &shell_wire::TraySniItemWire,
        info: &WindowInfo,
    ) -> bool {
        let mut window_tokens = Vec::new();
        let title = Self::tray_match_token(&info.title);
        if title.len() >= 4 {
            window_tokens.push(title);
        }
        let app_id = Self::tray_match_token(&info.app_id);
        if app_id.len() >= 4 && app_id != "wine" && app_id != "explorer" {
            window_tokens.push(app_id);
        }
        if window_tokens.is_empty() {
            return false;
        }
        let item_title = Self::tray_match_token(&item.title);
        let item_id = Self::tray_match_token(&item.id);
        window_tokens.iter().any(|token| {
            (item_title.len() >= 4
                && (item_title.contains(token) || token.contains(&item_title)))
                || (item_id.len() >= 4 && (item_id.contains(token) || token.contains(&item_id)))
        })
    }

    pub(crate) fn sni_item_pid_matches_window_info(
        item: &shell_wire::TraySniItemWire,
        info: &WindowInfo,
    ) -> bool {
        match (Self::sni_item_pid(&item.id), info.wayland_client_pid) {
            (Some(item_pid), Some(window_pid)) => item_pid == window_pid,
            _ => false,
        }
    }

    pub(crate) fn x11_window_has_matching_tray_item(&self, info: &WindowInfo) -> bool {
        self.sni_tray_items.iter().any(|item| {
            Self::sni_item_pid_matches_window_info(item, info)
                || Self::sni_item_matches_window_info(item, info)
        })
    }

    pub(crate) fn x11_window_should_hide_to_tray_on_close(&self, info: &WindowInfo) -> bool {
        if self.x11_window_has_matching_tray_item(info) {
            return true;
        }
        let title = Self::tray_match_token(&info.title);
        let app_id = Self::tray_match_token(&info.app_id);
        title.contains("v2rayn") || app_id.contains("v2rayn")
    }

    pub(crate) fn shell_x11_window_is_tray_hidden(&self, window_id: u32) -> bool {
        self.shell_tray_hidden_x11_window_ids.contains(&window_id)
            || self.shell_tray_hidden_x11_windows.contains_key(&window_id)
    }

    pub(crate) fn remember_tray_hidden_x11_window_id(
        &mut self,
        window_id: u32,
        info: Option<&WindowInfo>,
    ) {
        self.shell_tray_hidden_x11_window_ids.insert(window_id);
        let Some(info) = info else {
            return;
        };
        if let Some(item) = self.sni_tray_items.iter().find(|item| {
            Self::sni_item_pid_matches_window_info(item, info)
                || Self::sni_item_matches_window_info(item, info)
        }) {
            self.shell_tray_hidden_x11_notifier_window_ids
                .insert(item.id.clone(), window_id);
        }
    }

    pub(crate) fn forget_tray_hidden_x11_window_id(&mut self, window_id: u32) -> bool {
        let had_id = self.shell_tray_hidden_x11_window_ids.remove(&window_id);
        self.shell_tray_hidden_x11_notifier_window_ids
            .retain(|_, mapped_window_id| *mapped_window_id != window_id);
        had_id
    }

    pub(crate) fn refresh_tray_hidden_x11_notifier_window_ids<'a>(
        &mut self,
        records: impl IntoIterator<Item = &'a WindowInfo>,
    ) {
        let records: Vec<&WindowInfo> = records.into_iter().collect();
        let hidden_ids: HashSet<u32> = records.iter().map(|info| info.window_id).collect();
        self.shell_tray_hidden_x11_notifier_window_ids
            .retain(|_, window_id| hidden_ids.contains(window_id));
        for info in records {
            if let Some(item) = self.sni_tray_items.iter().find(|item| {
                Self::sni_item_pid_matches_window_info(item, info)
                    || Self::sni_item_matches_window_info(item, info)
            }) {
                self.shell_tray_hidden_x11_notifier_window_ids
                    .insert(item.id.clone(), info.window_id);
            }
        }
    }

    pub(crate) fn hidden_x11_window_id_for_sni_item<'a>(
        &self,
        id: &str,
        records: impl IntoIterator<Item = &'a WindowInfo>,
    ) -> Option<u32> {
        if let Some(&window_id) = self.shell_tray_hidden_x11_notifier_window_ids.get(id) {
            if self.shell_x11_window_is_tray_hidden(window_id) {
                return Some(window_id);
            }
        }
        let item_pid = Self::sni_item_pid(id);
        let item = self.sni_tray_items.iter().find(|item| item.id == id);
        records
            .into_iter()
            .find(|info| {
                self.shell_x11_window_is_tray_hidden(info.window_id)
                    && (matches!(
                        (info.wayland_client_pid, item_pid),
                        (Some(window_pid), Some(item_pid)) if window_pid == item_pid
                    )
                        || item
                            .map(|item| Self::sni_item_matches_window_info(item, info))
                            .unwrap_or(false))
            })
            .map(|info| info.window_id)
    }

    pub(crate) fn single_hidden_x11_window_id(&self) -> Option<u32> {
        (self.shell_tray_hidden_x11_windows.len() == 1)
            .then(|| self.shell_tray_hidden_x11_windows.keys().next().copied())
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tray_item(id: &str, title: &str) -> shell_wire::TraySniItemWire {
        shell_wire::TraySniItemWire {
            id: id.into(),
            title: title.into(),
            icon_png: Vec::new(),
        }
    }

    fn window_info(title: &str, app_id: &str, pid: Option<i32>) -> WindowInfo {
        WindowInfo {
            window_id: 7,
            surface_id: 8,
            title: title.into(),
            app_id: app_id.into(),
            icon: crate::chrome_bridge::WindowIconInfo::default(),
            wayland_client_pid: pid,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            output_name: "HDMI-A-1".into(),
            minimized: false,
            maximized: false,
            fullscreen: false,
            client_side_decoration: false,
        }
    }

    #[test]
    fn tray_match_token_strips_non_alphanumeric() {
        assert_eq!(
            TrayNotificationsState::tray_match_token(" V2RayN - Wine! "),
            "v2raynwine"
        );
    }

    #[test]
    fn sni_item_matches_window_info_by_title_or_app_id() {
        let item = tray_item("org.kde.StatusNotifierItem-42-1", "V2RayN");
        let title_match = window_info("V2RayN", "wine", None);
        let app_id_match = window_info("Settings", "com.derp.v2rayn", None);
        let miss = window_info("Settings", "wine", None);

        assert!(TrayNotificationsState::sni_item_matches_window_info(
            &item,
            &title_match
        ));
        assert!(TrayNotificationsState::sni_item_matches_window_info(
            &item,
            &app_id_match
        ));
        assert!(!TrayNotificationsState::sni_item_matches_window_info(
            &item, &miss
        ));
    }

    #[test]
    fn deduplicate_sni_tray_items_prefers_live_pid() {
        let items = vec![
            tray_item("org.kde.StatusNotifierItem-1-1", "V2RayN"),
            tray_item("org.kde.StatusNotifierItem-2-1", "V2RayN"),
        ];
        let live_pids = HashSet::from([2]);

        let out = TrayNotificationsState::deduplicate_sni_tray_items(items, &live_pids);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "org.kde.StatusNotifierItem-2-1");
    }

    #[test]
    fn x11_window_should_hide_to_tray_on_close_matches_v2rayn_fallback() {
        let (_sni_tx, sni_rx) = std::sync::mpsc::channel();
        let (_notifications_tx, notifications_rx) = std::sync::mpsc::channel();
        drop(sni_rx);
        drop(notifications_rx);
        let state = TrayNotificationsState::new(_sni_tx, _notifications_tx, true);
        let info = window_info("v2rayN", "wine", None);

        assert!(state.x11_window_should_hide_to_tray_on_close(&info));
    }
}
