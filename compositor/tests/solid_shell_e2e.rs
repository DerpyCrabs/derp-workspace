//! Opt-in E2E: headless compositor + real `cef_host` loading `shell/dist` (SolidJS).
//!
//! Run (Linux, after `cargo build -p cef_host` and `(cd shell && npm run build)`):
//! ```text
//! RUN_SOLID_SHELL_E2E=1 cargo test -p compositor solid_shell_overlay_drawn -- --ignored
//! ```
//!
//! Writes `solid_shell_overlay.png` in the temp runtime dir (via `DERP_SHELL_E2E_SCREENSHOT`).
//! A passing test means the **PN**G is not flat: it asserts BT.709 luma **spread** across a 3×3
//! sample grid, which the Solid shell’s diagonal gradient and panel satisfy (see `App.css`).
//!
//! Set `DERP_SHELL_E2E_KEEP_SCREENSHOT=1` to copy the PNG to `target/solid_e2e_last.png` under
//! the workspace root for manual inspection.
//!
//! Loads `shell/dist/index.html` via `file://` (absolute path). The Vite build uses `base: './'` and
//! strips `crossorigin` on scripts so ES modules work from `file://`. Paths with unusual characters
//! may need RFC 8089 percent-encoding; typical workspace paths are fine.
//!
//! Requires `readelf` on `PATH`. Clears `LD_LIBRARY_PATH` for `cef_host` so its `RUNPATH` selects
//! the matching `libcef.so`.
//!
//! Faster regression checks (no Chromium): `cargo test -p compositor --lib shell_osr` and
//! `cargo test -p cef_host --lib`. This PNG/luma test is disabled: dma-buf frames are not read back to CPU for E2E yet.

#![cfg(target_os = "linux")]

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;

const WL_SOCKET: &str = "derp-solid-shell-e2e";
const SHELL_SOCK: &str = "derp-solid-shell-ipc.sock";
const COMPOSITOR_MS: &str = "240000";

#[derive(Debug, Deserialize)]
struct ShellE2eStatus {
    width: u32,
    height: u32,
    min_luma: f64,
    max_luma: f64,
    spread: f64,
    has_frame: bool,
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn workspace_shell_index() -> PathBuf {
    workspace_root().join("shell/dist/index.html")
}

fn shell_index_file_url(index: &Path) -> String {
    let abs = index.canonicalize().unwrap_or_else(|_| index.to_path_buf());
    format!("file://{}", abs.display())
}

fn workspace_target_debug_bin(name: &str) -> PathBuf {
    workspace_root().join("target/debug").join(name)
}

fn read_runpath_dir(elf: &Path) -> PathBuf {
    let out = Command::new("readelf")
        .args(["-d"])
        .arg(elf)
        .output()
        .expect("run `readelf` (install binutils)");
    assert!(
        out.status.success(),
        "readelf failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .find(|l| l.contains("RUNPATH") && l.contains('['))
        .expect("cef_host ELF missing RUNPATH (rebuild cef_host)");
    let open = line.find('[').expect("RUNPATH parse");
    let close = line.rfind(']').expect("RUNPATH parse");
    PathBuf::from(line[open + 1..close].trim())
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
                if st.has_frame && st.width >= 200 && st.height >= 200 {
                    return st;
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!(
        "timed out waiting for valid {} (CEF did not paint or compositor did not apply frames)",
        path.display()
    );
}

/// SolidJS shell uses a dark gradient plus light text; an empty/black OSR buffer is mostly ~0 luma.
/// Sample a coarse grid on the PNG; gradient + light text produce noticeably different lumas.
fn rgba_sample_luma_spread(rgba: &image::RgbaImage) -> (u8, u8) {
    let (w, h) = rgba.dimensions();
    let xs = [w / 12, w / 2, w.saturating_sub(w / 12).max(1)];
    let ys = [h / 12, h / 2, h.saturating_sub(h / 12).max(1)];
    let mut lumas: Vec<u8> = Vec::new();
    for y in ys {
        for x in xs {
            let p = rgba.get_pixel((x).min(w - 1), (y).min(h - 1));
            let v = (0.0722 * p[2] as f32 + 0.7152 * p[1] as f32 + 0.2126 * p[0] as f32)
                .round()
                .clamp(0.0, 255.0) as u8;
            lumas.push(v);
        }
    }
    let mn = *lumas.iter().min().unwrap();
    let mx = *lumas.iter().max().unwrap();
    (mn, mx)
}

fn looks_like_shell_content(st: &ShellE2eStatus) -> bool {
    if !st.has_frame {
        return false;
    }
    let strong_signal = st.max_luma >= 90.0 || st.spread >= 12.0;
    let not_blank = st.max_luma >= 18.0;
    strong_signal && not_blank
}

#[test]
#[ignore = "dma-buf OSR: no DERP_SHELL_E2E CPU screenshot/luma yet; also set RUN_SOLID_SHELL_E2E=1 if re-enabled"]
fn solid_shell_overlay_drawn() {
    assert_eq!(
        std::env::var("RUN_SOLID_SHELL_E2E").as_deref(),
        Ok("1"),
        "set RUN_SOLID_SHELL_E2E=1 to run this integration test"
    );

    let index = workspace_shell_index();
    assert!(
        index.is_file(),
        "missing {} — run: (cd shell && npm ci && npm run build)",
        index.display()
    );

    let cef_bin = workspace_target_debug_bin("cef_host");
    assert!(
        cef_bin.is_file(),
        "build cef_host first: cargo build -p cef_host (expected {})",
        cef_bin.display()
    );

    let cef_dir = read_runpath_dir(&cef_bin);
    assert!(
        cef_dir.join("libcef.so").is_file(),
        "RUNPATH dir missing libcef.so: {}",
        cef_dir.display()
    );

    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = dir.path();
    let status_path = runtime.join("shell_e2e_status.json");
    let screenshot_path = runtime.join("solid_shell_overlay.png");
    let url = shell_index_file_url(&index);

    let compositor_bin = env!("CARGO_BIN_EXE_compositor");
    let mut compositor = Command::new(compositor_bin)
        .env("XDG_RUNTIME_DIR", runtime)
        .env("DERP_ALLOW_SHELL_SPAWN", "1")
        .env("DERP_SHELL_E2E_STATUS", &status_path)
        .env("DERP_SHELL_E2E_SCREENSHOT", &screenshot_path)
        .args([
            "--headless",
            "--socket",
            WL_SOCKET,
            "--shell-ipc-socket",
            SHELL_SOCK,
            "--run-for-ms",
            COMPOSITOR_MS,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn compositor");

    wait_path_exists(&runtime.join(WL_SOCKET), Duration::from_secs(15)).expect("wayland socket");
    wait_path_exists(&runtime.join(SHELL_SOCK), Duration::from_secs(15)).expect("shell ipc socket");

    let mut cef_host = Command::new(&cef_bin)
        .env("XDG_RUNTIME_DIR", runtime)
        .env("CEF_PATH", &cef_dir)
        .env_remove("LD_LIBRARY_PATH")
        .args([
            "--url",
            url.as_str(),
            "--compositor-socket",
            SHELL_SOCK,
            "--width",
            "800",
            "--height",
            "600",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn cef_host");

    let st = wait_shell_status(&status_path, Duration::from_secs(180));

    // Let the last OSR frame finish writing JSON/PNG; `kill()` uses SIGKILL, which can truncate
    // an in-progress `image::save` on the final path (0-byte png).
    thread::sleep(Duration::from_millis(600));

    let _ = cef_host.kill();
    let _ = cef_host.wait();
    let _ = compositor.kill();
    let _ = compositor.wait();

    assert!(
        screenshot_path.is_file(),
        "missing screenshot {} (DERP_SHELL_E2E_SCREENSHOT); compositor must write PNG on each frame",
        screenshot_path.display()
    );
    let png_len = fs::metadata(&screenshot_path)
        .expect("screenshot stat")
        .len();
    assert!(
        png_len > 800,
        "screenshot png too small ({png_len} bytes); encoding may have failed — {}",
        screenshot_path.display()
    );

    let shot = image::open(&screenshot_path).expect("screenshot png");
    let rgba = shot.to_rgba8();
    let (sw, sh) = rgba.dimensions();
    assert!(
        sw >= 200 && sh >= 200,
        "screenshot size unexpectedly small: {sw}x{sh}"
    );
    let mut max_chan = 0u8;
    for p in rgba.pixels() {
        max_chan = max_chan.max(p[0]).max(p[1]).max(p[2]);
    }
    assert!(
        max_chan >= 18,
        "screenshot looks uniformly dark (max RGB channel {}); open {} to inspect",
        max_chan,
        screenshot_path.display()
    );

    let (luma_lo, luma_hi) = rgba_sample_luma_spread(&rgba);
    let luma_spread = luma_hi.saturating_sub(luma_lo);
    assert!(
        luma_spread >= 6,
        "screenshot looks flat (BT.709 luma min={luma_lo} max={luma_hi}); expected Solid gradient/panel contrast in {} — is shell/dist built with vite base: './'?",
        screenshot_path.display()
    );

    if std::env::var_os("DERP_SHELL_E2E_KEEP_SCREENSHOT").is_some() {
        let keep = workspace_root().join("target/solid_e2e_last.png");
        if let Some(parent) = keep.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(&screenshot_path, &keep);
        eprintln!("copied screenshot to {}", keep.display());
    }

    assert!(
        looks_like_shell_content(&st),
        "frame looks blank or unlike Solid shell (min_luma={}, max_luma={}, spread={}): \
         expect light text or gradient contrast — got {:?}. Screenshot: {}",
        st.min_luma,
        st.max_luma,
        st.spread,
        st,
        screenshot_path.display()
    );
}
