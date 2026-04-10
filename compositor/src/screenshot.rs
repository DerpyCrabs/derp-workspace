use std::path::PathBuf;

use image::{
    codecs::png::PngEncoder,
    imageops::{self, FilterType},
    ImageBuffer, ImageEncoder, Rgba, RgbaImage,
};
use smithay::{
    backend::allocator::Fourcc,
    backend::renderer::{
        gles::{GlesRenderer, GlesTarget},
        ExportMem, TextureMapping,
    },
    utils::{Buffer, Logical, Rectangle, Size, Transform},
};

#[derive(Clone)]
pub(crate) enum ScreenshotRequestKind {
    Output {
        output_name: String,
    },
    Region {
        logical_rect: Rectangle<i32, Logical>,
    },
}

pub(crate) struct CapturedOutputFrame {
    pub output_name: String,
    pub logical_rect: Rectangle<i32, Logical>,
    pub image: RgbaImage,
}

pub(crate) struct PendingScreenshotRequest {
    pub kind: ScreenshotRequestKind,
    remaining_outputs: Vec<String>,
    captured_outputs: Vec<CapturedOutputFrame>,
}

impl PendingScreenshotRequest {
    pub(crate) fn for_output(output_name: String) -> Self {
        Self {
            kind: ScreenshotRequestKind::Output {
                output_name: output_name.clone(),
            },
            remaining_outputs: vec![output_name],
            captured_outputs: Vec::new(),
        }
    }

    pub(crate) fn for_region(
        logical_rect: Rectangle<i32, Logical>,
        outputs: Vec<String>,
    ) -> Result<Self, String> {
        if outputs.is_empty() {
            return Err("screenshot region does not intersect any output".into());
        }
        Ok(Self {
            kind: ScreenshotRequestKind::Region { logical_rect },
            remaining_outputs: outputs,
            captured_outputs: Vec::new(),
        })
    }

    pub(crate) fn needs_output(&self, output_name: &str) -> bool {
        self.remaining_outputs
            .iter()
            .any(|name| name == output_name)
    }

    pub(crate) fn push_capture(&mut self, frame: CapturedOutputFrame) {
        self.remaining_outputs
            .retain(|name| name != frame.output_name.as_str());
        self.captured_outputs.push(frame);
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.remaining_outputs.is_empty()
    }

    pub(crate) fn finalize_image(&self) -> Result<RgbaImage, String> {
        match &self.kind {
            ScreenshotRequestKind::Output { output_name } => self
                .captured_outputs
                .iter()
                .find(|frame| frame.output_name == *output_name)
                .map(|frame| frame.image.clone())
                .ok_or_else(|| format!("missing screenshot capture for output {output_name}")),
            ScreenshotRequestKind::Region { logical_rect } => {
                compose_region_image(*logical_rect, &self.captured_outputs)
            }
        }
    }
}

pub(crate) fn capture_output_image(
    renderer: &mut GlesRenderer,
    framebuffer: &GlesTarget<'_>,
    buffer_size: Size<i32, Buffer>,
    transform: Transform,
) -> Result<RgbaImage, String> {
    let mapping = renderer
        .copy_framebuffer(
            framebuffer,
            Rectangle::from_size(buffer_size),
            Fourcc::Abgr8888,
        )
        .map_err(|e| format!("screenshot copy_framebuffer: {e}"))?;
    let bytes = renderer
        .map_texture(&mapping)
        .map_err(|e| format!("screenshot map_texture: {e}"))?
        .to_vec();
    let image = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(
        buffer_size.w as u32,
        buffer_size.h as u32,
        bytes,
    )
    .ok_or_else(|| "screenshot readback size mismatch".to_string())?;
    let _ = mapping.flipped();
    Ok(apply_transform(image, transform))
}

pub(crate) fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(out)
}

pub(crate) fn save_png(bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = screenshot_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create screenshot dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("system clock before epoch: {e}"))?
        .as_millis();
    let path = dir.join(format!("Screenshot-{stamp}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("write screenshot: {e}"))?;
    Ok(path)
}

fn screenshot_dir() -> Result<PathBuf, String> {
    let base = dirs::picture_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Pictures")))
        .ok_or_else(|| "unable to resolve Pictures directory".to_string())?;
    Ok(base.join("Screenshots"))
}

fn apply_transform(image: RgbaImage, transform: Transform) -> RgbaImage {
    match transform {
        Transform::Normal => image,
        Transform::_90 => imageops::rotate90(&image),
        Transform::_180 => imageops::rotate180(&image),
        Transform::_270 => imageops::rotate270(&image),
        Transform::Flipped => imageops::flip_horizontal(&image),
        Transform::Flipped90 => imageops::flip_horizontal(&imageops::rotate90(&image)),
        Transform::Flipped180 => imageops::flip_vertical(&image),
        Transform::Flipped270 => imageops::flip_vertical(&imageops::rotate90(&image)),
    }
}

fn compose_region_image(
    logical_rect: Rectangle<i32, Logical>,
    frames: &[CapturedOutputFrame],
) -> Result<RgbaImage, String> {
    if logical_rect.size.w <= 0 || logical_rect.size.h <= 0 {
        return Err("screenshot region must be non-empty".into());
    }
    if frames.is_empty() {
        return Err("no captured outputs available for screenshot region".into());
    }

    let mut scale_x = 1.0f64;
    let mut scale_y = 1.0f64;
    for frame in frames {
        let w = frame.logical_rect.size.w.max(1) as f64;
        let h = frame.logical_rect.size.h.max(1) as f64;
        scale_x = scale_x.max(frame.image.width() as f64 / w);
        scale_y = scale_y.max(frame.image.height() as f64 / h);
    }

    let final_w = ((logical_rect.size.w as f64) * scale_x).round().max(1.0) as u32;
    let final_h = ((logical_rect.size.h as f64) * scale_y).round().max(1.0) as u32;
    let mut out = RgbaImage::new(final_w, final_h);

    for frame in frames {
        let Some(intersection) = frame.logical_rect.intersection(logical_rect) else {
            continue;
        };
        let frame_scale_x = frame.image.width() as f64 / frame.logical_rect.size.w.max(1) as f64;
        let frame_scale_y = frame.image.height() as f64 / frame.logical_rect.size.h.max(1) as f64;
        let local_x = intersection.loc.x - frame.logical_rect.loc.x;
        let local_y = intersection.loc.y - frame.logical_rect.loc.y;
        let src_x = (local_x as f64 * frame_scale_x).round().max(0.0) as u32;
        let src_y = (local_y as f64 * frame_scale_y).round().max(0.0) as u32;
        let mut src_w = ((intersection.size.w as f64) * frame_scale_x)
            .round()
            .max(1.0) as u32;
        let mut src_h = ((intersection.size.h as f64) * frame_scale_y)
            .round()
            .max(1.0) as u32;
        let max_w = frame.image.width().saturating_sub(src_x);
        let max_h = frame.image.height().saturating_sub(src_y);
        src_w = src_w.min(max_w.max(1));
        src_h = src_h.min(max_h.max(1));

        let dst_x = ((intersection.loc.x - logical_rect.loc.x) as f64 * scale_x)
            .round()
            .max(0.0) as i64;
        let dst_y = ((intersection.loc.y - logical_rect.loc.y) as f64 * scale_y)
            .round()
            .max(0.0) as i64;
        let dst_w = ((intersection.size.w as f64) * scale_x).round().max(1.0) as u32;
        let dst_h = ((intersection.size.h as f64) * scale_y).round().max(1.0) as u32;

        let mut fragment = imageops::crop_imm(&frame.image, src_x, src_y, src_w, src_h).to_image();
        if fragment.width() != dst_w || fragment.height() != dst_h {
            fragment = imageops::resize(&fragment, dst_w, dst_h, FilterType::Triangle);
        }
        imageops::overlay(&mut out, &fragment, dst_x, dst_y);
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use smithay::utils::{Rectangle, Transform};

    #[test]
    fn applies_output_transform_to_capture() {
        let image = RgbaImage::from_fn(2, 2, |x, y| match (x, y) {
            (0, 0) => Rgba([1, 0, 0, 255]),
            (1, 0) => Rgba([2, 0, 0, 255]),
            (0, 1) => Rgba([3, 0, 0, 255]),
            _ => Rgba([4, 0, 0, 255]),
        });
        let rotated = apply_transform(image, Transform::_180);
        assert_eq!(rotated.get_pixel(0, 0).0, [4, 0, 0, 255]);
        assert_eq!(rotated.get_pixel(1, 0).0, [3, 0, 0, 255]);
        assert_eq!(rotated.get_pixel(0, 1).0, [2, 0, 0, 255]);
        assert_eq!(rotated.get_pixel(1, 1).0, [1, 0, 0, 255]);
    }

    #[test]
    fn composes_region_across_outputs() {
        let left = CapturedOutputFrame {
            output_name: "left".into(),
            logical_rect: Rectangle::new((0, 0).into(), (100, 100).into()),
            image: RgbaImage::from_pixel(100, 100, Rgba([255, 0, 0, 255])),
        };
        let right = CapturedOutputFrame {
            output_name: "right".into(),
            logical_rect: Rectangle::new((100, 0).into(), (100, 100).into()),
            image: RgbaImage::from_pixel(100, 100, Rgba([0, 0, 255, 255])),
        };
        let image = compose_region_image(
            Rectangle::new((50, 0).into(), (100, 100).into()),
            &[left, right],
        )
        .expect("compose region");
        assert_eq!(image.width(), 100);
        assert_eq!(image.height(), 100);
        assert_eq!(image.get_pixel(0, 50).0, [255, 0, 0, 255]);
        assert_eq!(image.get_pixel(99, 50).0, [0, 0, 255, 255]);
    }
}
