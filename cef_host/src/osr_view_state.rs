use std::time::{Duration, Instant};

pub const OSR_BOOTSTRAP_DIP_W: i32 = 800;
pub const OSR_BOOTSTRAP_DIP_H: i32 = 600;

#[derive(Debug, Clone)]
pub struct OsrViewState {
    pub dip_w: i32,
    pub dip_h: i32,
    buffer_w: i32,
    buffer_h: i32,
    target_buf_w: i32,
    target_buf_h: i32,
    last_undersized_nudge: Option<Instant>,
}

impl OsrViewState {
    pub fn new(dip_w: i32, dip_h: i32) -> Self {
        Self {
            dip_w,
            dip_h,
            buffer_w: dip_w,
            buffer_h: dip_h,
            target_buf_w: dip_w,
            target_buf_h: dip_h,
            last_undersized_nudge: None,
        }
    }

    pub fn new_bootstrap() -> Self {
        Self::new(OSR_BOOTSTRAP_DIP_W, OSR_BOOTSTRAP_DIP_H)
    }

    pub fn set_target_buffer(&mut self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            self.target_buf_w = w;
            self.target_buf_h = h;
        }
    }

    pub fn reset_undersized_nudge(&mut self) {
        self.last_undersized_nudge = None;
    }

    pub fn maybe_take_undersized_paint_nudge(
        &mut self,
        buf_w: i32,
        buf_h: i32,
        min_interval: Duration,
    ) -> bool {
        if self.dip_w <= 0 || self.dip_h <= 0 || buf_w <= 0 || buf_h <= 0 {
            return false;
        }
        let tw = self.target_buf_w.max(1);
        let th = self.target_buf_h.max(1);
        if buf_w * 100 >= tw * 97 && buf_h * 100 >= th * 97 {
            return false;
        }
        let now = Instant::now();
        if let Some(t) = self.last_undersized_nudge {
            if now.saturating_duration_since(t) < min_interval {
                return false;
            }
        }
        self.last_undersized_nudge = Some(now);
        true
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

    pub fn buffer_to_view(&self, bx: i32, by: i32) -> (i32, i32) {
        let bw = self.buffer_w.max(1) as f64;
        let bh = self.buffer_h.max(1) as f64;
        let vx = ((bx as f64) * (self.dip_w as f64) / bw).round() as i32;
        let vy = ((by as f64) * (self.dip_h as f64) / bh).round() as i32;
        let xmax = self.dip_w.saturating_sub(1).max(0);
        let ymax = self.dip_h.saturating_sub(1).max(0);
        (vx.clamp(0, xmax), vy.clamp(0, ymax))
    }

    pub fn view_to_buffer(&self, vx: i32, vy: i32) -> (i32, i32) {
        let bw = self.buffer_w.max(1) as f64;
        let bh = self.buffer_h.max(1) as f64;
        let dw = self.dip_w.max(1) as f64;
        let dh = self.dip_h.max(1) as f64;
        let bx = ((vx as f64) * bw / dw).round() as i32;
        let by = ((vy as f64) * bh / dh).round() as i32;
        let xmax = self.buffer_w.saturating_sub(1).max(0);
        let ymax = self.buffer_h.saturating_sub(1).max(0);
        (bx.clamp(0, xmax), by.clamp(0, ymax))
    }

    pub fn view_rect_to_buffer_rect(&self, vx: i32, vy: i32, vw: i32, vh: i32) -> (i32, i32, i32, i32) {
        let vw = vw.max(1);
        let vh = vh.max(1);
        let (bx0, by0) = self.view_to_buffer(vx, vy);
        let vx1 = vx + vw - 1;
        let vy1 = vy + vh - 1;
        let (bx1, by1) = self.view_to_buffer(vx1, vy1);
        let bww = (bx1 - bx0 + 1).max(1);
        let bhh = (by1 - by0 + 1).max(1);
        (bx0, by0, bww, bhh)
    }
}
