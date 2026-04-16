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
    messages: Vec<shell_wire::DecodedCompositorToShellMessage>,
}

fn is_window_delta(msg: &shell_wire::DecodedCompositorToShellMessage) -> bool {
    matches!(
        msg,
        shell_wire::DecodedCompositorToShellMessage::WindowMapped { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowUnmapped { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowGeometry { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowMetadata { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowList { .. }
            | shell_wire::DecodedCompositorToShellMessage::WindowState { .. }
            | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
            | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. }
    )
}

fn push_pending_message(
    messages: &mut Vec<shell_wire::DecodedCompositorToShellMessage>,
    msg: shell_wire::DecodedCompositorToShellMessage,
) {
    match &msg {
        shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
        | shell_wire::DecodedCompositorToShellMessage::OutputLayout { .. }
        | shell_wire::DecodedCompositorToShellMessage::FocusChanged { .. }
        | shell_wire::DecodedCompositorToShellMessage::KeyboardLayout { .. }
        | shell_wire::DecodedCompositorToShellMessage::VolumeOverlay { .. }
        | shell_wire::DecodedCompositorToShellMessage::TrayHints { .. }
        | shell_wire::DecodedCompositorToShellMessage::TraySni { .. }
        | shell_wire::DecodedCompositorToShellMessage::WorkspaceState { .. } => {
            let keep = std::mem::discriminant(&msg);
            messages.retain(|pending| std::mem::discriminant(pending) != keep);
        }
        shell_wire::DecodedCompositorToShellMessage::WindowGeometry { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending,
                    shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowMetadata { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending,
                    shell_wire::DecodedCompositorToShellMessage::WindowMetadata {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowState { window_id, .. } => {
            messages.retain(|pending| {
                !matches!(
                    pending,
                    shell_wire::DecodedCompositorToShellMessage::WindowState {
                        window_id: pending_window_id,
                        ..
                    } if pending_window_id == window_id
                )
            });
        }
        shell_wire::DecodedCompositorToShellMessage::WindowList { .. } => {
            messages.retain(|pending| !is_window_delta(pending));
        }
        _ => {}
    }
    messages.push(msg);
}

wrap_task! {
    struct ApplyCompositorToShellTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
        pending_messages: Arc<Mutex<PendingCompositorMessages>>,
        pending_work: Arc<AtomicBool>,
    }

    impl Task {
        fn execute(&self) {
            loop {
                let messages = {
                    let Ok(mut guard) = self.pending_messages.lock() else {
                        return;
                    };
                    if guard.messages.is_empty() {
                        guard.scheduled = false;
                        self.pending_work.store(false, Ordering::Relaxed);
                        return;
                    }
                    std::mem::take(&mut guard.messages)
                };
                compositor_downlink::apply_messages(messages, &self.browser_holder, &self.view_state);
            }
        }
    }
}

wrap_task! {
    struct ExternalBeginFrameTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
    }

    impl Task {
        fn execute(&self) {
            let Ok(guard) = self.browser_holder.lock() else {
                return;
            };
            let Some(b) = guard.as_ref() else {
                return;
            };
            if let Some(host) = b.host() {
                host.send_external_begin_frame();
                crate::cef::begin_frame_diag::note_cef_ui_send_external_begin_frame();
            }
        }
    }
}

pub struct ShellToCefLink {
    browser_holder: Arc<Mutex<Option<Browser>>>,
    view_state: Arc<Mutex<OsrViewState>>,
    pending_messages: Arc<Mutex<PendingCompositorMessages>>,
    delivery_ready: Arc<AtomicBool>,
    pending_work: Arc<AtomicBool>,
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
            })),
            delivery_ready: Arc::new(AtomicBool::new(false)),
            pending_work: Arc::new(AtomicBool::new(false)),
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
        if let Ok(mut snapshot) = self.shared_snapshot.lock() {
            if let Some(snapshot) = snapshot.as_mut() {
                let _ = snapshot.apply_message(&msg);
            }
        }
        let should_post = {
            let Ok(mut guard) = self.pending_messages.lock() else {
                return;
            };
            push_pending_message(&mut guard.messages, msg);
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
        crate::cef::begin_frame_diag::note_schedule_from_compositor(kind);
        let mut task = ExternalBeginFrameTask::new(self.browser_holder.clone());
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }

    pub fn set_delivery_ready(&self, ready: bool) {
        self.delivery_ready.store(ready, Ordering::Relaxed);
        if ready {
            self.post_pending_messages();
        } else if let Ok(mut guard) = self.pending_messages.lock() {
            guard.scheduled = false;
        }
    }

    pub fn has_pending_shell_updates(&self) -> bool {
        self.pending_work.load(Ordering::Relaxed)
    }

    fn post_pending_messages(&self) {
        let mut task = ApplyCompositorToShellTask::new(
            self.browser_holder.clone(),
            self.view_state.clone(),
            self.pending_messages.clone(),
            self.pending_work.clone(),
        );
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            if let Ok(mut guard) = self.pending_messages.lock() {
                guard.scheduled = false;
            }
        }
    }
}
