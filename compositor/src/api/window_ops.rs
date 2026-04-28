use crate::state::CompositorState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowLayoutMode {
    Floating,
    Maximized,
}

impl WindowLayoutMode {
    fn wire(self) -> u32 {
        match self {
            Self::Floating => 0,
            Self::Maximized => 1,
        }
    }
}

impl CompositorState {
    pub fn window_op_focus(&mut self, window_id: u32) {
        self.shell_activate_window(window_id);
    }

    pub fn window_op_close(&mut self, window_id: u32) {
        self.shell_close_window(window_id);
    }

    pub fn window_op_minimize(&mut self, window_id: u32) {
        self.shell_minimize_window(window_id);
    }

    pub fn window_op_set_fullscreen(&mut self, window_id: u32, enabled: bool) {
        self.shell_set_window_fullscreen(window_id, enabled);
    }

    pub fn window_op_set_maximized(&mut self, window_id: u32, enabled: bool) {
        self.shell_set_window_maximized(window_id, enabled);
    }

    pub fn window_op_set_geometry(
        &mut self,
        window_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        mode: WindowLayoutMode,
    ) {
        self.shell_set_window_geometry(window_id, x, y, w, h, mode.wire());
    }

    pub fn window_op_begin_move(&mut self, window_id: u32) {
        self.shell_move_begin_from_shell(window_id);
    }

    pub fn window_op_end_move(&mut self, window_id: u32) {
        self.shell_move_end(window_id);
    }

    pub fn window_op_begin_resize(&mut self, window_id: u32, edges: u32) {
        self.shell_resize_begin(window_id, edges);
    }

    pub fn window_op_resize_delta(&mut self, dx: i32, dy: i32) {
        self.shell_resize_delta(dx, dy);
    }

    pub fn window_op_end_resize(&mut self, window_id: u32) {
        self.shell_resize_end(window_id);
    }
}
