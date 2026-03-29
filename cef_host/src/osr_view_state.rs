pub const OSR_BOOTSTRAP_LOGICAL_WIDTH: i32 = 800;
pub const OSR_BOOTSTRAP_LOGICAL_HEIGHT: i32 = 600;

#[derive(Debug, Clone)]
pub struct OsrViewState {
    pub logical_width: i32,
    pub logical_height: i32,
    physical_width: i32,
    physical_height: i32,
}

impl OsrViewState {
    pub fn new(logical_width: i32, logical_height: i32) -> Self {
        Self {
            logical_width,
            logical_height,
            physical_width: logical_width,
            physical_height: logical_height,
        }
    }

    pub fn new_bootstrap() -> Self {
        Self::new(OSR_BOOTSTRAP_LOGICAL_WIDTH, OSR_BOOTSTRAP_LOGICAL_HEIGHT)
    }

    pub fn set_physical_size(&mut self, w: i32, h: i32) {
        if w > 0 && h > 0 {
            self.physical_width = w;
            self.physical_height = h;
        }
    }

    pub fn physical_dimensions(&self) -> (i32, i32) {
        (self.physical_width, self.physical_height)
    }

    pub fn device_scale_factor(&self) -> f32 {
        (self.physical_width as f32 / self.logical_width.max(1) as f32).max(0.01)
    }

    pub fn physical_to_logical(&self, px: i32, py: i32) -> (i32, i32) {
        let pw = self.physical_width.max(1) as f64;
        let ph = self.physical_height.max(1) as f64;
        let vx = ((px as f64) * (self.logical_width as f64) / pw).round() as i32;
        let vy = ((py as f64) * (self.logical_height as f64) / ph).round() as i32;
        let xmax = self.logical_width.saturating_sub(1).max(0);
        let ymax = self.logical_height.saturating_sub(1).max(0);
        (vx.clamp(0, xmax), vy.clamp(0, ymax))
    }
}
