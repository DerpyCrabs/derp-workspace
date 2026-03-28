use std::time::Duration;

use smithay::{
    backend::{
        renderer::{
            damage::OutputDamageTracker,
            element::{memory::MemoryRenderBufferRenderElement, Kind},
            gles::GlesRenderer,
        },
        winit::{self, WinitEvent},
    },
    desktop::Window,
    output::{Mode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::calloop::EventLoop,
    utils::{Point, Rectangle, Size, Transform},
};

use crate::{shell_ipc, shell_letterbox, CalloopData, CompositorState};

pub fn init_winit(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    let display_handle = &mut data.display_handle;
    let state = &mut data.state;

    let (mut backend, winit) = winit::init()?;

    let mode = Mode {
        size: backend.window_size(),
        refresh: 60_000,
    };

    // Rough physical size in mm (~96 DPI) so wl_output isn’t advertised as 0×0 mm.
    let mm_w = ((mode.size.w.max(1) as f64) * 25.4 / 96.0).round() as i32;
    let mm_h = ((mode.size.h.max(1) as f64) * 25.4 / 96.0).round() as i32;

    let output = Output::new(
        "winit".to_string(),
        PhysicalProperties {
            size: (mm_w.max(1), mm_h.max(1)).into(),
            subpixel: Subpixel::Unknown,
            make: "derp-workspace".into(),
            model: "Winit".into(),
        },
    );
    let _global = output.create_global::<CompositorState>(display_handle);
    output.change_current_state(
        Some(mode),
        Some(Transform::Flipped180),
        Some(Scale::Fractional(backend.scale_factor())),
        Some((0, 0).into()),
    );
    output.set_preferred(mode);

    state.space.map_output(&output, (0, 0));
    state.shell_window_physical_px = (mode.size.w, mode.size.h);

    let mut damage_tracker = OutputDamageTracker::from_output(&output);

    std::env::set_var("WAYLAND_DISPLAY", &state.socket_name);

    event_loop
        .handle()
        .insert_source(winit, move |event, _, data| {
            let display = &mut data.display_handle;
            let state = &mut data.state;

            match event {
                WinitEvent::Resized { size, scale_factor } => {
                    state.shell_window_physical_px = (size.w, size.h);
                    output.change_current_state(
                        Some(Mode {
                            size,
                            refresh: 60_000,
                        }),
                        None,
                        Some(Scale::Fractional(scale_factor)),
                        None,
                    );
                    state.send_shell_output_geometry();
                }
                WinitEvent::Input(event) => {
                    // Keep in sync with winit’s CursorMoved denominator (`inner_size` at event time).
                    let ws = backend.window_size();
                    state.shell_window_physical_px = (ws.w, ws.h);
                    state.process_input_event(event);
                }
                WinitEvent::Redraw => {
                    shell_ipc::drain_shell_stream(state);

                    let size = backend.window_size();
                    let damage = Rectangle::from_size(size);

                    {
                        let (renderer, mut framebuffer) = backend.bind().unwrap();
                        let out_size = output.current_mode().map(|m| m.size).unwrap_or(size);

                        // Letterbox in **output logical** space; physical `location` matches Smithay’s
                        // `logical.to_physical(scale)` path used inside `from_buffer`.
                        let geo = state.space.output_geometry(&output);
                        let scale_f = output.current_scale().fractional_scale();
                        let (shell_loc_phys, shell_size_logical) = if let Some(g) = geo {
                            if let Some((ox_l, oy_l, cw_l, ch_l)) =
                                state.shell_letterbox_logical(g.size)
                            {
                                let px = (g.loc.x as f64 + ox_l as f64) * scale_f;
                                let py = (g.loc.y as f64 + oy_l as f64) * scale_f;
                                (Point::from((px, py)), Size::from((cw_l, ch_l)))
                            } else {
                                (Point::from((0.0f64, 0.0f64)), g.size)
                            }
                        } else {
                            (
                                Point::from((0.0f64, 0.0f64)),
                                Size::from((out_size.w, out_size.h)),
                            )
                        };

                        let mut custom: Vec<MemoryRenderBufferRenderElement<GlesRenderer>> =
                            Vec::new();
                        if state.shell_has_frame {
                            // Full-buffer `src`: see [`crate::shell_letterbox`] (regression tests there).
                            let src_full_buffer = state
                                .shell_view_px
                                .map(|(bw, bh)| shell_letterbox::full_buffer_src_rect(bw, bh));
                            match MemoryRenderBufferRenderElement::from_buffer(
                                renderer,
                                shell_loc_phys,
                                &state.shell_memory_buffer,
                                None,
                                src_full_buffer,
                                Some(shell_size_logical),
                                Kind::Unspecified,
                            ) {
                                Ok(el) => custom.push(el),
                                Err(e) => tracing::warn!(
                                    ?e,
                                    "shell overlay: MemoryRenderBufferRenderElement failed"
                                ),
                            }
                        }

                        smithay::desktop::space::render_output::<
                            _,
                            MemoryRenderBufferRenderElement<GlesRenderer>,
                            Window,
                            _,
                        >(
                            &output,
                            renderer,
                            &mut framebuffer,
                            1.0,
                            0,
                            [&state.space],
                            custom.as_slice(),
                            &mut damage_tracker,
                            [0.1, 0.1, 0.1, 1.0],
                        )
                        .unwrap();
                    }
                    backend.submit(Some(&[damage])).unwrap();

                    state.space.elements().for_each(|window| {
                        window.send_frame(
                            &output,
                            state.start_time.elapsed(),
                            Some(Duration::ZERO),
                            |_, _| Some(output.clone()),
                        )
                    });

                    state.space.refresh();
                    state.popups.cleanup();
                    let _ = display.flush_clients();

                    backend.window().request_redraw();
                }
                WinitEvent::CloseRequested => {
                    crate::sidecar::terminate_sidecar(&mut data.command_child);
                    state.loop_signal.stop();
                }
                _ => (),
            };
        })?;

    Ok(())
}
