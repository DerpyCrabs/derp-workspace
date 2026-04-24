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
    messages: Vec<PendingCompositorMessage>,
    snapshot: Vec<PendingCompositorMessage>,
    snapshot_epoch: u64,
}

pub(crate) struct PendingCompositorMessage {
    pub(crate) snapshot_epoch: u64,
    pub(crate) msg: shell_wire::DecodedCompositorToShellMessage,
}

fn push_pending_message(
    messages: &mut Vec<PendingCompositorMessage>,
    pending_message: PendingCompositorMessage,
) {
    let msg = &pending_message.msg;
    match &msg {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
        | shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. }
        | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
        | shell_wire::DecodedCompositorToShellMessage::WindowOrder { .. }
        | shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. }
        | shell_wire::DecodedCompositorToShellMessage::VolumeOverlay { .. }
        | shell_wire::DecodedCompositorToShellMessage::TrayHints { .. }
        | shell_wire::DecodedCompositorToShellMessage::TraySni { .. }
        | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
        | shell_wire::DecodedCompositorToShellMessage::WorkspaceStateBinary { .. }
        | shell_wire::DecodedCompositorToShellMessage::ShellHostedAppState { .. }
        | shell_wire::DecodedCompositorToShellMessage::InteractionState { .. } => {
            let keep = std::mem::discriminant(msg);
            messages.retain(|pending| std::mem::discriminant(&pending.msg) != keep);
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending.msg,
                    shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == *window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending.msg,
                    shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == *window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending.msg,
                    shell_wire::DecodedCompositorToShellMessage::WindowState {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == *window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending.msg,
                    shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
                )
            });
        }
        _ => {}
    }
    messages.push(pending_message);
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
            let (messages, snapshot_messages, snapshot_epoch) = {
                let Ok(mut guard) = self.pending_messages.lock() else {
                    return;
                };
                if guard.messages.is_empty() && guard.snapshot.is_empty() {
                    guard.scheduled = false;
                    self.pending_work.store(false, Ordering::Relaxed);
                    return;
                }
                guard.scheduled = false;
                (
                    std::mem::take(&mut guard.messages),
                    std::mem::take(&mut guard.snapshot),
                    std::mem::take(&mut guard.snapshot_epoch),
                )
            };
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
            let should_repost = {
                let Ok(mut guard) = self.pending_messages.lock() else {
                    return;
                };
                if guard.messages.is_empty() && guard.snapshot.is_empty() {
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
                messages: Vec::new(),
                snapshot: Vec::new(),
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
                    push_pending_message(
                        &mut guard.snapshot,
                        PendingCompositorMessage {
                            snapshot_epoch: 0,
                            msg: snapshot_msg,
                        },
                    );
                }
            }
            if let Some(snapshot_epoch) = snapshot_epoch {
                guard.snapshot_epoch = guard.snapshot_epoch.max(snapshot_epoch);
            }
            push_pending_message(
                &mut guard.messages,
                PendingCompositorMessage {
                    snapshot_epoch: msg_epoch.unwrap_or_default(),
                    msg,
                },
            );
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
