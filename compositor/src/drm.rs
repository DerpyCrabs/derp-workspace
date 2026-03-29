//! KMS/DRM session: libseat session, GBM scanout, EGL GLES, libinput. For GDM / tty logins.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use smithay::backend::renderer::{ImportDma, ImportEgl};
use smithay::backend::session::libseat::LibSeatSessionNotifier;
use smithay::backend::{
    allocator::{
        gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        Format, Fourcc,
    },
    drm::{DrmDevice, DrmDeviceFd, DrmEvent, DrmSurface, GbmBufferedSurface},
    egl::{context::ContextPriority, EGLContext, EGLDisplay},
    libinput::{LibinputInputBackend, LibinputSessionInterface},
    renderer::{
        damage::{Error as OutputDamageError, OutputDamageTracker, RenderOutputResult},
        element::AsRenderElements,
        gles::{GlesError, GlesRenderer},
        Bind, Renderer,
    },
    session::{
        libseat::LibSeatSession,
        Event as SessionEvent, Session,
    },
    udev::primary_gpu,
};
use smithay::desktop::space::space_render_elements;

use crate::derp_space::DerpSpaceElem;
use smithay::output::{Mode as OutputMode, Output, PhysicalProperties, Scale, Subpixel};
use smithay::reexports::{
    calloop::{
        timer::{TimeoutAction, Timer},
        EventLoop, LoopHandle,
    },
    drm::{
        control::{
            connector::{self, State as ConnectorState},
            crtc,
            Device as ControlDevice,
            Mode as DrmCtlMode,
        },
        Device as DrmFdDevice,
    },
    input::Libinput,
    rustix::fs::OFlags,
};
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::utils::{DeviceFd, Physical, Rectangle, Size, Transform};
use tracing::{debug, error, info, warn};

/// How many `(drm_fourcc, modifier)` pairs to log when sampling EGL import caps (avoid huge logs).
const DERP_EGL_DMABUF_FORMAT_SAMPLE_LEN: usize = 32;

fn log_egl_dmabuf_caps_after_drm_init(renderer: &GlesRenderer) {
    let rf = renderer.egl_context().dmabuf_render_formats();
    let tf = renderer.dmabuf_formats();
    let render_sample: Vec<(u32, u64)> = rf
        .iter()
        .take(DERP_EGL_DMABUF_FORMAT_SAMPLE_LEN)
        .map(|f| (f.code as u32, u64::from(f.modifier)))
        .collect();
    let texture_sample: Vec<(u32, u64)> = tf
        .iter()
        .take(DERP_EGL_DMABUF_FORMAT_SAMPLE_LEN)
        .map(|f| (f.code as u32, u64::from(f.modifier)))
        .collect();
    debug!(
        target: "derp_drm",
        egl_render_format_count = rf.iter().count(),
        egl_texture_import_format_count = tf.iter().count(),
        sample_egl_render_formats = ?render_sample,
        sample_egl_texture_import_formats = ?texture_sample,
        "EGL dma-buf capability snapshot (enable RUST_LOG=derp_drm=debug)"
    );
}

use crate::{
    desktop_stack::DesktopStack, pointer_render, shell_ipc, CalloopData, CompositorState,
};

/// Live DRM presentation state (one CRTC / connector set, v1).
pub struct DrmSession {
    pub drm: DrmDevice,
    pub gbm_surface: GbmBufferedSurface<GbmAllocator<DrmDeviceFd>, ()>,
    pub renderer: Arc<Mutex<GlesRenderer>>,
    damage_tracker: OutputDamageTracker,
    pub output: Output,
    _crtc: crtc::Handle,
    libinput: Libinput,
    loop_handle: LoopHandle<'static, CalloopData>,
    /// Cleared after a successful `frame_submitted` so we only schedule one idle per flip.
    pending_frame_complete: bool,
    _egl_display: EGLDisplay,
    _gbm_device: GbmDevice<DrmDeviceFd>,
}

impl DrmSession {
    fn pause(&mut self) {
        let _ = self.libinput.suspend();
        self.drm.pause();
    }

    fn activate(&mut self) {
        if let Err(e) = self.drm.activate(false) {
            warn!(?e, "drm activate");
        }
        if let Err(e) = self.libinput.resume() {
            warn!(?e, "libinput resume");
        }
    }

    fn schedule_render(&mut self) {
        self.loop_handle.insert_idle(|data| {
            drm_idle_render(data);
        });
    }

    fn on_vblank(&mut self) {
        if let Err(e) = self.gbm_surface.frame_submitted() {
            warn!(?e, "drm frame_submitted");
        }
        self.pending_frame_complete = false;
        self.schedule_render();
    }

    fn render_tick(&mut self, state: &mut CompositorState, display: &mut DisplayHandle) {

        shell_ipc::drain_shell_stream(state);
        state.shell_check_ipc_watchdog();

        if !self.drm.is_active() {
            return;
        }

        if self.pending_frame_complete {
            return;
        }

        let (mut dmabuf, buffer_age) = match self.gbm_surface.next_buffer() {
            Ok(x) => x,
            Err(e) => {
                warn!(?e, "drm next_buffer (busy or inactive); retry later");
                let h = self.loop_handle.clone();
                let _ = h.insert_source(Timer::from_duration(Duration::from_millis(4)), |_, _, d| {
                    drm_idle_render(d);
                    TimeoutAction::Drop
                });
                return;
            }
        };

        let output = &self.output;

        enum PendingSubmit {
            None,
            Damage(Vec<Rectangle<i32, Physical>>),
            Full,
        }

        let (submit, sync_for_queue) = {
            let Ok(mut renderer_guard) = self.renderer.lock() else {
                warn!("drm renderer mutex poisoned");
                return;
            };
            let renderer = &mut *renderer_guard;
            let mut fb_target = match renderer.bind(&mut dmabuf) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "drm bind dmabuf");
                    drop(renderer_guard);
                    self.schedule_render();
                    return;
                }
            };

            let render_res: Result<RenderOutputResult<'_>, OutputDamageError<GlesError>> =
                match space_render_elements(renderer, [&state.space], output, 1.0) {
                    Ok(space_els) => {
                        type Desk<'a> = DesktopStack<
                            'a,
                            <DerpSpaceElem as AsRenderElements<GlesRenderer>>::RenderElement,
                        >;
                        let mut render_elements: Vec<Desk<'_>> =
                            Vec::with_capacity(space_els.len() + 2);
                        pointer_render::append_pointer_desktop_elements(
                            state,
                            renderer,
                            output,
                            &mut render_elements,
                        );
                        let shell_dma = match crate::shell_render::compositor_shell_dmabuf_element(
                            state, renderer, output,
                        ) {
                            Ok(s) => s,
                            Err(e) => {
                                warn!(
                                    target: "derp_shell_dmabuf",
                                    ?e,
                                    "DRM render path: shell dma-buf layer skipped (details on this target above)"
                                );
                                None
                            }
                        };
                        if state.shell_presentation_fullscreen {
                            if let Some(ref el) = shell_dma {
                                render_elements.push(DesktopStack::ShellDma(el));
                            }
                            render_elements
                                .extend(space_els.into_iter().map(DesktopStack::Space));
                        } else {
                            render_elements
                                .extend(space_els.into_iter().map(DesktopStack::Space));
                            if let Some(ref el) = shell_dma {
                                render_elements.push(DesktopStack::ShellDma(el));
                            }
                        }

                        self.damage_tracker.render_output(
                            renderer,
                            &mut fb_target,
                            buffer_age as usize,
                            &render_elements,
                            [0.1, 0.1, 0.1, 1.0],
                        )
                    }
                    Err(e) => Err(e.into()),
                };

            match render_res {
                Ok(result) => {
                    let sync = result.sync;
                    let submit = if let Some(damage) = result.damage {
                        PendingSubmit::Damage(damage.clone())
                    } else {
                        let _ = renderer.cleanup_texture_cache();
                        PendingSubmit::None
                    };
                    (submit, sync)
                }
                Err(e) => {
                    warn!(?e, "drm render_output");
                    (
                        PendingSubmit::Full,
                        smithay::backend::renderer::sync::SyncPoint::signaled(),
                    )
                }
            }
        };

        let content_advanced = match &submit {
            PendingSubmit::Damage(d) => !d.is_empty(),
            PendingSubmit::Full => true,
            PendingSubmit::None => false,
        };

        let damage_for_queue: Option<Vec<Rectangle<i32, Physical>>> = match &submit {
            PendingSubmit::Damage(d) if !d.is_empty() => Some(d.clone()),
            _ => None,
        };

        if let Err(e) = self
            .gbm_surface
            .queue_buffer(Some(sync_for_queue), damage_for_queue, ())
        {
            warn!(?e, "drm queue_buffer");
            self.schedule_render();
            return;
        }

        self.pending_frame_complete = true;

        if content_advanced || state.needs_winit_redraw {
            state.space.elements().for_each(|elem| match elem {
                DerpSpaceElem::Wayland(window) => {
                    window.send_frame(
                        output,
                        state.start_time.elapsed(),
                        Some(Duration::ZERO),
                        |_, _| Some(output.clone()),
                    );
                }
                DerpSpaceElem::X11(x11) => {
                    if let Some(surf) = x11.wl_surface() {
                        smithay::desktop::utils::send_frames_surface_tree(
                            &surf,
                            output,
                            state.start_time.elapsed(),
                            Some(Duration::ZERO),
                            |_, _| Some(output.clone()),
                        );
                    }
                }
            });
        }
        state.needs_winit_redraw = false;

        state.space.refresh();
        state.popups.cleanup();
        let _ = display.flush_clients();
    }
}

fn drm_idle_render(data: &mut CalloopData) {
    let Some(drms) = data.drm.as_mut() else {
        return;
    };
    drms.render_tick(&mut data.state, &mut data.display_handle);
}

fn pick_crtc_and_surface(
    drm: &mut DrmDevice,
) -> Result<(DrmSurface, crtc::Handle, DrmCtlMode, Vec<connector::Handle>), String> {
    let handles = drm
        .resource_handles()
        .map_err(|e| format!("resource_handles: {e}"))?;
    for &conn in handles.connectors() {
        let info = drm
            .get_connector(conn, false)
            .map_err(|e| format!("get_connector: {e}"))?;
        if info.state() != ConnectorState::Connected {
            continue;
        }
        let Some(mode) = info.modes().first().copied() else {
            continue;
        };
        for &enc in info.encoders() {
            let enc_info = match drm.get_encoder(enc) {
                            Ok(e) => e,
                Err(_) => continue,
            };
            let crtcs = handles.filter_crtcs(enc_info.possible_crtcs());
            if let Some(&crtc_h) = crtcs.first() {
                let surface = drm
                    .create_surface(crtc_h, mode, &[conn])
                    .map_err(|e| format!("create_surface: {e}"))?;
                return Ok((surface, crtc_h, mode, vec![conn]));
            }
        }
    }
    Err("no connected connector with mode".into())
}

/// Start DRM backend: GPU scanout, libinput, session VT hooks. `session` must be the seat from [`LibSeatSession::new`].
pub fn init_drm(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
    mut session: LibSeatSession,
    session_notifier: LibSeatSessionNotifier,
    drm_device_override: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let loop_handle = event_loop.handle().clone();
    let loop_handle_static: LoopHandle<'static, CalloopData> =
        unsafe { std::mem::transmute(loop_handle.clone()) };

    // Libseat enables the seat asynchronously. Opening the DRM node before `SeatEvent::Enable`
    // is processed often prevents `DRM_IOCTL_SET_MASTER` (Smithay logs "assuming unprivileged mode").
    event_loop
        .handle()
        .insert_source(session_notifier, move |event, _, d| match event {
            SessionEvent::PauseSession => {
                if let Some(drms) = d.drm.as_mut() {
                    drms.pause();
                }
            }
            SessionEvent::ActivateSession => {
                if let Some(drms) = d.drm.as_mut() {
                    drms.activate();
                }
                drm_idle_render(d);
            }
        })
        .map_err(|e| format!("session notifier: {e}"))?;

    let seat_wait = std::time::Duration::from_millis(
        std::env::var("DERP_DRM_SEAT_WAIT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5_000),
    );
    let seat_deadline = std::time::Instant::now() + seat_wait;
    while !session.is_active() && std::time::Instant::now() < seat_deadline {
        event_loop
            .dispatch(Some(std::time::Duration::from_millis(20)), data)
            .map_err(|e| format!("event_loop.dispatch (wait for libseat): {e}"))?;
    }
    if session.is_active() {
        info!("libseat session active before DRM device open");
    } else {
        warn!(
            ?seat_wait,
            "libseat session still inactive; DRM master may fail if another process holds it or logind has not activated this seat"
        );
    }

    let path: PathBuf = if let Some(p) = drm_device_override {
        p
    } else if let Ok(p) = std::env::var("DERP_DRM_DEVICE") {
        PathBuf::from(p)
    } else {
        primary_gpu(session.seat())
            .map_err(|e| format!("primary_gpu: {e}"))?
            .ok_or_else(|| "no DRM device for seat (try DERP_DRM_DEVICE=/dev/dri/card0)".to_string())?
    };

    info!(path = %path.display(), "Opening DRM device via session");
    let fd = session
        .open(path.as_path(), OFlags::RDWR | OFlags::CLOEXEC)
        .map_err(|e| format!("session.open drm: {e}"))?;
    let drm_fd = DrmDeviceFd::new(DeviceFd::from(fd));
    let gbm_drm_fd = drm_fd.clone();
    let (mut drm, drm_notifier) =
        DrmDevice::new(drm_fd, true).map_err(|e| format!("DrmDevice::new: {e}"))?;

    let drm_driver_name = drm
        .get_driver()
        .ok()
        .map(|d| d.name.to_string_lossy().into_owned());
    let drm_client_authenticated = drm.authenticated().ok();
    debug!(
        target: "derp_drm",
        seat = %session.seat(),
        drm_path = %path.display(),
        libseat_active = session.is_active(),
        drm_atomic = drm.is_atomic(),
        drm_driver_name = drm_driver_name.as_deref(),
        drm_client_authenticated,
        smithay_master_hint = "if drm master acquisition failed, Smithay logs WARN 'Unable to become drm master, assuming unprivileged mode' immediately before 'DrmDevice initializing'",
        "DRM device opened"
    );

    let (drm_surface, crtc_h, drm_mode, conns) = pick_crtc_and_surface(&mut drm)?;
    let conn_info = drm
        .get_connector(conns[0], false)
        .map_err(|e| format!("get_connector (props): {e}"))?;
    let (phys_w, phys_h) = conn_info
        .size()
        .map(|(w, h)| (w as i32, h as i32))
        .unwrap_or_else(|| {
            let (pw, ph) = drm_mode.size();
            let w = ((pw as f64) * 25.4 / 96.0).round() as i32;
            let h = ((ph as f64) * 25.4 / 96.0).round() as i32;
            (w.max(1), h.max(1))
        });
    let output_name = conn_info.to_string();

    let gbm = GbmDevice::new(gbm_drm_fd)
        .map_err(|e| format!("GbmDevice: {e}"))?;
    let egl_display =
        unsafe { EGLDisplay::new(gbm.clone()).map_err(|e| format!("EGLDisplay: {e}"))? };
    let egl_ctx = EGLContext::new_with_priority(&egl_display, ContextPriority::High)
        .map_err(|e| format!("EGLContext: {e}"))?;
    let mut renderer =
        unsafe { GlesRenderer::new(egl_ctx).map_err(|e| format!("GlesRenderer: {e}"))? };

    log_egl_dmabuf_caps_after_drm_init(&renderer);

    let dh = data.display_handle.clone();
    if let Err(e) = renderer.bind_wl_display(&dh) {
        warn!(?e, "bind_wl_display (drm); clients may lack EGL buffers");
    }

    let mut formats: HashSet<Format> = renderer.dmabuf_formats().iter().copied().collect();
    formats.retain(|f| {
        matches!(
            f.code,
            Fourcc::Argb8888 | Fourcc::Xrgb8888 | Fourcc::Abgr8888 | Fourcc::Xbgr8888
        )
    });
    if formats.is_empty() {
        formats = renderer.dmabuf_formats().iter().copied().collect();
    }
    let format_vec: Vec<Format> = formats.into_iter().collect();

    let linux_dmabuf_formats = crate::state::formats_for_linux_dmabuf_global(&renderer);

    let renderer = Arc::new(Mutex::new(renderer));
    data.state.dmabuf_import_renderer = Some(Arc::downgrade(&renderer));
    data.state
        .init_linux_dmabuf_global(linux_dmabuf_formats.iter().copied());

    let color_formats = [
        Fourcc::Xrgb8888,
        Fourcc::Argb8888,
        Fourcc::Abgr8888,
        Fourcc::Argb8888,
    ];
    let allocator = GbmAllocator::new(
        gbm.clone(),
        GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT,
    );
    let gbm_surface = GbmBufferedSurface::new(
        drm_surface,
        allocator,
        &color_formats,
        format_vec,
    )
    .map_err(|e| format!("GbmBufferedSurface: {e}"))?;

    let (mw, mh) = drm_mode.size();
    let mode = OutputMode {
        size: Size::from((mw as i32, mh as i32)),
        refresh: (drm_mode.vrefresh() as i32).saturating_mul(1000).max(1),
    };
    let output = Output::new(
        output_name,
        PhysicalProperties {
            size: (phys_w.max(1), phys_h.max(1)).into(),
            subpixel: Subpixel::Unknown,
            make: "derp-workspace".into(),
            model: "DRM".into(),
        },
    );
    let _global = output.create_global::<CompositorState>(&mut data.display_handle);
    output.change_current_state(
        Some(mode),
        Some(Transform::Normal),
        Some(Scale::Integer(1)),
        Some((0, 0).into()),
    );
    output.set_preferred(mode);

    data.state.space.map_output(&output, (0, 0));
    data.state.shell_window_physical_px = (mode.size.w, mode.size.h);
    data.state.send_shell_output_geometry();
    data.state.shell_embedded_notify_output_ready();
    data.state.refresh_all_surface_fractional_scales();

    let damage_tracker = OutputDamageTracker::from_output(&output);

    std::env::set_var("WAYLAND_DISPLAY", &data.state.socket_name);

    let mut libinput_context =
        Libinput::new_with_udev(LibinputSessionInterface::from(session.clone()));
    libinput_context
        .udev_assign_seat(session.seat().as_ref())
        .map_err(|()| "udev_assign_seat failed".to_string())?;
    let libinput_backend = LibinputInputBackend::new(libinput_context.clone());

    event_loop
        .handle()
        .insert_source(libinput_backend, move |event, _, d| {
            d.state.process_input_event(event);
        })
        .map_err(|e| format!("libinput insert_source: {e}"))?;

    let crtc_for_drm = crtc_h;
    event_loop
        .handle()
        .insert_source(drm_notifier, move |event, _meta, d| match event {
            DrmEvent::VBlank(c) if c == crtc_for_drm => {
                if let Some(drms) = d.drm.as_mut() {
                    drms.on_vblank();
                }
            }
            DrmEvent::Error(err) => error!(?err, "DRM event error"),
            _ => {}
        })
        .map_err(|e| format!("drm notifier: {e}"))?;

    let drm_session = DrmSession {
        drm,
        gbm_surface,
        renderer,
        damage_tracker,
        output,
        _crtc: crtc_h,
        libinput: libinput_context,
        loop_handle: loop_handle_static,
        pending_frame_complete: false,
        _egl_display: egl_display,
        _gbm_device: gbm,
    };
    data.drm = Some(drm_session);

    loop_handle.insert_idle(|d| {
        drm_idle_render(d);
    });

    Ok(())
}
