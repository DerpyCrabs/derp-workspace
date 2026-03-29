//! Letterboxing and pointer → OSR **buffer-pixel** mapping ([`crate::state::CompositorState`] / dma-buf overlay).

use smithay::utils::{Logical, Size};

/// Fit `buf_w`×`buf_h` inside `output_logical`, preserve aspect, center; returns output-local `(ox, oy, cw, ch)` in **logical** pixels.
pub(crate) fn letterbox_logical(
    output_logical: Size<i32, Logical>,
    buf_w: u32,
    buf_h: u32,
) -> Option<(i32, i32, i32, i32)> {
    if buf_w == 0 || buf_h == 0 {
        return None;
    }
    let ow = output_logical.w.max(1);
    let oh = output_logical.h.max(1);
    let bw = buf_w as f64;
    let bh = buf_h as f64;
    let s = (ow as f64 / bw).min(oh as f64 / bh);
    let cw = (bw * s).floor() as i32;
    let ch = (bh * s).floor() as i32;
    let cw = cw.max(1);
    let ch = ch.max(1);
    let ox = ow.saturating_sub(cw) / 2;
    let oy = oh.saturating_sub(ch) / 2;
    Some((ox, oy, cw, ch))
}

/// Normalized pointer inside the letterbox (0..1) → buffer pixel indices (inclusive of edges).
pub fn norm_to_buffer_px(nx: f64, ny: f64, buf_w: u32, buf_h: u32) -> (i32, i32) {
    let nx = nx.clamp(0.0, 1.0);
    let ny = ny.clamp(0.0, 1.0);
    let xmax = buf_w.saturating_sub(1) as f64;
    let ymax = buf_h.saturating_sub(1) as f64;
    let x = (nx * xmax).round() as i32;
    let y = (ny * ymax).round() as i32;
    let xi = buf_w.saturating_sub(1) as i32;
    let yi = buf_h.saturating_sub(1) as i32;
    (x.clamp(0, xi), y.clamp(0, yi))
}

/// Pointer in **output-local** logical coords relative to letterbox origin `(0,0)` at top-left of letterbox.
pub(crate) fn local_in_letterbox_to_buffer_px(
    lx: f64,
    ly: f64,
    cw_l: i32,
    ch_l: i32,
    buf_w: u32,
    buf_h: u32,
) -> Option<(i32, i32)> {
    let cw_f = cw_l.max(1) as f64;
    let ch_f = ch_l.max(1) as f64;
    if lx < 0.0 || ly < 0.0 || lx >= cw_f || ly >= ch_f {
        return None;
    }
    let x = ((lx / cw_f) * buf_w as f64).round() as i32;
    let y = ((ly / ch_f) * buf_h as f64).round() as i32;
    let xmax = buf_w.saturating_sub(1) as i32;
    let ymax = buf_h.saturating_sub(1) as i32;
    Some((x.clamp(0, xmax), y.clamp(0, ymax)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::utils::{Point, Rectangle};

    #[test]
    fn letterbox_preserves_buffer_aspect() {
        let out = Size::<i32, Logical>::from((800, 600));
        let (ox, oy, cw, ch) = letterbox_logical(out, 900, 600).unwrap();
        assert_eq!((ox, oy), (0, 33));
        assert_eq!((cw, ch), (800, 533));
        let ar_buf = 900.0 / 600.0;
        let ar_box = cw as f64 / ch as f64;
        assert!(
            (ar_buf - ar_box).abs() < 0.002,
            "ar_buf={ar_buf} ar_box={ar_box}"
        );
    }

    #[test]
    fn letterbox_fills_output_when_aspect_matches() {
        let out = Size::<i32, Logical>::from((1280, 720));
        let (ox, oy, cw, ch) = letterbox_logical(out, 1920, 1080).unwrap();
        assert_eq!((ox, oy, cw, ch), (0, 0, 1280, 720));
    }

    #[test]
    fn letterbox_with_larger_buffer_same_aspect() {
        let out = Size::<i32, Logical>::from((400, 300));
        let (ox, oy, cw, ch) = letterbox_logical(out, 600, 450).unwrap();
        assert_eq!((ox, oy, cw, ch), (0, 0, 400, 300));
    }

    #[test]
    fn norm_center_maps_to_buffer_center() {
        let (x, y) = norm_to_buffer_px(0.5, 0.5, 301, 201);
        assert_eq!((x, y), (150, 100));
    }

    #[test]
    fn local_center_round_trips_to_buffer_center() {
        let out = Size::<i32, Logical>::from((1000, 500));
        let (ox, oy, cw, ch) = letterbox_logical(out, 300, 200).unwrap();
        assert_eq!((ox, oy), (125, 0));
        let lx = cw as f64 * 0.5;
        let ly = ch as f64 * 0.5;
        let (bx, by) = local_in_letterbox_to_buffer_px(lx, ly, cw, ch, 300, 200).unwrap();
        assert_eq!((bx, by), (150, 100));
    }

    #[test]
    fn full_logical_rect_for_buffer_matches_dimensions() {
        let r = Rectangle::new(
            Point::<f64, Logical>::from((0.0, 0.0)),
            Size::<f64, Logical>::from((1200.0, 800.0)),
        );
        assert_eq!(r.loc.x, 0.0);
        assert_eq!(r.size.w, 1200.0);
        assert_eq!(r.size.h, 800.0);
    }

    #[test]
    fn normalized_pointer_pipeline_matches_buffer_to_view_math() {
        let dip_w = 800i32;
        let dip_h = 600i32;
        let buf_w = 1200u32;
        let buf_h = 900u32;
        let (bx, by) = norm_to_buffer_px(0.5, 0.5, buf_w, buf_h);
        assert_eq!((bx, by), (600, 450));
        let vx = ((bx as f64) * (dip_w as f64) / (buf_w as f64)).round() as i32;
        let vy = ((by as f64) * (dip_h as f64) / (buf_h as f64)).round() as i32;
        assert_eq!((vx, vy), (400, 300));
    }
}
