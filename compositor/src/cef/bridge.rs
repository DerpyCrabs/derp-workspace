use std::sync::{Arc, Mutex};

use cef::{
    post_task, rc::Rc, wrap_task, Browser, ImplBrowser, ImplBrowserHost, ImplTask, Task, ThreadId,
    WrapTask,
};

use crate::cef::compositor_downlink;
use crate::cef::osr_view_state::OsrViewState;

struct PendingCompositorMessages {
    scheduled: bool,
    messages: Vec<shell_wire::DecodedCompositorToShellMessage>,
}

fn push_pending_message(
    messages: &mut Vec<shell_wire::DecodedCompositorToShellMessage>,
    msg: shell_wire::DecodedCompositorToShellMessage,
) {
    if let shell_wire::DecodedCompositorToShellMessage::WindowGeometry {
        window_id,
        ..
    } = &msg
    {
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
    messages.push(msg);
}

wrap_task! {
    struct ApplyCompositorToShellTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
        pending_messages: Arc<Mutex<PendingCompositorMessages>>,
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
        let should_post = {
            let Ok(mut guard) = self.pending_messages.lock() else {
                return;
            };
            push_pending_message(&mut guard.messages, msg);
            if guard.scheduled {
                false
            } else {
                guard.scheduled = true;
                true
            }
        };
        if !should_post {
            return;
        }
        let mut task = ApplyCompositorToShellTask::new(
            self.browser_holder.clone(),
            self.view_state.clone(),
            self.pending_messages.clone(),
        );
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            if let Ok(mut guard) = self.pending_messages.lock() {
                guard.scheduled = false;
            }
        }
    }

    pub fn schedule_external_begin_frame(&self) {
        crate::cef::begin_frame_diag::note_schedule_from_compositor();
        let mut task = ExternalBeginFrameTask::new(self.browser_holder.clone());
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }
}
