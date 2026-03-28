use std::{
    ffi::OsString,
    io::Write,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use smithay::{
    backend::renderer::element::memory::MemoryRenderBuffer,
    desktop::{PopupManager, Space, Window, WindowSurfaceType},
    input::{Seat, SeatState},
    reexports::{
        calloop::{generic::Generic, EventLoop, Interest, LoopSignal, Mode, PostAction},
        wayland_server::{
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::wl_surface::WlSurface,
            Display, DisplayHandle, Resource,
        },
    },
    utils::{Logical, Point, Size},
    wayland::{
        compositor::{CompositorClientState, CompositorState as WlCompositorState},
        output::OutputManagerState,
        selection::data_device::DataDeviceState,
        shell::xdg::XdgShellState,
        shm::ShmState,
        socket::ListeningSocketSource,
    },
};

use crate::{
    chrome_bridge::{ChromeEvent, NoOpChromeBridge, SharedChromeBridge},
    shell_ipc,
    window_registry::WindowRegistry,
    CalloopData,
};

#[derive(Debug, Clone)]
pub enum SocketConfig {
    Auto,
    Fixed(String),
}

#[derive(Clone)]
pub struct CompositorInitOptions {
    pub socket: SocketConfig,
    pub seat_name: String,
    pub chrome_bridge: SharedChromeBridge,
    /// When set, listen on `XDG_RUNTIME_DIR`/name for shell pixel IPC ([`shell_wire`]).
    pub shell_ipc_socket: Option<String>,
    /// When set, each applied shell frame overwrites this file with JSON luminance stats (E2E tests).
    pub shell_e2e_status_path: Option<PathBuf>,
    /// When set, each applied shell frame overwrites this path with a PNG (BGRA → RGBA) for visual debugging / screenshot tests.
    pub shell_e2e_screenshot_path: Option<PathBuf>,
}

impl Default for CompositorInitOptions {
    fn default() -> Self {
        Self {
            socket: SocketConfig::Auto,
            seat_name: "compositor".to_string(),
            chrome_bridge: Arc::new(NoOpChromeBridge),
            shell_ipc_socket: None,
            shell_e2e_status_path: None,
            shell_e2e_screenshot_path: None,
        }
    }
}

pub struct CompositorState {
    pub start_time: std::time::Instant,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,

    pub space: Space<Window>,
    pub loop_signal: LoopSignal,

    pub compositor_state: WlCompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<CompositorState>,
    pub data_device_state: DataDeviceState,
    pub popups: PopupManager,

    pub seat: Seat<Self>,

    pub chrome_bridge: SharedChromeBridge,
    pub window_registry: WindowRegistry,

    pub shell_ipc_client: Option<UnixStream>,
    pub shell_read_buf: Vec<u8>,
    pub shell_memory_buffer: MemoryRenderBuffer,
    pub shell_has_frame: bool,
    /// Last OSR frame dimensions (buffer pixels) — maps nested pointer into the same space as the BGRA frame for [`shell_ipc_try_write`](Self::shell_ipc_try_write).
    pub shell_view_px: Option<(u32, u32)>,
    /// Winit [`Window::inner_size`](https://docs.rs/winit/latest/winit/window/struct.Window.html#method.inner_size) —
    /// same denominator the backend uses for pointer normalization ([`crate::winit`] updates on resize).
    pub(crate) shell_window_physical_px: (i32, i32),
    /// Latest pointer position as fraction of [`Self::shell_window_physical_px`] (0..1), window-local physical.
    pub(crate) shell_pointer_norm: Option<(f64, f64)>,
    shell_e2e_status_path: Option<PathBuf>,
    shell_e2e_screenshot_path: Option<PathBuf>,
}

impl CompositorState {
    pub fn new(
        event_loop: &mut EventLoop<CalloopData>,
        display: Display<Self>,
        options: CompositorInitOptions,
    ) -> Self {
        let start_time = std::time::Instant::now();

        let dh = display.handle();

        let compositor_state = WlCompositorState::new::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let chrome_bridge = options.chrome_bridge;
        let shell_ipc_socket = options.shell_ipc_socket.clone();
        let shell_e2e_status_path = options.shell_e2e_status_path.clone();
        let shell_e2e_screenshot_path = options.shell_e2e_screenshot_path.clone();
        let popups = PopupManager::default();
        let window_registry = WindowRegistry::new();
        let shell_memory_buffer = crate::shell_overlay::new_shell_memory_buffer();

        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, &options.seat_name);
        seat.add_keyboard(Default::default(), 200, 25).unwrap();
        seat.add_pointer();

        let space = Space::default();

        let socket_name = Self::init_wayland_listener(display, event_loop, &options.socket);

        let loop_signal = event_loop.get_signal();

        let s = Self {
            start_time,
            display_handle: dh,
            space,
            loop_signal,
            socket_name,
            compositor_state,
            xdg_shell_state,
            shm_state,
            output_manager_state,
            seat_state,
            data_device_state,
            popups,
            seat,
            chrome_bridge,
            window_registry,
            shell_ipc_client: None,
            shell_read_buf: Vec::new(),
            shell_memory_buffer,
            shell_has_frame: false,
            shell_view_px: None,
            shell_window_physical_px: (1, 1),
            shell_pointer_norm: None,
            shell_e2e_status_path,
            shell_e2e_screenshot_path,
        };

        if let Some(name) = shell_ipc_socket {
            if let Ok(rd) = std::env::var("XDG_RUNTIME_DIR") {
                if let Err(e) =
                    shell_ipc::register_shell_ipc_listener(event_loop, Path::new(&rd), &name)
                {
                    tracing::warn!(?e, name, "failed to bind shell ipc socket");
                } else {
                    tracing::info!(%name, "shell ipc listening");
                }
            } else {
                tracing::warn!("XDG_RUNTIME_DIR unset; shell ipc not started");
            }
        }

        s
    }

    fn init_wayland_listener(
        display: Display<CompositorState>,
        event_loop: &mut EventLoop<CalloopData>,
        socket: &SocketConfig,
    ) -> OsString {
        let listening_socket = match socket {
            SocketConfig::Auto => ListeningSocketSource::new_auto().unwrap(),
            SocketConfig::Fixed(name) => ListeningSocketSource::with_name(name).unwrap(),
        };

        let socket_name = listening_socket.socket_name().to_os_string();

        let loop_handle = event_loop.handle();

        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                    .unwrap();
            })
            .expect("Failed to init the wayland event source.");

        loop_handle
            .insert_source(
                Generic::new(display, Interest::READ, Mode::Level),
                |_, display, state| {
                    unsafe {
                        display
                            .get_mut()
                            .dispatch_clients(&mut state.state)
                            .unwrap();
                    }
                    Ok(PostAction::Continue)
                },
            )
            .unwrap();

        socket_name
    }

    pub fn surface_under(
        &self,
        pos: Point<f64, Logical>,
    ) -> Option<(WlSurface, Point<f64, Logical>)> {
        self.space
            .element_under(pos)
            .and_then(|(window, location)| {
                window
                    .surface_under(pos - location.to_f64(), WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64()))
            })
    }

    /// Updates [`WindowRegistry`] from current [`Space`] layout and notifies the bridge if geometry changed.
    pub fn notify_geometry_if_changed(&mut self, window: &Window) {
        let Some(toplevel) = window.toplevel() else {
            return;
        };
        let surface_id = toplevel.wl_surface().id().protocol_id();
        let Some(loc) = self.space.element_location(window) else {
            return;
        };
        let size = window.geometry().size;
        let changed = self
            .window_registry
            .set_geometry(surface_id, loc.x, loc.y, size.w, size.h);
        if let Some(true) = changed {
            if let Some(info) = self.window_registry.snapshot_for_surface(surface_id) {
                self.chrome_bridge
                    .notify(ChromeEvent::WindowGeometryChanged { info });
            }
        }
    }

    pub fn clear_shell_frame(&mut self) {
        self.shell_has_frame = false;
        self.shell_view_px = None;
    }

    /// Letterboxed shell in **output-local logical** pixels `(ox, oy, cw, ch)`.
    ///
    /// Matches [`AbsolutePositionEvent::position_transformed`] (logical) and the logical `size`
    /// passed to [`smithay::backend::renderer::element::memory::MemoryRenderBufferRenderElement::from_buffer`],
    /// so hit-testing and drawing use one coordinate space.
    pub(crate) fn shell_letterbox_logical(
        &self,
        output_logical_size: Size<i32, Logical>,
    ) -> Option<(i32, i32, i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (buf_w, buf_h) = self.shell_view_px?;
        crate::shell_letterbox::letterbox_logical(output_logical_size, buf_w, buf_h)
    }

    /// Map normalized pointer (0..1) in letterboxed shell space into OSR buffer pixels.
    pub fn shell_pointer_view_px_norm(&self, nx: f64, ny: f64) -> Option<(i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (vw, vh) = self.shell_view_px?;
        Some(crate::shell_letterbox::norm_to_buffer_px(nx, ny, vw, vh))
    }

    /// Fallback: map global **logical** seat position to OSR buffer pixels (e.g. button before motion).
    pub fn shell_pointer_view_px(&self, pos: Point<f64, Logical>) -> Option<(i32, i32)> {
        if !self.shell_has_frame {
            return None;
        }
        let (vw, vh) = self.shell_view_px?;
        let output = self.space.outputs().next()?;
        let geo = self.space.output_geometry(output)?;
        let (ox_l, oy_l, cw_l, ch_l) = self.shell_letterbox_logical(geo.size)?;
        let ox = geo.loc.x as f64 + ox_l as f64;
        let oy = geo.loc.y as f64 + oy_l as f64;
        let lx = pos.x - ox;
        let ly = pos.y - oy;
        crate::shell_letterbox::local_in_letterbox_to_buffer_px(lx, ly, cw_l, ch_l, vw, vh)
    }

    pub fn shell_overlay_has_pointer(&self, pos: Point<f64, Logical>) -> bool {
        self.shell_pointer_view_px(pos).is_some()
    }

    /// Send compositor → `cef_host` message (pointer routing). No-op if shell IPC is disconnected.
    pub fn shell_ipc_try_write(&mut self, packet: &[u8]) {
        if let Some(ref mut stream) = self.shell_ipc_client {
            if let Err(e) = stream.write_all(packet) {
                tracing::warn!(?e, "shell ipc: write to client failed");
            }
            let _ = stream.flush();
        }
    }

    /// Upload a BGRA8888 frame (`shell_wire` pixels) into [`Self::shell_memory_buffer`].
    pub fn apply_shell_frame_bgra(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        pixels: &[u8],
    ) -> Result<(), &'static str> {
        let w = width as i32;
        let h = height as i32;
        if w <= 0 || h <= 0 {
            return Err("bad dimensions");
        }
        let need = (stride as usize)
            .checked_mul(h as usize)
            .ok_or("stride overflow")?;
        if pixels.len() < need {
            return Err("pixel buffer too small");
        }
        {
            let mut ctx = self.shell_memory_buffer.render();
            ctx.resize((w, h));
            ctx.draw(|mem| {
                let row = w as usize * 4;
                if stride as usize == row {
                    mem[..need].copy_from_slice(&pixels[..need]);
                } else {
                    for y in 0..h as usize {
                        let src_off = y * stride as usize;
                        let dst_off = y * row;
                        mem[dst_off..dst_off + row]
                            .copy_from_slice(&pixels[src_off..src_off + row]);
                    }
                }
                Ok(vec![smithay::utils::Rectangle::from_size(
                    smithay::utils::Size::from((w, h)),
                )])
            })
            .map_err(|_: ()| "memory buffer draw")?;
        }
        self.shell_has_frame = true;
        self.shell_view_px = Some((width, height));
        if let Some(ref path) = self.shell_e2e_status_path {
            write_shell_e2e_frame_status(path, w, h, stride, pixels);
        }
        if let Some(ref path) = self.shell_e2e_screenshot_path {
            write_shell_e2e_screenshot_png(path, w, h, stride, pixels);
        }
        Ok(())
    }

    /// Run `sh -c` with [`Self::socket_name`] as `WAYLAND_DISPLAY` (nested compositor clients).
    ///
    /// Disabled unless `DERP_ALLOW_SHELL_SPAWN=1` (trusted local shell IPC only).
    #[cfg(unix)]
    pub fn try_spawn_wayland_client_sh(&self, shell_command: &str) -> Result<(), String> {
        if std::env::var("DERP_ALLOW_SHELL_SPAWN").as_deref() != Ok("1") {
            return Err(
                "spawning from shell IPC requires DERP_ALLOW_SHELL_SPAWN=1 (trusted local connection)"
                    .into(),
            );
        }
        let trimmed = shell_command.trim();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if trimmed.len() > shell_wire::MAX_SPAWN_COMMAND_BYTES as usize {
            return Err("command too long".into());
        }
        let display = self.socket_name.to_string_lossy().into_owned();
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR unset")?;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(trimmed)
            .env("WAYLAND_DISPLAY", display)
            .env("XDG_RUNTIME_DIR", runtime)
            .stdin(Stdio::null());
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        tracing::info!(pid = child.id(), "spawned Wayland client via shell IPC");
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn try_spawn_wayland_client_sh(&self, _shell_command: &str) -> Result<(), String> {
        Err("shell IPC spawn is only supported on Unix".into())
    }
}

/// BT.709 luma for BGRA samples (B, G, R channels).
fn shell_sample_luma(b: u8, g: u8, r: u8) -> f32 {
    // BT.709 luma (B, G, R order for BGRA).
    0.0722 * b as f32 + 0.7152 * g as f32 + 0.2126 * r as f32
}

fn write_shell_e2e_frame_status(path: &Path, w: i32, h: i32, stride: u32, pixels: &[u8]) {
    let wu = w as usize;
    let hu = h as usize;
    let stride = stride as usize;
    if wu == 0 || hu == 0 {
        return;
    }
    let sample_coords = [
        (0usize, 0usize),
        (wu.saturating_sub(1), 0),
        (0, hu.saturating_sub(1)),
        (wu.saturating_sub(1), hu.saturating_sub(1)),
        (wu / 2, hu / 2),
    ];
    let mut lumas = Vec::new();
    for (x, y) in sample_coords {
        let o = y.saturating_mul(stride).saturating_add(x.saturating_mul(4));
        if o + 3 < pixels.len() {
            lumas.push(shell_sample_luma(pixels[o], pixels[o + 1], pixels[o + 2]));
        }
    }
    if lumas.is_empty() {
        return;
    }
    let min_l = lumas.iter().copied().fold(f32::MAX, f32::min);
    let max_l = lumas.iter().copied().fold(f32::MIN, f32::max);
    let spread = max_l - min_l;
    // Lowercase JSON numbers for easy parsing in tests.
    let json = format!(
        r#"{{"width":{w},"height":{h},"min_luma":{min_l},"max_luma":{max_l},"spread":{spread},"has_frame":true}}"#,
        w = w,
        h = h,
        min_l = min_l,
        max_l = max_l,
        spread = spread,
    );
    if let Err(e) = std::fs::write(path, json) {
        tracing::warn!(?e, path = ?path, "shell e2e: failed to write status file");
    }
}

/// Encode the latest shell frame as PNG (BGRA input) for E2E / manual inspection.
fn write_shell_e2e_screenshot_png(path: &Path, w: i32, h: i32, stride: u32, pixels: &[u8]) {
    let wu = w as u32;
    let hu = h as u32;
    if wu == 0 || hu == 0 {
        return;
    }
    let stride = stride as usize;
    let row_bytes = wu as usize * 4;
    let mut rgba = vec![0u8; row_bytes * hu as usize];
    for y in 0..hu as usize {
        let src_row = y * stride;
        let dst_row = y * row_bytes;
        for x in 0..wu as usize {
            let s = src_row + x * 4;
            let d = dst_row + x * 4;
            if s + 3 >= pixels.len() || d + 3 >= rgba.len() {
                continue;
            }
            rgba[d] = pixels[s + 2];
            rgba[d + 1] = pixels[s + 1];
            rgba[d + 2] = pixels[s];
            rgba[d + 3] = pixels[s + 3];
        }
    }
    let Some(img) = image::RgbaImage::from_raw(wu, hu, rgba) else {
        tracing::warn!(path = ?path, "shell e2e: screenshot dimensions mismatch buffer");
        return;
    };
    let tmp_path = path.with_extension("tmp.png");
    if let Err(e) = img.save(&tmp_path) {
        tracing::warn!(?e, path = ?tmp_path, "shell e2e: png encode failed");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        tracing::warn!(?e, dst = ?path, "shell e2e: failed to finalize screenshot png");
    }
}

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
