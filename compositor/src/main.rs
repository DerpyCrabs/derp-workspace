//! Binary entry: winit-backed compositor or `--headless` for CI / integration tests.

use std::{path::PathBuf, time::Duration};

use clap::Parser;
use compositor::{
    chrome_bridge::NoOpChromeBridge,
    headless,
    state::{CompositorInitOptions, SocketConfig},
    winit,
    CalloopData, CompositorState,
};
use smithay::reexports::{calloop::EventLoop, wayland_server::Display};

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

    /// Spawn this command once the compositor is ready (optional).
    #[arg(short, long, value_name = "CMD")]
    command: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(env_filter) = tracing_subscriber::EnvFilter::try_from_default_env() {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .init();
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
        };
        let run_for = cli.run_for_ms.map(Duration::from_millis);
        headless::run(opts, run_for)?;
        return Ok(());
    }

    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display: Display<CompositorState> = Display::new()?;
    let display_handle = display.handle();

    let init = CompositorInitOptions {
        socket: cli
            .socket
            .map(SocketConfig::Fixed)
            .unwrap_or(SocketConfig::Auto),
        seat_name: "winit".to_string(),
        chrome_bridge: std::sync::Arc::new(NoOpChromeBridge),
    };

    let state = CompositorState::new(&mut event_loop, display, init);
    tracing::info!(socket = ?state.socket_name, "Compositor listening");

    let mut data = CalloopData {
        state,
        display_handle,
    };

    winit::init_winit(&mut event_loop, &mut data)?;

    if let Some(cmd) = cli.command {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        std::process::Command::new(sh).arg("-c").arg(&cmd).spawn().ok();
    }

    event_loop.run(None, &mut data, |_| {})?;

    Ok(())
}
