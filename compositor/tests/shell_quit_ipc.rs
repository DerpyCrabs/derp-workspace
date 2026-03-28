//! `MSG_SHELL_QUIT_COMPOSITOR` stops the headless compositor loop.

#![cfg(all(unix, target_os = "linux"))]

use std::{
    io::Write,
    os::unix::net::UnixStream,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const WL_SOCKET: &str = "derp-quit-wl";
const IPC_SOCK: &str = "derp-quit-shell.sock";

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
fn shell_ipc_quit_stops_compositor() {
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
            "60000",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn compositor");

    let shell_path = runtime.join(IPC_SOCK);
    wait_for_file(&shell_path, Duration::from_secs(5)).expect("shell socket");

    let mut stream = UnixStream::connect(&shell_path).expect("connect");
    stream
        .write_all(&shell_wire::encode_shell_quit_compositor())
        .expect("quit");

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(st) => {
                assert!(st.success(), "compositor exit status {:?}", st.code());
                return;
            }
            None if Instant::now() > deadline => panic!("compositor did not exit after quit"),
            None => thread::sleep(Duration::from_millis(30)),
        }
    }
}
