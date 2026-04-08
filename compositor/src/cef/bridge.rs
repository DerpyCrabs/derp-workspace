use std::sync::{Arc, Mutex};

use cef::{
    post_task, wrap_task, rc::Rc, Browser, ImplBrowser, ImplBrowserHost, ImplTask, Task, ThreadId,
    WrapTask,
};

use crate::cef::compositor_downlink;
use crate::cef::osr_view_state::OsrViewState;

wrap_task! {
    struct ApplyCompositorToShellTask {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
        msg: shell_wire::DecodedCompositorToShellMessage,
    }

    impl Task {
        fn execute(&self) {
            compositor_downlink::apply_message(
                self.msg.clone(),
                &self.browser_holder,
                &self.view_state,
            );
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
}

impl ShellToCefLink {
    pub fn new(
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
    ) -> Self {
        Self {
            browser_holder,
            view_state,
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
        let mut task = ApplyCompositorToShellTask::new(
            self.browser_holder.clone(),
            self.view_state.clone(),
            msg,
        );
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }

    pub fn schedule_external_begin_frame(&self) {
        crate::cef::begin_frame_diag::note_schedule_from_compositor();
        let mut task = ExternalBeginFrameTask::new(self.browser_holder.clone());
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }
}
