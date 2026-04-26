use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use cef::{
    post_task, rc::Rc, wrap_task, Browser, ImplBrowser, ImplBrowserHost, ImplTask, Task, ThreadId,
    WrapTask,
};

use crate::cef::compositor_downlink;
use crate::cef::osr_view_state::OsrViewState;
use crate::cef::shell_snapshot::SharedShellSnapshotWriter;

struct PendingCompositorMessages {
    scheduled: bool,
    urgent: PendingCompositorMessageQueue,
    messages: PendingCompositorMessageQueue,
    snapshot: PendingCompositorMessageQueue,
    snapshot_epoch: u64,
}

pub(crate) struct PendingCompositorMessage {
    pub(crate) snapshot_epoch: u64,
    pub(crate) msg: shell_wire::DecodedCompositorToShellMessage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PendingCompositorMessageStaticKey {
    OutputGeometry,
    OutputLayout,
    FocusChanged,
    WindowOrder,
    KeyboardLayout,
    VolumeOverlay,
    TrayHints,
    TraySni,
    WorkspaceState,
    WorkspaceStateBinary,
    ShellHostedAppState,
    CommandPaletteState,
    InteractionState,
    NotificationsState,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum PendingCompositorMessageDedupKey {
    Static(PendingCompositorMessageStaticKey),
    WindowGeometry(u32),
    WindowMetadata(u32),
    WindowState(u32),
    WindowList,
}

#[derive(Default)]
struct PendingCompositorMessageQueue {
    next_sequence: u64,
    ordered: BTreeMap<u64, PendingCompositorMessage>,
    dedup_sequences: HashMap<PendingCompositorMessageDedupKey, u64>,
}

impl PendingCompositorMessageQueue {
    fn is_empty(&self) -> bool {
        self.ordered.is_empty()
    }

    fn push(&mut self, pending_message: PendingCompositorMessage) {
        let sequence = self.next_sequence.wrapping_add(1).max(1);
        self.next_sequence = sequence;
        if let Some(key) = pending_message_dedup_key(&pending_message.msg) {
            if let Some(previous_sequence) = self.dedup_sequences.insert(key, sequence) {
                self.ordered.remove(&previous_sequence);
            }
        }
        self.ordered.insert(sequence, pending_message);
    }

    fn push_urgent_input(&mut self, pending_message: PendingCompositorMessage) {
        if matches!(
            pending_message.msg,
            shell_wire::DecodedCompositorToShellMessage::PointerMove { .. }
        ) {
            if let Some((&sequence, previous)) = self.ordered.last_key_value() {
                if matches!(
                    previous.msg,
                    shell_wire::DecodedCompositorToShellMessage::PointerMove { .. }
                ) {
                    self.ordered.insert(sequence, pending_message);
                    return;
                }
            }
        }
        self.push(pending_message);
    }

    fn take_all(&mut self) -> Vec<PendingCompositorMessage> {
        self.dedup_sequences.clear();
        std::mem::take(&mut self.ordered).into_values().collect()
    }
}

fn pending_message_dedup_key(
    msg: &shell_wire::DecodedCompositorToShellMessage,
) -> Option<PendingCompositorMessageDedupKey> {
    match msg {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::OutputGeometry,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::OutputLayout,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::FocusChanged,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::WindowOrder,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::KeyboardLayout,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::VolumeOverlay { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::VolumeOverlay,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::TrayHints { .. } => Some(
            PendingCompositorMessageDedupKey::Static(PendingCompositorMessageStaticKey::TrayHints),
        ),
        shell_wire::DecodedCompositorToShellMessage::TraySni { .. } => Some(
            PendingCompositorMessageDedupKey::Static(PendingCompositorMessageStaticKey::TraySni),
        ),
        shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::WorkspaceState,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::WorkspaceStateBinary,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::ShellHostedAppState,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::CommandPaletteState { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::CommandPaletteState,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::InteractionState { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::InteractionState,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::NotificationsState { .. } => {
            Some(PendingCompositorMessageDedupKey::Static(
                PendingCompositorMessageStaticKey::NotificationsState,
            ))
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry { window_id, .. } => {
            Some(PendingCompositorMessageDedupKey::WindowGeometry(*window_id))
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata { window_id, .. } => {
            Some(PendingCompositorMessageDedupKey::WindowMetadata(*window_id))
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState { window_id, .. } => {
            Some(PendingCompositorMessageDedupKey::WindowState(*window_id))
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { .. } => {
            Some(PendingCompositorMessageDedupKey::WindowList)
        }
        _ => None,
    }
}

fn pending_message_is_urgent_input(msg: &shell_wire::DecodedCompositorToShellMessage) -> bool {
    matches!(
        msg,
        shell_wire::DecodedCompositorToShellMessage::PointerMove { .. }
            | shell_wire::DecodedCompositorToShellMessage::PointerButton { .. }
            | shell_wire::DecodedCompositorToShellMessage::PointerAxis { .. }
            | shell_wire::DecodedCompositorToShellMessage::Key { .. }
            | shell_wire::DecodedCompositorToShellMessage::Touch { .. }
    )
}

fn pending_message_needs_fast_begin_frame(
    msg: &shell_wire::DecodedCompositorToShellMessage,
) -> bool {
    matches!(
        msg,
        shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowState { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowMetadata { .. }
            | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. }
            | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
            | shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. }
            | shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { .. }
            | shell_wire::DecodedCompositorToShellMessage::InteractionState { .. }
            | shell_wire::DecodedCompositorToShellMessage::TrayHints { .. }
            | shell_wire::DecodedCompositorToShellMessage::TraySni { .. }
            | shell_wire::DecodedCompositorToShellMessage::NotificationsState { .. }
            | shell_wire::DecodedCompositorToShellMessage::NotificationEvent { .. }
            | shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. }
            | shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
    )
}

fn post_external_begin_frame_task(
    browser_holder: Arc<Mutex<Option<Browser>>>,
    pending_begin_frame: Arc<AtomicBool>,
    pending_begin_frame_reschedule: Arc<AtomicBool>,
    kind: crate::cef::begin_frame_diag::CompositorScheduleKind,
) {
    crate::cef::begin_frame_diag::note_schedule_from_compositor(kind);
    if pending_begin_frame
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let mut task = ExternalBeginFrameTask::new(
        browser_holder,
        pending_begin_frame.clone(),
        pending_begin_frame_reschedule,
    );
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        pending_begin_frame.store(false, Ordering::Relaxed);
    }
}

wrap_task! {
    struct ApplyCompositorToShellTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
        pending_messages: Arc<Mutex<PendingCompositorMessages>>,
        pending_work: Arc<AtomicBool>,
        pending_begin_frame: Arc<AtomicBool>,
        pending_begin_frame_reschedule: Arc<AtomicBool>,
        shared_snapshot: Arc<Mutex<Option<SharedShellSnapshotWriter>>>,
    }

    impl Task {
        fn execute(&self) {
            let (urgent_messages, messages, snapshot_messages, snapshot_epoch) = {
                let Ok(mut guard) = self.pending_messages.lock() else {
                    return;
                };
                if guard.urgent.is_empty() && guard.messages.is_empty() && guard.snapshot.is_empty() {
                    guard.scheduled = false;
                    self.pending_work.store(false, Ordering::Relaxed);
                    return;
                }
                guard.scheduled = false;
                (
                    guard.urgent.take_all(),
                    guard.messages.take_all(),
                    guard.snapshot.take_all(),
                    std::mem::take(&mut guard.snapshot_epoch),
                )
            };
            if !urgent_messages.is_empty() {
                compositor_downlink::apply_messages(urgent_messages, &self.browser_holder, &self.view_state);
            }
            let needs_fast_begin_frame = snapshot_messages
                .iter()
                .any(|pending| pending_message_needs_fast_begin_frame(&pending.msg))
                || messages
                    .iter()
                    .any(|pending| pending_message_needs_fast_begin_frame(&pending.msg));
            if !snapshot_messages.is_empty() {
                if let Ok(mut snapshot) = self.shared_snapshot.lock() {
                    if let Some(snapshot) = snapshot.as_mut() {
                        let snapshot_messages: Vec<_> =
                            snapshot_messages.into_iter().map(|pending| pending.msg).collect();
                        if let Err(error) =
                            snapshot.publish_messages(snapshot_epoch, &snapshot_messages)
                        {
                            tracing::warn!(%error, "publish shell snapshot failed");
                        }
                    }
                }
            }
            if !messages.is_empty() {
                compositor_downlink::apply_messages(messages, &self.browser_holder, &self.view_state);
            }
            if needs_fast_begin_frame {
                post_external_begin_frame_task(
                    self.browser_holder.clone(),
                    self.pending_begin_frame.clone(),
                    self.pending_begin_frame_reschedule.clone(),
                    crate::cef::begin_frame_diag::CompositorScheduleKind::Active,
                );
            }
            let should_repost = {
                let Ok(mut guard) = self.pending_messages.lock() else {
                    return;
                };
                if guard.urgent.is_empty() && guard.messages.is_empty() && guard.snapshot.is_empty() {
                    self.pending_work.store(false, Ordering::Relaxed);
                    false
                } else if guard.scheduled {
                    false
                } else {
                    guard.scheduled = true;
                    true
                }
            };
            if should_repost {
                let mut task = ApplyCompositorToShellTask::new(
                    self.browser_holder.clone(),
                    self.view_state.clone(),
                    self.pending_messages.clone(),
                    self.pending_work.clone(),
                    self.pending_begin_frame.clone(),
                    self.pending_begin_frame_reschedule.clone(),
                    self.shared_snapshot.clone(),
                );
                if post_task(ThreadId::UI, Some(&mut task)) == 0 {
                    if let Ok(mut guard) = self.pending_messages.lock() {
                        guard.scheduled = false;
                    }
                }
            }
        }
    }
}

wrap_task! {
    struct ExternalBeginFrameTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        pending_begin_frame: Arc<AtomicBool>,
        pending_begin_frame_reschedule: Arc<AtomicBool>,
    }

    impl Task {
        fn execute(&self) {
            let Ok(guard) = self.browser_holder.lock() else {
                self.pending_begin_frame.store(false, Ordering::Relaxed);
                self.pending_begin_frame_reschedule
                    .store(false, Ordering::Relaxed);
                return;
            };
            let Some(b) = guard.as_ref() else {
                self.pending_begin_frame.store(false, Ordering::Relaxed);
                self.pending_begin_frame_reschedule
                    .store(false, Ordering::Relaxed);
                return;
            };
            if let Some(host) = b.host() {
                host.send_external_begin_frame();
                crate::cef::begin_frame_diag::note_cef_ui_send_external_begin_frame();
            }
            self.pending_begin_frame.store(false, Ordering::Relaxed);
            self.pending_begin_frame_reschedule
                .store(false, Ordering::Relaxed);
        }
    }
}

pub struct ShellToCefLink {
    browser_holder: Arc<Mutex<Option<Browser>>>,
    view_state: Arc<Mutex<OsrViewState>>,
    pending_messages: Arc<Mutex<PendingCompositorMessages>>,
    delivery_ready: Arc<AtomicBool>,
    pending_work: Arc<AtomicBool>,
    pending_begin_frame: Arc<AtomicBool>,
    pending_begin_frame_reschedule: Arc<AtomicBool>,
    shared_snapshot: Arc<Mutex<Option<SharedShellSnapshotWriter>>>,
}

impl ShellToCefLink {
    pub fn new(
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
    ) -> Self {
        Self {
            browser_holder,
            view_state,
            pending_messages: Arc::new(Mutex::new(PendingCompositorMessages {
                scheduled: false,
                urgent: PendingCompositorMessageQueue::default(),
                messages: PendingCompositorMessageQueue::default(),
                snapshot: PendingCompositorMessageQueue::default(),
                snapshot_epoch: 0,
            })),
            delivery_ready: Arc::new(AtomicBool::new(false)),
            pending_work: Arc::new(AtomicBool::new(false)),
            pending_begin_frame: Arc::new(AtomicBool::new(false)),
            pending_begin_frame_reschedule: Arc::new(AtomicBool::new(false)),
            shared_snapshot: Arc::new(Mutex::new(
                SharedShellSnapshotWriter::new(crate::cef::runtime_dir()).ok(),
            )),
        }
    }

    pub fn sync_osr_physical_from_dmabuf(&self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            if let Ok(mut g) = self.view_state.lock() {
                g.set_physical_size(w, h);
            }
        }
    }

    pub fn send(&self, msg: shell_wire::DecodedCompositorToShellMessage) {
        self.send_with_snapshot(msg, None, None, None);
    }

    pub fn send_with_snapshot(
        &self,
        msg: shell_wire::DecodedCompositorToShellMessage,
        snapshot: Option<Vec<shell_wire::DecodedCompositorToShellMessage>>,
        snapshot_epoch: Option<u64>,
        msg_epoch: Option<u64>,
    ) {
        let should_post = {
            let Ok(mut guard) = self.pending_messages.lock() else {
                return;
            };
            if let Some(snapshot) = snapshot {
                for snapshot_msg in snapshot {
                    guard.snapshot.push(PendingCompositorMessage {
                        snapshot_epoch: 0,
                        msg: snapshot_msg,
                    });
                }
            }
            if let Some(snapshot_epoch) = snapshot_epoch {
                guard.snapshot_epoch = guard.snapshot_epoch.max(snapshot_epoch);
            }
            let pending = PendingCompositorMessage {
                snapshot_epoch: msg_epoch.unwrap_or_default(),
                msg,
            };
            if pending_message_is_urgent_input(&pending.msg) {
                guard.urgent.push_urgent_input(pending);
            } else {
                guard.messages.push(pending);
            }
            self.pending_work.store(true, Ordering::Relaxed);
            if guard.scheduled {
                false
            } else {
                guard.scheduled = true;
                true
            }
        };
        if !should_post || !self.delivery_ready.load(Ordering::Relaxed) {
            return;
        }
        self.post_pending_messages();
    }

    pub fn shared_snapshot_path(&self) -> Option<PathBuf> {
        let Ok(snapshot) = self.shared_snapshot.lock() else {
            return None;
        };
        snapshot
            .as_ref()
            .map(|snapshot| snapshot.path().to_path_buf())
    }

    pub(crate) fn schedule_external_begin_frame(
        &self,
        kind: crate::cef::begin_frame_diag::CompositorScheduleKind,
    ) {
        if !self.delivery_ready.load(Ordering::Relaxed) {
            return;
        }
        post_external_begin_frame_task(
            self.browser_holder.clone(),
            self.pending_begin_frame.clone(),
            self.pending_begin_frame_reschedule.clone(),
            kind,
        );
    }

    pub fn set_delivery_ready(&self, ready: bool) {
        self.delivery_ready.store(ready, Ordering::Relaxed);
        if ready {
            self.post_pending_messages();
        } else if let Ok(mut guard) = self.pending_messages.lock() {
            guard.scheduled = false;
        }
    }

    pub fn delivery_ready(&self) -> bool {
        self.delivery_ready.load(Ordering::Relaxed)
    }

    pub fn has_pending_shell_updates(&self) -> bool {
        self.pending_work.load(Ordering::Relaxed)
            || self.pending_begin_frame.load(Ordering::Relaxed)
    }

    fn post_pending_messages(&self) {
        let mut task = ApplyCompositorToShellTask::new(
            self.browser_holder.clone(),
            self.view_state.clone(),
            self.pending_messages.clone(),
            self.pending_work.clone(),
            self.pending_begin_frame.clone(),
            self.pending_begin_frame_reschedule.clone(),
            self.shared_snapshot.clone(),
        );
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            if let Ok(mut guard) = self.pending_messages.lock() {
                guard.scheduled = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        pending_message_dedup_key, PendingCompositorMessage, PendingCompositorMessageDedupKey,
        PendingCompositorMessageQueue,
    };

    #[test]
    fn pending_queue_replaces_window_geometry_without_scanning_previous_entries() {
        let mut queue = PendingCompositorMessageQueue::default();
        queue.push(PendingCompositorMessage {
            snapshot_epoch: 2,
            msg: shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id: 7,
                surface_id: 70,
                x: 10,
                y: 20,
                w: 300,
                h: 200,
                maximized: false,
                fullscreen: false,
                client_side_decoration: false,
                output_id: String::new(),
                output_name: "DP-1".to_string(),
            },
        });
        queue.push(PendingCompositorMessage {
            snapshot_epoch: 4,
            msg: shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                window_id: 7,
                surface_id: 70,
                x: 40,
                y: 50,
                w: 640,
                h: 480,
                maximized: true,
                fullscreen: false,
                client_side_decoration: false,
                output_id: String::new(),
                output_name: "DP-2".to_string(),
            },
        });

        let drained = queue.take_all();
        assert_eq!(drained.len(), 1);
        match &drained[0].msg {
            shell_wire::DecodedCompositorToShellMessage::WindowGeometry { x, y, w, h, .. } => {
                assert_eq!((*x, *y, *w, *h), (40, 50, 640, 480));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn pending_queue_keeps_non_deduped_messages_in_order() {
        let mut queue = PendingCompositorMessageQueue::default();
        queue.push(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::ProgramsMenuToggle,
        });
        queue.push(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::Ping,
        });

        let drained = queue.take_all();
        assert!(matches!(
            drained[0].msg,
            shell_wire::DecodedCompositorToShellMessage::ProgramsMenuToggle
        ));
        assert!(matches!(
            drained[1].msg,
            shell_wire::DecodedCompositorToShellMessage::Ping
        ));
        assert_eq!(pending_message_dedup_key(&drained[0].msg), None);
        assert_eq!(
            pending_message_dedup_key(&shell_wire::DecodedCompositorToShellMessage::WindowList {
                revision: 1,
                windows: Vec::new(),
            }),
            Some(PendingCompositorMessageDedupKey::WindowList)
        );
    }

    #[test]
    fn urgent_queue_coalesces_adjacent_pointer_moves_without_crossing_buttons() {
        let mut queue = PendingCompositorMessageQueue::default();
        queue.push_urgent_input(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::PointerMove {
                x: 10,
                y: 20,
                modifiers: 1,
            },
        });
        queue.push_urgent_input(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::PointerMove {
                x: 30,
                y: 40,
                modifiers: 2,
            },
        });
        queue.push_urgent_input(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::PointerButton {
                x: 30,
                y: 40,
                button: 0,
                mouse_up: false,
                titlebar_drag_window_id: 0,
                modifiers: 2,
            },
        });
        queue.push_urgent_input(PendingCompositorMessage {
            snapshot_epoch: 0,
            msg: shell_wire::DecodedCompositorToShellMessage::PointerMove {
                x: 50,
                y: 60,
                modifiers: 0,
            },
        });

        let drained = queue.take_all();
        assert_eq!(drained.len(), 3);
        assert!(matches!(
            drained[0].msg,
            shell_wire::DecodedCompositorToShellMessage::PointerMove { x: 30, y: 40, .. }
        ));
        assert!(matches!(
            drained[1].msg,
            shell_wire::DecodedCompositorToShellMessage::PointerButton {
                mouse_up: false,
                ..
            }
        ));
        assert!(matches!(
            drained[2].msg,
            shell_wire::DecodedCompositorToShellMessage::PointerMove { x: 50, y: 60, .. }
        ));
    }
}
