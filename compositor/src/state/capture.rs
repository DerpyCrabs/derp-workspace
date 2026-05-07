use super::*;

pub(crate) struct CaptureState {
    pub(crate) dmabuf_state: DmabufState,
    pub(crate) dmabuf_global: Option<DmabufGlobal>,
    pub(crate) drm_syncobj_state: Option<DrmSyncobjState>,
    pub(crate) dmabuf_import_renderer: Option<Weak<Mutex<GlesRenderer>>>,
    pub(crate) capture_dmabuf_formats: Vec<Format>,
    pub(crate) capture_dmabuf_device: Option<libc::dev_t>,
    pub(crate) foreign_toplevel_list_state: ForeignToplevelListState,
    pub(crate) capture_toplevel_handles: HashMap<u32, ForeignToplevelHandle>,
    pub(crate) capture_window_source_cache:
        HashMap<u32, crate::render::capture::CachedCaptureWindowSource>,
    pub(crate) _screencopy_manager_state: crate::render::capture::ScreencopyManagerState,
    pub(crate) pending_screencopy_copies: Vec<crate::render::capture::PendingScreencopyCopy>,
    pub(crate) _ext_image_capture_manager_state:
        crate::render::capture_ext::ExtImageCaptureManagerState,
    pub(crate) pending_image_copy_captures:
        Vec<crate::render::capture_ext::PendingImageCopyCapture>,
    screenshot_request: Option<crate::render::screenshot::PendingScreenshotRequest>,
    screenshot_selection_active: bool,
    screenshot_selection_anchor: Option<Point<i32, Logical>>,
    screenshot_selection_current: Option<Point<i32, Logical>>,
    screenshot_overlay_needs_full_damage: bool,
    pub(crate) capture_force_full_damage_frames: u8,
    pub(crate) active_image_copy_capture_sessions: usize,
}

pub(crate) enum ScreenshotPointerAction {
    None,
    Cancel,
    RequestRegion(Rectangle<i32, Logical>),
}

impl CaptureState {
    pub(crate) fn new(
        dmabuf_state: DmabufState,
        foreign_toplevel_list_state: ForeignToplevelListState,
        screencopy_manager_state: crate::render::capture::ScreencopyManagerState,
        ext_image_capture_manager_state: crate::render::capture_ext::ExtImageCaptureManagerState,
    ) -> Self {
        Self {
            dmabuf_state,
            dmabuf_global: None,
            drm_syncobj_state: None,
            dmabuf_import_renderer: None,
            capture_dmabuf_formats: Vec::new(),
            capture_dmabuf_device: None,
            foreign_toplevel_list_state,
            capture_toplevel_handles: HashMap::new(),
            capture_window_source_cache: HashMap::new(),
            _screencopy_manager_state: screencopy_manager_state,
            pending_screencopy_copies: Vec::new(),
            _ext_image_capture_manager_state: ext_image_capture_manager_state,
            pending_image_copy_captures: Vec::new(),
            screenshot_request: None,
            screenshot_selection_active: false,
            screenshot_selection_anchor: None,
            screenshot_selection_current: None,
            screenshot_overlay_needs_full_damage: false,
            capture_force_full_damage_frames: 0,
            active_image_copy_capture_sessions: 0,
        }
    }

    pub(crate) fn formats_for_linux_dmabuf_global(renderer: &GlesRenderer) -> Vec<Format> {
        let modifierless = Modifier::from(72057594037927935u64);
        let mut out: Vec<Format> = renderer
            .egl_context()
            .dmabuf_render_formats()
            .iter()
            .copied()
            .filter(|f| {
                matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888)
                    && f.modifier == modifierless
            })
            .collect();
        if out.is_empty() {
            out = renderer
                .dmabuf_formats()
                .iter()
                .copied()
                .filter(|f| {
                    matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888)
                        && f.modifier == modifierless
                })
                .collect();
            tracing::warn!(
                "linux-dmabuf global: no modifierless XRGB/ARGB formats in EGL render set; falling back to texture/import formats"
            );
        }
        if out.is_empty() {
            out = renderer
                .egl_context()
                .dmabuf_render_formats()
                .iter()
                .copied()
                .filter(|f| matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888))
                .collect();
            if out.is_empty() {
                out = renderer
                    .dmabuf_formats()
                    .iter()
                    .copied()
                    .filter(|f| matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888))
                    .collect();
            }
            tracing::warn!(
                "linux-dmabuf global: no modifierless XRGB/ARGB formats available; falling back to explicit modifiers"
            );
        }
        let advertised_formats: Vec<(u32, u64)> = out
            .iter()
            .map(|f| (f.code as u32, u64::from(f.modifier)))
            .collect();
        tracing::warn!(
            ?advertised_formats,
            "linux-dmabuf advertised format/modifier pairs"
        );
        out
    }

    pub(crate) fn normalize_dmabuf_format(format: Format) -> Format {
        let modifier = if format.modifier == Modifier::Invalid {
            Modifier::Linear
        } else {
            format.modifier
        };
        Format {
            code: format.code,
            modifier,
        }
    }

    pub(crate) fn init_linux_dmabuf_global(
        &mut self,
        renderer: &GlesRenderer,
        display_handle: &DisplayHandle,
        formats: impl IntoIterator<Item = Format>,
    ) {
        if self.dmabuf_global.is_some() {
            return;
        }
        let formats: Vec<Format> = formats.into_iter().collect();
        if formats.is_empty() {
            tracing::warn!("linux-dmabuf global skipped (no dma-buf formats from renderer)");
            return;
        }
        let render_node = EGLDevice::device_for_display(renderer.egl_context().display())
            .ok()
            .and_then(|device| device.try_get_render_node().ok().flatten());
        let render_node_dev_id = render_node.as_ref().map(|node| node.dev_id());
        let display_handle_for_filter = display_handle.clone();
        let global = render_node
            .and_then(|node| {
                DmabufFeedbackBuilder::new(node.dev_id(), formats.iter().copied())
                    .build()
                    .ok()
            })
            .map(|feedback| {
                self.dmabuf_state
                    .create_global_with_filter_and_default_feedback::<CompositorState, _>(
                        display_handle,
                        &feedback,
                        move |client| {
                            client_allows_linux_dmabuf(client, &display_handle_for_filter)
                        },
                    )
            })
            .unwrap_or_else(|| {
                tracing::warn!("linux-dmabuf global falling back to v3 without default feedback");
                let display_handle_for_filter = display_handle.clone();
                self.dmabuf_state
                    .create_global_with_filter::<CompositorState, _>(
                        display_handle,
                        formats.iter().copied(),
                        move |client| {
                            client_allows_linux_dmabuf(client, &display_handle_for_filter)
                        },
                    )
            });
        self.dmabuf_global = Some(global);
        self.capture_dmabuf_formats = formats
            .iter()
            .copied()
            .map(Self::normalize_dmabuf_format)
            .collect();
        self.capture_dmabuf_device = render_node_dev_id;
        tracing::debug!("linux-dmabuf global created");
    }

    pub(crate) fn init_drm_syncobj_global(
        &mut self,
        display_handle: &DisplayHandle,
        import_device: DrmDeviceFd,
    ) -> bool {
        if self.drm_syncobj_state.is_some() {
            return true;
        }
        if !supports_syncobj_eventfd(&import_device) {
            tracing::debug!(
                "linux-drm-syncobj-v1 global skipped (DRM syncobj eventfd unsupported)"
            );
            return false;
        }
        self.drm_syncobj_state = Some(DrmSyncobjState::new::<CompositorState>(
            display_handle,
            import_device,
        ));
        tracing::debug!("linux-drm-syncobj-v1 global created");
        true
    }

    pub(crate) fn screenshot_selection_active(&self) -> bool {
        self.screenshot_selection_active
    }

    pub(crate) fn has_screenshot_request(&self) -> bool {
        self.screenshot_request.is_some()
    }

    pub(crate) fn screenshot_selection_current(&self) -> Option<Point<i32, Logical>> {
        self.screenshot_selection_current
    }

    pub(crate) fn take_screenshot_request(
        &mut self,
    ) -> Option<crate::render::screenshot::PendingScreenshotRequest> {
        self.screenshot_request.take()
    }

    pub(crate) fn set_screenshot_request(
        &mut self,
        request: crate::render::screenshot::PendingScreenshotRequest,
    ) {
        self.screenshot_request = Some(request);
    }

    pub(crate) fn capture_needs_full_damage(&self) -> bool {
        self.active_image_copy_capture_sessions > 0
            || self.capture_force_full_damage_frames > 0
            || !self.pending_screencopy_copies.is_empty()
            || !self.pending_image_copy_captures.is_empty()
    }

    pub(crate) fn screenshot_overlay_needs_full_damage(&self) -> bool {
        self.screenshot_overlay_needs_full_damage
    }

    pub(crate) fn mark_rendered_frame(&mut self) {
        self.screenshot_overlay_needs_full_damage = false;
        if self.capture_force_full_damage_frames > 0 {
            self.capture_force_full_damage_frames -= 1;
        }
    }

    pub(crate) fn begin_screenshot_selection_mode(
        &mut self,
        current_pointer: Option<Point<i32, Logical>>,
    ) {
        self.screenshot_selection_active = true;
        self.screenshot_selection_anchor = None;
        self.screenshot_selection_current = current_pointer;
        self.screenshot_overlay_needs_full_damage = true;
    }

    pub(crate) fn cancel_screenshot_selection_mode(&mut self) -> bool {
        if !self.screenshot_selection_active {
            return false;
        }
        self.screenshot_selection_active = false;
        self.screenshot_selection_anchor = None;
        self.screenshot_selection_current = None;
        self.screenshot_overlay_needs_full_damage = true;
        true
    }

    pub(crate) fn update_screenshot_selection_pointer(&mut self, pos: Point<f64, Logical>) -> bool {
        if !self.screenshot_selection_active {
            return false;
        }
        self.screenshot_selection_current = Some(pos.to_i32_round());
        self.screenshot_overlay_needs_full_damage = true;
        true
    }

    pub(crate) fn screenshot_selection_rect(&self) -> Option<Rectangle<i32, Logical>> {
        Self::screenshot_selection_rect_from_points(
            self.screenshot_selection_active,
            self.screenshot_selection_anchor,
            self.screenshot_selection_current,
        )
    }

    pub(crate) fn screenshot_selection_rect_from_points(
        active: bool,
        anchor: Option<Point<i32, Logical>>,
        current: Option<Point<i32, Logical>>,
    ) -> Option<Rectangle<i32, Logical>> {
        if !active {
            return None;
        }
        let anchor = anchor?;
        let current = current?;
        let x0 = anchor.x.min(current.x);
        let y0 = anchor.y.min(current.y);
        let x1 = anchor.x.max(current.x);
        let y1 = anchor.y.max(current.y);
        let width = x1.saturating_sub(x0).saturating_add(1);
        let height = y1.saturating_sub(y0).saturating_add(1);
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(Rectangle::new((x0, y0).into(), (width, height).into()))
    }

    pub(crate) fn handle_screenshot_pointer_button(
        &mut self,
        button: u32,
        button_state: smithay::backend::input::ButtonState,
        pos: Option<Point<i32, Logical>>,
    ) -> Option<ScreenshotPointerAction> {
        if !self.screenshot_selection_active {
            return None;
        }
        const BTN_LEFT: u32 = 0x110;
        const BTN_RIGHT: u32 = 0x111;
        let action = match (button, button_state) {
            (BTN_RIGHT, smithay::backend::input::ButtonState::Pressed) => {
                self.cancel_screenshot_selection_mode();
                ScreenshotPointerAction::Cancel
            }
            (BTN_LEFT, smithay::backend::input::ButtonState::Pressed) => {
                if let Some(pos) = pos {
                    self.screenshot_selection_anchor = Some(pos);
                    self.screenshot_selection_current = Some(pos);
                    self.screenshot_overlay_needs_full_damage = true;
                }
                ScreenshotPointerAction::None
            }
            (BTN_LEFT, smithay::backend::input::ButtonState::Released) => {
                let rect = self.screenshot_selection_rect();
                self.cancel_screenshot_selection_mode();
                rect.map(ScreenshotPointerAction::RequestRegion)
                    .unwrap_or(ScreenshotPointerAction::Cancel)
            }
            _ => ScreenshotPointerAction::None,
        };
        Some(action)
    }

    pub(crate) fn request_screenshot_output(&mut self, output_name: String) {
        self.screenshot_request =
            Some(crate::render::screenshot::PendingScreenshotRequest::for_output(output_name));
    }

    pub(crate) fn request_screenshot_region(
        &mut self,
        logical_rect: Rectangle<i32, Logical>,
        outputs: Vec<String>,
    ) -> Result<(), String> {
        if logical_rect.size.w <= 0 || logical_rect.size.h <= 0 {
            return Err("screenshot region must be non-empty".into());
        }
        self.screenshot_request = Some(
            crate::render::screenshot::PendingScreenshotRequest::for_region(logical_rect, outputs)?,
        );
        Ok(())
    }

    pub(crate) fn finish_screenshot_request(
        request: crate::render::screenshot::PendingScreenshotRequest,
    ) -> Result<(PathBuf, Vec<u8>), String> {
        let image = request.finalize_image()?;
        let png = crate::render::screenshot::encode_png(&image)?;
        let path = if let Some(save_path) = request.save_path.as_ref() {
            crate::render::screenshot::save_png_to_path(&png, save_path)?
        } else {
            crate::render::screenshot::save_png(&png)?
        };
        if let Some(request_id) = request.e2e_request_id {
            crate::e2e::publish_screenshot_result(
                request_id,
                Ok(crate::e2e::E2eScreenshotResult {
                    request_id,
                    path: path.display().to_string(),
                    width: image.width(),
                    height: image.height(),
                    captured_at_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                }),
            );
        }
        Ok((path, png))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dmabuf_format_replaces_invalid_modifier_with_linear() {
        let format = Format {
            code: Fourcc::Argb8888,
            modifier: Modifier::Invalid,
        };
        assert_eq!(
            CaptureState::normalize_dmabuf_format(format).modifier,
            Modifier::Linear
        );
    }

    #[test]
    fn screenshot_selection_rect_normalizes_drag_direction() {
        let rect = CaptureState::screenshot_selection_rect_from_points(
            true,
            Some(Point::from((10, 20))),
            Some(Point::from((3, 4))),
        )
        .unwrap();
        assert_eq!(rect.loc, Point::from((3, 4)));
        assert_eq!(rect.size, Size::from((8, 17)));
    }

    #[test]
    fn screenshot_selection_rect_requires_active_selection() {
        assert!(CaptureState::screenshot_selection_rect_from_points(
            false,
            Some(Point::from((0, 0))),
            Some(Point::from((10, 10))),
        )
        .is_none());
    }
}

fn client_allows_linux_dmabuf(
    _client: &smithay::reexports::wayland_server::Client,
    _dh: &DisplayHandle,
) -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ShellSharedStateStaleReason {
    OutputLayoutRevision {
        payload_revision: u64,
        current_revision: u64,
    },
}

pub(super) fn shell_shared_state_payload_stale_reason(
    payload: &[u8],
    current_output_layout_revision: u64,
    _current_snapshot_epoch: u64,
) -> Option<ShellSharedStateStaleReason> {
    if payload.len() < 16 {
        return None;
    }
    let output_layout_revision = u64::from_le_bytes(payload[8..16].try_into().unwrap());
    if output_layout_revision > 0 && output_layout_revision < current_output_layout_revision {
        return Some(ShellSharedStateStaleReason::OutputLayoutRevision {
            payload_revision: output_layout_revision,
            current_revision: current_output_layout_revision,
        });
    }
    None
}
