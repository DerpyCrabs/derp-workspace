//! Default pointer bitmap from the Xcursor theme (`left_ptr` / …) or a small built-in arrow.

use smithay::{
    backend::renderer::element::memory::MemoryRenderBuffer,
    utils::{Rectangle, Size, Transform},
};

use crate::shell_overlay::SHELL_OSR_MEMORY_FOURCC;

/// Match CEf/shell path: **B,G,R,A** bytes per pixel for [`SHELL_OSR_MEMORY_FOURCC`] (see `apply_shell_frame_bgra`).
fn rgba_strip_to_shell_bgra(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let n = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if rgba.len() < n {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for px in rgba[..n].chunks_exact(4) {
        let r = px[0];
        let g = px[1];
        let b = px[2];
        let a = px[3];
        out.extend_from_slice(&[b, g, r, a]);
    }
    Some(out)
}

fn pick_image(images: &[xcursor::parser::Image]) -> Option<&xcursor::parser::Image> {
    if images.is_empty() {
        return None;
    }
    images
        .iter()
        .min_by_key(|img| (img.size as i32 - 32).abs())
        .or_else(|| images.iter().max_by_key(|img| img.width.saturating_mul(img.height)))
}

fn load_system_cursor() -> Option<(MemoryRenderBuffer, (i32, i32))> {
    let theme_name = std::env::var("XCURSOR_THEME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let theme = xcursor::CursorTheme::load(&theme_name);
    for icon in ["left_ptr", "default", "arrow"] {
        let path = theme.load_icon(icon)?;
        let data = std::fs::read(&path).ok()?;
        let images = xcursor::parser::parse_xcursor(&data)?;
        let img = pick_image(&images)?;
        let w = img.width as i32;
        let h = img.height as i32;
        if w <= 0 || h <= 0 {
            continue;
        }
        let bgra = rgba_strip_to_shell_bgra(img.width, img.height, &img.pixels_rgba)?;
        let mut buf = MemoryRenderBuffer::new(SHELL_OSR_MEMORY_FOURCC, (w, h), 1, Transform::Normal, None);
        {
            let mut ctx = buf.render();
            ctx.draw(|mem| {
                mem[..bgra.len()].copy_from_slice(&bgra);
                Result::<_, ()>::Ok(vec![Rectangle::from_size(Size::from((w, h)))])
            })
            .ok()?;
        }
        let xhot = img.xhot.min(img.width.saturating_sub(1)) as i32;
        let yhot = img.yhot.min(img.height.saturating_sub(1)) as i32;
        return Some((buf, (xhot, yhot)));
    }
    None
}

fn build_vector_fallback() -> (MemoryRenderBuffer, (i32, i32)) {
    const W: i32 = 24;
    const H: i32 = 24;
    let mut buf = MemoryRenderBuffer::new(SHELL_OSR_MEMORY_FOURCC, (W, H), 1, Transform::Normal, None);
    {
        let mut ctx = buf.render();
        ctx.draw(|mem| {
            mem.fill(0);
            let outline = [24u8, 24u8, 28u8, 255u8];
            let fill = [0xf8u8, 0xf8u8, 0xfcu8, 255u8];
            // Left stem
            for y in 0..17 {
                let i = ((y * W) * 4) as usize;
                mem[i..i + 4].copy_from_slice(&outline);
                if y >= 1 && y <= 15 {
                    let i2 = ((y * W + 1) * 4) as usize;
                    mem[i2..i2 + 4].copy_from_slice(&fill);
                }
            }
            // Diagonal bottom flare + hypotenuse
            for x in 1..12 {
                let y = x;
                if y >= H {
                    break;
                }
                let i = ((y * W + x) * 4) as usize;
                mem[i..i + 4].copy_from_slice(&outline);
                if x >= 2 && y + 1 < H {
                    let i2 = (((y + 1) * W + x) * 4) as usize;
                    mem[i2..i2 + 4].copy_from_slice(&fill);
                }
            }
            Result::<_, ()>::Ok(vec![Rectangle::from_size(Size::from((W, H)))])
        })
        .expect("builtin cursor fallback");
    }
    (buf, (0, 0))
}

pub fn load_cursor_fallback() -> (MemoryRenderBuffer, (i32, i32)) {
    if let Some(pair) = load_system_cursor() {
        return pair;
    }
    tracing::warn!(
        "cursor_fallback: no Xcursor icon (install icon theme or set XCURSOR_THEME); using builtin arrow"
    );
    build_vector_fallback()
}
