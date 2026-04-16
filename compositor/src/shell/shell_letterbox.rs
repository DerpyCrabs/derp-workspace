use smithay::utils::{Logical, Size};

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
    let cw = (bw * s).round().clamp(1.0, ow as f64) as i32;
    let ch = (bh * s).round().clamp(1.0, oh as f64) as i32;
    let ox = ow.saturating_sub(cw) / 2;
    let oy = oh.saturating_sub(ch) / 2;
    Some((ox, oy, cw, ch))
}

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
