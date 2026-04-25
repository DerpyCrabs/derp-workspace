use clap::Parser;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_output, delegate_pointer, delegate_pointer_constraints,
    delegate_registry, delegate_relative_pointer, delegate_seat, delegate_shm,
    delegate_xdg_shell, delegate_xdg_window,
    globals::ProvidesBoundGlobal,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        pointer::{PointerEvent, PointerHandler},
        pointer_constraints::{PointerConstraintsHandler, PointerConstraintsState},
        relative_pointer::{RelativeMotionEvent, RelativePointerHandler, RelativePointerState},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        xdg::{
            window::{Window, WindowConfigure, WindowDecorations, WindowHandler},
            XdgShell,
        },
        WaylandSurface,
    },
    shm::{
        slot::{Buffer, SlotPool},
        Shm, ShmHandler,
    },
};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_seat, wl_surface},
    Connection, QueueHandle,
};
use wayland_protocols::wp::{
    pointer_constraints::zv1::client::{
        zwp_confined_pointer_v1, zwp_locked_pointer_v1, zwp_pointer_constraints_v1,
    },
    relative_pointer::zv1::client::zwp_relative_pointer_v1,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerConstraintMode {
    None,
    Lock,
    Confine,
}

impl PointerConstraintMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Ok(Self::None),
            "lock" | "locked" => Ok(Self::Lock),
            "confine" | "confined" => Ok(Self::Confine),
            other => Err(format!("unsupported --pointer-constraint value: {other}")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Lock => "lock",
            Self::Confine => "confine",
        }
    }
}

enum PointerConstraintHandle {
    Locked(zwp_locked_pointer_v1::ZwpLockedPointerV1),
    Confined(zwp_confined_pointer_v1::ZwpConfinedPointerV1),
}

impl PointerConstraintHandle {
    fn destroy(self) {
        match self {
            Self::Locked(handle) => handle.destroy(),
            Self::Confined(handle) => handle.destroy(),
        }
    }
}

#[derive(Parser, Debug, Clone)]
struct Args {
    #[arg(long, default_value = "Derp E2E Native Test")]
    title: String,
    #[arg(long, default_value = "derp.e2e.native")]
    app_id: String,
    #[arg(long, default_value = "default")]
    token: String,
    #[arg(long, default_value = "auto")]
    strip: String,
    #[arg(long, default_value_t = 480)]
    width: u32,
    #[arg(long, default_value_t = 320)]
    height: u32,
    #[arg(long, default_value_t = false)]
    drop_buffer_after_draw: bool,
    #[arg(long, default_value = "none")]
    pointer_constraint: String,
}

fn main() {
    let args = Args::parse();
    let pointer_constraint_mode = PointerConstraintMode::parse(&args.pointer_constraint)
        .unwrap_or_else(|error| panic!("{error}"));
    let strip_color = parse_strip_color(&args.strip, &args.token)
        .unwrap_or_else(|error| panic!("invalid --strip value: {error}"));
    let conn = Connection::connect_to_env().expect("connect to wayland compositor");
    let (globals, mut event_queue) = registry_queue_init(&conn).expect("init registry");
    let qh = event_queue.handle();

    let compositor_state = CompositorState::bind(&globals, &qh).expect("bind wl_compositor");
    let shm_state = Shm::bind(&globals, &qh).expect("bind wl_shm");
    let xdg_shell_state = XdgShell::bind(&globals, &qh).expect("bind xdg_shell");
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);
    let seat_state = SeatState::new(&globals, &qh);
    let relative_pointer_state = RelativePointerState::bind(&globals, &qh);
    let pointer_constraint_state = PointerConstraintsState::bind(&globals, &qh);

    let surface = compositor_state.create_surface(&qh);
    let window = xdg_shell_state.create_window(surface, WindowDecorations::RequestServer, &qh);
    window.set_title(args.title.clone());
    window.set_app_id(args.app_id.clone());
    window.set_min_size(Some((args.width, args.height)));
    window.set_max_size(Some((args.width, args.height)));
    window.commit();

    let pool = SlotPool::new((args.width * args.height * 4) as usize, &shm_state)
        .expect("create shared memory pool");

    let mut state = TestClient {
        registry_state,
        output_state,
        seat_state,
        _compositor_state: compositor_state,
        shm_state,
        _xdg_shell_state: xdg_shell_state,
        relative_pointer_state,
        pointer_constraint_state,
        pool,
        window,
        buffer: None,
        width: args.width,
        height: args.height,
        configured: false,
        needs_redraw: false,
        exit: false,
        base_title: args.title,
        token: args.token,
        strip_color,
        drop_buffer_after_draw: args.drop_buffer_after_draw,
        buffer_dropped: false,
        pending_presentation_loops: 0,
        pointer_constraint_mode,
        pointer: None,
        relative_pointer: None,
        pointer_constraint: None,
        constraint_locked: false,
        constraint_confined: false,
        last_relative: (0.0, 0.0),
        total_relative: (0.0, 0.0),
    };

    while !state.exit {
        event_queue
            .blocking_dispatch(&mut state)
            .expect("dispatch wayland events");
    }
}

struct TestClient {
    registry_state: RegistryState,
    output_state: OutputState,
    seat_state: SeatState,
    _compositor_state: CompositorState,
    shm_state: Shm,
    _xdg_shell_state: XdgShell,
    relative_pointer_state: RelativePointerState,
    pointer_constraint_state: PointerConstraintsState,
    pool: SlotPool,
    window: Window,
    buffer: Option<Buffer>,
    width: u32,
    height: u32,
    configured: bool,
    needs_redraw: bool,
    exit: bool,
    base_title: String,
    token: String,
    strip_color: [u8; 4],
    drop_buffer_after_draw: bool,
    buffer_dropped: bool,
    pending_presentation_loops: u32,
    pointer_constraint_mode: PointerConstraintMode,
    pointer: Option<wl_pointer::WlPointer>,
    relative_pointer: Option<zwp_relative_pointer_v1::ZwpRelativePointerV1>,
    pointer_constraint: Option<PointerConstraintHandle>,
    constraint_locked: bool,
    constraint_confined: bool,
    last_relative: (f64, f64),
    total_relative: (f64, f64),
}

impl TestClient {
    fn draw(&mut self, _conn: &Connection, qh: &QueueHandle<Self>) {
        if !self.configured || !self.needs_redraw {
            return;
        }

        let stride = (self.width * 4) as i32;
        let required_len = (self.width * self.height * 4) as usize;
        if self.pool.len() < required_len {
            self.pool.resize(required_len).expect("resize pool");
        }

        if self.buffer.is_none() {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create buffer");
            self.buffer = Some(buffer);
        }

        let needs_replacement = {
            let buffer = self.buffer.as_mut().expect("buffer allocated");
            self.pool.canvas(buffer).is_none()
        };
        if needs_replacement {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create fallback buffer");
            self.buffer = Some(buffer);
        }

        let buffer = self.buffer.as_mut().expect("buffer ready");
        let canvas = self.pool.canvas(buffer).expect("buffer canvas");

        draw_pattern(
            canvas,
            self.width,
            self.height,
            &self.token,
            self.strip_color,
        );

        self.window
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.window
            .wl_surface()
            .frame(qh, self.window.wl_surface().clone());
        buffer
            .attach_to(self.window.wl_surface())
            .expect("attach buffer");
        self.window.wl_surface().commit();
        self.needs_redraw = false;
    }

    fn drop_buffer(&mut self) {
        if self.buffer_dropped {
            return;
        }
        self.window.wl_surface().attach(None, 0, 0);
        self.window.wl_surface().commit();
        self.buffer = None;
        self.buffer_dropped = true;
    }

    fn ensure_game_pointer_state(&mut self, qh: &QueueHandle<Self>) {
        if self.pointer_constraint_mode == PointerConstraintMode::None {
            return;
        }
        if self.pointer_constraint.is_some() {
            return;
        }
        let Some(pointer) = self.pointer.as_ref() else {
            return;
        };
        if self.pointer_constraint_state.bound_global().is_err() {
            return;
        }
        let surface = self.window.wl_surface();
        self.pointer_constraint = match self.pointer_constraint_mode {
            PointerConstraintMode::Lock => self
                .pointer_constraint_state
                .lock_pointer(
                    surface,
                    pointer,
                    None,
                    zwp_pointer_constraints_v1::Lifetime::Persistent,
                    qh,
                )
                .ok()
                .map(PointerConstraintHandle::Locked),
            PointerConstraintMode::Confine => self
                .pointer_constraint_state
                .confine_pointer(
                    surface,
                    pointer,
                    None,
                    zwp_pointer_constraints_v1::Lifetime::Persistent,
                    qh,
                )
                .ok()
                .map(PointerConstraintHandle::Confined),
            PointerConstraintMode::None => None,
        };
    }

    fn update_status_title(&self) {
        if self.pointer_constraint_mode == PointerConstraintMode::None {
            return;
        }
        self.window.set_title(format!(
            "{} | mode={} lock={} confine={} last={:.0},{:.0} total={:.0},{:.0}",
            self.base_title,
            self.pointer_constraint_mode.label(),
            u8::from(self.constraint_locked),
            u8::from(self.constraint_confined),
            self.last_relative.0.round(),
            self.last_relative.1.round(),
            self.total_relative.0.round(),
            self.total_relative.1.round(),
        ));
    }
}

fn draw_pattern(canvas: &mut [u8], width: u32, height: u32, token: &str, strip_color: [u8; 4]) {
    let seed = hash_token(token);
    let bg = color(seed, 0x10);
    let accent_a = color(seed.rotate_left(11), 0x28);
    let accent_b = color(seed.rotate_left(23), 0x34);
    let accent_c = color(seed.rotate_left(37), 0x40);
    let border = [18, 18, 22, 255];
    let light = [244, 244, 248, 255];
    let width_i = width as usize;
    let height_i = height as usize;
    let border_px = (width.min(height) / 40).max(3) as usize;
    let header_h = (height / 7).max(24) as usize;
    let strip_h = (height / 16).max(18) as usize;
    let footer_h = (height / 8).max(28) as usize;
    let grid_top = header_h + border_px;
    let grid_bottom = height_i.saturating_sub(footer_h + border_px);
    let grid_h = grid_bottom.saturating_sub(grid_top).max(1);
    let cell_w = (width_i.saturating_sub(border_px * 2) / 8).max(1);
    let cell_h = (grid_h / 4).max(1);
    let bars = token.as_bytes();

    for y in 0..height_i {
        for x in 0..width_i {
            let rgba = if x < border_px
                || y < border_px
                || x >= width_i.saturating_sub(border_px)
                || y >= height_i.saturating_sub(border_px)
            {
                border
            } else if y < strip_h {
                strip_color
            } else if y < header_h {
                mix(accent_a, accent_b, x as u32, width.max(1))
            } else if y >= height_i.saturating_sub(footer_h) {
                footer_color(
                    x, y, width_i, height_i, footer_h, bars, accent_b, accent_c, light,
                )
            } else {
                let gx = (x.saturating_sub(border_px)) / cell_w;
                let gy = (y.saturating_sub(grid_top)) / cell_h;
                let cell_seed = seed
                    ^ ((gx as u64).wrapping_mul(0x9e37_79b9))
                    ^ ((gy as u64).wrapping_mul(0x85eb_ca6b));
                let base = if (gx + gy) % 2 == 0 {
                    color(cell_seed.rotate_left(7), 0x30)
                } else {
                    color(cell_seed.rotate_left(19), 0x50)
                };
                let mut rgba = brighten(base, if (gx + gy) % 3 == 0 { 22 } else { 0 });
                let cx = width_i / 2;
                let cy = grid_top + grid_h / 2;
                let dx = x.abs_diff(cx);
                let dy = y.abs_diff(cy);
                if dx < border_px * 2 || dy < border_px * 2 {
                    rgba = light;
                }
                if dx < border_px || dy < border_px {
                    rgba = border;
                }
                if (x + y + ((seed >> 8) as usize)) % 29 == 0 {
                    rgba = brighten(bg, 18);
                }
                rgba
            };
            put_pixel(canvas, width_i, x, y, rgba);
        }
    }
}

fn footer_color(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    footer_h: usize,
    bars: &[u8],
    accent_a: [u8; 4],
    accent_b: [u8; 4],
    light: [u8; 4],
) -> [u8; 4] {
    let local_y = y.saturating_sub(height.saturating_sub(footer_h));
    let bar_width = (width / bars.len().max(1)).max(1);
    let idx = (x / bar_width).min(bars.len().saturating_sub(1));
    let byte = bars.get(idx).copied().unwrap_or(0);
    let threshold = ((byte as usize) % footer_h.max(1)).max(3);
    if local_y >= footer_h.saturating_sub(threshold) {
        if byte.count_ones() % 2 == 0 {
            accent_a
        } else {
            accent_b
        }
    } else if local_y % 7 == 0 {
        light
    } else {
        [28, 28, 34, 255]
    }
}

fn mix(a: [u8; 4], b: [u8; 4], pos: u32, span: u32) -> [u8; 4] {
    let t = pos.min(span) as u64;
    let span = span.max(1) as u64;
    [
        (((a[0] as u64) * (span - t) + (b[0] as u64) * t) / span) as u8,
        (((a[1] as u64) * (span - t) + (b[1] as u64) * t) / span) as u8,
        (((a[2] as u64) * (span - t) + (b[2] as u64) * t) / span) as u8,
        255,
    ]
}

fn brighten(mut color: [u8; 4], amount: u8) -> [u8; 4] {
    color[0] = color[0].saturating_add(amount);
    color[1] = color[1].saturating_add(amount);
    color[2] = color[2].saturating_add(amount);
    color
}

fn color(seed: u64, bias: u8) -> [u8; 4] {
    [
        ((seed & 0xff) as u8).saturating_div(2).saturating_add(bias),
        (((seed >> 8) & 0xff) as u8)
            .saturating_div(2)
            .saturating_add(bias),
        (((seed >> 16) & 0xff) as u8)
            .saturating_div(2)
            .saturating_add(bias),
        255,
    ]
}

fn parse_strip_color(strip: &str, token: &str) -> Result<[u8; 4], String> {
    let trimmed = strip.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        let seed = hash_token(token).rotate_left(5);
        return Ok(color(seed, 0x60));
    }
    let named = match trimmed.to_ascii_lowercase().as_str() {
        "red" => Some([220, 60, 60, 255]),
        "green" => Some([50, 190, 90, 255]),
        "blue" => Some([70, 110, 230, 255]),
        "yellow" => Some([220, 190, 60, 255]),
        "orange" => Some([230, 130, 50, 255]),
        "purple" => Some([150, 90, 220, 255]),
        "pink" => Some([230, 90, 170, 255]),
        "cyan" => Some([60, 190, 210, 255]),
        "white" => Some([235, 235, 235, 255]),
        "gray" | "grey" => Some([140, 140, 150, 255]),
        "black" => Some([30, 30, 34, 255]),
        _ => None,
    };
    if let Some(color) = named {
        return Ok(color);
    }
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "expected auto, a named color, or #RRGGBB, got {trimmed}"
        ));
    }
    let r = u8::from_str_radix(&hex[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&hex[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&hex[4..6], 16).map_err(|e| e.to_string())?;
    Ok([r, g, b, 255])
}

fn hash_token(token: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in token.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn put_pixel(canvas: &mut [u8], width: usize, x: usize, y: usize, rgba: [u8; 4]) {
    let idx = (y * width + x) * 4;
    canvas[idx] = rgba[2];
    canvas[idx + 1] = rgba[1];
    canvas[idx + 2] = rgba[0];
    canvas[idx + 3] = rgba[3];
}

impl CompositorHandler for TestClient {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        conn: &Connection,
        qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
        if self.drop_buffer_after_draw && !self.buffer_dropped {
            self.pending_presentation_loops = self.pending_presentation_loops.saturating_add(1);
            if self.pending_presentation_loops < 5 {
                self.window
                    .wl_surface()
                    .frame(qh, self.window.wl_surface().clone());
                self.window.wl_surface().commit();
                return;
            }
            self.drop_buffer();
            return;
        }
        self.draw(conn, qh);
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for TestClient {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl WindowHandler for TestClient {
    fn request_close(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _window: &Window) {
        self.exit = true;
    }

    fn configure(
        &mut self,
        conn: &Connection,
        qh: &QueueHandle<Self>,
        _window: &Window,
        configure: WindowConfigure,
        _serial: u32,
    ) {
        self.buffer = None;
        if let Some(width) = configure.new_size.0.map(|v| v.get()) {
            self.width = width;
        }
        if let Some(height) = configure.new_size.1.map(|v| v.get()) {
            self.height = height;
        }
        self.configured = true;
        self.needs_redraw = true;
        if !(self.drop_buffer_after_draw && !self.buffer_dropped) {
            self.pending_presentation_loops = 0;
        }
        self.ensure_game_pointer_state(qh);
        self.draw(conn, qh);
    }
}

impl ShmHandler for TestClient {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl SeatHandler for TestClient {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer && self.pointer.is_none() {
            let pointer = self
                .seat_state
                .get_pointer(qh, &seat)
                .expect("create pointer");
            self.relative_pointer = self
                .relative_pointer_state
                .get_relative_pointer(&pointer, qh)
                .ok();
            self.pointer = Some(pointer);
            self.ensure_game_pointer_state(qh);
        }
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer {
            if let Some(constraint) = self.pointer_constraint.take() {
                constraint.destroy();
            }
            if let Some(relative_pointer) = self.relative_pointer.take() {
                relative_pointer.destroy();
            }
            if let Some(pointer) = self.pointer.take() {
                pointer.release();
            }
            self.constraint_locked = false;
            self.constraint_confined = false;
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}

impl PointerHandler for TestClient {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        _events: &[PointerEvent],
    ) {
    }
}

impl PointerConstraintsHandler for TestClient {
    fn confined(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _confined_pointer: &zwp_confined_pointer_v1::ZwpConfinedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_confined = true;
        self.constraint_locked = false;
        self.update_status_title();
    }

    fn unconfined(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _confined_pointer: &zwp_confined_pointer_v1::ZwpConfinedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_confined = false;
        self.update_status_title();
    }

    fn locked(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _locked_pointer: &zwp_locked_pointer_v1::ZwpLockedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_locked = true;
        self.constraint_confined = false;
        self.update_status_title();
    }

    fn unlocked(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _locked_pointer: &zwp_locked_pointer_v1::ZwpLockedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_locked = false;
        self.update_status_title();
    }
}

impl RelativePointerHandler for TestClient {
    fn relative_pointer_motion(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _relative_pointer: &zwp_relative_pointer_v1::ZwpRelativePointerV1,
        _pointer: &wl_pointer::WlPointer,
        event: RelativeMotionEvent,
    ) {
        self.last_relative = event.delta;
        self.total_relative.0 += event.delta.0;
        self.total_relative.1 += event.delta.1;
        self.update_status_title();
    }
}

delegate_compositor!(TestClient);
delegate_output!(TestClient);
delegate_shm!(TestClient);
delegate_pointer!(TestClient);
delegate_pointer_constraints!(TestClient);
delegate_relative_pointer!(TestClient);
delegate_xdg_shell!(TestClient);
delegate_xdg_window!(TestClient);
delegate_seat!(TestClient);
delegate_registry!(TestClient);

impl ProvidesRegistryState for TestClient {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState, SeatState);
}
