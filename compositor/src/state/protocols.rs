use super::*;

impl XdgDecorationHandler for CompositorState {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn request_mode(
        &mut self,
        toplevel: ToplevelSurface,
        _mode: smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode,
    ) {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        // Shell draws decorations (CEF); force SSD so clients like foot omit CSD.
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        use smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as XdgDecoMode;
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(XdgDecoMode::ServerSide);
        });
        toplevel.send_configure();
    }
}

impl FractionalScaleHandler for CompositorState {
    fn new_fractional_scale(&mut self, surface: WlSurface) {
        let scale = if let Some(x11) = self.x11_window_containing_surface(&surface) {
            self.xwayland_scale_for_space_element(&DerpSpaceElem::X11(x11))
        } else {
            self.wayland_window_containing_surface(&surface)
                .map(|w| self.fractional_scale_for_space_element(&DerpSpaceElem::Wayland(w)))
                .unwrap_or_else(|| {
                    self.leftmost_output()
                        .map(|o| o.current_scale().fractional_scale())
                        .unwrap_or(1.0)
                })
        };
        smithay::wayland::compositor::with_states(&surface, |states| {
            smithay::wayland::fractional_scale::with_fractional_scale(states, |fs| {
                fs.set_preferred_scale(scale);
            });
        });
    }
}

impl DmabufHandler for CompositorState {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        if let Some(weak) = self.dmabuf_import_renderer.as_ref() {
            if let Some(renderer_arc) = weak.upgrade() {
                match renderer_arc.lock() {
                    Ok(mut r) => match r.import_dmabuf(&dmabuf, None) {
                        Ok(_) => {
                            let _ = notifier.successful::<Self>();
                            return;
                        }
                        Err(e) => {
                            tracing::warn!(?e, "linux-dmabuf import rejected by GLES");
                            notifier.failed();
                            return;
                        }
                    },
                    Err(_) => {
                        notifier.failed();
                        return;
                    }
                }
            }
        }
        let _ = notifier.successful::<Self>();
    }
}

impl DrmSyncobjHandler for CompositorState {
    fn drm_syncobj_state(&mut self) -> Option<&mut DrmSyncobjState> {
        self.drm_syncobj_state.as_mut()
    }
}

smithay::delegate_xdg_activation!(crate::CompositorState);
smithay::delegate_xdg_decoration!(crate::CompositorState);
smithay::delegate_fractional_scale!(crate::CompositorState);
smithay::delegate_viewporter!(crate::CompositorState);
smithay::delegate_cursor_shape!(crate::CompositorState);
smithay::delegate_xwayland_shell!(crate::CompositorState);
smithay::delegate_dmabuf!(crate::CompositorState);
smithay::delegate_drm_syncobj!(crate::CompositorState);
smithay::delegate_fifo!(crate::CompositorState);
smithay::delegate_presentation!(crate::CompositorState);
smithay::delegate_content_type!(crate::CompositorState);
crate::delegate_tearing_control!(crate::CompositorState);

