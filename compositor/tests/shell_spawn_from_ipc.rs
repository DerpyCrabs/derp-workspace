//! Headless compositor accepts `shell_wire` spawn messages and runs `sh -c` with `WAYLAND_DISPLAY`.

#![cfg(all(unix, target_os = "linux"))]

use std::{
    fs,
    io::Write,
    os::unix::net::UnixStream,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const WL_SOCKET: &str = "derp-spawn-test-wl";
const IPC_SOCK: &str = "derp-spawn-test-shell.sock";

fn wait_for_file(path: &Path, timeout: Duration) -> std::io::Result<()> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if path.exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "path did not appear",
    ))
}

#[test]
fn shell_ipc_spawn_sets_wayland_display() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();
    let out_path = runtime.join("wl_display_out.txt");
    let out_quoted = out_path.to_string_lossy().replace('\'', "'\\''");

    let mut child = Command::new(env!("CARGO_BIN_EXE_compositor"))
        .env("XDG_RUNTIME_DIR", runtime)
        .env("DERP_ALLOW_SHELL_SPAWN", "1")
        .args([
            "--headless",
            "--socket",
            WL_SOCKET,
            "--shell-ipc-socket",
            IPC_SOCK,
            "--run-for-ms",
            "15000",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn compositor");

    let shell_path = runtime.join(IPC_SOCK);
    wait_for_file(&shell_path, Duration::from_secs(5)).expect("shell socket");

    let cmd = format!(r#"printf '%s' "$WAYLAND_DISPLAY" > '{}'"#, out_quoted);
    let msg = shell_wire::encode_spawn_wayland_client(&cmd).expect("encode spawn");
    let mut stream = UnixStream::connect(&shell_path).expect("connect shell ipc");
    stream.write_all(&msg).expect("write");
    stream.flush().ok();

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if out_path.is_file() {
            let s = fs::read_to_string(&out_path).expect("read");
            if s == WL_SOCKET {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
        thread::sleep(Duration::from_millis(30));
    }

    let _ = child.kill();
    let _ = child.wait();
    panic!("expected WAYLAND_DISPLAY written to {}", out_path.display());
}
