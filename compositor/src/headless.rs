//! Headless compositor loop: Wayland socket + software frame tick, no winit/EGL window.
//! Used for `--headless` and integration tests via subprocess + `WAYLAND_DISPLAY`.

use std::time::Duration;

use smithay::{
    desktop::Window,
    output::{Mode, Output, PhysicalProperties, Subpixel},
    reexports::calloop::{
        timer::{TimeoutAction, Timer},
        EventLoop,
    },
    utils::Transform,
};

use crate::{shell_ipc, CalloopData, CompositorInitOptions, CompositorState};

pub fn run(
    options: CompositorInitOptions,
    run_for: Option<Duration>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut event_loop: EventLoop<CalloopData> = EventLoop::try_new()?;
    let display = smithay::reexports::wayland_server::Display::new()?;
    let display_handle = display.handle();
    let state = CompositorState::new(&mut event_loop, display, options);
    let socket_name = state.socket_name.clone();
    let mut data = CalloopData {
        state,
        display_handle,
        command_child: None,
        drm: None,
    };

    let dh = data.display_handle.clone();
    let mode = Mode {
        size: (800, 600).into(),
        refresh: 60_000,
    };
    let output = Output::new(
        "headless".to_string(),
        PhysicalProperties {
            size: (0, 0).into(),
            subpixel: Subpixel::Unknown,
            make: "derp-workspace".into(),
            model: "Headless".into(),
        },
    );
    let _global = output.create_global::<CompositorState>(&dh);
    output.change_current_state(
        Some(mode),
        Some(Transform::Normal),
        None,
        Some((0, 0).into()),
    );
    output.set_preferred(mode);
    data.state.space.map_output(&output, (0, 0));

    let output_for_timer = output.clone();
    let deadline = run_for.map(|d| std::time::Instant::now() + d);
    event_loop
        .handle()
        .insert_source(Timer::from_duration(Duration::from_millis(16)), {
            move |_, _, data| {
                if let Some(end) = deadline {
                    if std::time::Instant::now() >= end {
                        data.state.loop_signal.stop();
                        return TimeoutAction::Drop;
                    }
                }

                shell_ipc::drain_shell_stream(&mut data.state);
                data.state.space.refresh();
                data.state.popups.cleanup();

                data.state.space.elements().for_each(|window: &Window| {
                    window.send_frame(
                        &output_for_timer,
                        data.state.start_time.elapsed(),
                        Some(Duration::ZERO),
                        |_, _| Some(output_for_timer.clone()),
                    );
                });

                let _ = data.display_handle.flush_clients();
                TimeoutAction::ToDuration(Duration::from_millis(16))
            }
        })
        .expect("timer");

    std::env::set_var("WAYLAND_DISPLAY", &socket_name);
    tracing::info!(?socket_name, "Headless compositor listening");

    event_loop.run(None, &mut data, |_| {})?;
    Ok(())
}
