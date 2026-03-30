#![cfg(unix)]

use libc;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use clap::Parser;
use compositor::{
    cef,
    chrome_bridge::NoOpChromeBridge,
    drm,
    state::{CompositorInitOptions, SocketConfig},
    xwayland,
    CalloopData,
    CompositorState,
};
use smithay::backend::session::libseat::LibSeatSession;
use smithay::backend::session::Session;
use smithay::reexports::{calloop::EventLoop, wayland_server::Display};

#[derive(Parser, Debug)]
#[command(name = "compositor", about = "Minimal Smithay Wayland compositor with CEF shell")]
struct Cli {
    #[arg(long, value_name = "NAME")]
    socket: Option<String>,

    #[arg(short, long, value_name = "CMD")]
    command: Option<String>,

    #[arg(long, env = "CEF_SHELL_URL", value_name = "URL")]
    cef_shell_url: Option<String>,
}

fn default_wayland_socket_name() -> String {
    format!("wayland-d{}", unsafe { libc::getuid() })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if let Some(code) = cef::maybe_run_cef_subprocess_only() {
        std::process::exit(code);
    }

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("warn,derp_input=debug,derp_shell_osr=info")
    });
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .init();

    tracing::warn!(
        target: "derp_shell_sync",
        "compositor startup"
    );

    let cli = Cli::parse();
    let socket_name = cli
        .socket
        .unwrap_or_else(default_wayland_socket_name);

    let Some(cef_url) = cli.cef_shell_url else {
        return Err(
            "CEF_SHELL_URL or --cef-shell-url is required (Solid shell page URL)".into(),
        );
    };

    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display: Display<CompositorState> = Display::new()?;
    let display_handle = display.handle();

    let (session, notifier) = LibSeatSession::new()?;

    let shell_to_cef = Arc::new(Mutex::new(None));
    let cef_handshake = Arc::new(AtomicBool::new(false));

    let init = CompositorInitOptions {
        socket: SocketConfig::Fixed(socket_name),
        seat_name: session.seat().to_string(),
        chrome_bridge: Arc::new(NoOpChromeBridge),
        shell_to_cef: shell_to_cef.clone(),
        shell_cef_handshake: Some(cef_handshake.clone()),
        shell_ipc_stall_timeout: Some(std::time::Duration::from_secs(5)),
    };

    let state = CompositorState::new(&mut event_loop, display, init);
    tracing::info!(socket = ?state.socket_name, "Compositor listening");

    let mut data = CalloopData {
        state,
        display_handle,
        command_child: None,
        pending_sidecar_cmd: None,
        drm: None,
    };

    let vt_session = session.clone();
    drm::init_drm(&mut event_loop, &mut data, session, notifier)?;
    data.state.set_vt_session(Some(vt_session));

    cef::spawn_cef_ui_thread(
        cef_url,
        data.state.cef_to_compositor_tx.clone(),
        shell_to_cef.clone(),
        cef_handshake,
    );

    data.pending_sidecar_cmd = cli.command.clone();
    if let Err(e) = xwayland::start_xwayland(&mut event_loop, &mut data) {
        tracing::error!(%e, "XWayland failed to spawn; continuing without DISPLAY");
        xwayland::spawn_pending_sidecar(&mut data);
    }

    let loop_stop = data.state.loop_signal.clone();
    let request_restart = Arc::new(AtomicBool::new(false));
    let request_restart_thread = Arc::clone(&request_restart);
    std::thread::Builder::new()
        .name("signal-hook-stop".into())
        .spawn(move || {
            use signal_hook::consts::signal::*;
            use signal_hook::iterator::Signals;
            if let Ok(mut signals) = Signals::new([SIGINT, SIGTERM, SIGUSR2]) {
                if let Some(sig) = signals.forever().next() {
                    if sig == SIGUSR2 {
                        request_restart_thread.store(true, Ordering::SeqCst);
                        tracing::info!(
                            "SIGUSR2: graceful stop for reload (exit 42 after --command teardown)"
                        );
                    } else {
                        tracing::info!(
                            sig,
                            "caught, stopping compositor and tearing down --command"
                        );
                    }
                    loop_stop.stop();
                    loop_stop.wakeup();
                }
            }
        })
        .expect("signal-hook thread");

    event_loop.run(None, &mut data, |_| {})?;
    compositor::sidecar::terminate_sidecar(&mut data.command_child);

    if request_restart.load(Ordering::SeqCst) {
        std::process::exit(42);
    }

    Ok(())
}
