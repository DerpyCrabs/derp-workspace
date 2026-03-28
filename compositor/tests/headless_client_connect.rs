//! Spawns the compositor binary in headless mode and connects a minimal Wayland client.

use std::{
    io,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use wayland_client::{
    globals::{registry_queue_init, GlobalListContents},
    protocol::wl_registry,
    Connection, Dispatch, QueueHandle,
};

const SOCKET: &str = "derp-integration-test";

struct AppData;

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

#[test]
fn headless_compositor_accepts_client_and_exposes_globals() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();

    let mut child = Command::new(env!("CARGO_BIN_EXE_compositor"))
        .env("XDG_RUNTIME_DIR", runtime)
        .args([
            "--headless",
            "--socket",
            SOCKET,
            "--run-for-ms",
            "15000",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn compositor");

    wait_for_socket(runtime, Duration::from_secs(5)).expect("socket ready");

    std::env::set_var("XDG_RUNTIME_DIR", runtime);
    std::env::set_var("WAYLAND_DISPLAY", SOCKET);

    let conn = Connection::connect_to_env().expect("connect");
    let (globals, mut queue) = registry_queue_init::<AppData>(&conn).expect("registry");

    let mut state = AppData;
    queue.roundtrip(&mut state).expect("event queue roundtrip");

    let interfaces: Vec<String> = globals
        .contents()
        .clone_list()
        .into_iter()
        .map(|g| g.interface)
        .collect();

    assert!(
        interfaces.iter().any(|i| i == "wl_compositor"),
        "expected wl_compositor in {:?}",
        interfaces
    );
    assert!(
        interfaces.iter().any(|i| i == "wl_output"),
        "expected wl_output in {:?}",
        interfaces
    );

    let _ = child.kill();
    let _ = child.wait();
}
