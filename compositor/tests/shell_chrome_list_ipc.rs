//! Headless compositor replies to [`shell_wire::MSG_SHELL_LIST_WINDOWS`] with [`shell_wire::MSG_WINDOW_LIST`].

#![cfg(all(unix, target_os = "linux"))]

use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const WL_SOCKET: &str = "derp-chrome-list-wl";
const IPC_SOCK: &str = "derp-chrome-list-shell.sock";

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
fn shell_ipc_list_windows_returns_empty_packet() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();

    let mut child = Command::new(env!("CARGO_BIN_EXE_compositor"))
        .env("XDG_RUNTIME_DIR", runtime)
        .args([
            "--headless",
            "--socket",
            WL_SOCKET,
            "--shell-ipc-socket",
            IPC_SOCK,
            "--run-for-ms",
            "8000",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn compositor");

    let shell_path = runtime.join(IPC_SOCK);
    wait_for_file(&shell_path, Duration::from_secs(5)).expect("shell socket");

    let req = shell_wire::encode_shell_list_windows();
    let mut stream = UnixStream::connect(&shell_path).expect("connect shell ipc");
    stream.write_all(&req).expect("write");
    stream.flush().ok();

    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set_read_timeout");

    thread::sleep(Duration::from_millis(200));

    let mut acc = Vec::new();
    let mut got_list = false;
    for _ in 0..32 {
        let mut len_buf = [0u8; 4];
        if stream.read_exact(&mut len_buf).is_err() {
            break;
        }
        let body_len = u32::from_le_bytes(len_buf) as usize;
        assert!(body_len <= shell_wire::MAX_BODY_BYTES as usize);
        let mut body_only = vec![0u8; body_len];
        if stream.read_exact(&mut body_only).is_err() {
            break;
        }
        acc.extend_from_slice(&len_buf);
        acc.extend_from_slice(&body_only);

        while let Some(msg) = shell_wire::pop_compositor_to_shell_message(&mut acc).expect("decode") {
            if let shell_wire::DecodedCompositorToShellMessage::WindowList { windows } = msg {
                assert!(windows.is_empty());
                got_list = true;
                break;
            }
        }
        if got_list {
            break;
        }
    }

    if !got_list {
        let _ = child.kill();
        let _ = child.wait();
        panic!("did not receive WindowList");
    }

    let _ = child.kill();
    let _ = child.wait();
}
