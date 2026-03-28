//! Binary entry: winit-backed compositor or `--headless` for CI / integration tests.

use std::{path::PathBuf, time::Duration};

use clap::Parser;
use compositor::{
    chrome_bridge::NoOpChromeBridge,
    drm,
    headless,
    state::{CompositorInitOptions, SocketConfig},
    winit, CalloopData, CompositorState,
};
use smithay::backend::session::libseat::LibSeatSession;
use smithay::backend::session::Session;
use smithay::reexports::{calloop::EventLoop, wayland_server::Display};

#[derive(Clone, Copy, Debug, Default, clap::ValueEnum)]
enum CompositorBackend {
    /// Nested window via winit (development).
    #[default]
    Winit,
    /// KMS/DRM session (GDM, tty). Requires libseat/logind and a seat.
    Drm,
}

#[derive(Parser, Debug)]
#[command(name = "compositor", about = "Minimal Smithay Wayland compositor")]
struct Cli {
    /// Fixed `WAYLAND_DISPLAY` socket name (under `XDG_RUNTIME_DIR`). Default: auto `wayland-N`.
    #[arg(long, value_name = "NAME")]
    socket: Option<String>,

    /// Run without a winit window (socket + software tick only).
    #[arg(long)]
    headless: bool,

    /// Exit after this many milliseconds (headless only; integration tests).
    #[arg(long, value_name = "MS")]
    run_for_ms: Option<u64>,

    /// Spawn `sh -c CMD` after startup (optional). The process group is signaled when the window
    /// closes / the event loop exits (e.g. tears down `cef_host`).
    #[arg(short, long, value_name = "CMD")]
    command: Option<String>,

    /// Shell pixel IPC socket name under `XDG_RUNTIME_DIR` (winit and headless; default on winit: derp-shell.sock).
    #[arg(long, value_name = "NAME")]
    shell_ipc_socket: Option<String>,

    /// Graphics backend when not using `--headless`.
    #[arg(long, value_enum, default_value_t = CompositorBackend::Winit)]
    backend: CompositorBackend,

    /// DRM node path (`--backend drm`). Overrides `DERP_DRM_DEVICE` and primary GPU detection.
    #[arg(long, value_name = "PATH")]
    drm_device: Option<PathBuf>,
}

fn shell_e2e_status_from_env() -> Option<PathBuf> {
    std::env::var_os("DERP_SHELL_E2E_STATUS").map(PathBuf::from)
}

fn shell_e2e_screenshot_from_env() -> Option<PathBuf> {
    std::env::var_os("DERP_SHELL_E2E_SCREENSHOT").map(PathBuf::from)
}

/// If set to a positive integer, exit when `cef_host` sends no shell IPC messages for this many seconds.
fn shell_ipc_stall_timeout_from_env() -> Option<Duration> {
    let Ok(raw) = std::env::var("DERP_SHELL_WATCHDOG_SEC") else {
        return None;
    };
    let secs: u64 = raw.trim().parse().ok()?;
    if secs == 0 {
        return None;
    }
    Some(Duration::from_secs(secs))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(env_filter) = tracing_subscriber::EnvFilter::try_from_default_env() {
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
    } else {
        tracing_subscriber::fmt().init();
    }

    let cli = Cli::parse();

    if cli.headless {
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            let fallback = PathBuf::from("/tmp");
            tracing::warn!("XDG_RUNTIME_DIR unset; using /tmp (set per-test for isolation)");
            std::env::set_var("XDG_RUNTIME_DIR", fallback);
        }

        let opts = CompositorInitOptions {
            socket: cli
                .socket
                .map(SocketConfig::Fixed)
                .unwrap_or(SocketConfig::Auto),
            seat_name: "headless".to_string(),
            chrome_bridge: std::sync::Arc::new(NoOpChromeBridge),
            shell_ipc_socket: cli.shell_ipc_socket.clone(),
            shell_e2e_status_path: shell_e2e_status_from_env(),
            shell_e2e_screenshot_path: shell_e2e_screenshot_from_env(),
            shell_ipc_stall_timeout: shell_ipc_stall_timeout_from_env(),
        };
        let run_for = cli.run_for_ms.map(Duration::from_millis);
        headless::run(opts, run_for)?;
        return Ok(());
    }

    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display: Display<CompositorState> = Display::new()?;
    let display_handle = display.handle();

    let drm_session_setup = match cli.backend {
        CompositorBackend::Drm => {
            let (session, notifier) = LibSeatSession::new()?;
            Some((session, notifier))
        }
        CompositorBackend::Winit => None,
    };

    let init = CompositorInitOptions {
        socket: cli
            .socket
            .map(SocketConfig::Fixed)
            .unwrap_or(SocketConfig::Auto),
        seat_name: drm_session_setup
            .as_ref()
            .map(|(s, _)| s.seat())
            .unwrap_or_else(|| "winit".to_string()),
        chrome_bridge: std::sync::Arc::new(NoOpChromeBridge),
        shell_ipc_socket: Some(
            cli.shell_ipc_socket
                .clone()
                .unwrap_or_else(|| "derp-shell.sock".to_string()),
        ),
        shell_e2e_status_path: shell_e2e_status_from_env(),
        shell_e2e_screenshot_path: shell_e2e_screenshot_from_env(),
        shell_ipc_stall_timeout: shell_ipc_stall_timeout_from_env(),
    };

    let state = CompositorState::new(&mut event_loop, display, init);
    tracing::info!(socket = ?state.socket_name, "Compositor listening");

    let mut data = CalloopData {
        state,
        display_handle,
        command_child: None,
        drm: None,
    };

    match cli.backend {
        CompositorBackend::Winit => {
            #[cfg(feature = "winit-backend")]
            {
                winit::init_winit(&mut event_loop, &mut data)?;
            }
            #[cfg(not(feature = "winit-backend"))]
            {
                return Err("compositor built without winit-backend".into());
            }
        }
        CompositorBackend::Drm => {
            let (session, notifier) = drm_session_setup.expect("drm session");
            drm::init_drm(
                &mut event_loop,
                &mut data,
                session,
                notifier,
                cli.drm_device.clone(),
            )?;
        }
    }

    if let Some(cmd) = cli.command {
        match compositor::sidecar::spawn_shell_command_line(&cmd) {
            Ok(child) => {
                data.command_child = Some(child);
                tracing::info!("spawned --command sidecar (pid will own a new process group)");
            }
            Err(e) => tracing::warn!(%e, "failed to spawn --command"),
        }
    }

    // Without this, SIGINT/SIGTERM (terminal, systemd, pkill) aborts the process before
    // `event_loop.run` returns and `terminate_sidecar` never runs — CEF subprocesses linger.
    let loop_stop = data.state.loop_signal.clone();
    std::thread::Builder::new()
        .name("signal-hook-stop".into())
        .spawn(move || {
            use signal_hook::consts::signal::*;
            use signal_hook::iterator::Signals;
            if let Ok(mut signals) = Signals::new([SIGINT, SIGTERM]) {
                if let Some(sig) = signals.forever().next() {
                    tracing::info!(
                        sig,
                        "caught, stopping compositor and tearing down --command"
                    );
                    loop_stop.stop();
                    loop_stop.wakeup();
                }
            }
        })
        .expect("signal-hook thread");

    event_loop.run(None, &mut data, |_| {})?;
    compositor::sidecar::terminate_sidecar(&mut data.command_child);

    Ok(())
}
