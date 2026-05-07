use super::*;

pub(crate) struct CoreState {
    pub(crate) start_time: std::time::Instant,
    pub(crate) socket_name: OsString,
    pub(crate) display_handle: DisplayHandle,
    pub(crate) loop_signal: LoopSignal,
    pub(crate) loop_handle: LoopHandle<'static, CalloopData>,
    pub(crate) event_loop_stop: Arc<AtomicBool>,
}

impl CoreState {
    pub(crate) fn stop_event_loop(&self) {
        self.event_loop_stop.store(true, Ordering::Release);
        self.loop_signal.stop();
        self.loop_signal.wakeup();
    }

    pub(crate) fn socket_name(&self) -> &OsString {
        &self.socket_name
    }

    pub(crate) fn loop_signal(&self) -> LoopSignal {
        self.loop_signal.clone()
    }

    pub(crate) fn event_loop_stop_flag(&self) -> Arc<AtomicBool> {
        self.event_loop_stop.clone()
    }

    pub(crate) fn event_loop_should_stop(&self) -> bool {
        self.event_loop_stop.load(Ordering::Acquire)
    }
}
