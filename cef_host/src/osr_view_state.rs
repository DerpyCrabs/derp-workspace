//! OSR view / buffer sizes and compositor (**buffer** px) → CEF (**DIP**) mapping.

/// DIP (CSS / “view”) size of the browser plus last OSR paint dimensions.
///
/// CEF [`send_mouse_move_event`](cef::ImplBrowserHost::send_mouse_move_event) expects coordinates
/// in **view** space, while `on_paint` buffer sizes are **device** pixels
/// (`view * device_scale_factor`). The compositor maps pointer position into **buffer** pixels
/// (same space as the BGRA frame); we convert to view pixels here.
#[derive(Debug, Clone)]
pub struct OsrViewState {
    /// DIP / CSS width (matches CEF view and `WindowInfo::bounds`).
    pub dip_w: i32,
    /// DIP / CSS height.
    pub dip_h: i32,
    buffer_w: i32,
    buffer_h: i32,
}

impl OsrViewState {
    pub fn new(dip_w: i32, dip_h: i32) -> Self {
        Self {
            dip_w,
            dip_h,
            buffer_w: dip_w,
            buffer_h: dip_h,
        }
    }

    pub fn set_buffer_size(&mut self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            self.buffer_w = w;
            self.buffer_h = h;
        }
    }

    pub fn buffer_dimensions(&self) -> (i32, i32) {
        (self.buffer_w, self.buffer_h)
    }

    pub fn device_scale_factor(&self) -> f32 {
        (self.buffer_w as f32 / self.dip_w.max(1) as f32).max(0.01)
    }

    /// Map compositor / frame (**buffer**) coordinates to CEF mouse (**view / DIP**) coordinates.
    pub fn buffer_to_view(&self, bx: i32, by: i32) -> (i32, i32) {
        let bw = self.buffer_w.max(1) as f64;
        let bh = self.buffer_h.max(1) as f64;
        let vx = ((bx as f64) * (self.dip_w as f64) / bw).round() as i32;
        let vy = ((by as f64) * (self.dip_h as f64) / bh).round() as i32;
        let xmax = self.dip_w.saturating_sub(1).max(0);
        let ymax = self.dip_h.saturating_sub(1).max(0);
        (vx.clamp(0, xmax), vy.clamp(0, ymax))
    }
}

#[cfg(test)]
mod tests {
    use super::OsrViewState;

    #[test]
    fn device_scale_tracks_buffer_over_dip() {
        let mut s = OsrViewState::new(800, 600);
        s.set_buffer_size(1200, 900);
        assert!((s.device_scale_factor() - 1.5).abs() < 0.001);
    }

    #[test]
    fn buffer_to_view_scales_linearly() {
        let mut s = OsrViewState::new(800, 600);
        s.set_buffer_size(1200, 900);
        let (vx, vy) = s.buffer_to_view(600, 450);
        assert_eq!((vx, vy), (400, 300));
    }

    #[test]
    fn buffer_center_maps_to_view_center() {
        let mut s = OsrViewState::new(801, 601);
        s.set_buffer_size(801, 601);
        let (vx, vy) = s.buffer_to_view(400, 300);
        assert_eq!((vx, vy), (400, 300));
    }
}
