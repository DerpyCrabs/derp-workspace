use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use smithay::reexports::calloop::channel::Sender;
use zbus::blocking::{connection::Builder, Connection};
use zbus::interface;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::OwnedValue;

const DEFAULT_TIMEOUT_MS: i32 = 5000;
const HISTORY_LIMIT: usize = 64;
const ACTION_LIMIT: usize = 8;
const SUMMARY_LIMIT: usize = 256;
const BODY_LIMIT: usize = 4096;
const APP_NAME_LIMIT: usize = 128;
const APP_ICON_LIMIT: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationAction {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationEntry {
    pub id: u32,
    pub app_name: String,
    pub app_icon: String,
    pub summary: String,
    pub body: String,
    pub actions: Vec<NotificationAction>,
    pub source: String,
    pub urgency: u8,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub closed_at_ms: Option<u64>,
    pub close_reason: Option<u32>,
    pub action_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationsStatePayload {
    pub revision: u64,
    pub enabled: bool,
    pub active: Vec<NotificationEntry>,
    pub history: Vec<NotificationEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationEventPayload {
    pub notification_id: u32,
    pub event_type: String,
    pub action_key: Option<String>,
    pub close_reason: Option<u32>,
    pub source: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct ShellNotificationActionRequest {
    pub key: String,
    pub label: String,
}

impl Default for ShellNotificationActionRequest {
    fn default() -> Self {
        Self {
            key: String::new(),
            label: String::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct ShellNotificationRequest {
    pub app_name: String,
    pub app_icon: String,
    pub summary: String,
    pub body: String,
    pub actions: Vec<ShellNotificationActionRequest>,
    pub expire_timeout_ms: Option<i32>,
    pub urgency: Option<u8>,
}

impl Default for ShellNotificationRequest {
    fn default() -> Self {
        Self {
            app_name: String::new(),
            app_icon: String::new(),
            summary: String::new(),
            body: String::new(),
            actions: Vec::new(),
            expire_timeout_ms: None,
            urgency: None,
        }
    }
}

#[derive(Debug)]
pub enum NotificationsCmd {
    GetState {
        reply: std::sync::mpsc::Sender<String>,
    },
    SetEnabled {
        enabled: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    ShellNotify {
        request: ShellNotificationRequest,
        reply: std::sync::mpsc::Sender<Result<u32, String>>,
    },
    Close {
        id: u32,
        reason: u32,
        source: String,
    },
    InvokeAction {
        id: u32,
        action_key: String,
        source: String,
    },
}

#[derive(Debug)]
pub enum NotificationsLoopMsg {
    State(String),
    Event(NotificationEventPayload),
}

#[derive(Debug)]
struct NotificationsRuntime {
    enabled: bool,
    revision: u64,
    next_id: u32,
    active: Vec<NotificationEntry>,
    history: Vec<NotificationEntry>,
}

impl NotificationsRuntime {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            revision: 1,
            next_id: 1,
            active: Vec::new(),
            history: Vec::new(),
        }
    }

    fn snapshot(&self) -> NotificationsStatePayload {
        NotificationsStatePayload {
            revision: self.revision,
            enabled: self.enabled,
            active: self.active.clone(),
            history: self.history.clone(),
        }
    }

    fn snapshot_json(&self) -> String {
        serde_json::to_string(&self.snapshot()).unwrap_or_else(|_| {
            format!(
                r#"{{"revision":{},"enabled":{},"active":[],"history":[]}}"#,
                self.revision,
                if self.enabled { "true" } else { "false" }
            )
        })
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    fn set_enabled(&mut self, enabled: bool) -> bool {
        if self.enabled == enabled {
            return false;
        }
        self.enabled = enabled;
        self.bump_revision();
        true
    }

    fn next_notification_id(&mut self, requested: u32) -> u32 {
        if requested != 0 && self.active.iter().any(|entry| entry.id == requested) {
            return requested;
        }
        let id = self.next_id.max(1);
        self.next_id = self.next_id.wrapping_add(1).max(1);
        id
    }

    fn upsert_entry(&mut self, entry: NotificationEntry) {
        if let Some(existing) = self.active.iter_mut().find(|row| row.id == entry.id) {
            *existing = entry.clone();
        } else {
            self.active.push(entry.clone());
            self.active.sort_by_key(|row| row.id);
        }
        self.upsert_history(entry);
    }

    fn upsert_history(&mut self, entry: NotificationEntry) {
        if let Some(index) = self.history.iter().position(|row| row.id == entry.id) {
            self.history.remove(index);
        }
        self.history.insert(0, entry);
        if self.history.len() > HISTORY_LIMIT {
            self.history.truncate(HISTORY_LIMIT);
        }
    }

    fn notify(
        &mut self,
        source: &str,
        replaces_id: u32,
        app_name: String,
        app_icon: String,
        summary: String,
        body: String,
        actions: Vec<NotificationAction>,
        expire_timeout_ms: i32,
        urgency: u8,
    ) -> u32 {
        let now = now_ms();
        let id = self.next_notification_id(replaces_id);
        let created_at_ms = self
            .active
            .iter()
            .find(|row| row.id == id)
            .or_else(|| self.history.iter().find(|row| row.id == id))
            .map(|row| row.created_at_ms)
            .unwrap_or(now);
        let expires_at_ms = compute_expires_at_ms(expire_timeout_ms, urgency, now);
        let entry = NotificationEntry {
            id,
            app_name,
            app_icon,
            summary,
            body,
            actions,
            source: source.to_string(),
            urgency,
            created_at_ms,
            updated_at_ms: now,
            expires_at_ms,
            closed_at_ms: None,
            close_reason: None,
            action_key: None,
        };
        if self.enabled {
            self.upsert_entry(entry);
        } else {
            self.upsert_history(entry);
        }
        self.bump_revision();
        id
    }

    fn invoke_action(&mut self, id: u32, action_key: &str) -> Option<NotificationEventPayload> {
        let entry = self.active.iter_mut().find(|row| row.id == id)?;
        entry.action_key = Some(clamp_text(action_key, 64));
        entry.updated_at_ms = now_ms();
        let event = NotificationEventPayload {
            notification_id: id,
            event_type: "action_invoked".to_string(),
            action_key: entry.action_key.clone(),
            close_reason: None,
            source: entry.source.clone(),
        };
        let snapshot = entry.clone();
        self.upsert_history(snapshot);
        self.bump_revision();
        Some(event)
    }

    fn close(&mut self, id: u32, reason: u32) -> Option<NotificationEntry> {
        let index = self.active.iter().position(|row| row.id == id)?;
        let mut entry = self.active.remove(index);
        entry.closed_at_ms = Some(now_ms());
        entry.close_reason = Some(reason);
        entry.updated_at_ms = entry.closed_at_ms.unwrap_or(entry.updated_at_ms);
        self.upsert_history(entry.clone());
        self.bump_revision();
        Some(entry)
    }

    fn expire_due(&mut self, now: u64) -> Vec<NotificationEntry> {
        let mut expired = Vec::new();
        let mut kept = Vec::with_capacity(self.active.len());
        let mut expired_history = Vec::new();
        for mut entry in self.active.drain(..) {
            if entry.expires_at_ms.is_some_and(|deadline| deadline <= now) {
                entry.closed_at_ms = Some(now);
                entry.close_reason = Some(1);
                entry.updated_at_ms = now;
                expired_history.push(entry.clone());
                expired.push(entry);
            } else {
                kept.push(entry);
            }
        }
        for entry in expired_history {
            self.upsert_history(entry);
        }
        if !expired.is_empty() {
            self.active = kept;
            self.bump_revision();
        } else {
            self.active = kept;
        }
        expired
    }
}

#[derive(Clone)]
struct NotificationsDbus {
    runtime: Arc<Mutex<NotificationsRuntime>>,
    loop_tx: Sender<NotificationsLoopMsg>,
}

#[interface(name = "org.freedesktop.Notifications", spawn = false)]
impl NotificationsDbus {
    #[zbus(name = "GetCapabilities")]
    fn get_capabilities(&self) -> Vec<String> {
        vec![
            "actions".to_string(),
            "body".to_string(),
            "body-markup".to_string(),
        ]
    }

    #[zbus(name = "GetServerInformation")]
    fn get_server_information(&self) -> (String, String, String, String) {
        (
            "Derp Notifications".to_string(),
            "DerpyCrabs".to_string(),
            "0.1".to_string(),
            "1.3".to_string(),
        )
    }

    #[zbus(name = "Notify")]
    fn notify(
        &self,
        app_name: &str,
        replaces_id: u32,
        app_icon: &str,
        summary: &str,
        body: &str,
        actions: Vec<String>,
        _hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
    ) -> zbus::fdo::Result<u32> {
        let normalized_actions = normalize_actions(actions);
        let urgency = 1;
        let id = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return Err(zbus::fdo::Error::Failed(
                    "notification runtime poisoned".into(),
                ));
            };
            runtime.notify(
                "native",
                replaces_id,
                clamp_text(app_name, APP_NAME_LIMIT),
                clamp_text(app_icon, APP_ICON_LIMIT),
                clamp_text(summary, SUMMARY_LIMIT),
                clamp_text(body, BODY_LIMIT),
                normalized_actions,
                expire_timeout,
                urgency,
            )
        };
        let _ = self.loop_tx.send(NotificationsLoopMsg::State(
            self.runtime
                .lock()
                .map(|runtime| runtime.snapshot_json())
                .unwrap_or_else(|_| initial_state_json(true)),
        ));
        Ok(id)
    }

    #[zbus(name = "CloseNotification")]
    fn close_notification(
        &self,
        id: u32,
        #[zbus(signal_context)] ctxt: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let closed = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return Err(zbus::fdo::Error::Failed(
                    "notification runtime poisoned".into(),
                ));
            };
            runtime.close(id, 3)
        };
        if let Some(entry) = closed {
            let event = NotificationEventPayload {
                notification_id: entry.id,
                event_type: "closed".to_string(),
                action_key: None,
                close_reason: Some(3),
                source: entry.source.clone(),
            };
            let _ = self.loop_tx.send(NotificationsLoopMsg::State(
                self.runtime
                    .lock()
                    .map(|runtime| runtime.snapshot_json())
                    .unwrap_or_else(|_| initial_state_json(true)),
            ));
            let _ = self.loop_tx.send(NotificationsLoopMsg::Event(event));
            let _ = zbus::block_on(Self::notification_closed(&ctxt, entry.id, 3));
        }
        Ok(())
    }

    #[zbus(signal, name = "NotificationClosed")]
    async fn notification_closed(
        signal_ctxt: &SignalEmitter<'_>,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()>;

    #[zbus(signal, name = "ActionInvoked")]
    async fn action_invoked(
        signal_ctxt: &SignalEmitter<'_>,
        id: u32,
        action_key: &str,
    ) -> zbus::Result<()>;
}

pub fn initial_state_json(enabled: bool) -> String {
    NotificationsRuntime::new(enabled).snapshot_json()
}

pub fn spawn_notifications_thread(
    loop_tx: Sender<NotificationsLoopMsg>,
    cmd_rx: std::sync::mpsc::Receiver<NotificationsCmd>,
    enabled: bool,
) {
    std::thread::Builder::new()
        .name("derp-notifications".into())
        .spawn(move || run_notifications(loop_tx, cmd_rx, enabled))
        .ok();
}

fn run_notifications(
    loop_tx: Sender<NotificationsLoopMsg>,
    cmd_rx: std::sync::mpsc::Receiver<NotificationsCmd>,
    enabled: bool,
) {
    let runtime = Arc::new(Mutex::new(NotificationsRuntime::new(enabled)));
    let interface = NotificationsDbus {
        runtime: runtime.clone(),
        loop_tx: loop_tx.clone(),
    };
    let connection = match Builder::session().and_then(|builder| {
        builder
            .name("org.freedesktop.Notifications")?
            .serve_at("/org/freedesktop/Notifications", interface)?
            .build()
    }) {
        Ok(connection) => Some(connection),
        Err(error) => {
            tracing::warn!(
                ?error,
                "notifications: could not own org.freedesktop.Notifications"
            );
            match Connection::session() {
                Ok(connection) => Some(connection),
                Err(session_error) => {
                    tracing::warn!(?session_error, "notifications: session dbus unavailable");
                    None
                }
            }
        }
    };
    let _ = loop_tx.send(NotificationsLoopMsg::State(
        runtime
            .lock()
            .map(|runtime| runtime.snapshot_json())
            .unwrap_or_else(|_| initial_state_json(enabled)),
    ));
    loop {
        match cmd_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(NotificationsCmd::GetState { reply }) => {
                let _ = reply.send(
                    runtime
                        .lock()
                        .map(|runtime| runtime.snapshot_json())
                        .unwrap_or_else(|_| initial_state_json(enabled)),
                );
            }
            Ok(NotificationsCmd::SetEnabled { enabled, reply }) => {
                let changed = runtime
                    .lock()
                    .map(|mut runtime| runtime.set_enabled(enabled))
                    .unwrap_or(false);
                if changed {
                    let _ = loop_tx.send(NotificationsLoopMsg::State(
                        runtime
                            .lock()
                            .map(|runtime| runtime.snapshot_json())
                            .unwrap_or_else(|_| initial_state_json(enabled)),
                    ));
                }
                let _ = reply.send(Ok(()));
            }
            Ok(NotificationsCmd::ShellNotify { request, reply }) => {
                let request = normalize_shell_request(request);
                if request.summary.is_empty() {
                    let _ = reply.send(Err("notification summary is required".into()));
                    continue;
                }
                let id = runtime
                    .lock()
                    .map(|mut runtime| {
                        runtime.notify(
                            "shell",
                            0,
                            request.app_name,
                            request.app_icon,
                            request.summary,
                            request.body,
                            request.actions,
                            request.expire_timeout_ms,
                            request.urgency,
                        )
                    })
                    .map_err(|_| "notification runtime poisoned".to_string());
                match id {
                    Ok(id) => {
                        let _ = loop_tx.send(NotificationsLoopMsg::State(
                            runtime
                                .lock()
                                .map(|runtime| runtime.snapshot_json())
                                .unwrap_or_else(|_| initial_state_json(enabled)),
                        ));
                        let _ = reply.send(Ok(id));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(NotificationsCmd::Close { id, reason, source }) => {
                let closed = runtime
                    .lock()
                    .ok()
                    .and_then(|mut runtime| runtime.close(id, reason));
                if let Some(entry) = closed {
                    let _ = loop_tx.send(NotificationsLoopMsg::State(
                        runtime
                            .lock()
                            .map(|runtime| runtime.snapshot_json())
                            .unwrap_or_else(|_| initial_state_json(enabled)),
                    ));
                    let _ = loop_tx.send(NotificationsLoopMsg::Event(NotificationEventPayload {
                        notification_id: entry.id,
                        event_type: "closed".to_string(),
                        action_key: None,
                        close_reason: Some(reason),
                        source,
                    }));
                    emit_notification_closed(connection.as_ref(), entry.id, reason);
                }
            }
            Ok(NotificationsCmd::InvokeAction {
                id,
                action_key,
                source,
            }) => {
                let action_event = runtime
                    .lock()
                    .ok()
                    .and_then(|mut runtime| runtime.invoke_action(id, &action_key));
                if let Some(event) = action_event {
                    let _ = loop_tx.send(NotificationsLoopMsg::State(
                        runtime
                            .lock()
                            .map(|runtime| runtime.snapshot_json())
                            .unwrap_or_else(|_| initial_state_json(enabled)),
                    ));
                    let _ = loop_tx.send(NotificationsLoopMsg::Event(NotificationEventPayload {
                        notification_id: event.notification_id,
                        event_type: event.event_type.clone(),
                        action_key: event.action_key.clone(),
                        close_reason: None,
                        source: source.clone(),
                    }));
                    emit_action_invoked(connection.as_ref(), event.notification_id, &action_key);
                }
                let closed = runtime
                    .lock()
                    .ok()
                    .and_then(|mut runtime| runtime.close(id, 2));
                if let Some(entry) = closed {
                    let _ = loop_tx.send(NotificationsLoopMsg::State(
                        runtime
                            .lock()
                            .map(|runtime| runtime.snapshot_json())
                            .unwrap_or_else(|_| initial_state_json(enabled)),
                    ));
                    let _ = loop_tx.send(NotificationsLoopMsg::Event(NotificationEventPayload {
                        notification_id: entry.id,
                        event_type: "closed".to_string(),
                        action_key: None,
                        close_reason: Some(2),
                        source,
                    }));
                    emit_notification_closed(connection.as_ref(), entry.id, 2);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let expired = runtime
            .lock()
            .map(|mut runtime| runtime.expire_due(now_ms()))
            .unwrap_or_default();
        if !expired.is_empty() {
            let _ = loop_tx.send(NotificationsLoopMsg::State(
                runtime
                    .lock()
                    .map(|runtime| runtime.snapshot_json())
                    .unwrap_or_else(|_| initial_state_json(enabled)),
            ));
            for entry in expired {
                let _ = loop_tx.send(NotificationsLoopMsg::Event(NotificationEventPayload {
                    notification_id: entry.id,
                    event_type: "closed".to_string(),
                    action_key: None,
                    close_reason: Some(1),
                    source: entry.source.clone(),
                }));
                emit_notification_closed(connection.as_ref(), entry.id, 1);
            }
        }
    }
}

fn emit_notification_closed(connection: Option<&Connection>, id: u32, reason: u32) {
    let Some(connection) = connection else {
        return;
    };
    let Ok(ctxt) = SignalEmitter::new(connection.inner(), "/org/freedesktop/Notifications")
    else {
        return;
    };
    let _ = zbus::block_on(NotificationsDbus::notification_closed(&ctxt, id, reason));
}

fn emit_action_invoked(connection: Option<&Connection>, id: u32, action_key: &str) {
    let Some(connection) = connection else {
        return;
    };
    let Ok(ctxt) = SignalEmitter::new(connection.inner(), "/org/freedesktop/Notifications")
    else {
        return;
    };
    let _ = zbus::block_on(NotificationsDbus::action_invoked(&ctxt, id, action_key));
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn clamp_text(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

fn normalize_actions(raw: Vec<String>) -> Vec<NotificationAction> {
    let mut actions = Vec::new();
    let mut iter = raw.into_iter();
    while let Some(key) = iter.next() {
        let Some(label) = iter.next() else {
            break;
        };
        let key = clamp_text(&key, 64);
        let label = clamp_text(&label, 128);
        if key.is_empty() || label.is_empty() {
            continue;
        }
        actions.push(NotificationAction { key, label });
        if actions.len() >= ACTION_LIMIT {
            break;
        }
    }
    actions
}

fn normalize_shell_request(
    request: ShellNotificationRequest,
) -> NormalizedShellNotificationRequest {
    let mut actions = Vec::new();
    for action in request.actions {
        let key = clamp_text(&action.key, 64);
        let label = clamp_text(&action.label, 128);
        if key.is_empty() || label.is_empty() {
            continue;
        }
        actions.push(NotificationAction { key, label });
        if actions.len() >= ACTION_LIMIT {
            break;
        }
    }
    NormalizedShellNotificationRequest {
        app_name: clamp_text(&request.app_name, APP_NAME_LIMIT),
        app_icon: clamp_text(&request.app_icon, APP_ICON_LIMIT),
        summary: clamp_text(&request.summary, SUMMARY_LIMIT),
        body: clamp_text(&request.body, BODY_LIMIT),
        actions,
        expire_timeout_ms: request.expire_timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        urgency: request.urgency.unwrap_or(1).min(2),
    }
}

struct NormalizedShellNotificationRequest {
    app_name: String,
    app_icon: String,
    summary: String,
    body: String,
    actions: Vec<NotificationAction>,
    expire_timeout_ms: i32,
    urgency: u8,
}

fn compute_expires_at_ms(expire_timeout_ms: i32, urgency: u8, now: u64) -> Option<u64> {
    if expire_timeout_ms == 0 {
        return None;
    }
    let effective_timeout = if expire_timeout_ms < 0 {
        if urgency >= 2 {
            0
        } else {
            DEFAULT_TIMEOUT_MS
        }
    } else {
        expire_timeout_ms
    };
    if effective_timeout <= 0 {
        return None;
    }
    Some(now.saturating_add(effective_timeout as u64))
}

#[cfg(test)]
mod tests {
    use super::{NotificationAction, NotificationsRuntime};

    #[test]
    fn notify_enabled_keeps_active_and_history() {
        let mut runtime = NotificationsRuntime::new(true);
        let id = runtime.notify(
            "shell",
            0,
            "Shell".into(),
            String::new(),
            "Visible".into(),
            String::new(),
            Vec::<NotificationAction>::new(),
            0,
            1,
        );

        assert_eq!(id, 1);
        assert_eq!(runtime.active.len(), 1);
        assert_eq!(runtime.history.len(), 1);
        assert_eq!(runtime.active[0].id, id);
        assert_eq!(runtime.history[0].id, id);
    }

    #[test]
    fn notify_disabled_keeps_history_only() {
        let mut runtime = NotificationsRuntime::new(false);
        let id = runtime.notify(
            "native",
            0,
            "Native".into(),
            String::new(),
            "Muted".into(),
            String::new(),
            Vec::<NotificationAction>::new(),
            0,
            1,
        );

        assert_eq!(id, 1);
        assert!(runtime.active.is_empty());
        assert_eq!(runtime.history.len(), 1);
        assert_eq!(runtime.history[0].id, id);
    }
}
