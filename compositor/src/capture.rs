use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{imageops, RgbaImage};
use smithay::{
    backend::renderer::gles::{GlesRenderer, GlesTarget},
    output::Output,
    reexports::wayland_server::{
        backend::GlobalId,
        protocol::{wl_buffer::WlBuffer, wl_output::WlOutput, wl_shm},
        Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
    },
    utils::{Buffer, Logical, Rectangle, Size, Transform},
    wayland::{
        foreign_toplevel_list::{ForeignToplevelListHandler, ForeignToplevelListState},
        idle_inhibit::IdleInhibitHandler,
        keyboard_shortcuts_inhibit::{
            KeyboardShortcutsInhibitHandler, KeyboardShortcutsInhibitState, KeyboardShortcutsInhibitor,
        },
        shm::{with_buffer_contents_mut, BufferAccessError},
    },
};
use tracing::warn;
use wayland_protocols_wlr::screencopy::v1::server::{
    zwlr_screencopy_frame_v1::{self, ZwlrScreencopyFrameV1},
    zwlr_screencopy_manager_v1::{self, ZwlrScreencopyManagerV1},
};

use crate::state::{shell_window_row_should_show, CompositorState};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum CaptureSourceKey {
    Output(String),
    Window(u32),
}

#[derive(Debug, Clone)]
pub(crate) struct CaptureSourceDescriptor {
    pub key: CaptureSourceKey,
    pub title: String,
    pub app_id: String,
    pub output_name: String,
    pub logical_rect: Rectangle<i32, Logical>,
    pub buffer_size: Size<i32, Buffer>,
}

#[derive(Debug)]
pub(crate) struct ScreencopyManagerState {
    _global: GlobalId,
}

#[derive(Debug)]
pub(crate) struct ScreencopyFrameState {
    output_name: String,
    logical_region: Rectangle<i32, Logical>,
    buffer_size: Size<i32, Buffer>,
    used: AtomicBool,
}

#[derive(Debug)]
pub(crate) struct PendingScreencopyCopy {
    frame: ZwlrScreencopyFrameV1,
    output_name: String,
    logical_region: Rectangle<i32, Logical>,
    buffer: WlBuffer,
    with_damage: bool,
}

impl ScreencopyManagerState {
    pub(crate) fn new<D>(display: &DisplayHandle) -> Self
    where
        D: GlobalDispatch<ZwlrScreencopyManagerV1, ()>,
        D: Dispatch<ZwlrScreencopyManagerV1, ()>,
        D: Dispatch<ZwlrScreencopyFrameV1, ScreencopyFrameState>,
        D: 'static,
    {
        let global = display.create_global::<D, ZwlrScreencopyManagerV1, _>(3, ());
        Self { _global: global }
    }
}

impl CompositorState {
    pub(crate) fn capture_output_source(&self, output: &Output) -> Option<CaptureSourceDescriptor> {
        let logical_rect = self.space.output_geometry(output)?;
        let mode = output.current_mode()?;
        let buffer_size = transformed_output_size(
            Size::from((mode.size.w as i32, mode.size.h as i32)),
            output.current_transform(),
        );
        Some(CaptureSourceDescriptor {
            key: CaptureSourceKey::Output(output.name()),
            title: output.name(),
            app_id: "derp.output".to_string(),
            output_name: output.name(),
            logical_rect,
            buffer_size,
        })
    }

    pub(crate) fn capture_window_sources(&self) -> Vec<CaptureSourceDescriptor> {
        self.window_registry
            .all_records()
            .into_iter()
            .filter(|record| !self.window_info_is_solid_shell_host(&record.info))
            .filter(|record| record.kind != crate::window_registry::WindowKind::ShellHosted)
            .filter(|record| shell_window_row_should_show(&record.info))
            .filter(|record| !self.wayland_window_id_is_pending_deferred_toplevel(record.info.window_id))
            .map(|record| CaptureSourceDescriptor {
                key: CaptureSourceKey::Window(record.info.window_id),
                title: record.info.title.clone(),
                app_id: record.info.app_id.clone(),
                output_name: record.info.output_name.clone(),
                logical_rect: Rectangle::new(
                    (record.info.x, record.info.y).into(),
                    (record.info.width.max(1), record.info.height.max(1)).into(),
                ),
                buffer_size: Size::from((record.info.width.max(1), record.info.height.max(1))),
            })
            .collect()
    }

    pub(crate) fn capture_sync_toplevel_handles(&mut self) {
        let mut active = HashSet::new();
        for source in self.capture_window_sources() {
            let CaptureSourceKey::Window(window_id) = source.key else {
                continue;
            };
            active.insert(window_id);
            if !self.capture_toplevel_handles.contains_key(&window_id) {
                let handle = self
                    .foreign_toplevel_list_state
                    .new_toplevel::<Self>(source.title.clone(), source.app_id.clone());
                crate::capture_ext::capture_tag_toplevel_handle(&handle, window_id);
                self.capture_toplevel_handles.insert(window_id, handle);
            }
            let Some(handle) = self.capture_toplevel_handles.get(&window_id).cloned() else {
                continue;
            };
            handle.send_title(&source.title);
            handle.send_app_id(&source.app_id);
            handle.send_done();
        }

        let stale: Vec<u32> = self
            .capture_toplevel_handles
            .keys()
            .copied()
            .filter(|window_id| !active.contains(window_id))
            .collect();
        for window_id in stale {
            if let Some(handle) = self.capture_toplevel_handles.remove(&window_id) {
                self.foreign_toplevel_list_state.remove_toplevel(&handle);
            }
        }
        self.foreign_toplevel_list_state.cleanup_closed_handles();
    }

    pub(crate) fn process_screencopy_output_if_needed(
        &mut self,
        output: &Output,
        renderer: &mut GlesRenderer,
        framebuffer: &GlesTarget<'_>,
    ) {
        let output_name = output.name();
        let mut pending = std::mem::take(&mut self.pending_screencopy_copies);
        let mut matching = Vec::new();
        let mut remaining = Vec::with_capacity(pending.len());
        for request in pending.drain(..) {
            if request.output_name == output_name {
                matching.push(request);
            } else {
                remaining.push(request);
            }
        }
        self.pending_screencopy_copies = remaining;
        if matching.is_empty() {
            return;
        }

        let Some(source) = self.capture_output_source(output) else {
            for request in matching {
                if request.frame.is_alive() {
                    request.frame.failed();
                }
                if request.buffer.is_alive() {
                    request.buffer.release();
                }
            }
            return;
        };

        let image = match crate::screenshot::capture_output_image(
            renderer,
            framebuffer,
            source.buffer_size,
            output.current_transform(),
        ) {
            Ok(image) => image,
            Err(error) => {
                warn!(%error, output = %output_name, "screencopy capture failed");
                for request in matching {
                    if request.frame.is_alive() {
                        request.frame.failed();
                    }
                    if request.buffer.is_alive() {
                        request.buffer.release();
                    }
                }
                return;
            }
        };

        for request in matching {
            if !request.frame.is_alive() {
                continue;
            }
            let cropped = match crop_capture_image(&image, source.logical_rect, request.logical_region) {
                Ok(cropped) => cropped,
                Err(error) => {
                    warn!(%error, output = %output_name, "screencopy crop failed");
                    request.frame.failed();
                    if request.buffer.is_alive() {
                        request.buffer.release();
                    }
                    continue;
                }
            };
            if request.with_damage {
                request.frame.damage(0, 0, cropped.width(), cropped.height());
            }
            if let Err(error) = write_image_to_shm_buffer(&request.buffer, &cropped) {
                warn!(%error, output = %output_name, "screencopy write failed");
                request.frame.failed();
                if request.buffer.is_alive() {
                    request.buffer.release();
                }
                continue;
            }
            let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(now) => now,
                Err(error) => {
                    warn!(?error, output = %output_name, "screencopy timestamp failed");
                    request.frame.failed();
                    if request.buffer.is_alive() {
                        request.buffer.release();
                    }
                    continue;
                }
            };
            request.frame.flags(zwlr_screencopy_frame_v1::Flags::empty());
            request
                .frame
                .ready((now.as_secs() >> 32) as u32, now.as_secs() as u32, now.subsec_nanos());
            if request.buffer.is_alive() {
                request.buffer.release();
            }
        }
    }
}

impl ForeignToplevelListHandler for CompositorState {
    fn foreign_toplevel_list_state(&mut self) -> &mut ForeignToplevelListState {
        &mut self.foreign_toplevel_list_state
    }
}

impl IdleInhibitHandler for CompositorState {
    fn inhibit(&mut self, surface: smithay::reexports::wayland_server::protocol::wl_surface::WlSurface) {
        if let Some(client) = surface.client() {
            self.idle_inhibit_surfaces
                .insert((client.id(), surface.id().protocol_id()));
        }
    }

    fn uninhibit(
        &mut self,
        surface: smithay::reexports::wayland_server::protocol::wl_surface::WlSurface,
    ) {
        if let Some(client) = surface.client() {
            self.idle_inhibit_surfaces
                .remove(&(client.id(), surface.id().protocol_id()));
        }
    }
}

impl KeyboardShortcutsInhibitHandler for CompositorState {
    fn keyboard_shortcuts_inhibit_state(&mut self) -> &mut KeyboardShortcutsInhibitState {
        &mut self.keyboard_shortcuts_inhibit_state
    }

    fn new_inhibitor(&mut self, inhibitor: KeyboardShortcutsInhibitor) {
        inhibitor.activate();
    }
}

impl GlobalDispatch<ZwlrScreencopyManagerV1, (), CompositorState> for ScreencopyManagerState {
    fn bind(
        _state: &mut CompositorState,
        _display: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrScreencopyManagerV1>,
        _global_data: &(),
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ZwlrScreencopyManagerV1, (), CompositorState> for ScreencopyManagerState {
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        _resource: &ZwlrScreencopyManagerV1,
        request: zwlr_screencopy_manager_v1::Request,
        _data: &(),
        _display: &DisplayHandle,
        data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            zwlr_screencopy_manager_v1::Request::CaptureOutput {
                frame,
                overlay_cursor: _,
                output,
            } => {
                init_screencopy_frame(state, frame, output, None, data_init);
            }
            zwlr_screencopy_manager_v1::Request::CaptureOutputRegion {
                frame,
                overlay_cursor: _,
                output,
                x,
                y,
                width,
                height,
            } => {
                let region = Rectangle::new((x, y).into(), (width.max(1), height.max(1)).into());
                init_screencopy_frame(state, frame, output, Some(region), data_init);
            }
            zwlr_screencopy_manager_v1::Request::Destroy => {}
            _ => unreachable!(),
        }
    }
}

impl Dispatch<ZwlrScreencopyFrameV1, ScreencopyFrameState, CompositorState> for ScreencopyManagerState {
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &ZwlrScreencopyFrameV1,
        request: zwlr_screencopy_frame_v1::Request,
        data: &ScreencopyFrameState,
        _display: &DisplayHandle,
        _data_init: &mut DataInit<'_, CompositorState>,
    ) {
        match request {
            zwlr_screencopy_frame_v1::Request::Copy { buffer } => {
                queue_screencopy_copy(state, resource, data, buffer, false);
            }
            zwlr_screencopy_frame_v1::Request::CopyWithDamage { buffer } => {
                queue_screencopy_copy(state, resource, data, buffer, true);
            }
            zwlr_screencopy_frame_v1::Request::Destroy => {}
            _ => unreachable!(),
        }
    }
}

fn init_screencopy_frame(
    state: &mut CompositorState,
    frame: New<ZwlrScreencopyFrameV1>,
    output: WlOutput,
    requested_region: Option<Rectangle<i32, Logical>>,
    data_init: &mut DataInit<'_, CompositorState>,
) {
    let Some(output) = Output::from_resource(&output) else {
        let frame = data_init.init(
            frame,
            ScreencopyFrameState {
                output_name: String::new(),
                logical_region: Rectangle::new((0, 0).into(), (1, 1).into()),
                buffer_size: Size::from((1, 1)),
                used: AtomicBool::new(false),
            },
        );
        frame.failed();
        return;
    };
    let Some(source) = state.capture_output_source(&output) else {
        let frame = data_init.init(
            frame,
            ScreencopyFrameState {
                output_name: String::new(),
                logical_region: Rectangle::new((0, 0).into(), (1, 1).into()),
                buffer_size: Size::from((1, 1)),
                used: AtomicBool::new(false),
            },
        );
        frame.failed();
        return;
    };

    let logical_region = requested_region
        .map(|region| {
            Rectangle::new(
                (
                    source.logical_rect.loc.x.saturating_add(region.loc.x),
                    source.logical_rect.loc.y.saturating_add(region.loc.y),
                )
                    .into(),
                region.size,
            )
        })
        .unwrap_or(source.logical_rect)
        .intersection(source.logical_rect);
    let Some(logical_region) = logical_region else {
        let frame = data_init.init(
            frame,
            ScreencopyFrameState {
                output_name: source.output_name,
                logical_region: Rectangle::new((0, 0).into(), (1, 1).into()),
                buffer_size: Size::from((1, 1)),
                used: AtomicBool::new(false),
            },
        );
        frame.failed();
        return;
    };
    let buffer_size = region_buffer_size(&source, logical_region);
    let frame = data_init.init(
        frame,
        ScreencopyFrameState {
            output_name: source.output_name,
            logical_region,
            buffer_size,
            used: AtomicBool::new(false),
        },
    );
    frame.buffer(wl_shm::Format::Argb8888, buffer_size.w as u32, buffer_size.h as u32, (buffer_size.w * 4) as u32);
    if frame.version() >= 3 {
        frame.buffer_done();
    }
}

fn queue_screencopy_copy(
    state: &mut CompositorState,
    frame: &ZwlrScreencopyFrameV1,
    data: &ScreencopyFrameState,
    buffer: WlBuffer,
    with_damage: bool,
) {
    if data.used.swap(true, Ordering::AcqRel) {
        frame.post_error(
            zwlr_screencopy_frame_v1::Error::AlreadyUsed,
            "screencopy frame already copied".to_string(),
        );
        return;
    }

    match validate_screencopy_buffer(&buffer, data) {
        Ok(()) => {
            state.pending_screencopy_copies.push(PendingScreencopyCopy {
                frame: frame.clone(),
                output_name: data.output_name.clone(),
                logical_region: data.logical_region,
                buffer,
                with_damage,
            });
            state.loop_signal.wakeup();
        }
        Err(error) => {
            frame.post_error(zwlr_screencopy_frame_v1::Error::InvalidBuffer, error);
        }
    }
}

fn validate_screencopy_buffer(buffer: &WlBuffer, data: &ScreencopyFrameState) -> Result<(), String> {
    with_buffer_contents_mut(buffer, |_, _, meta| {
        if meta.format != wl_shm::Format::Xrgb8888 && meta.format != wl_shm::Format::Argb8888 {
            return Err("screencopy requires wl_shm Xrgb8888 or Argb8888".to_string());
        }
        if meta.width <= 0 || meta.height <= 0 {
            return Err("screencopy buffer dimensions must be positive".to_string());
        }
        let expected = Size::from((meta.width, meta.height));
        if expected != data.buffer_size {
            return Err("screencopy buffer dimensions do not match advertised frame size".to_string());
        }
        if meta.stride < meta.width * 4 {
            return Err("screencopy buffer stride is too small".to_string());
        }
        Ok(())
    })
    .map_err(buffer_access_error)?
}

fn transformed_output_size(size: Size<i32, Buffer>, transform: Transform) -> Size<i32, Buffer> {
    match transform {
        Transform::_90 | Transform::_270 | Transform::Flipped90 | Transform::Flipped270 => {
            Size::from((size.h, size.w))
        }
        _ => size,
    }
}

fn region_buffer_size(source: &CaptureSourceDescriptor, region: Rectangle<i32, Logical>) -> Size<i32, Buffer> {
    if region == source.logical_rect {
        return source.buffer_size;
    }
    Size::from((
        ((region.size.w as f64) * (source.buffer_size.w as f64 / source.logical_rect.size.w.max(1) as f64))
            .round()
            .max(1.0) as i32,
        ((region.size.h as f64) * (source.buffer_size.h as f64 / source.logical_rect.size.h.max(1) as f64))
            .round()
            .max(1.0) as i32,
    ))
}

pub(crate) fn crop_capture_image(
    image: &RgbaImage,
    output_rect: Rectangle<i32, Logical>,
    capture_rect: Rectangle<i32, Logical>,
) -> Result<RgbaImage, String> {
    if capture_rect == output_rect {
        return Ok(image.clone());
    }
    let scale_x = image.width() as f64 / output_rect.size.w.max(1) as f64;
    let scale_y = image.height() as f64 / output_rect.size.h.max(1) as f64;
    let local_x = capture_rect.loc.x - output_rect.loc.x;
    let local_y = capture_rect.loc.y - output_rect.loc.y;
    let src_x = (local_x as f64 * scale_x).round().max(0.0) as u32;
    let src_y = (local_y as f64 * scale_y).round().max(0.0) as u32;
    let src_w = ((capture_rect.size.w as f64) * scale_x).round().max(1.0) as u32;
    let src_h = ((capture_rect.size.h as f64) * scale_y).round().max(1.0) as u32;
    let src_w = src_w.min(image.width().saturating_sub(src_x).max(1));
    let src_h = src_h.min(image.height().saturating_sub(src_y).max(1));
    Ok(imageops::crop_imm(image, src_x, src_y, src_w, src_h).to_image())
}

pub(crate) fn write_image_to_shm_buffer(buffer: &WlBuffer, image: &RgbaImage) -> Result<(), String> {
    with_buffer_contents_mut(buffer, |ptr, len, data| {
        let width = data.width.max(1) as usize;
        let height = data.height.max(1) as usize;
        let stride = data.stride.max(0) as usize;
        let start = data.offset.max(0) as usize;
        let row_bytes = width * 4;
        if width != image.width() as usize || height != image.height() as usize {
            return Err("screencopy buffer size changed before copy".to_string());
        }
        if stride < row_bytes {
            return Err("screencopy buffer stride is too small".to_string());
        }
        let end = start.saturating_add(stride.saturating_mul(height));
        if end > len {
            return Err("screencopy buffer exceeds shm pool".to_string());
        }
        let pool = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
        let src = image.as_raw();
        for y in 0..height {
            let dst_row = &mut pool[start + y * stride..start + y * stride + row_bytes];
            let src_row = &src[y * row_bytes..(y + 1) * row_bytes];
            for x in 0..width {
                let s = &src_row[x * 4..x * 4 + 4];
                let d = &mut dst_row[x * 4..x * 4 + 4];
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = if data.format == wl_shm::Format::Argb8888 { s[3] } else { 0xff };
            }
        }
        Ok(())
    })
    .map_err(buffer_access_error)?
}

pub(crate) fn buffer_access_error(error: BufferAccessError) -> String {
    match error {
        BufferAccessError::NotManaged => "screencopy requires a wl_shm buffer".to_string(),
        BufferAccessError::BadMap => "screencopy buffer shm pool is invalid".to_string(),
        BufferAccessError::NotReadable => "screencopy buffer is not readable".to_string(),
        BufferAccessError::NotWritable => "screencopy buffer is not writable".to_string(),
    }
}

smithay::delegate_foreign_toplevel_list!(CompositorState);
smithay::delegate_idle_inhibit!(CompositorState);
smithay::delegate_keyboard_shortcuts_inhibit!(CompositorState);
smithay::reexports::wayland_server::delegate_global_dispatch!(
    CompositorState: [ZwlrScreencopyManagerV1: ()] => ScreencopyManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    CompositorState: [ZwlrScreencopyManagerV1: ()] => ScreencopyManagerState
);
smithay::reexports::wayland_server::delegate_dispatch!(
    CompositorState: [ZwlrScreencopyFrameV1: ScreencopyFrameState] => ScreencopyManagerState
);
