use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use smithay::{
    backend::{
        allocator::{dmabuf::Dmabuf, Buffer as AllocatorBuffer, Fourcc},
        renderer::{
            element::AsRenderElements,
            gles::{GlesRenderer, GlesTarget, GlesTexture},
            Bind, Blit, Frame, Offscreen, Renderer, TextureFilter,
        },
    },
    desktop::space::SpaceElement,
    output::Output,
    reexports::wayland_server::{
        backend::GlobalId,
        protocol::{wl_buffer::WlBuffer, wl_shm},
        Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, WEnum,
    },
    utils::{Buffer, Logical, Physical, Rectangle, Scale, Size, Transform},
    wayland::{
        dmabuf::get_dmabuf, foreign_toplevel_list::ForeignToplevelHandle,
        shm::with_buffer_contents_mut,
    },
};
use tracing::warn;
use wayland_protocols::ext::{
    image_capture_source::v1::server::{
        ext_foreign_toplevel_image_capture_source_manager_v1::{
            self, ExtForeignToplevelImageCaptureSourceManagerV1,
        },
        ext_image_capture_source_v1::{self, ExtImageCaptureSourceV1},
        ext_output_image_capture_source_manager_v1::{self, ExtOutputImageCaptureSourceManagerV1},
    },
    image_copy_capture::v1::server::{
        ext_image_copy_capture_frame_v1::{self, ExtImageCopyCaptureFrameV1},
        ext_image_copy_capture_manager_v1::{self, ExtImageCopyCaptureManagerV1},
        ext_image_copy_capture_session_v1::{self, ExtImageCopyCaptureSessionV1},
    },
};

use crate::{
    render::capture::{
        buffer_access_error, crop_capture_image, write_image_to_shm_buffer,
        CaptureSourceDescriptor, CaptureSourceKey,
    },
    state::{normalize_capture_dmabuf_format, CompositorState},
};

#[derive(Debug)]
pub(crate) struct ExtImageCaptureManagerState {
    _output_global: GlobalId,
    _toplevel_global: GlobalId,
    _copy_global: GlobalId,
}

#[derive(Debug, Clone)]
pub(crate) struct ImageCaptureSourceData {
    key: CaptureSourceKey,
}

#[derive(Debug)]
pub(crate) struct ImageCopyCaptureSessionState {
    source: CaptureSourceKey,
    frame_active: Arc<AtomicBool>,
    registered_for_full_damage: AtomicBool,
    buffer_size: Mutex<Size<i32, Buffer>>,
}

#[derive(Debug)]
pub(crate) struct ImageCopyCaptureFrameState {
    session: ExtImageCopyCaptureSessionV1,
    frame_active: Arc<AtomicBool>,
    inner: Mutex<ImageCopyCaptureFrameInner>,
}

#[derive(Debug, Default)]
struct ImageCopyCaptureFrameInner {
    buffer: Option<WlBuffer>,
    captured: bool,
}

#[derive(Debug, Clone)]
enum ValidatedCaptureBuffer {
    Shm(WlBuffer),
    Dmabuf(Dmabuf),
}

#[derive(Debug)]
pub(crate) struct PendingImageCopyCapture {
    frame: ExtImageCopyCaptureFrameV1,
    session: ExtImageCopyCaptureSessionV1,
    frame_active: Arc<AtomicBool>,
    window_id: Option<u32>,
    output_name: String,
    output_logical_rect: Rectangle<i32, Logical>,
    logical_region: Rectangle<i32, Logical>,
    buffer_size: Size<i32, Buffer>,
    buffer: ValidatedCaptureBuffer,
}

#[derive(Debug, Clone, Copy)]
struct CaptureWindowId(pub u32);

#[derive(Debug)]
struct ResolvedCaptureRequest {
    source: CaptureSourceDescriptor,
    window_id: Option<u32>,
    output_name: String,
    output_logical_rect: Rectangle<i32, Logical>,
    logical_region: Rectangle<i32, Logical>,
}

impl ExtImageCaptureManagerState {
    pub(crate) fn new<D>(display: &DisplayHandle) -> Self
    where
        D: GlobalDispatch<ExtOutputImageCaptureSourceManagerV1, ()>,
        D: Dispatch<ExtOutputImageCaptureSourceManagerV1, ()>,
        D: GlobalDispatch<ExtForeignToplevelImageCaptureSourceManagerV1, ()>,
        D: Dispatch<ExtForeignToplevelImageCaptureSourceManagerV1, ()>,
        D: Dispatch<ExtImageCaptureSourceV1, ImageCaptureSourceData>,
        D: GlobalDispatch<ExtImageCopyCaptureManagerV1, ()>,
        D: Dispatch<ExtImageCopyCaptureManagerV1, ()>,
        D: Dispatch<ExtImageCopyCaptureSessionV1, ImageCopyCaptureSessionState>,
        D: Dispatch<ExtImageCopyCaptureFrameV1, ImageCopyCaptureFrameState>,
        D: 'static,
    {
        let output_global =
            display.create_global::<D, ExtOutputImageCaptureSourceManagerV1, _>(1, ());
        let toplevel_global =
            display.create_global::<D, ExtForeignToplevelImageCaptureSourceManagerV1, _>(1, ());
        let copy_global = display.create_global::<D, ExtImageCopyCaptureManagerV1, _>(1, ());
        Self {
            _output_global: output_global,
            _toplevel_global: toplevel_global,
            _copy_global: copy_global,
        }
    }
}

impl CompositorState {
    pub(crate) fn process_ext_image_copy_capture_output_if_needed(
        &mut self,
        output: &Output,
        renderer: &mut GlesRenderer,
        framebuffer: &GlesTarget<'_>,
    ) {
        let output_name = output.name();
        let mut pending = std::mem::take(&mut self.pending_image_copy_captures);
        let mut matching = Vec::new();
        let mut remaining = Vec::with_capacity(pending.len());
        for request in pending.drain(..) {
            if request.output_name == output_name {
                matching.push(request);
            } else {
                remaining.push(request);
            }
        }
        self.pending_image_copy_captures = remaining;
        if matching.is_empty() {
            return;
        }

        let Some(output_source) = self.capture_output_source(output) else {
            for request in matching {
                stop_or_fail_image_copy_request(request);
            }
            return;
        };

        let image = if matching
            .iter()
            .any(|request| matches!(&request.buffer, ValidatedCaptureBuffer::Shm(_)))
        {
            match crate::render::screenshot::capture_output_image(
                renderer,
                framebuffer,
                output_source.buffer_size,
                output.current_transform(),
            ) {
                Ok(image) => Some(image),
                Err(error) => {
                    warn!(%error, output = %output_name, "ext image copy capture failed");
                    for request in matching {
                        fail_image_copy_request(
                            request,
                            ext_image_copy_capture_frame_v1::FailureReason::Unknown,
                        );
                    }
                    return;
                }
            }
        } else {
            None
        };

        for request in matching {
            if !request.frame.is_alive() {
                request.frame_active.store(false, Ordering::Release);
                continue;
            }
            let window_id = request.window_id;
            let write_result = match request.buffer.clone() {
                ValidatedCaptureBuffer::Shm(buffer) => match window_id {
                    Some(window_id) => render_window_capture_image(
                        self,
                        renderer,
                        window_id,
                        &request.output_name,
                        request.output_logical_rect,
                        request.logical_region,
                        request.buffer_size,
                    )
                    .and_then(|rendered| write_image_to_shm_buffer(&buffer, &rendered)),
                    None => {
                        let Some(image) = image.as_ref() else {
                            fail_image_copy_request(
                                request,
                                ext_image_copy_capture_frame_v1::FailureReason::Unknown,
                            );
                            continue;
                        };
                        let cropped = match crop_capture_image(
                            image,
                            request.output_logical_rect,
                            request.logical_region,
                        ) {
                            Ok(cropped) => cropped,
                            Err(error) => {
                                warn!(%error, output = %output_name, "ext image copy crop failed");
                                fail_image_copy_request(
                                    request,
                                    ext_image_copy_capture_frame_v1::FailureReason::Unknown,
                                );
                                continue;
                            }
                        };
                        write_image_to_shm_buffer(&buffer, &cropped)
                    }
                },
                ValidatedCaptureBuffer::Dmabuf(mut dmabuf) => match window_id {
                    Some(window_id) => render_window_to_dmabuf(
                        self,
                        renderer,
                        window_id,
                        &request.output_name,
                        request.output_logical_rect,
                        request.logical_region,
                        request.buffer_size,
                        &mut dmabuf,
                    ),
                    None => write_output_to_dmabuf(
                        renderer,
                        framebuffer,
                        output_source.buffer_size,
                        request.output_logical_rect,
                        request.logical_region,
                        &mut dmabuf,
                    ),
                },
            };
            if let Err(error) = write_result {
                warn!(%error, output = %output_name, "ext image copy write failed");
                fail_image_copy_request(
                    request,
                    ext_image_copy_capture_frame_v1::FailureReason::BufferConstraints,
                );
                continue;
            }
            let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(now) => now,
                Err(error) => {
                    warn!(?error, output = %output_name, "ext image copy timestamp failed");
                    fail_image_copy_request(
                        request,
                        ext_image_copy_capture_frame_v1::FailureReason::Unknown,
                    );
                    continue;
                }
            };
            request.frame.transform(Transform::Normal.into());
            request
                .frame
                .damage(0, 0, request.buffer_size.w, request.buffer_size.h);
            request.frame.presentation_time(
                (now.as_secs() >> 32) as u32,
                now.as_secs() as u32,
                now.subsec_nanos(),
            );
            request.frame.ready();
            request.frame_active.store(false, Ordering::Release);
        }
    }

    pub(crate) fn capture_source_descriptor(
        &self,
        key: &CaptureSourceKey,
    ) -> Option<CaptureSourceDescriptor> {
        match key {
            CaptureSourceKey::Output(output_name) => self
                .space
                .outputs()
                .find(|output| output.name() == *output_name)
                .and_then(|output| self.capture_output_source(output)),
            CaptureSourceKey::Window(window_id) => {
                self.capture_window_source_descriptor(*window_id)
            }
        }
    }

    fn resolve_image_copy_request(&self, key: &CaptureSourceKey) -> Option<ResolvedCaptureRequest> {
        let source = self.capture_source_descriptor(key)?;
        match &source.key {
            CaptureSourceKey::Output(_) => Some(ResolvedCaptureRequest {
                output_name: source.output_name.clone(),
                output_logical_rect: source.logical_rect,
                logical_region: source.logical_rect,
                window_id: None,
                source,
            }),
            CaptureSourceKey::Window(window_id) => {
                let output = self
                    .space
                    .outputs()
                    .find(|output| output.name() == source.output_name)?;
                let output_source = self.capture_output_source(output)?;
                Some(ResolvedCaptureRequest {
                    output_name: output_source.output_name.clone(),
                    output_logical_rect: output_source.logical_rect,
                    logical_region: source.logical_rect,
                    window_id: Some(*window_id),
                    source,
                })
            }
        }
    }
}

fn stop_or_fail_image_copy_request(request: PendingImageCopyCapture) {
    if request.session.is_alive() {
        request.session.stopped();
    }
    if request.frame.is_alive() {
        request
            .frame
            .failed(ext_image_copy_capture_frame_v1::FailureReason::Stopped);
    }
    request.frame_active.store(false, Ordering::Release);
}

fn fail_image_copy_request(
    request: PendingImageCopyCapture,
    reason: ext_image_copy_capture_frame_v1::FailureReason,
) {
    if request.frame.is_alive() {
        request.frame.failed(reason);
    }
    request.frame_active.store(false, Ordering::Release);
}

fn release_image_copy_session(state: &mut CompositorState, data: &ImageCopyCaptureSessionState) {
    if data
        .registered_for_full_damage
        .swap(false, Ordering::AcqRel)
        && state.active_image_copy_capture_sessions > 0
    {
        state.active_image_copy_capture_sessions -= 1;
    }
}

fn send_session_constraints(
    state: &CompositorState,
    session: &ExtImageCopyCaptureSessionV1,
    data: &ImageCopyCaptureSessionState,
    descriptor: &CaptureSourceDescriptor,
) {
    if let Ok(mut size) = data.buffer_size.lock() {
        *size = descriptor.buffer_size;
    }
    session.shm_format(wl_shm::Format::Xrgb8888.into());
    if let Some(device) = state.capture_dmabuf_device {
        session.dmabuf_device(device.to_ne_bytes().to_vec());
        let mut formats: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        for format in &state.capture_dmabuf_formats {
            formats
                .entry(format.code as u32)
                .or_default()
                .extend_from_slice(&u64::from(format.modifier).to_ne_bytes());
        }
        for (code, modifiers) in formats {
            session.dmabuf_format(code, modifiers);
        }
    }
    session.buffer_size(
        descriptor.buffer_size.w as u32,
        descriptor.buffer_size.h as u32,
    );
    session.done();
}

fn validate_ext_buffer(
    state: &CompositorState,
    buffer: &WlBuffer,
    expected_size: Size<i32, Buffer>,
) -> Result<ValidatedCaptureBuffer, String> {
    if let Ok(dmabuf) = get_dmabuf(buffer) {
        let dmabuf = dmabuf.clone();
        let actual = AllocatorBuffer::size(&dmabuf);
        let format = normalize_capture_dmabuf_format(AllocatorBuffer::format(&dmabuf));
        if actual != expected_size {
            return Err(
                "ext image copy buffer dimensions do not match advertised size".to_string(),
            );
        }
        if !state.capture_dmabuf_formats.contains(&format) {
            return Err("ext image copy dmabuf format is not advertised".to_string());
        }
        return Ok(ValidatedCaptureBuffer::Dmabuf(dmabuf));
    }
    with_buffer_contents_mut(buffer, |_, _, meta| {
        if meta.format != wl_shm::Format::Xrgb8888 {
            return Err("ext image copy requires wl_shm Xrgb8888".to_string());
        }
        if meta.width <= 0 || meta.height <= 0 {
            return Err("ext image copy buffer dimensions must be positive".to_string());
        }
        let actual = Size::from((meta.width, meta.height));
        if actual != expected_size {
            return Err(
                "ext image copy buffer dimensions do not match advertised size".to_string(),
            );
        }
        if meta.stride < meta.width * 4 {
            return Err("ext image copy buffer stride is too small".to_string());
        }
        Ok(ValidatedCaptureBuffer::Shm(buffer.clone()))
    })
    .map_err(buffer_access_error)?
}

fn capture_region_buffer_rect(
    output_buffer_size: Size<i32, Buffer>,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
) -> Rectangle<i32, Physical> {
    if capture_rect == output_rect {
        return Rectangle::new(
            (0, 0).into(),
            (output_buffer_size.w, output_buffer_size.h).into(),
        );
    }
    let scale_x = output_buffer_size.w as f64 / output_rect.size.w.max(1) as f64;
    let scale_y = output_buffer_size.h as f64 / output_rect.size.h.max(1) as f64;
    let local_x = capture_rect.loc.x - output_rect.loc.x;
    let local_y = capture_rect.loc.y - output_rect.loc.y;
    let src_x = (local_x as f64 * scale_x).round().max(0.0) as i32;
    let src_y = (local_y as f64 * scale_y).round().max(0.0) as i32;
    let src_w = ((capture_rect.size.w as f64) * scale_x).round().max(1.0) as i32;
    let src_h = ((capture_rect.size.h as f64) * scale_y).round().max(1.0) as i32;
    let src_w = src_w.min((output_buffer_size.w - src_x).max(1));
    let src_h = src_h.min((output_buffer_size.h - src_y).max(1));
    Rectangle::new((src_x, src_y).into(), (src_w, src_h).into())
}

fn write_output_to_dmabuf(
    renderer: &mut GlesRenderer,
    framebuffer: &GlesTarget<'_>,
    output_buffer_size: Size<i32, Buffer>,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
    dmabuf: &mut Dmabuf,
) -> Result<(), String> {
    let src = capture_region_buffer_rect(output_buffer_size, output_rect, capture_rect);
    let dst_size = AllocatorBuffer::size(dmabuf);
    let dst = Rectangle::new((0, 0).into(), (dst_size.w, dst_size.h).into());
    let mut target = renderer.bind(dmabuf).map_err(|error| error.to_string())?;
    renderer
        .blit(framebuffer, &mut target, src, dst, TextureFilter::Linear)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn render_window_output_texture(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    window_id: u32,
    output_name: &str,
) -> Result<
    (
        GlesTexture,
        Size<i32, Buffer>,
        Rectangle<i32, Logical>,
        Option<Rectangle<i32, Physical>>,
    ),
    String,
> {
    let output = state
        .space
        .outputs()
        .find(|output| output.name() == output_name)
        .ok_or_else(|| "capture output is no longer available".to_string())?;
    let output_source = state
        .capture_output_source(&output)
        .ok_or_else(|| "capture output source is no longer available".to_string())?;
    let elements: Vec<_> =
        crate::render::derp_space_render::derp_space_render_elements_with_window_ids(
            &state.space,
            state,
            renderer,
            &output,
            1.0,
        )
        .into_iter()
        .filter_map(|(el, wid, _)| (wid == Some(window_id)).then_some(el))
        .collect();
    let rendered_bounds = state
        .capture_window_source_descriptor(window_id)
        .and_then(|source| {
            (source.output_name == output_name)
                .then_some(source.logical_rect)
                .and_then(|logical_rect| logical_rect.intersection(output_source.logical_rect))
        })
        .map(|visible_logical_rect| {
            capture_region_buffer_rect(
                output_source.buffer_size,
                output_source.logical_rect,
                visible_logical_rect,
            )
        });
    let mut offscreen: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, output_source.buffer_size)
        .map_err(|error| error.to_string())?;
    {
        let mut target = renderer
            .bind(&mut offscreen)
            .map_err(|error| error.to_string())?;
        let target_size =
            Size::<i32, Physical>::from((output_source.buffer_size.w, output_source.buffer_size.h));
        let damage = [Rectangle::from_size(target_size)];
        let render_scale = output.current_scale().fractional_scale();
        let mut frame = renderer
            .render(&mut target, target_size, Transform::Normal)
            .map_err(|error| error.to_string())?;
        frame
            .clear([0.0, 0.0, 0.0, 0.0].into(), &damage)
            .map_err(|error| error.to_string())?;
        smithay::backend::renderer::utils::draw_render_elements(
            &mut frame,
            render_scale,
            &elements,
            &damage,
        )
        .map_err(|error| error.to_string())?;
        let _ = frame.finish().map_err(|error| error.to_string())?;
    }
    Ok((
        offscreen,
        output_source.buffer_size,
        output_source.logical_rect,
        rendered_bounds,
    ))
}

fn blit_capture_region_to_target(
    renderer: &mut GlesRenderer,
    source: &GlesTarget<'_>,
    output_buffer_size: Size<i32, Buffer>,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
    rendered_bounds: Option<Rectangle<i32, Physical>>,
    target: &mut GlesTarget<'_>,
    target_size: Size<i32, Buffer>,
) -> Result<(), String> {
    clear_capture_target(renderer, target, target_size)?;
    let Some((src, dst)) = capture_blit_rects(
        output_buffer_size,
        output_rect,
        capture_rect,
        rendered_bounds,
        target_size,
    ) else {
        return Ok(());
    };
    renderer
        .blit(source, target, src, dst, TextureFilter::Nearest)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn clear_capture_target(
    renderer: &mut GlesRenderer,
    target: &mut GlesTarget<'_>,
    target_size: Size<i32, Buffer>,
) -> Result<(), String> {
    let physical_size = Size::<i32, Physical>::from((target_size.w.max(1), target_size.h.max(1)));
    let damage = [Rectangle::from_size(physical_size)];
    let mut frame = renderer
        .render(target, physical_size, Transform::Normal)
        .map_err(|error| error.to_string())?;
    frame
        .clear([0.0, 0.0, 0.0, 0.0].into(), &damage)
        .map_err(|error| error.to_string())?;
    let _ = frame.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn capture_blit_rects(
    output_buffer_size: Size<i32, Buffer>,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
    rendered_bounds: Option<Rectangle<i32, Physical>>,
    target_size: Size<i32, Buffer>,
) -> Option<(Rectangle<i32, Physical>, Rectangle<i32, Physical>)> {
    let capture_src = capture_region_buffer_rect(output_buffer_size, output_rect, capture_rect);
    let dst = Rectangle::new(
        (0, 0).into(),
        (target_size.w.max(1), target_size.h.max(1)).into(),
    );
    match rendered_bounds {
        Some(bounds) => {
            let src = intersect_physical_rect(bounds, capture_src)?;
            if src == capture_src {
                Some((src, dst))
            } else {
                Some((
                    src,
                    map_capture_src_to_target(capture_src, src, target_size),
                ))
            }
        }
        None => Some((capture_src, dst)),
    }
}

fn intersect_physical_rect(
    bounds: Rectangle<i32, Physical>,
    capture_src: Rectangle<i32, Physical>,
) -> Option<Rectangle<i32, Physical>> {
    let left = bounds.loc.x.max(capture_src.loc.x);
    let top = bounds.loc.y.max(capture_src.loc.y);
    let right = (bounds.loc.x + bounds.size.w).min(capture_src.loc.x + capture_src.size.w);
    let bottom = (bounds.loc.y + bounds.size.h).min(capture_src.loc.y + capture_src.size.h);
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rectangle::new(
        (left, top).into(),
        (right - left, bottom - top).into(),
    ))
}

fn map_capture_src_to_target(
    capture_src: Rectangle<i32, Physical>,
    src: Rectangle<i32, Physical>,
    target_size: Size<i32, Buffer>,
) -> Rectangle<i32, Physical> {
    let capture_width = capture_src.size.w.max(1) as f64;
    let capture_height = capture_src.size.h.max(1) as f64;
    let target_width = target_size.w.max(1) as f64;
    let target_height = target_size.h.max(1) as f64;
    let src_left = (src.loc.x - capture_src.loc.x).max(0) as f64;
    let src_top = (src.loc.y - capture_src.loc.y).max(0) as f64;
    let src_right = (src.loc.x + src.size.w - capture_src.loc.x).max(0) as f64;
    let src_bottom = (src.loc.y + src.size.h - capture_src.loc.y).max(0) as f64;
    let dst_left = ((src_left / capture_width) * target_width).round() as i32;
    let dst_top = ((src_top / capture_height) * target_height).round() as i32;
    let dst_right = ((src_right / capture_width) * target_width).round() as i32;
    let dst_bottom = ((src_bottom / capture_height) * target_height).round() as i32;
    let max_width = target_size.w.max(1);
    let max_height = target_size.h.max(1);
    let left = dst_left.clamp(0, max_width - 1);
    let top = dst_top.clamp(0, max_height - 1);
    let right = dst_right.max(left + 1).min(max_width);
    let bottom = dst_bottom.max(top + 1).min(max_height);
    Rectangle::new((left, top).into(), (right - left, bottom - top).into())
}

fn render_window_capture_image(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    window_id: u32,
    output_name: &str,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
    buffer_size: Size<i32, Buffer>,
) -> Result<image::RgbaImage, String> {
    let (mut source_offscreen, output_buffer_size, output_logical_rect, rendered_bounds) =
        render_window_output_texture(state, renderer, window_id, output_name)?;
    let source = renderer
        .bind(&mut source_offscreen)
        .map_err(|error| error.to_string())?;
    if output_buffer_size == buffer_size
        && output_logical_rect == output_rect
        && output_rect == capture_rect
    {
        return crate::render::screenshot::capture_output_image(
            renderer,
            &source,
            output_buffer_size,
            Transform::Normal,
        );
    }
    let mut cropped: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, buffer_size)
        .map_err(|error| error.to_string())?;
    let mut target = renderer
        .bind(&mut cropped)
        .map_err(|error| error.to_string())?;
    blit_capture_region_to_target(
        renderer,
        &source,
        output_buffer_size,
        output_rect,
        capture_rect,
        rendered_bounds,
        &mut target,
        buffer_size,
    )?;
    crate::render::screenshot::capture_output_image(
        renderer,
        &target,
        buffer_size,
        Transform::Normal,
    )
}

pub(crate) fn capture_window_preview_png(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    window_id: u32,
) -> Result<Vec<u8>, String> {
    let image = render_window_preview_image_direct(state, renderer, window_id)?;
    crate::render::screenshot::encode_png(&image)
}

fn render_window_preview_image_direct(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    window_id: u32,
) -> Result<image::RgbaImage, String> {
    let source = state
        .capture_window_source_descriptor(window_id)
        .ok_or_else(|| format!("missing capture source for window {window_id}"))?;
    let output = state
        .space
        .outputs()
        .find(|output| output.name() == source.output_name)
        .ok_or_else(|| "capture output is no longer available".to_string())?;
    let render_scale = output.current_scale().fractional_scale();
    let scale = Scale::from(render_scale);
    let elem = state
        .space
        .elements()
        .find(|elem| state.derp_elem_window_id(elem) == Some(window_id))
        .cloned()
        .ok_or_else(|| "capture window is no longer mapped".to_string())?;
    let map_loc = state
        .space
        .element_location(&elem)
        .ok_or_else(|| "capture window location is unavailable".to_string())?;
    let render_origin = map_loc - elem.geometry().loc;
    let location = (render_origin - source.logical_rect.loc).to_physical_precise_round(scale);
    let elements = AsRenderElements::<GlesRenderer>::render_elements::<
        crate::render::derp_space_render::DerpWinRenderEl,
    >(&elem, renderer, location, scale, 1.0);
    let mut offscreen: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, source.buffer_size)
        .map_err(|error| error.to_string())?;
    {
        let mut target = renderer
            .bind(&mut offscreen)
            .map_err(|error| error.to_string())?;
        let target_size = Size::<i32, Physical>::from((source.buffer_size.w, source.buffer_size.h));
        let damage = [Rectangle::from_size(target_size)];
        let mut frame = renderer
            .render(&mut target, target_size, Transform::Normal)
            .map_err(|error| error.to_string())?;
        frame
            .clear([0.0, 0.0, 0.0, 0.0].into(), &damage)
            .map_err(|error| error.to_string())?;
        smithay::backend::renderer::utils::draw_render_elements(
            &mut frame,
            render_scale,
            &elements,
            &damage,
        )
        .map_err(|error| error.to_string())?;
        let _ = frame.finish().map_err(|error| error.to_string())?;
    }
    let target = renderer
        .bind(&mut offscreen)
        .map_err(|error| error.to_string())?;
    crate::render::screenshot::capture_output_image(
        renderer,
        &target,
        source.buffer_size,
        Transform::Normal,
    )
}

fn render_window_to_dmabuf(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    window_id: u32,
    output_name: &str,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
    buffer_size: Size<i32, Buffer>,
    dmabuf: &mut Dmabuf,
) -> Result<(), String> {
    let (mut source_offscreen, output_buffer_size, _, rendered_bounds) =
        render_window_output_texture(state, renderer, window_id, output_name)?;
    let source = renderer
        .bind(&mut source_offscreen)
        .map_err(|error| error.to_string())?;
    let mut target = renderer.bind(dmabuf).map_err(|error| error.to_string())?;
    blit_capture_region_to_target(
        renderer,
        &source,
        output_buffer_size,
        output_rect,
        capture_rect,
        rendered_bounds,
        &mut target,
        buffer_size,
    )
}

impl GlobalDispatch<ExtOutputImageCaptureSourceManagerV1, (), CompositorState>
    for ExtImageCaptureManagerState
{
    fn bind(
        _state: &mut CompositorState,
        _display: &DisplayHandle,
        _client: &Client,
        resource: New<ExtOutputImageCaptureSourceManagerV1>,
        _global_data: &(),
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ExtOutputImageCaptureSourceManagerV1, (), CompositorState>
    for ExtImageCaptureManagerState
{
    fn request(
        _state: &mut CompositorState,
        _client: &Client,
        _resource: &ExtOutputImageCaptureSourceManagerV1,
        request: ext_output_image_capture_source_manager_v1::Request,
        _data: &(),
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_output_image_capture_source_manager_v1::Request::CreateSource {
                source,
                output,
            } => {
                let key = Output::from_resource(&output)
                    .map(|output| CaptureSourceKey::Output(output.name()))
                    .unwrap_or_else(|| CaptureSourceKey::Output(String::new()));
                data_init.init(source, ImageCaptureSourceData { key });
            }
            ext_output_image_capture_source_manager_v1::Request::Destroy => {}
            _ => {}
        }
    }
}

impl GlobalDispatch<ExtForeignToplevelImageCaptureSourceManagerV1, (), CompositorState>
    for ExtImageCaptureManagerState
{
    fn bind(
        _state: &mut CompositorState,
        _display: &DisplayHandle,
        _client: &Client,
        resource: New<ExtForeignToplevelImageCaptureSourceManagerV1>,
        _global_data: &(),
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ExtForeignToplevelImageCaptureSourceManagerV1, (), CompositorState>
    for ExtImageCaptureManagerState
{
    fn request(
        _state: &mut CompositorState,
        _client: &Client,
        _resource: &ExtForeignToplevelImageCaptureSourceManagerV1,
        request: ext_foreign_toplevel_image_capture_source_manager_v1::Request,
        _data: &(),
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_foreign_toplevel_image_capture_source_manager_v1::Request::CreateSource {
                source,
                toplevel_handle,
            } => {
                let key = ForeignToplevelHandle::from_resource(&toplevel_handle)
                    .and_then(|handle| handle.user_data().get::<CaptureWindowId>().copied())
                    .map(|window_id| CaptureSourceKey::Window(window_id.0))
                    .unwrap_or(CaptureSourceKey::Window(0));
                data_init.init(source, ImageCaptureSourceData { key });
            }
            ext_foreign_toplevel_image_capture_source_manager_v1::Request::Destroy => {}
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCaptureSourceV1, ImageCaptureSourceData, CompositorState>
    for ExtImageCaptureManagerState
{
    fn request(
        _state: &mut CompositorState,
        _client: &Client,
        _resource: &ExtImageCaptureSourceV1,
        request: ext_image_capture_source_v1::Request,
        _data: &ImageCaptureSourceData,
        _display: &DisplayHandle,
        _data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_image_capture_source_v1::Request::Destroy => {}
            _ => {}
        }
    }
}

impl GlobalDispatch<ExtImageCopyCaptureManagerV1, (), CompositorState>
    for ExtImageCaptureManagerState
{
    fn bind(
        _state: &mut CompositorState,
        _display: &DisplayHandle,
        _client: &Client,
        resource: New<ExtImageCopyCaptureManagerV1>,
        _global_data: &(),
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ExtImageCopyCaptureManagerV1, (), CompositorState> for ExtImageCaptureManagerState {
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &ExtImageCopyCaptureManagerV1,
        request: ext_image_copy_capture_manager_v1::Request,
        _data: &(),
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_image_copy_capture_manager_v1::Request::CreateSession {
                session,
                source,
                options,
            } => {
                let Some(source_data) = source.data::<ImageCaptureSourceData>().cloned() else {
                    resource.post_error(
                        ext_image_copy_capture_manager_v1::Error::InvalidOption,
                        "missing image capture source".to_string(),
                    );
                    return;
                };
                match options {
                    WEnum::Value(value)
                        if value.bits()
                            & !ext_image_copy_capture_manager_v1::Options::PaintCursors.bits()
                            == 0 => {}
                    _ => {
                        resource.post_error(
                            ext_image_copy_capture_manager_v1::Error::InvalidOption,
                            "invalid image copy capture options".to_string(),
                        );
                        return;
                    }
                }
                let session_data = ImageCopyCaptureSessionState {
                    source: source_data.key,
                    frame_active: Arc::new(AtomicBool::new(false)),
                    registered_for_full_damage: AtomicBool::new(true),
                    buffer_size: Mutex::new(Size::from((1, 1))),
                };
                state.active_image_copy_capture_sessions += 1;
                let session = data_init.init(session, session_data);
                if let Some(data) = session.data::<ImageCopyCaptureSessionState>() {
                    if let Some(descriptor) = state.capture_source_descriptor(&data.source) {
                        send_session_constraints(state, &session, data, &descriptor);
                    } else {
                        release_image_copy_session(state, data);
                        session.stopped();
                    }
                }
            }
            ext_image_copy_capture_manager_v1::Request::Destroy => {}
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureSessionV1, ImageCopyCaptureSessionState, CompositorState>
    for ExtImageCaptureManagerState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &ExtImageCopyCaptureSessionV1,
        request: ext_image_copy_capture_session_v1::Request,
        data: &ImageCopyCaptureSessionState,
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_image_copy_capture_session_v1::Request::CreateFrame { frame } => {
                if data.frame_active.swap(true, Ordering::AcqRel) {
                    resource.post_error(
                        ext_image_copy_capture_session_v1::Error::DuplicateFrame,
                        "image copy capture frame already exists".to_string(),
                    );
                    return;
                }
                let Some(descriptor) = state.capture_source_descriptor(&data.source) else {
                    resource.stopped();
                    data.frame_active.store(false, Ordering::Release);
                    return;
                };
                let needs_update = data
                    .buffer_size
                    .lock()
                    .map(|size| *size != descriptor.buffer_size)
                    .unwrap_or(true);
                if needs_update {
                    send_session_constraints(state, resource, data, &descriptor);
                }
                let frame_data = ImageCopyCaptureFrameState {
                    session: resource.clone(),
                    frame_active: data.frame_active.clone(),
                    inner: Mutex::new(ImageCopyCaptureFrameInner::default()),
                };
                data_init.init(frame, frame_data);
            }
            ext_image_copy_capture_session_v1::Request::Destroy => {
                release_image_copy_session(state, data);
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, ImageCopyCaptureFrameState, CompositorState>
    for ExtImageCaptureManagerState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &ExtImageCopyCaptureFrameV1,
        request: ext_image_copy_capture_frame_v1::Request,
        data: &ImageCopyCaptureFrameState,
        _display: &DisplayHandle,
        _data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            ext_image_copy_capture_frame_v1::Request::AttachBuffer { buffer } => {
                let Ok(mut inner) = data.inner.lock() else {
                    resource.failed(ext_image_copy_capture_frame_v1::FailureReason::Unknown);
                    data.frame_active.store(false, Ordering::Release);
                    return;
                };
                if inner.captured {
                    resource.post_error(
                        ext_image_copy_capture_frame_v1::Error::AlreadyCaptured,
                        "image copy capture frame already captured".to_string(),
                    );
                    return;
                }
                inner.buffer = Some(buffer);
            }
            ext_image_copy_capture_frame_v1::Request::DamageBuffer {
                x,
                y,
                width,
                height,
            } => {
                let Ok(inner) = data.inner.lock() else {
                    resource.failed(ext_image_copy_capture_frame_v1::FailureReason::Unknown);
                    data.frame_active.store(false, Ordering::Release);
                    return;
                };
                if inner.captured {
                    resource.post_error(
                        ext_image_copy_capture_frame_v1::Error::AlreadyCaptured,
                        "image copy capture frame already captured".to_string(),
                    );
                    return;
                }
                if x < 0 || y < 0 || width <= 0 || height <= 0 {
                    resource.post_error(
                        ext_image_copy_capture_frame_v1::Error::InvalidBufferDamage,
                        "invalid image copy capture damage".to_string(),
                    );
                }
            }
            ext_image_copy_capture_frame_v1::Request::Capture => {
                let buffer = {
                    let Ok(mut inner) = data.inner.lock() else {
                        resource.failed(ext_image_copy_capture_frame_v1::FailureReason::Unknown);
                        data.frame_active.store(false, Ordering::Release);
                        return;
                    };
                    if inner.captured {
                        resource.post_error(
                            ext_image_copy_capture_frame_v1::Error::AlreadyCaptured,
                            "image copy capture frame already captured".to_string(),
                        );
                        return;
                    }
                    let Some(buffer) = inner.buffer.clone() else {
                        resource.post_error(
                            ext_image_copy_capture_frame_v1::Error::NoBuffer,
                            "image copy capture frame has no buffer".to_string(),
                        );
                        return;
                    };
                    inner.captured = true;
                    buffer
                };
                let Some(session_data) = data.session.data::<ImageCopyCaptureSessionState>() else {
                    resource.failed(ext_image_copy_capture_frame_v1::FailureReason::Unknown);
                    data.frame_active.store(false, Ordering::Release);
                    return;
                };
                let Some(resolved) = state.resolve_image_copy_request(&session_data.source) else {
                    if data.session.is_alive() {
                        release_image_copy_session(state, session_data);
                        data.session.stopped();
                    }
                    resource.failed(ext_image_copy_capture_frame_v1::FailureReason::Stopped);
                    data.frame_active.store(false, Ordering::Release);
                    return;
                };
                let needs_update = session_data
                    .buffer_size
                    .lock()
                    .map(|size| *size != resolved.source.buffer_size)
                    .unwrap_or(true);
                if needs_update {
                    send_session_constraints(state, &data.session, session_data, &resolved.source);
                    resource
                        .failed(ext_image_copy_capture_frame_v1::FailureReason::BufferConstraints);
                    data.frame_active.store(false, Ordering::Release);
                    return;
                }
                let validated_buffer =
                    match validate_ext_buffer(state, &buffer, resolved.source.buffer_size) {
                        Ok(validated_buffer) => validated_buffer,
                        Err(error) => {
                            warn!(%error, "ext image copy buffer validation failed");
                            resource.failed(
                                ext_image_copy_capture_frame_v1::FailureReason::BufferConstraints,
                            );
                            data.frame_active.store(false, Ordering::Release);
                            return;
                        }
                    };
                state
                    .pending_image_copy_captures
                    .push(PendingImageCopyCapture {
                        frame: resource.clone(),
                        session: data.session.clone(),
                        frame_active: data.frame_active.clone(),
                        window_id: resolved.window_id,
                        output_name: resolved.output_name,
                        output_logical_rect: resolved.output_logical_rect,
                        logical_region: resolved.logical_region,
                        buffer_size: resolved.source.buffer_size,
                        buffer: validated_buffer,
                    });
                state.capture_force_full_damage_frames =
                    state.capture_force_full_damage_frames.max(8);
                state.loop_signal.wakeup();
            }
            ext_image_copy_capture_frame_v1::Request::Destroy => {
                data.frame_active.store(false, Ordering::Release);
            }
            _ => {}
        }
    }
}

pub(crate) fn capture_tag_toplevel_handle(handle: &ForeignToplevelHandle, window_id: u32) {
    handle
        .user_data()
        .insert_if_missing_threadsafe(|| CaptureWindowId(window_id));
}

smithay::reexports::wayland_server::delegate_global_dispatch!(
    crate::CompositorState: [ExtOutputImageCaptureSourceManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtOutputImageCaptureSourceManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_global_dispatch!(
    crate::CompositorState: [ExtForeignToplevelImageCaptureSourceManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtForeignToplevelImageCaptureSourceManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtImageCaptureSourceV1: ImageCaptureSourceData] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_global_dispatch!(
    crate::CompositorState: [ExtImageCopyCaptureManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtImageCopyCaptureManagerV1: ()] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtImageCopyCaptureSessionV1: ImageCopyCaptureSessionState] => ExtImageCaptureManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    crate::CompositorState: [ExtImageCopyCaptureFrameV1: ImageCopyCaptureFrameState] => ExtImageCaptureManagerState
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_blit_rects_keep_clipped_gap_in_same_scale_target() {
        let output_buffer_size = Size::<i32, Buffer>::from((720, 480));
        let output_rect = Rectangle::<i32, Logical>::new((0, 0).into(), (480, 320).into());
        let capture_rect = output_rect;
        let rendered_bounds = Some(Rectangle::<i32, Physical>::new(
            (180, 0).into(),
            (540, 480).into(),
        ));
        let target_size = Size::<i32, Buffer>::from((720, 480));
        let (src, dst) = capture_blit_rects(
            output_buffer_size,
            output_rect,
            capture_rect,
            rendered_bounds,
            target_size,
        )
        .expect("expected clipped blit rects");
        assert_eq!(
            src,
            Rectangle::<i32, Physical>::new((180, 0).into(), (540, 480).into())
        );
        assert_eq!(
            dst,
            Rectangle::<i32, Physical>::new((180, 0).into(), (540, 480).into())
        );
    }

    #[test]
    fn capture_blit_rects_keep_clipped_gap_when_downscaling() {
        let output_buffer_size = Size::<i32, Buffer>::from((720, 480));
        let output_rect = Rectangle::<i32, Logical>::new((0, 0).into(), (480, 320).into());
        let capture_rect = output_rect;
        let rendered_bounds = Some(Rectangle::<i32, Physical>::new(
            (180, 0).into(),
            (540, 480).into(),
        ));
        let target_size = Size::<i32, Buffer>::from((480, 320));
        let (src, dst) = capture_blit_rects(
            output_buffer_size,
            output_rect,
            capture_rect,
            rendered_bounds,
            target_size,
        )
        .expect("expected clipped blit rects");
        assert_eq!(
            src,
            Rectangle::<i32, Physical>::new((180, 0).into(), (540, 480).into())
        );
        assert_eq!(
            dst,
            Rectangle::<i32, Physical>::new((120, 0).into(), (360, 320).into())
        );
    }

    #[test]
    fn capture_blit_rects_return_none_when_window_is_fully_outside_capture() {
        let output_buffer_size = Size::<i32, Buffer>::from((720, 480));
        let output_rect = Rectangle::<i32, Logical>::new((0, 0).into(), (480, 320).into());
        let capture_rect = output_rect;
        let rendered_bounds = Some(Rectangle::<i32, Physical>::new(
            (900, 0).into(),
            (120, 480).into(),
        ));
        let target_size = Size::<i32, Buffer>::from((720, 480));
        assert!(capture_blit_rects(
            output_buffer_size,
            output_rect,
            capture_rect,
            rendered_bounds,
            target_size,
        )
        .is_none());
    }
}
