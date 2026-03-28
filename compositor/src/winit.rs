use std::time::Duration;

use smithay::{
    backend::{
        renderer::{
            damage::{Error as OutputDamageError, OutputDamageTracker, RenderOutputResult},
            element::{
                memory::MemoryRenderBufferRenderElement,
                AsRenderElements, Kind,
            },
            gles::{GlesError, GlesRenderer},
            Renderer,
        },
        winit::{self, WinitEvent},
    },
    desktop::{
        space::space_render_elements,
        Window,
    },
    output::{Mode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::calloop::EventLoop,
    utils::{Physical, Point, Rectangle, Size, Transform},
};

use crate::{
    desktop_stack::DesktopStack, pointer_render, shell_ipc, shell_letterbox, CalloopData,
    CompositorState,
};

pub fn init_winit(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
) -> Result<(), Box<dyn std::error::Error>> {
    let display_handle = &mut data.display_handle;
    let state = &mut data.state;

    // Default Smithay attributes (`vsync: false`): nested EGL + vsync-on has stalled or confused
    // some host compositor + driver stacks; post-swap `buffer_age()` caused BAD_SURFACE/context loss.
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
    state.touch_abs_is_window_pixels = true;

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
                    state.refresh_all_surface_fractional_scales();
                    state.needs_winit_redraw = true;
                }
                WinitEvent::Input(event) => {
                    // Keep in sync with winit’s CursorMoved denominator (`inner_size` at event time).
                    let ws = backend.window_size();
                    state.shell_window_physical_px = (ws.w, ws.h);
                    state.process_input_event(event);
                }
                WinitEvent::Redraw => {
                    shell_ipc::drain_shell_stream(state);
                    state.shell_check_ipc_watchdog();

                    let size = backend.window_size();

                    enum PendingSubmit {
                        None,
                        Damage(Vec<Rectangle<i32, Physical>>),
                        Full,
                    }

                    let submit = {
                        let (renderer, mut framebuffer) = backend.bind().unwrap();
                        // Never call `backend.buffer_age()` before `bind()` (nested EGL BAD_SURFACE).
                        // We also avoid `buffer_age()` after `submit`: same class of failures on some drivers.
                        // Smithay: treat age `0` as full repaint — correct, slightly more GPU work.
                        let buffer_age = 0usize;
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

                        // `OutputDamageTracker::render_output` expects **front-to-back** order (first entry =
                        // topmost). Pointer → toplevels → shell OSR so the cursor is never covered by the
                        // Solid/CEF plane and native windows stay above the shell.
                        let render_res: Result<
                            RenderOutputResult<'_>,
                            OutputDamageError<GlesError>,
                        > = match space_render_elements(
                            renderer,
                            [&state.space],
                            &output,
                            1.0,
                        ) {
                            Ok(space_els) => {
                                let mut render_elements: Vec<
                                    DesktopStack<
                                        '_,
                                        GlesRenderer,
                                        <Window as AsRenderElements<GlesRenderer>>::RenderElement,
                                        MemoryRenderBufferRenderElement<GlesRenderer>,
                                    >,
                                > = Vec::with_capacity(space_els.len() + custom.len() + 2);
                                pointer_render::append_pointer_desktop_elements(
                                    state,
                                    renderer,
                                    &output,
                                    &mut render_elements,
                                );
                                render_elements
                                    .extend(space_els.into_iter().map(DesktopStack::Space));
                                render_elements
                                    .extend(custom.iter().map(DesktopStack::Shell));

                                damage_tracker.render_output(
                                    renderer,
                                    &mut framebuffer,
                                    buffer_age,
                                    &render_elements,
                                    [0.1, 0.1, 0.1, 1.0],
                                )
                            }
                            Err(e) => Err(e.into()),
                        };

                        match render_res {
                            Ok(result) => {
                                if let Some(damage) = result.damage {
                                    PendingSubmit::Damage(damage.clone())
                                } else {
                                    let _ = renderer.cleanup_texture_cache();
                                    PendingSubmit::None
                                }
                            }
                            Err(e) => {
                                tracing::warn!(?e, "render_output");
                                PendingSubmit::Full
                            }
                        }
                    };

                    let content_advanced = match &submit {
                        PendingSubmit::Damage(d) => !d.is_empty(),
                        PendingSubmit::Full => true,
                        PendingSubmit::None => false,
                    };

                    // Always swap after `bind()`/`render_output`. Use partial damage only when the
                    // tracker produced non-empty regions; `None` means full-surface swap (Smithay).
                    let damage_for_swap: Option<&[Rectangle<i32, Physical>]> = match &submit {
                        PendingSubmit::Damage(d) if !d.is_empty() => Some(d.as_slice()),
                        _ => None,
                    };
                    let submitted = match backend.submit(damage_for_swap) {
                        Ok(()) => true,
                        Err(e) => {
                            tracing::warn!(?e, "winit submit");
                            false
                        }
                    };
                    if submitted && content_advanced {
                        state.space.elements().for_each(|window| {
                            window.send_frame(
                                &output,
                                state.start_time.elapsed(),
                                Some(Duration::ZERO),
                                |_, _| Some(output.clone()),
                            )
                        });
                    }

                    state.space.refresh();
                    state.popups.cleanup();
                    let _ = display.flush_clients();

                    // Do not tie the redraw loop to `shell_has_frame` — that forces compositing every
                    // winit tick while Chrome has ever sent a frame. New frames set `needs_winit_redraw`.
                    let schedule_next = content_advanced || state.needs_winit_redraw;
                    state.needs_winit_redraw = false;
                    if schedule_next {
                        backend.window().request_redraw();
                    }
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
