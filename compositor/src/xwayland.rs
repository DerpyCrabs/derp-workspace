use std::io;
use std::process::Stdio;

use crate::{sidecar, CalloopData};
use smithay::reexports::calloop::{EventLoop, LoopHandle};
use smithay::xwayland::{X11Wm, XWayland, XWaylandEvent};

pub fn spawn_pending_sidecar(data: &mut CalloopData) {
    if let Some(cmd) = data.pending_sidecar_cmd.take() {
        match sidecar::spawn_shell_command_line(&cmd) {
            Ok(child) => {
                data.command_child = Some(child);
                tracing::debug!("spawned --command sidecar");
            }
            Err(e) => tracing::warn!(%e, "failed to spawn --command"),
        }
    }
}

pub fn start_xwayland(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> io::Result<()> {
    let dh = data.display_handle.clone();
    let (xwayland, client) = XWayland::spawn(
        &dh,
        None::<u32>,
        std::iter::empty::<(&str, &str)>(),
        true,
        Stdio::inherit(),
        Stdio::inherit(),
        |_| (),
    )?;

    let loop_handle: LoopHandle<'static, CalloopData> =
        unsafe { std::mem::transmute(event_loop.handle().clone()) };

    tracing::debug!("XWayland subprocess spawned (waiting for DISPLAY; needs `Xwayland` on PATH)");

    event_loop
        .handle()
        .insert_source(xwayland, move |event, _, d: &mut CalloopData| match event {
            XWaylandEvent::Ready {
                x11_socket,
                display_number,
            } => {
                std::env::set_var("DISPLAY", format!(":{}", display_number));
                tracing::warn!(
                    display = display_number,
                    "XWayland ready; DISPLAY set for OSR / child processes"
                );
                match X11Wm::start_wm(loop_handle.clone(), &dh, x11_socket, client.clone()) {
                    Ok(wm) => {
                        let id = wm.id();
                        tracing::warn!(xwm_id = ?id, "X11Wm::start_wm succeeded");
                        d.state.x11_wm_slot = Some((id, wm));
                    }
                    Err(e) => {
                        d.state.x11_wm_slot = None;
                        tracing::error!(?e, "X11Wm::start_wm failed");
                    }
                }
                spawn_pending_sidecar(d);
            }
            XWaylandEvent::Error => {
                d.state.x11_wm_slot = None;
                tracing::error!("XWayland failed to start (is `xwayland` installed?)");
                spawn_pending_sidecar(d);
            }
        })
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    Ok(())
}
