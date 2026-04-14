use clap::Parser;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_output, delegate_registry, delegate_seat, delegate_shm,
    delegate_xdg_shell, delegate_xdg_window,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{Capability, SeatHandler, SeatState},
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
    protocol::{wl_output, wl_surface},
    Connection, QueueHandle,
};

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
}

fn main() {
    let args = Args::parse();
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
        pool,
        window,
        buffer: None,
        width: args.width,
        height: args.height,
        configured: false,
        needs_redraw: false,
        exit: false,
        token: args.token,
        strip_color,
        drop_buffer_after_draw: args.drop_buffer_after_draw,
        buffer_dropped: false,
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
    pool: SlotPool,
    window: Window,
    buffer: Option<Buffer>,
    width: u32,
    height: u32,
    configured: bool,
    needs_redraw: bool,
    exit: bool,
    token: String,
    strip_color: [u8; 4],
    drop_buffer_after_draw: bool,
    buffer_dropped: bool,
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

    fn new_seat(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wayland_client::protocol::wl_seat::WlSeat,
    ) {
    }

    fn new_capability(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wayland_client::protocol::wl_seat::WlSeat,
        _capability: Capability,
    ) {
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _: &QueueHandle<Self>,
        _: wayland_client::protocol::wl_seat::WlSeat,
        _capability: Capability,
    ) {
    }

    fn remove_seat(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wayland_client::protocol::wl_seat::WlSeat,
    ) {
    }
}

delegate_compositor!(TestClient);
delegate_output!(TestClient);
delegate_shm!(TestClient);
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
