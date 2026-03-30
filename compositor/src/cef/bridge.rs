use std::sync::{Arc, Mutex};

use cef::{post_task, wrap_task, rc::Rc, Browser, ImplTask, Task, ThreadId, WrapTask};

use smithay::reexports::calloop::channel::Sender;

use crate::cef::compositor_downlink;
use crate::cef::compositor_tx::CefToCompositor;
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

pub struct ShellToCefLink {
    browser_holder: Arc<Mutex<Option<Browser>>>,
    view_state: Arc<Mutex<OsrViewState>>,
    cef_tx: Sender<CefToCompositor>,
}

impl ShellToCefLink {
    pub fn new(
        browser_holder: Arc<Mutex<Option<Browser>>>,
        view_state: Arc<Mutex<OsrViewState>>,
        cef_tx: Sender<CefToCompositor>,
    ) -> Self {
        Self {
            browser_holder,
            view_state,
            cef_tx,
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
        if matches!(msg, shell_wire::DecodedCompositorToShellMessage::Ping) {
            let _ = self.cef_tx.send(CefToCompositor::ShellRxNote);
            return;
        }
        let mut task = ApplyCompositorToShellTask::new(
            self.browser_holder.clone(),
            self.view_state.clone(),
            msg,
        );
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }
}
