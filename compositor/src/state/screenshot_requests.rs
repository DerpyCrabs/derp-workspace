use super::*;

impl CompositorState {
    pub(crate) fn screenshot_selection_active(&self) -> bool {
        self.capture.screenshot_selection_active()
    }

    pub(crate) fn begin_screenshot_selection_mode(&mut self) {
        let current_pointer = self
            .input_routing
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round());
        self.capture
            .begin_screenshot_selection_mode(current_pointer);
        self.input_routing.programs_menu_clear_super_press();
        self.shell_keyboard_capture_clear();
        self.shell_emit_shell_ui_focus_if_changed(None);
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn cancel_screenshot_selection_mode(&mut self) {
        if !self.capture.cancel_screenshot_selection_mode() {
            return;
        }
        self.input_routing.programs_menu_clear_super_press();
        self.core.loop_signal.wakeup();
    }

    pub(crate) fn update_screenshot_selection_pointer(&mut self, pos: Point<f64, Logical>) {
        if self.capture.update_screenshot_selection_pointer(pos) {
            self.core.loop_signal.wakeup();
        }
    }

    pub(crate) fn screenshot_selection_rect(&self) -> Option<Rectangle<i32, Logical>> {
        self.capture.screenshot_selection_rect()
    }

    pub(crate) fn handle_screenshot_pointer_button(
        &mut self,
        button: u32,
        button_state: smithay::backend::input::ButtonState,
    ) -> bool {
        let pos = self
            .input_routing
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round())
            .or(self.capture.screenshot_selection_current());
        let Some(action) = self
            .capture
            .handle_screenshot_pointer_button(button, button_state, pos)
        else {
            return false;
        };
        match action {
            ScreenshotPointerAction::RequestRegion(rect) => {
                self.input_routing.programs_menu_clear_super_press();
                if let Err(error) = self.request_screenshot_region(rect) {
                    tracing::warn!(%error, "screenshot region request failed");
                }
            }
            ScreenshotPointerAction::Cancel => {
                self.input_routing.programs_menu_clear_super_press();
            }
            ScreenshotPointerAction::None => {}
        }
        self.core.loop_signal.wakeup();
        true
    }

    pub(crate) fn request_screenshot_current_output(&mut self) -> Result<(), String> {
        let output = self
            .new_toplevel_placement_output(None)
            .ok_or_else(|| "no output available for screenshot".to_string())?;
        self.capture.request_screenshot_output(output.name());
        self.core.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn request_screenshot_region(
        &mut self,
        logical_rect: Rectangle<i32, Logical>,
    ) -> Result<(), String> {
        let outputs = self
            .output_topology
            .space
            .outputs()
            .filter_map(|output| {
                let geo = self.output_topology.space.output_geometry(output)?;
                if geo.overlaps(logical_rect) {
                    Some(output.name())
                } else {
                    None
                }
            })
            .collect();
        self.capture
            .request_screenshot_region(logical_rect, outputs)?;
        self.core.loop_signal.wakeup();
        Ok(())
    }

    pub(crate) fn screenshot_capture_output_if_needed(
        &mut self,
        output: &Output,
        renderer: &mut GlesRenderer,
        framebuffer: &GlesTarget<'_>,
    ) {
        let Some(mut request) = self.capture.take_screenshot_request() else {
            return;
        };
        let output_name = output.name();
        if !request.needs_output(&output_name) {
            self.capture.set_screenshot_request(request);
            return;
        }
        let capture = (|| -> Result<(), String> {
            let geo = self
                .output_topology
                .space
                .output_geometry(output)
                .ok_or_else(|| format!("screenshot missing geometry for output {output_name}"))?;
            let mode = output
                .current_mode()
                .ok_or_else(|| format!("screenshot missing mode for output {output_name}"))?;
            let image = crate::render::screenshot::capture_output_image(
                renderer,
                framebuffer,
                Size::from((mode.size.w as i32, mode.size.h as i32)),
                output.current_transform(),
            )?;
            request.push_capture(crate::render::screenshot::CapturedOutputFrame {
                output_name: output_name.clone(),
                logical_rect: geo,
                image,
            });
            Ok(())
        })();
        if let Err(error) = capture {
            if let Some(request_id) = request.e2e_request_id {
                crate::e2e::publish_screenshot_result(request_id, Err(error.clone()));
            }
            tracing::warn!(%error, output = %output_name, "screenshot capture failed");
            return;
        }
        if request.is_complete() {
            let request_id = request.e2e_request_id;
            if let Err(error) = self.finish_screenshot_request(request) {
                if let Some(request_id) = request_id {
                    crate::e2e::publish_screenshot_result(request_id, Err(error.clone()));
                }
                tracing::warn!(%error, "screenshot finalize failed");
            }
            return;
        }
        self.capture.set_screenshot_request(request);
    }

    fn finish_screenshot_request(
        &mut self,
        request: crate::render::screenshot::PendingScreenshotRequest,
    ) -> Result<PathBuf, String> {
        let (path, png) = CaptureState::finish_screenshot_request(request)?;
        self.publish_screenshot_clipboard(png);
        tracing::warn!(path = %path.display(), "screenshot saved");
        Ok(path)
    }

    fn publish_screenshot_clipboard(&mut self, png: Vec<u8>) {
        set_data_device_selection::<Self>(
            &self.core.display_handle,
            &self.input_routing.seat,
            vec!["image/png".into()],
            Arc::new(png),
        );
    }
}
