use std::{ffi::OsString, sync::Arc};

use smithay::reexports::calloop::{generic::Generic, EventLoop, Interest, Mode, PostAction};
use smithay::reexports::wayland_server::Display;
use smithay::wayland::socket::ListeningSocketSource;

use crate::state::{ClientState, CompositorState, SocketConfig};
use crate::CalloopData;

pub fn init_wayland_listener(
    display: Display<CompositorState>,
    event_loop: &mut EventLoop<CalloopData>,
    socket: &SocketConfig,
) -> Result<OsString, String> {
    let listening_socket = match socket {
        SocketConfig::Auto => ListeningSocketSource::new_auto()
            .map_err(|e| format!("wayland socket auto-bind: {e}"))?,
        SocketConfig::Fixed(name) => ListeningSocketSource::with_name(name)
            .map_err(|e| format!("wayland socket bind {name}: {e}"))?,
    };

    let socket_name = listening_socket.socket_name().to_os_string();
    let loop_handle = event_loop.handle();

    loop_handle
        .insert_source(listening_socket, move |client_stream, _, state| {
            if let Err(e) = state
                .display_handle
                .insert_client(client_stream, Arc::new(ClientState::default()))
            {
                tracing::warn!(?e, "wayland client insert failed");
            }
        })
        .map_err(|e| format!("wayland listener source insert: {e}"))?;

    loop_handle
        .insert_source(
            Generic::new(display, Interest::READ, Mode::Level),
            |_, display, state| {
                unsafe {
                    if let Err(e) = display.get_mut().dispatch_clients(&mut state.state) {
                        tracing::warn!(?e, "wayland client dispatch failed");
                    }
                }
                state.state.handle_pending_wayland_client_disconnects();
                if std::mem::take(&mut state.state.wayland_commit_needs_render) {
                    if let Some(drms) = state.drm.as_mut() {
                        drms.request_render();
                    }
                }
                Ok(PostAction::Continue)
            },
        )
        .map_err(|e| format!("wayland display source insert: {e}"))?;

    Ok(socket_name)
}
