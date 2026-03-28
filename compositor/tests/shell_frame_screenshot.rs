//! Headless compositor + shell IPC: writes PNG via `DERP_SHELL_E2E_SCREENSHOT` so you can
//! inspect frames or assert pixels in tests (no CEF).
//!
//! ```text
//! cargo test -p compositor headless_shell_overlay_png -- --nocapture
//! ```

use std::{
    fs,
    io::Write,
    os::unix::net::UnixStream,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;

const WL_SOCKET: &str = "derp-shell-screenshot-wl";
const SHELL_SOCK: &str = "derp-shell-screenshot-ipc.sock";

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ShellE2eStatus {
    width: u32,
    height: u32,
    min_luma: f64,
    max_luma: f64,
    spread: f64,
    has_frame: bool,
}

fn wait_path_exists(path: &Path, timeout: Duration) -> std::io::Result<()> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if path.exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!("timeout waiting for {}", path.display()),
    ))
}

fn wait_shell_status(path: &Path, timeout: Duration) -> ShellE2eStatus {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(s) = fs::read_to_string(path) {
            if let Ok(st) = serde_json::from_str::<ShellE2eStatus>(&s) {
                if st.has_frame {
                    return st;
                }
            }
        }
        thread::sleep(Duration::from_millis(30));
    }
    panic!(
        "timed out waiting for shell frame status at {} (compositor not applying IPC?)",
        path.display()
    );
}

fn solid_bgra(width: u32, height: u32, b: u8, g: u8, r: u8, a: u8) -> Vec<u8> {
    let stride = width * 4;
    let n = (stride * height) as usize;
    let mut v = Vec::with_capacity(n);
    for _ in 0..(width * height) {
        v.extend_from_slice(&[b, g, r, a]);
    }
    v
}

fn spawn_headless_compositor(
    runtime: &Path,
    status: &Path,
    screenshot: &Path,
) -> std::process::Child {
    let bin = env!("CARGO_BIN_EXE_compositor");
    std::process::Command::new(bin)
        .env("XDG_RUNTIME_DIR", runtime)
        .env("DERP_SHELL_E2E_STATUS", status)
        .env("DERP_SHELL_E2E_SCREENSHOT", screenshot)
        .args([
            "--headless",
            "--socket",
            WL_SOCKET,
            "--shell-ipc-socket",
            SHELL_SOCK,
            "--run-for-ms",
            "60000",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn compositor")
}

/// After a colored shell frame, the PNG must match (center pixel) — catches “nothing drawn”
/// when the shell buffer stays black while IPC claims a size.
#[test]
fn headless_shell_overlay_png_shows_sent_pixels() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();
    let status_path = runtime.join("status.json");
    let png_path = runtime.join("overlay.png");

    let mut comp = spawn_headless_compositor(runtime, &status_path, &png_path);
    wait_path_exists(&runtime.join(WL_SOCKET), Duration::from_secs(15)).expect("wl socket");
    wait_path_exists(&runtime.join(SHELL_SOCK), Duration::from_secs(15)).expect("shell socket");

    let w = 64u32;
    let h = 64u32;
    let pixels = solid_bgra(w, h, 0, 0, 255, 255);
    let frame = shell_wire::encode_frame_bgra(w, h, w * 4, &pixels).expect("encode");
    let mut sock = UnixStream::connect(runtime.join(SHELL_SOCK)).expect("connect shell ipc");
    sock.write_all(&frame).expect("write frame");
    sock.flush().ok();

    let st = wait_shell_status(&status_path, Duration::from_secs(10));
    assert_eq!(st.width, w);
    assert_eq!(st.height, h);

    assert!(
        png_path.is_file(),
        "DERP_SHELL_E2E_SCREENSHOT did not create {}",
        png_path.display()
    );
    let img = image::open(&png_path).expect("read png");
    let rgba = img.to_rgba8();
    assert_eq!(rgba.dimensions(), (w, h));
    let p = rgba.get_pixel(w / 2, h / 2);
    assert!(
        p[0] >= 240 && p[1] <= 20 && p[2] <= 20,
        "expected saturated red center, got Rgba {:?}",
        p
    );

    assert!(
        st.max_luma > 40.0 && st.max_luma < 70.0,
        "red fill BT.709 luma ~54, got max_luma={}",
        st.max_luma
    );

    let _ = comp.kill();
    let _ = comp.wait();
}

#[test]
fn headless_shell_blank_png_is_black() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();
    let status_path = runtime.join("status.json");
    let png_path = runtime.join("blank.png");

    let mut comp = spawn_headless_compositor(runtime, &status_path, &png_path);
    wait_path_exists(&runtime.join(WL_SOCKET), Duration::from_secs(15)).expect("wl socket");
    wait_path_exists(&runtime.join(SHELL_SOCK), Duration::from_secs(15)).expect("shell socket");

    let w = 48u32;
    let h = 32u32;
    let pixels = vec![0u8; (w * h * 4) as usize];
    let frame = shell_wire::encode_frame_bgra(w, h, w * 4, &pixels).expect("encode");
    let mut sock = UnixStream::connect(runtime.join(SHELL_SOCK)).expect("connect");
    sock.write_all(&frame).expect("write");
    sock.flush().ok();

    let st = wait_shell_status(&status_path, Duration::from_secs(10));
    assert!(
        st.max_luma < 1.0,
        "blank frame should have ~0 luma, got {:?}",
        st
    );

    let img = image::open(&png_path).expect("png");
    let rgba = img.to_rgba8();
    let p = rgba.get_pixel(w / 2, h / 2);
    assert!(
        p[0] < 3 && p[1] < 3 && p[2] < 3,
        "expected black center, got {:?}",
        p
    );

    let _ = comp.kill();
    let _ = comp.wait();
}
