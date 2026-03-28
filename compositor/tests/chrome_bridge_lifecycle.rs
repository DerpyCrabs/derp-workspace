//! In-process headless compositor with `LoggingChromeBridge` and a minimal xdg-shell client
//! to assert real `ChromeEvent` ordering (Phase 1 bridge semantics without CEF).
//!
//! Focus changes are not asserted: pointer/keyboard focus from this minimal client is not
//! deterministic enough for a stable integration test.
//!
//! The client performs an initial `wl_surface.commit` after creating the xdg toplevel so the
//! compositor sends `xdg_surface.configure`; without that commit, configure never arrives and
//! buffer commits (and thus `WindowGeometryChanged`) never happen.

use std::{
    io,
    io::Write,
    os::fd::AsFd,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use compositor::{
    chrome_bridge::{ChromeEvent, LoggingChromeBridge},
    headless,
    state::{CompositorInitOptions, SocketConfig},
};
use wayland_client::{
    globals::{registry_queue_init, GlobalListContents},
    protocol::{
        wl_buffer, wl_compositor, wl_registry, wl_shm, wl_shm_pool, wl_surface,
    },
    Connection, Dispatch, QueueHandle,
};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};

const SOCKET: &str = "derp-chrome-bridge-lifecycle";

const TEST_TITLE: &str = "bridge-test-window";
const TEST_APP_ID: &str = "com.derp.bridge-test";

fn wait_for_socket(runtime_dir: &std::path::Path, timeout: Duration) -> io::Result<()> {
    let path = runtime_dir.join(SOCKET);
    let start = Instant::now();
    while start.elapsed() < timeout {
        if path.exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "Wayland socket did not appear",
    ))
}

#[derive(Default)]
struct XdgSurfaceData;

struct AppData {
    wl_surface: wl_surface::WlSurface,
    shm: wl_shm::WlShm,
    /// First `configure`: attach SHM buffer, ack, commit.
    pending_initial_commit: bool,
    /// Keep buffer alive until teardown so the compositor can read SHM dimensions.
    #[allow(dead_code)]
    mapped_buffer: Option<wl_buffer::WlBuffer>,
    #[allow(dead_code)]
    mapped_pool: Option<wl_shm_pool::WlShmPool>,
}

impl Dispatch<wl_compositor::WlCompositor, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_compositor::WlCompositor,
        _: wl_compositor::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_surface::WlSurface, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_shm::WlShm, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_shm::WlShm,
        _: wl_shm::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_shm_pool::WlShmPool, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_shm_pool::WlShmPool,
        _: wl_shm_pool::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release {} = event {
            // ignore
        }
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for AppData {
    fn event(
        _: &mut Self,
        proxy: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            proxy.pong(serial);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, XdgSurfaceData> for AppData {
    fn event(
        state: &mut Self,
        xdg: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &XdgSurfaceData,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            if state.pending_initial_commit {
                state.pending_initial_commit = false;
                state.attach_and_commit_mapped(xdg, serial, qh);
            } else {
                xdg.ack_configure(serial);
            }
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        _: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl AppData {
    fn attach_and_commit_mapped(
        &mut self,
        xdg: &xdg_surface::XdgSurface,
        serial: u32,
        qh: &QueueHandle<Self>,
    ) {
        let stride = 4i32;
        let width = 1i32;
        let height = 1i32;
        let pool_size = (stride * height) as usize;

        let mut file = tempfile::tempfile().expect("shm tempfile");
        file.set_len(pool_size as u64).expect("set_len");
        file.write_all(&[0u8, 0, 0, 0]).expect("write pixel");
        file.flush().ok();

        let pool = self
            .shm
            .create_pool(file.as_fd(), pool_size as i32, qh, ());
        let buffer = pool.create_buffer(0, width, height, stride, wl_shm::Format::Argb8888, qh, ());

        self.wl_surface.attach(Some(&buffer), 0, 0);
        xdg.ack_configure(serial);
        self.wl_surface.commit();
        self.mapped_buffer = Some(buffer);
        self.mapped_pool = Some(pool);
    }
}

#[test]
fn headless_emits_chrome_bridge_window_lifecycle() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path().to_path_buf();

    let bridge = Arc::new(LoggingChromeBridge::new());
    let bridge_for_thread = bridge.clone();
    let runtime_for_thread = runtime.clone();

    let compositor_thread = thread::spawn(move || {
        // ListeningSocketSource uses XDG_RUNTIME_DIR for the named socket.
        std::env::set_var("XDG_RUNTIME_DIR", &runtime_for_thread);
        let opts = CompositorInitOptions {
            socket: SocketConfig::Fixed(SOCKET.to_string()),
            seat_name: "chrome-bridge-test".to_string(),
            chrome_bridge: bridge_for_thread,
            shell_ipc_socket: None,
            shell_e2e_status_path: None,
            shell_e2e_screenshot_path: None,
        };
        headless::run(opts, Some(Duration::from_secs(12))).expect("headless run");
    });

    wait_for_socket(&runtime, Duration::from_secs(5)).expect("socket ready");

    std::env::set_var("XDG_RUNTIME_DIR", &runtime);
    std::env::set_var("WAYLAND_DISPLAY", SOCKET);

    let conn = Connection::connect_to_env().expect("connect");
    let (globals, mut event_queue) = registry_queue_init::<AppData>(&conn).expect("registry");
    let qh = event_queue.handle();

    let compositor: wl_compositor::WlCompositor = globals
        .bind(&qh, 1..=5, ())
        .expect("wl_compositor");
    let shm: wl_shm::WlShm = globals.bind(&qh, 1..=1, ()).expect("wl_shm");
    let xdg_wm: xdg_wm_base::XdgWmBase = globals.bind(&qh, 1..=5, ()).expect("xdg_wm_base");

    let wl_surface = compositor.create_surface(&qh, ());
    let xdg_surface = xdg_wm.get_xdg_surface(&wl_surface, &qh, XdgSurfaceData::default());
    let toplevel = xdg_surface.get_toplevel(&qh, ());
    toplevel.set_title(TEST_TITLE.to_string());
    toplevel.set_app_id(TEST_APP_ID.to_string());

    // Initial commit: xdg-shell requires a surface commit so the compositor sends configure.
    wl_surface.commit();

    let mut state = AppData {
        wl_surface: wl_surface.clone(),
        shm: shm.clone(),
        pending_initial_commit: true,
        mapped_buffer: None,
        mapped_pool: None,
    };

    // Receives configure; handler attaches SHM and commits.
    event_queue.roundtrip(&mut state).expect("roundtrip after toplevel");

    for _ in 0..3 {
        event_queue.roundtrip(&mut state).expect("roundtrip after commit");
        thread::sleep(Duration::from_millis(20));
    }

    assert!(
        state.mapped_buffer.is_some(),
        "client should receive configure and attach a buffer; pending_initial_commit={}",
        state.pending_initial_commit
    );

    toplevel.destroy();
    xdg_surface.destroy();
    wl_surface.destroy();

    event_queue.roundtrip(&mut state).expect("roundtrip after destroy");

    drop(conn);
    compositor_thread.join().expect("compositor join");

    let events = bridge.take_events();

    // `WindowMapped` fires from `new_toplevel` before the client sets title/app_id; metadata
    // arrives as `WindowMetadataChanged` (see xdg_surface.set_title / set_app_id order).
    let mapped: Vec<&compositor::chrome_bridge::WindowInfo> = events
        .iter()
        .filter_map(|e| {
            if let ChromeEvent::WindowMapped { info } = e {
                Some(info)
            } else {
                None
            }
        })
        .collect();

    assert!(
        !mapped.is_empty(),
        "expected at least one WindowMapped; got {events:?}"
    );

    let mapped_window_id = mapped[0].window_id;

    assert!(
        events.iter().any(|e| {
            match e {
                ChromeEvent::WindowMetadataChanged { info } | ChromeEvent::WindowMapped { info } => {
                    info.window_id == mapped_window_id
                        && info.title == TEST_TITLE
                        && info.app_id == TEST_APP_ID
                }
                _ => false,
            }
        }),
        "expected title/app_id on WindowMetadataChanged (or mapped) for window {mapped_window_id}; got {events:?}"
    );

    let mapped_pos = events.iter().position(|e| matches!(e, ChromeEvent::WindowMapped { .. }));

    let geometry_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, ChromeEvent::WindowGeometryChanged { .. }))
        .collect();
    assert!(
        !geometry_events.is_empty(),
        "expected at least one WindowGeometryChanged after buffer commit; got {events:?}"
    );

    let geometry_pos = events
        .iter()
        .position(|e| matches!(e, ChromeEvent::WindowGeometryChanged { .. }));
    assert!(
        mapped_pos.is_some() && geometry_pos.is_some() && mapped_pos < geometry_pos,
        "expected WindowGeometryChanged after WindowMapped; events={events:?}"
    );

    let unmapped: Vec<u32> = events
        .iter()
        .filter_map(|e| {
            if let ChromeEvent::WindowUnmapped { window_id } = e {
                Some(*window_id)
            } else {
                None
            }
        })
        .collect();

    assert!(
        unmapped.contains(&mapped_window_id),
        "expected WindowUnmapped for window_id {mapped_window_id}; unmapped={unmapped:?} events={events:?}"
    );

    let unmapped_pos = events
        .iter()
        .position(|e| matches!(e, ChromeEvent::WindowUnmapped { .. }));
    assert!(
        mapped_pos.is_some() && unmapped_pos.is_some() && mapped_pos < unmapped_pos,
        "expected WindowMapped before WindowUnmapped; events={events:?}"
    );
}
