use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    session::{libseat::LibSeatSession, Event as SessionEvent, Session},
    udev::primary_gpu,
};
use smithay::desktop::space::space_render_elements;

use crate::render::derp_space_render;

use crate::derp_space::DerpSpaceElem;
use smithay::output::{Mode as OutputMode, Output, PhysicalProperties, Subpixel};
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::reexports::{
    calloop::{
        generic::{Generic, NoIoDrop},
        timer::{TimeoutAction, Timer},
        EventLoop, Interest, LoopHandle, Mode, PostAction,
    },
    drm::{
        control::{
            connector::{self, State as ConnectorState},
            crtc, Device as ControlDevice, Mode as DrmCtlMode,
        },
        Device as DrmFdDevice,
    },
    input::Libinput,
    rustix::fs::OFlags,
};
use smithay::utils::{DeviceFd, Physical, Rectangle, Transform};
use tracing::{debug, error, info, warn};

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
    desktop::desktop_stack::{DesktopStack, SpaceExclusionClip},
    render::pointer_render,
    CalloopData, CompositorState,
};

pub struct DrmHead {
    pub gbm_surface: GbmBufferedSurface<GbmAllocator<DrmDeviceFd>, ()>,
    damage_tracker: OutputDamageTracker,
    pub output: Output,
    pub connector_name: String,
    pub connector: connector::Handle,
    crtc: crtc::Handle,
    pending_frame_complete: bool,
    last_vblank_at: Option<Instant>,
}

impl DrmHead {
    fn on_vblank_inner(&mut self) {
        if let Err(e) = self.gbm_surface.frame_submitted() {
            warn!(?e, "drm frame_submitted");
        }
        self.pending_frame_complete = false;
        self.last_vblank_at = Some(Instant::now());
    }

    fn render_one(
        &mut self,
        drm: &DrmDevice,
        renderer: &Arc<Mutex<GlesRenderer>>,
        loop_handle: &LoopHandle<'static, CalloopData>,
        state: &mut CompositorState,
        _display: &mut DisplayHandle,
    ) -> (bool, bool) {
        let output = &self.output;

        if !drm.is_active() {
            return (false, false);
        }

        if self.pending_frame_complete {
            return (false, false);
        }

        let (mut dmabuf, buffer_age) = match self.gbm_surface.next_buffer() {
            Ok(x) => x,
            Err(e) => {
                warn!(?e, "drm next_buffer (busy or inactive); retry later");
                let h = loop_handle.clone();
                let _ =
                    h.insert_source(Timer::from_duration(Duration::from_millis(4)), |_, _, d| {
                        drm_idle_render(d);
                        TimeoutAction::Drop
                    });
                return (false, false);
            }
        };

        enum PendingSubmit {
            None,
            Damage(Vec<Rectangle<i32, Physical>>),
            Full,
        }

        let (submit, sync_for_queue) = {
            let Ok(mut renderer_guard) = renderer.lock() else {
                warn!("drm renderer mutex poisoned");
                return (false, false);
            };
            let renderer = &mut *renderer_guard;
            let mut fb_target = match renderer.bind(&mut dmabuf) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "drm bind dmabuf");
                    drop(renderer_guard);
                    loop_handle.insert_idle(|d| drm_idle_render(d));
                    return (false, false);
                }
            };

            type Desk<'a> =
                DesktopStack<'a, <DerpSpaceElem as AsRenderElements<GlesRenderer>>::RenderElement>;
            let output_scale = output.current_scale().fractional_scale();

            let mut render_elements: Vec<Desk<'_>> = Vec::new();
            pointer_render::append_pointer_desktop_elements(
                state,
                renderer,
                output,
                &mut render_elements,
            );
            crate::render::screenshot_overlay_render::append_screenshot_overlay_for_output(
                state,
                output,
                &mut render_elements,
            );
            crate::render::tile_preview_render::append_tile_preview_for_output(
                state,
                output,
                &mut render_elements,
            );
            let shell_render = match crate::render::shell_render::compositor_shell_render_elements(
                state, renderer, output,
            ) {
                Ok(render) => render,
                Err(e) => {
                    warn!(
                        target: "derp_shell_dmabuf",
                        ?e,
                        "DRM render path: shell dma-buf layers skipped (details on this target above)"
                    );
                    crate::render::shell_render::ShellOutputRenderElements::default()
                }
            };

            let cc = state.desktop_background_config.solid_rgba;

            let render_res: Result<RenderOutputResult<'_>, OutputDamageError<GlesError>> =
                if state.shell_presentation_fullscreen {
                    match space_render_elements(renderer, [&state.space], output, 1.0) {
                        Ok(space_els) => {
                            for el in &shell_render.move_proxy {
                                render_elements.push(DesktopStack::ShellDma(el));
                            }
                            if let Some(ref el) = shell_render.dmabuf {
                                render_elements.push(DesktopStack::ShellDma(el));
                            }
                            render_elements.extend(space_els.into_iter().map(|el| {
                                DesktopStack::Space(
                                crate::desktop::desktop_stack::FractionalDamageSpaceElements::new(
                                    el,
                                    output_scale,
                                ),
                            )
                            }));
                            let (backdrop, backdrop_force_full_damage) =
                                crate::render::backdrop_render::desktop_backdrop_layers(
                                    state,
                                    output,
                                    output_scale,
                                );
                            for s in backdrop.solids {
                                render_elements.push(DesktopStack::BackdropSolid(s));
                            }
                            for t in backdrop.textures {
                                render_elements.push(DesktopStack::BackdropTex(t));
                            }
                            let capture_needs_full_damage =
                                state.active_image_copy_capture_sessions > 0
                                    || state.capture_force_full_damage_frames > 0
                                    || !state.pending_screencopy_copies.is_empty()
                                    || !state.pending_image_copy_captures.is_empty();
                            let age_for_render = if state.shell_exclusion_zones_need_full_damage
                                || state.screenshot_overlay_needs_full_damage
                                || shell_render.force_full_damage
                                || backdrop_force_full_damage
                                || capture_needs_full_damage
                            {
                                0usize
                            } else {
                                buffer_age as usize
                            };
                            let out = self.damage_tracker.render_output(
                                renderer,
                                &mut fb_target,
                                age_for_render,
                                &render_elements,
                                [cc[0], cc[1], cc[2], cc[3]],
                            );
                            if out.is_ok() {
                                state.shell_exclusion_zones_need_full_damage = false;
                                state.screenshot_overlay_needs_full_damage = false;
                                if state.capture_force_full_damage_frames > 0 {
                                    state.capture_force_full_damage_frames -= 1;
                                }
                            }
                            out
                        }
                        Err(e) => Err(e.into()),
                    }
                } else {
                    for el in &shell_render.move_proxy {
                        render_elements.push(DesktopStack::ShellDma(el));
                    }
                    let tagged = derp_space_render::derp_space_render_elements_with_window_ids(
                        &state.space,
                        state,
                        renderer,
                        output,
                        1.0,
                    );
                    let ordered_window_ids_on_output = state.ordered_window_ids_on_output(output);
                    for (el, wid, include_self_decor) in tagged {
                        let excl_ctx = state.shell_exclusion_clip_ctx_for_draw(
                            output,
                            wid,
                            include_self_decor,
                            Some(&ordered_window_ids_on_output),
                        );
                        match excl_ctx {
                            None => render_elements.push(DesktopStack::Space(
                                crate::desktop::desktop_stack::FractionalDamageSpaceElements::new(
                                    el,
                                    output_scale,
                                ),
                            )),
                            Some(ctx) => render_elements.push(DesktopStack::SpaceClip(
                                SpaceExclusionClip::new(el, output_scale, ctx),
                            )),
                        }
                    }
                    let bypass_shell = state.output_has_fullscreen_native_direct_path(output);
                    if bypass_shell {
                        crate::cef::begin_frame_diag::note_drm_fullscreen_shell_bypass();
                    }
                    if !bypass_shell {
                        if let Some(ref el) = shell_render.dmabuf {
                            render_elements.push(DesktopStack::ShellDma(el));
                        }
                    }
                    let (backdrop, backdrop_force_full_damage) =
                        crate::render::backdrop_render::desktop_backdrop_layers(
                            state,
                            output,
                            output_scale,
                        );
                    for s in backdrop.solids {
                        render_elements.push(DesktopStack::BackdropSolid(s));
                    }
                    for t in backdrop.textures {
                        render_elements.push(DesktopStack::BackdropTex(t));
                    }
                    let capture_needs_full_damage = state.active_image_copy_capture_sessions > 0
                        || state.capture_force_full_damage_frames > 0
                        || !state.pending_screencopy_copies.is_empty()
                        || !state.pending_image_copy_captures.is_empty();
                    let age_for_render = if state.shell_exclusion_zones_need_full_damage
                        || state.screenshot_overlay_needs_full_damage
                        || shell_render.force_full_damage
                        || backdrop_force_full_damage
                        || capture_needs_full_damage
                    {
                        0usize
                    } else {
                        buffer_age as usize
                    };
                    let out = self.damage_tracker.render_output(
                        renderer,
                        &mut fb_target,
                        age_for_render,
                        &render_elements,
                        [cc[0], cc[1], cc[2], cc[3]],
                    );
                    if out.is_ok() {
                        state.shell_exclusion_zones_need_full_damage = false;
                        state.screenshot_overlay_needs_full_damage = false;
                        if state.capture_force_full_damage_frames > 0 {
                            state.capture_force_full_damage_frames -= 1;
                        }
                    }
                    out
                };

            if render_res.is_ok() {
                state.screenshot_capture_output_if_needed(output, renderer, &fb_target);
                state.process_screencopy_output_if_needed(output, renderer, &fb_target);
                state.process_ext_image_copy_capture_output_if_needed(output, renderer, &fb_target);
            }

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
            loop_handle.insert_idle(|d| drm_idle_render(d));
            return (false, false);
        }

        self.pending_frame_complete = true;

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

        (content_advanced, true)
    }
}

pub struct DrmSession {
    pub drm: DrmDevice,
    pub renderer: Arc<Mutex<GlesRenderer>>,
    pub heads: Vec<DrmHead>,
    libinput: Libinput,
    loop_handle: LoopHandle<'static, CalloopData>,
    _egl_display: EGLDisplay,
    _gbm_device: GbmDevice<DrmDeviceFd>,
    output_formats: Vec<Format>,
    hotplug_retry_after: HashMap<connector::Handle, Instant>,
    drm_idle_render_armed: bool,
    drm_late_render_armed: bool,
}

impl DrmSession {
    fn frame_interval(&self) -> Duration {
        self.heads
            .iter()
            .filter_map(|head| head.output.current_mode())
            .filter_map(|mode| u64::try_from(mode.refresh.max(1)).ok())
            .map(|refresh| Duration::from_nanos((1_000_000_000_000u64 / refresh).max(1)))
            .min()
            .unwrap_or(Duration::from_millis(16))
    }

    fn render_late_margin(&self) -> Duration {
        let interval = self.frame_interval();
        (interval / 4).clamp(Duration::from_millis(2), Duration::from_millis(5))
    }

    fn next_late_render_target(&self) -> Option<Instant> {
        let interval = self.frame_interval();
        let margin = self.render_late_margin();
        self.heads
            .iter()
            .filter_map(|head| head.last_vblank_at.map(|at| at + interval - margin))
            .min()
    }

    fn shell_begin_min_when_active(&self) -> Duration {
        let refresh_milli_hz = self
            .heads
            .iter()
            .filter_map(|head| head.output.current_mode())
            .filter_map(|mode| u64::try_from(mode.refresh.max(1)).ok())
            .map(|refresh| refresh.min(60_000))
            .max()
            .unwrap_or(60_000);
        Duration::from_nanos((1_000_000_000_000u64 / refresh_milli_hz.max(1)).max(1))
    }

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

    fn on_vblank(&mut self, crtc_h: crtc::Handle) {
        for head in &mut self.heads {
            if head.crtc == crtc_h {
                head.on_vblank_inner();
                break;
            }
        }
        self.schedule_drm_idle_render_coalesced();
    }

    fn schedule_drm_idle_render_coalesced(&mut self) {
        if self.drm_idle_render_armed || self.drm_late_render_armed {
            return;
        }
        if let Some(target) = self.next_late_render_target() {
            let now = Instant::now();
            if target > now {
                self.drm_late_render_armed = true;
                crate::cef::begin_frame_diag::note_drm_render_late_timer();
                let h = self.loop_handle.clone();
                let delay = target.duration_since(now);
                let _ = h.insert_source(Timer::from_duration(delay), |_, _, d| {
                    if let Some(drms) = d.drm.as_mut() {
                        drms.drm_late_render_armed = false;
                    }
                    drm_idle_render(d);
                    TimeoutAction::Drop
                });
                return;
            }
        }
        self.drm_idle_render_armed = true;
        let h = self.loop_handle.clone();
        h.insert_idle(|d| drm_idle_render(d));
    }

    pub(crate) fn request_render(&mut self) {
        self.schedule_drm_idle_render_coalesced();
    }

    fn prune_disconnected_heads(&mut self, state: &mut CompositorState) {
        let mut any_removed = false;
        let mut i = 0;
        while i < self.heads.len() {
            let conn = self.heads[i].connector;
            let still_here = match self.drm.get_connector(conn, false) {
                Ok(info) => info.state() == ConnectorState::Connected,
                Err(_) => true,
            };
            if still_here {
                i += 1;
                continue;
            }
            let head = self.heads.remove(i);
            any_removed = true;
            info!(
                target: "derp_drm",
                connector = %head.connector_name,
                "connector disconnected; migrating windows and unmapping output"
            );
            state.migrate_windows_before_output_unmapped(&head.output);
            state.space.unmap_output(&head.output);
            self.hotplug_retry_after.remove(&head.connector);
            drop(head);
        }
        if any_removed && !self.heads.is_empty() {
            state.normalize_workspace_to_origin_after_output_removed();
            state.resync_wayland_window_registry_from_space();
            state.shell_after_drm_topology_changed();
        }
        if self.heads.is_empty() {
            warn!(
                target: "derp_drm",
                "all DRM heads disconnected; compositor has no physical outputs"
            );
        }
    }

    fn attach_new_heads(
        &mut self,
        state: &mut CompositorState,
        display: &mut DisplayHandle,
        force_connector_probe: bool,
    ) {
        if !self.drm.is_active() {
            return;
        }
        let now = Instant::now();
        let existing_conn: HashSet<_> = self.heads.iter().map(|h| h.connector).collect();
        let existing_crtc: HashSet<_> = self.heads.iter().map(|h| h.crtc).collect();
        let new_specs = match enumerate_new_crtc_plans(
            &mut self.drm,
            &existing_conn,
            &existing_crtc,
            now,
            &self.hotplug_retry_after,
            force_connector_probe,
        ) {
            Ok(v) => v,
            Err(e) => {
                warn!(target: "derp_drm", err = %e, "enumerate_new_crtc_plans");
                return;
            }
        };
        if new_specs.is_empty() {
            return;
        }

        let shell_sc = CompositorState::wayland_scale_for_shell_ui(state.shell_ui_scale);
        let hotplug_backoff = Duration::from_secs(2);
        let mut shift_total = 0i32;
        let mut planned: Vec<(crtc::Handle, DrmCtlMode, Vec<connector::Handle>, i32)> =
            Vec::with_capacity(new_specs.len());
        for (crtc_h, drm_mode, conns) in new_specs {
            let mode = OutputMode::from(drm_mode);
            let lw = {
                let sz = Transform::Normal
                    .transform_size(mode.size)
                    .to_f64()
                    .to_logical(shell_sc.fractional_scale())
                    .to_i32_ceil();
                std::cmp::max(sz.w, 0)
            };
            shift_total = shift_total.saturating_add(lw);
            planned.push((crtc_h, drm_mode, conns, lw));
        }

        state.translate_workspace_by(shift_total, 0);

        let color_formats = [
            Fourcc::Xrgb8888,
            Fourcc::Argb8888,
            Fourcc::Abgr8888,
            Fourcc::Argb8888,
        ];
        let mut cursor_x = 0i32;
        let cursor_y = 0i32;
        let n_before = self.heads.len();

        for (crtc_h, drm_mode, conns, lw) in planned {
            let drm_surface = match self.drm.create_surface(crtc_h, drm_mode, conns.as_slice()) {
                Ok(s) => s,
                Err(e) => {
                    warn!(target: "derp_drm", ?e, "hotplug create_surface");
                    self.hotplug_retry_after
                        .insert(conns[0], Instant::now() + hotplug_backoff);
                    continue;
                }
            };
            let conn_info = match self.drm.get_connector(conns[0], false) {
                Ok(i) => i,
                Err(e) => {
                    warn!(target: "derp_drm", ?e, "hotplug get_connector");
                    self.hotplug_retry_after
                        .insert(conns[0], Instant::now() + hotplug_backoff);
                    continue;
                }
            };
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
            info!(
                target: "derp_drm",
                connector = %output_name,
                crtc = ?crtc_h,
                pos_x = cursor_x,
                pos_y = cursor_y,
                "hotplug new head"
            );

            let allocator = GbmAllocator::new(
                self._gbm_device.clone(),
                GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT,
            );
            let gbm_surface = match GbmBufferedSurface::new(
                drm_surface,
                allocator,
                &color_formats,
                self.output_formats.clone(),
            ) {
                Ok(s) => s,
                Err(e) => {
                    warn!(target: "derp_drm", ?e, "hotplug GbmBufferedSurface");
                    self.hotplug_retry_after
                        .insert(conns[0], Instant::now() + hotplug_backoff);
                    continue;
                }
            };

            let mode = OutputMode::from(drm_mode);
            self.hotplug_retry_after.remove(&conns[0]);
            let output = Output::new(
                output_name.clone(),
                PhysicalProperties {
                    size: (phys_w.max(1), phys_h.max(1)).into(),
                    subpixel: Subpixel::Unknown,
                    make: "derp-workspace".into(),
                    model: "DRM".into(),
                    serial_number: "N/A".into(),
                },
            );
            let _global = output.create_global::<CompositorState>(display);
            output.change_current_state(
                Some(mode),
                Some(Transform::Normal),
                Some(shell_sc),
                Some((cursor_x, cursor_y).into()),
            );
            output.set_preferred(mode);

            state.space.map_output(&output, (cursor_x, cursor_y));

            cursor_x = cursor_x.saturating_add(lw);

            let damage_tracker = OutputDamageTracker::from_output(&output);

            self.heads.push(DrmHead {
                gbm_surface,
                damage_tracker,
                output,
                connector_name: output_name,
                connector: conns[0],
                crtc: crtc_h,
                pending_frame_complete: false,
                last_vblank_at: None,
            });
        }

        if self.heads.len() == n_before {
            state.translate_workspace_by(-shift_total, 0);
            tracing::warn!(
                target: "derp_hotplug_shell",
                n_before,
                shift_total,
                "hotplug attach rolled back no new heads"
            );
            return;
        }

        tracing::warn!(
            target: "derp_hotplug_shell",
            heads = self.heads.len(),
            n_before,
            shift_total,
            "hotplug attach calling apply_stored_from_heads+shell_after_drm_topology_changed"
        );
        let _ =
            crate::controls::display_config::apply_stored_from_heads(state, &self.drm, &self.heads);
        state.shell_after_drm_topology_changed();
        self.schedule_drm_idle_render_coalesced();
    }

    fn render_tick(&mut self, state: &mut CompositorState, display: &mut DisplayHandle) {
        state.shell_check_ipc_watchdog();

        if state.display_config_save_pending && !state.display_config_save_suppressed {
            state.display_config_save_pending = false;
            crate::controls::display_config::save_from_drm_session(state, self);
        }

        if !self.drm.is_active() {
            return;
        }

        state.sync_shell_shared_state_for_input();
        state.space.refresh();

        crate::cef::begin_frame_diag::note_drm_render_tick();

        let renderer = self.renderer.clone();
        let loop_handle = self.loop_handle.clone();
        let drm_ref = &self.drm;

        if let Ok(mut rg) = renderer.lock() {
            state.sync_desktop_wallpaper_upload(&mut *rg);
            state.shell_native_drag_preview_capture_if_needed(&mut *rg);
        }

        let mut any_advanced = false;
        for head in &mut self.heads {
            let (advanced, _presented) =
                head.render_one(drm_ref, &renderer, &loop_handle, state, display);
            any_advanced |= advanced;
        }

        const SHELL_BEGIN_MIN_WHEN_IDLE: Duration = Duration::from_millis(250);
        let now = Instant::now();
        let schedule_kind = if any_advanced || state.shell_begin_frame_interaction_active(now) {
            crate::cef::begin_frame_diag::CompositorScheduleKind::Active
        } else {
            crate::cef::begin_frame_diag::CompositorScheduleKind::Idle
        };
        let shell_begin_min_when_active = self.shell_begin_min_when_active();
        let min_gap = match schedule_kind {
            crate::cef::begin_frame_diag::CompositorScheduleKind::Idle => SHELL_BEGIN_MIN_WHEN_IDLE,
            crate::cef::begin_frame_diag::CompositorScheduleKind::Active
            | crate::cef::begin_frame_diag::CompositorScheduleKind::Forced => {
                shell_begin_min_when_active
            }
        };
        let shell_send = match state.shell_begin_frame_last {
            None => true,
            Some(t) => now.duration_since(t) >= min_gap,
        };
        if shell_send {
            if let Ok(g) = state.shell_to_cef.lock() {
                if let Some(link) = g.as_ref() {
                    link.schedule_external_begin_frame(schedule_kind);
                }
            }
            state.shell_begin_frame_last = Some(now);
        }

        crate::cef::begin_frame_diag::maybe_log_cef_begin_frame_pacing();

        state.popups.cleanup();
        let _ = display.flush_clients();
    }
}

fn drm_idle_render(data: &mut CalloopData) {
    let Some(drms) = data.drm.as_mut() else {
        return;
    };
    drms.drm_idle_render_armed = false;
    drms.drm_late_render_armed = false;
    drms.render_tick(&mut data.state, &mut data.display_handle);
}

fn drm_connector_topology_sort_key(info: &connector::Info, h: connector::Handle) -> (u8, u32, u32) {
    use connector::Interface as If;
    let kind = match info.interface() {
        If::EmbeddedDisplayPort | If::LVDS | If::DSI => 0u8,
        If::DisplayPort => 1,
        If::HDMIA | If::HDMIB => 2,
        If::DVID | If::DVII | If::DVIA => 3,
        If::VGA => 4,
        _ => 5,
    };
    (kind, info.interface_id(), u32::from(h))
}

fn sort_connected_connector_handles(
    drm: &mut DrmDevice,
    candidates: &[connector::Handle],
    force_probe: bool,
    pred: impl Fn(connector::Handle) -> bool,
) -> Vec<connector::Handle> {
    let mut scored: Vec<(connector::Handle, (u8, u32, u32))> = candidates
        .iter()
        .copied()
        .filter(|&c| pred(c))
        .filter_map(|c| {
            let info = drm.get_connector(c, force_probe).ok()?;
            (info.state() == ConnectorState::Connected)
                .then_some((c, drm_connector_topology_sort_key(&info, c)))
        })
        .collect();
    // Interface id orders DP-1, DP-2, … and HDMI-A-1, … to match kernel naming / scanout expectations.
    scored.sort_by(|a, b| a.1.cmp(&b.1));
    scored.into_iter().map(|(h, _)| h).collect()
}

fn pick_all_crtc_surfaces(
    drm: &mut DrmDevice,
) -> Result<Vec<(DrmSurface, crtc::Handle, DrmCtlMode, Vec<connector::Handle>)>, String> {
    let handles = drm
        .resource_handles()
        .map_err(|e| format!("resource_handles: {e}"))?;
    let connected = sort_connected_connector_handles(drm, handles.connectors(), false, |_| true);

    let mut used_crtcs: HashSet<crtc::Handle> = HashSet::new();
    let mut out = Vec::new();

    for conn in connected {
        let info = drm
            .get_connector(conn, false)
            .map_err(|e| format!("get_connector: {e}"))?;
        let Some(mode) = info.modes().first().copied() else {
            continue;
        };
        let mut picked: Option<crtc::Handle> = None;
        for &enc in info.encoders() {
            let Ok(enc_info) = drm.get_encoder(enc) else {
                continue;
            };
            for crtc_h in handles.filter_crtcs(enc_info.possible_crtcs()) {
                if used_crtcs.contains(&crtc_h) {
                    continue;
                }
                picked = Some(crtc_h);
                break;
            }
            if picked.is_some() {
                break;
            }
        }
        let Some(crtc_h) = picked else {
            continue;
        };
        let surface = drm
            .create_surface(crtc_h, mode, &[conn])
            .map_err(|e| format!("create_surface: {e}"))?;
        used_crtcs.insert(crtc_h);
        out.push((surface, crtc_h, mode, vec![conn]));
    }

    if out.is_empty() {
        return Err("no connected connector with mode".into());
    }
    Ok(out)
}

fn enumerate_new_crtc_plans(
    drm: &mut DrmDevice,
    existing_connectors: &HashSet<connector::Handle>,
    existing_crtcs: &HashSet<crtc::Handle>,
    now: Instant,
    hotplug_retry_after: &HashMap<connector::Handle, Instant>,
    force_probe: bool,
) -> Result<Vec<(crtc::Handle, DrmCtlMode, Vec<connector::Handle>)>, String> {
    let handles = drm
        .resource_handles()
        .map_err(|e| format!("resource_handles: {e}"))?;
    let connected = sort_connected_connector_handles(drm, handles.connectors(), force_probe, |c| {
        !existing_connectors.contains(&c)
            && hotplug_retry_after
                .get(&c)
                .map_or(true, |until| now >= *until)
    });
    let mut used_crtcs: HashSet<crtc::Handle> = existing_crtcs.iter().copied().collect();
    let mut out = Vec::new();
    for conn in connected {
        let info = drm
            .get_connector(conn, force_probe)
            .map_err(|e| format!("get_connector: {e}"))?;
        let Some(mode) = info.modes().first().copied() else {
            continue;
        };
        let mut picked: Option<crtc::Handle> = None;
        for &enc in info.encoders() {
            let Ok(enc_info) = drm.get_encoder(enc) else {
                continue;
            };
            for crtc_h in handles.filter_crtcs(enc_info.possible_crtcs()) {
                if used_crtcs.contains(&crtc_h) {
                    continue;
                }
                picked = Some(crtc_h);
                break;
            }
            if picked.is_some() {
                break;
            }
        }
        let Some(crtc_h) = picked else {
            continue;
        };
        used_crtcs.insert(crtc_h);
        out.push((crtc_h, mode, vec![conn]));
    }
    Ok(out)
}

fn drm_hotplug_on_udev_drm_change(data: &mut CalloopData) {
    let Some(drms) = data.drm.as_mut() else {
        return;
    };
    if !drms.drm.is_active() {
        return;
    }
    let n_before = drms.heads.len();
    drms.prune_disconnected_heads(&mut data.state);
    let n_after_prune = drms.heads.len();
    drms.attach_new_heads(&mut data.state, &mut data.display_handle, true);
    let n_after_attach = drms.heads.len();
    tracing::warn!(
        target: "derp_hotplug_shell",
        n_before,
        n_after_prune,
        n_after_attach,
        "udev drm hotplug finished prune+attach"
    );
}

fn drm_hotplug_timer_prune_only(data: &mut CalloopData) {
    let Some(drms) = data.drm.as_mut() else {
        return;
    };
    if !drms.drm.is_active() {
        return;
    }
    drms.prune_disconnected_heads(&mut data.state);
}

pub fn init_drm(
    event_loop: &mut EventLoop<CalloopData>,
    data: &mut CalloopData,
    mut session: LibSeatSession,
    session_notifier: LibSeatSessionNotifier,
) -> Result<(), Box<dyn std::error::Error>> {
    let loop_handle = event_loop.handle().clone();
    let loop_handle_static: LoopHandle<'static, CalloopData> =
        unsafe { std::mem::transmute(loop_handle.clone()) };

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

    let seat_wait = std::time::Duration::from_millis(5_000);
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

    let path: PathBuf = primary_gpu(session.seat())
        .map_err(|e| format!("primary_gpu: {e}"))?
        .ok_or_else(|| "no DRM device for seat".to_string())?;

    let drm_rdev = std::fs::metadata(path.as_path())
        .map_err(|e| format!("drm metadata: {e}"))?
        .rdev();

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

    let head_specs = pick_all_crtc_surfaces(&mut drm)?;

    let gbm = GbmDevice::new(gbm_drm_fd).map_err(|e| format!("GbmDevice: {e}"))?;
    let egl_display =
        unsafe { EGLDisplay::new(gbm.clone()).map_err(|e| format!("EGLDisplay: {e}"))? };
    let egl_ctx = EGLContext::new_with_priority(&egl_display, ContextPriority::High)
        .map_err(|e| format!("EGLContext: {e}"))?;
    let mut renderer =
        unsafe { GlesRenderer::new(egl_ctx).map_err(|e| format!("GlesRenderer: {e}"))? };

    log_egl_dmabuf_caps_after_drm_init(&renderer);

    let dh = data.display_handle.clone();
    if let Err(e) = renderer.bind_wl_display(&dh) {
        debug!(?e, "bind_wl_display failed");
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
    data.state
        .init_linux_dmabuf_global(&renderer, linux_dmabuf_formats.iter().copied());

    let renderer = Arc::new(Mutex::new(renderer));
    data.state.dmabuf_import_renderer = Some(Arc::downgrade(&renderer));

    let color_formats = [
        Fourcc::Xrgb8888,
        Fourcc::Argb8888,
        Fourcc::Abgr8888,
        Fourcc::Argb8888,
    ];
    let mut cursor_x = 0i32;
    let cursor_y = 0i32;
    let mut heads = Vec::with_capacity(head_specs.len());

    for (drm_surface, crtc_h, drm_mode, conns) in head_specs {
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
        info!(
            target: "derp_drm",
            connector = %output_name,
            crtc = ?crtc_h,
            pos_x = cursor_x,
            pos_y = cursor_y,
            "DRM head"
        );

        let allocator = GbmAllocator::new(
            gbm.clone(),
            GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT,
        );
        let gbm_surface =
            GbmBufferedSurface::new(drm_surface, allocator, &color_formats, format_vec.clone())
                .map_err(|e| format!("GbmBufferedSurface: {e}"))?;

        let mode = OutputMode::from(drm_mode);
        let shell_sc = CompositorState::wayland_scale_for_shell_ui(data.state.shell_ui_scale);
        let logical_stride_w = {
            let sz = Transform::Normal
                .transform_size(mode.size)
                .to_f64()
                .to_logical(shell_sc.fractional_scale())
                .to_i32_ceil();
            std::cmp::max(sz.w, 0)
        };
        let output = Output::new(
            output_name.clone(),
            PhysicalProperties {
                size: (phys_w.max(1), phys_h.max(1)).into(),
                subpixel: Subpixel::Unknown,
                make: "derp-workspace".into(),
                model: "DRM".into(),
                serial_number: "N/A".into(),
            },
        );
        let _global = output.create_global::<CompositorState>(&mut data.display_handle);
        output.change_current_state(
            Some(mode),
            Some(Transform::Normal),
            Some(shell_sc),
            Some((cursor_x, cursor_y).into()),
        );
        output.set_preferred(mode);

        data.state.space.map_output(&output, (cursor_x, cursor_y));

        cursor_x = cursor_x.saturating_add(logical_stride_w);

        let damage_tracker = OutputDamageTracker::from_output(&output);

        heads.push(DrmHead {
            gbm_surface,
            damage_tracker,
            output,
            connector_name: output_name,
            connector: conns[0],
            crtc: crtc_h,
            pending_frame_complete: false,
            last_vblank_at: None,
        });
    }

    let _ = crate::controls::display_config::apply_stored_from_heads(&mut data.state, &drm, &heads);
    data.state.shell_after_drm_topology_changed();
    data.state.shell_embedded_notify_output_ready();

    std::env::set_var("WAYLAND_DISPLAY", &data.state.socket_name);

    let mut libinput_context =
        Libinput::new_with_udev(LibinputSessionInterface::from(session.clone()));
    libinput_context
        .udev_assign_seat(session.seat().as_ref())
        .map_err(|()| "udev_assign_seat failed".to_string())?;
    let libinput_backend = LibinputInputBackend::new(libinput_context.clone());

    let lh_libinput = loop_handle.clone();
    event_loop
        .handle()
        .insert_source(libinput_backend, move |event, _, d| {
            d.state.process_input_event(event, &lh_libinput);
        })
        .map_err(|e| format!("libinput insert_source: {e}"))?;

    event_loop
        .handle()
        .insert_source(drm_notifier, move |event, _meta, d| match event {
            DrmEvent::VBlank(c) => {
                if let Some(drms) = d.drm.as_mut() {
                    drms.on_vblank(c);
                }
            }
            DrmEvent::Error(err) => error!(?err, "DRM event error"),
        })
        .map_err(|e| format!("drm notifier: {e}"))?;

    data.drm = Some(DrmSession {
        drm,
        renderer,
        heads,
        libinput: libinput_context,
        loop_handle: loop_handle_static,
        _egl_display: egl_display,
        _gbm_device: gbm,
        output_formats: format_vec,
        hotplug_retry_after: HashMap::new(),
        drm_idle_render_armed: false,
        drm_late_render_armed: false,
    });

    let drm_monitor = udev::MonitorBuilder::new()
        .map_err(|e| format!("udev MonitorBuilder: {e}"))?
        .match_subsystem("drm")
        .map_err(|e| format!("udev match_subsystem: {e}"))?
        .listen()
        .map_err(|e| format!("udev listen: {e}"))?;
    event_loop
        .handle()
        .insert_source(
            Generic::new(drm_monitor, Interest::READ, Mode::Level),
            move |_, monitor: &mut NoIoDrop<udev::MonitorSocket>, d| {
                let sock = unsafe { monitor.get_mut() };
                let mut ours = false;
                for ev in sock.iter() {
                    if !matches!(
                        ev.event_type(),
                        udev::EventType::Change | udev::EventType::Add
                    ) {
                        continue;
                    }
                    let Some(ev_rdev) = ev.devnum() else {
                        continue;
                    };
                    if ev_rdev as u64 != drm_rdev {
                        continue;
                    }
                    ours = true;
                }
                if ours {
                    drm_hotplug_on_udev_drm_change(d);
                }
                Ok(PostAction::Continue)
            },
        )
        .map_err(|e| format!("drm udev monitor: {e}"))?;

    let hotplug_fallback = Duration::from_secs(5);
    event_loop
        .handle()
        .insert_source(Timer::from_duration(hotplug_fallback), move |_, _, d| {
            drm_hotplug_timer_prune_only(d);
            TimeoutAction::ToDuration(hotplug_fallback)
        })
        .map_err(|e| format!("drm hotplug fallback timer: {e}"))?;

    loop_handle.insert_idle(|d| {
        drm_idle_render(d);
    });

    Ok(())
}
