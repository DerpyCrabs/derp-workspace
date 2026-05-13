mod compositor;
mod layer_shell;
mod xdg_shell;

use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use crate::{
    chrome_bridge::{ChromeEvent, WindowIconBufferInfo, WindowIconInfo, WindowInfo},
    CompositorState,
};

use smithay::delegate_input_method_manager;
use smithay::delegate_layer_shell;
use smithay::delegate_pointer_constraints;
use smithay::delegate_pointer_gestures;
use smithay::delegate_relative_pointer;
use smithay::delegate_text_input_manager;
use smithay::input::{
    dnd::{DnDGrab, DndAction, DndGrabHandler, DndTarget, GrabType, Source, SourceMetadata},
    pointer::Focus,
    Seat, SeatHandler, SeatState,
};
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{IsAlive, Logical, Point, Rectangle, Serial};
use smithay::wayland::input_method::{InputMethodHandler, PopupSurface as InputMethodPopupSurface};
use smithay::wayland::output::OutputHandler;
use smithay::wayland::pointer_constraints::{with_pointer_constraint, PointerConstraintsHandler};
use smithay::wayland::selection::data_device::{
    set_data_device_focus, DataDeviceHandler, DataDeviceState, WaylandDndGrabHandler,
};
use smithay::wayland::selection::primary_selection::{
    set_primary_focus, PrimarySelectionHandler, PrimarySelectionState,
};
use smithay::wayland::selection::wlr_data_control::DataControlHandler;
use smithay::wayland::selection::{SelectionHandler, SelectionSource, SelectionTarget};
use smithay::wayland::tablet_manager::TabletSeatHandler;
use smithay::wayland::xdg_activation::{
    XdgActivationHandler, XdgActivationState, XdgActivationToken, XdgActivationTokenData,
};
use smithay::wayland::xdg_toplevel_icon::{ToplevelIconCachedState, XdgToplevelIconHandler};
use smithay::{
    delegate_data_control, delegate_data_device, delegate_output, delegate_primary_selection,
    delegate_seat,
};

struct XdgToplevelDragAwareSource<S: Source> {
    inner: S,
    allow_no_target_drop: Arc<AtomicBool>,
}

impl<S: Source> IsAlive for XdgToplevelDragAwareSource<S> {
    fn alive(&self) -> bool {
        self.inner.alive()
    }
}

impl<S: Source> Source for XdgToplevelDragAwareSource<S> {
    fn is_client_local(&self, target: &dyn std::any::Any) -> bool {
        let allow_no_target_drop = self.allow_no_target_drop.load(Ordering::SeqCst);
        let metadata = self.metadata();
        let chromium_window_drag = metadata.as_ref().is_some_and(|metadata| {
            metadata
                .mime_types
                .iter()
                .any(|mime| mime == "chromium/x-window" || mime == "chromium/x-window-drag")
        });
        if allow_no_target_drop || chromium_window_drag {
            return false;
        }
        self.inner.is_client_local(target)
    }

    fn metadata(&self) -> Option<SourceMetadata> {
        self.inner.metadata()
    }

    fn choose_action(&self, action: DndAction) {
        self.inner.choose_action(action);
    }

    fn send(&self, mime_type: &str, fd: std::os::fd::OwnedFd) {
        self.inner.send(mime_type, fd);
    }

    fn drop_performed(&self) {
        self.inner.drop_performed();
    }

    fn cancel(&self) {
        if self.allow_no_target_drop.swap(false, Ordering::SeqCst) {
            self.inner.drop_performed();
            self.inner.finished();
        } else {
            self.inner.cancel();
        }
    }

    fn finished(&self) {
        self.inner.finished();
    }
}

impl CompositorState {
    fn xdg_activation_token_max_age(&self) -> std::time::Duration {
        self.xdg_activation_token_max_age_override
            .unwrap_or_else(|| std::time::Duration::from_secs(10))
    }

    pub(crate) fn xdg_activation_prune_stale_tokens(&mut self) {
        let max_age = self.xdg_activation_token_max_age();
        self.xdg_activation_state
            .retain_tokens(|_, data| data.timestamp.elapsed() < max_age);
    }

    fn xdg_activation_serial_is_current(&self, serial: Serial) -> bool {
        self.input_routing
            .seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.last_enter())
            .is_some_and(|last_enter| serial.is_no_older_than(&last_enter))
            || self
                .input_routing
                .seat
                .get_pointer()
                .and_then(|pointer| pointer.last_enter())
                .is_some_and(|last_enter| serial.is_no_older_than(&last_enter))
    }

    fn xdg_activation_surface_matches_keyboard_focus(&self, surface: &WlSurface) -> bool {
        let root = self.pointer_constraint_root_surface(surface);
        self.input_routing
            .seat
            .get_keyboard()
            .and_then(|keyboard| keyboard.current_focus())
            .is_some_and(|focus| self.pointer_constraint_root_surface(&focus) == root)
    }

    fn xdg_activation_window_id_for_surface(&self, surface: &WlSurface) -> Option<u32> {
        self.windows
            .window_registry
            .window_id_for_wl_surface(surface)
            .or_else(|| {
                let root = self.pointer_constraint_root_surface(surface);
                self.windows.window_registry.window_id_for_wl_surface(&root)
            })
    }

    fn xdg_activation_client_token_is_valid(
        &self,
        data: &XdgActivationTokenData,
        require_current_serial: bool,
    ) -> bool {
        let Some(client_id) = data.client_id.as_ref() else {
            return true;
        };
        let Some(surface) = data.surface.as_ref() else {
            let Some((serial, seat)) = data.serial.as_ref() else {
                return false;
            };
            if Seat::from_resource(seat) != Some(self.input_routing.seat.clone()) {
                return false;
            }
            return !require_current_serial || self.xdg_activation_serial_is_current(*serial);
        };
        if surface
            .client()
            .is_none_or(|client| client.id() != *client_id)
        {
            return false;
        }
        self.xdg_activation_surface_matches_keyboard_focus(surface)
    }

    fn xdg_activation_request_is_authorized(
        &self,
        data: &XdgActivationTokenData,
        target: &WindowInfo,
    ) -> bool {
        if !self.xdg_activation_client_token_is_valid(data, false) {
            return false;
        }
        if let Some(app_id) = data
            .app_id
            .as_ref()
            .filter(|app_id| !app_id.trim().is_empty())
        {
            if target.app_id != *app_id {
                return false;
            }
        }
        true
    }

    pub(crate) fn pointer_constraint_root_surface(&self, surface: &WlSurface) -> WlSurface {
        let mut root = surface.clone();
        while let Some(parent) = smithay::wayland::compositor::get_parent(&root) {
            root = parent;
        }
        root
    }

    pub(crate) fn pointer_constraint_surface_origin(
        &self,
        surface: &WlSurface,
    ) -> Option<Point<f64, Logical>> {
        let root = self.pointer_constraint_root_surface(surface);
        if let Some(window) = self.wayland_window_containing_surface(&root) {
            let map_loc = self
                .output_topology
                .space
                .element_location(&crate::DerpSpaceElem::Wayland(window.clone()))?;
            let render_loc = map_loc - window.geometry().loc;
            return Some(render_loc.to_f64());
        }
        if let Some(x11) = self.x11_window_containing_surface(&root) {
            let map_loc = self
                .output_topology
                .space
                .element_location(&crate::DerpSpaceElem::X11(x11.clone()))?;
            let render_loc = map_loc - x11.geometry().loc;
            return Some(render_loc.to_f64());
        }
        None
    }

    pub(crate) fn pointer_constraint_maybe_activate(
        &self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
        pointer_location: Point<f64, Logical>,
    ) {
        let root = self.pointer_constraint_root_surface(surface);
        let Some(surface_origin) = self.pointer_constraint_surface_origin(&root) else {
            return;
        };
        with_pointer_constraint(&root, pointer, |constraint| {
            let Some(constraint) = constraint else {
                return;
            };
            if constraint.is_active() {
                return;
            }
            let point = (pointer_location - surface_origin).to_i32_round();
            if constraint
                .region()
                .is_none_or(|region| region.contains(point))
            {
                constraint.activate();
            }
        });
    }

    pub(crate) fn xdg_toplevel_icon_sync_committed(&mut self, surface: &WlSurface) {
        let Some(window_id) = self
            .windows
            .window_registry
            .window_id_for_wl_surface(surface)
        else {
            return;
        };
        let icon = smithay::wayland::compositor::with_states(surface, |states| {
            let mut cached = states.cached_state.get::<ToplevelIconCachedState>();
            let current = cached.current();
            let buffers = current
                .buffers()
                .iter()
                .filter_map(|(buffer, scale)| {
                    let data =
                        smithay::wayland::shm::with_buffer_contents(buffer, |_ptr, _len, data| {
                            data
                        })
                        .ok()?;
                    Some(WindowIconBufferInfo {
                        width: data.width,
                        height: data.height,
                        scale: *scale,
                    })
                })
                .collect();
            WindowIconInfo {
                name: current.icon_name().unwrap_or_default().to_string(),
                buffers,
            }
        });
        if let Some(true) = self.windows.window_registry.set_icon(surface, icon) {
            if let Some(info) = self.windows.window_registry.window_info(window_id) {
                self.shell_emit_chrome_event(ChromeEvent::WindowMetadataChanged { info });
            }
        }
    }
}

impl SeatHandler for CompositorState {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<CompositorState> {
        &mut self.input_routing.seat_state
    }

    fn cursor_image(
        &mut self,
        _seat: &Seat<Self>,
        image: smithay::input::pointer::CursorImageStatus,
    ) {
        self.input_routing.pointer_cursor_image = image;
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let dh = &self.core.display_handle;
        let client = focused.and_then(|s| dh.get_client(s.id()).ok());
        set_data_device_focus(dh, seat, client.clone());
        set_primary_focus(dh, seat, client);

        self.keyboard_on_focus_surface_changed(focused);

        let window_id = focused.and_then(|s| {
            self.windows
                .window_registry
                .window_id_for_wl_surface(s)
                .or_else(|| {
                    let popup = self.popups.find_popup(s)?;
                    let root = smithay::desktop::find_popup_root_surface(&popup).ok()?;
                    self.windows.window_registry.window_id_for_wl_surface(&root)
                })
        });
        if let Some(wid) = window_id {
            if let Some(sid) = self.windows.window_registry.surface_id_for_window(wid) {
                if let Some(window) = self.find_window_by_surface_id(sid) {
                    self.output_topology
                        .space
                        .raise_element(&crate::derp_space::DerpSpaceElem::Wayland(window), true);
                } else if let Some(x11) = self.find_x11_window_by_surface_id(sid) {
                    self.output_topology
                        .space
                        .raise_element(&crate::derp_space::DerpSpaceElem::X11(x11), true);
                }
            }
            self.shell_window_stack_touch(wid);
            if let Some(info) = self.windows.window_registry.window_info(wid) {
                if !self.window_info_is_solid_shell_host(&info) {
                    self.shell_note_non_shell_focus();
                }
            }
        }
        let surface_id =
            window_id.and_then(|w| self.windows.window_registry.surface_id_for_window(w));
        self.shell_emit_chrome_event(ChromeEvent::FocusChanged {
            surface_id,
            window_id,
        });
    }
}

delegate_seat!(crate::CompositorState);
delegate_text_input_manager!(crate::CompositorState);
delegate_input_method_manager!(crate::CompositorState);

impl TabletSeatHandler for CompositorState {}

impl InputMethodHandler for CompositorState {
    fn new_popup(&mut self, surface: InputMethodPopupSurface) {
        let _ = self
            .popups
            .track_popup(smithay::desktop::PopupKind::InputMethod(surface));
        self.windows.wayland_commit_needs_render = true;
    }

    fn dismiss_popup(&mut self, surface: InputMethodPopupSurface) {
        let popup = smithay::desktop::PopupKind::InputMethod(surface);
        if let Ok(root) = smithay::desktop::find_popup_root_surface(&popup) {
            let _ = smithay::desktop::PopupManager::dismiss_popup(&root, &popup);
        }
        self.popups.cleanup();
        self.windows.wayland_commit_needs_render = true;
    }

    fn popup_repositioned(&mut self, _surface: InputMethodPopupSurface) {
        self.windows.wayland_commit_needs_render = true;
    }

    fn commit_string_without_text_input(&mut self, text: String) -> bool {
        self.shell_ipc_commit_text_to_cef(&text)
    }

    fn input_method_without_text_input_should_activate(&self) -> bool {
        self.session_services.osk_shell_text_input_active
    }

    fn parent_geometry(&self, parent: &WlSurface) -> Rectangle<i32, Logical> {
        let root = self
            .popups
            .find_popup(parent)
            .and_then(|popup| smithay::desktop::find_popup_root_surface(&popup).ok())
            .unwrap_or_else(|| parent.clone());
        self.output_topology
            .space
            .elements()
            .find_map(|elem| match elem {
                crate::derp_space::DerpSpaceElem::Wayland(window)
                    if window
                        .toplevel()
                        .is_some_and(|top| top.wl_surface() == &root) =>
                {
                    self.output_topology.space.element_geometry(
                        &crate::derp_space::DerpSpaceElem::Wayland(window.clone()),
                    )
                }
                _ => None,
            })
            .unwrap_or_default()
    }
}

impl XdgActivationHandler for CompositorState {
    fn activation_state(&mut self) -> &mut XdgActivationState {
        &mut self.xdg_activation_state
    }

    fn token_created(&mut self, _token: XdgActivationToken, data: XdgActivationTokenData) -> bool {
        self.xdg_activation_prune_stale_tokens();
        let Some((serial, seat)) = data
            .serial
            .as_ref()
            .map(|(serial, seat)| (*serial, seat.clone()))
        else {
            return false;
        };
        if Seat::from_resource(&seat) != Some(self.input_routing.seat.clone()) {
            return false;
        }
        if !self.xdg_activation_serial_is_current(serial) {
            return false;
        }
        if !self.xdg_activation_client_token_is_valid(&data, true) {
            return false;
        }
        true
    }

    fn request_activation(
        &mut self,
        token: XdgActivationToken,
        token_data: XdgActivationTokenData,
        surface: WlSurface,
    ) {
        self.xdg_activation_prune_stale_tokens();
        if token_data.timestamp.elapsed() >= self.xdg_activation_token_max_age() {
            self.xdg_activation_state.remove_token(&token);
            return;
        }
        let Some(window_id) = self.xdg_activation_window_id_for_surface(&surface) else {
            self.xdg_activation_state.remove_token(&token);
            return;
        };
        let Some(info) = self.windows.window_registry.window_info(window_id) else {
            self.xdg_activation_state.remove_token(&token);
            return;
        };
        if !self.xdg_activation_request_is_authorized(&token_data, &info) {
            self.xdg_activation_state.remove_token(&token);
            return;
        }
        if info.minimized {
            if self
                .workspace_layout
                .scratchpad_windows
                .contains_key(&window_id)
            {
                self.xdg_activation_state.remove_token(&token);
                return;
            }
            self.shell_restore_minimized_window(window_id);
        } else if self.window_id_is_deferred_initial_map(window_id) {
            self.windows.shell_pending_native_focus_window_id = Some(window_id);
        } else {
            self.shell_raise_and_focus_window(window_id);
            self.shell_reply_window_list();
            let order = self.shell_window_order_message();
            self.shell_send_to_cef(order);
        }
        self.xdg_activation_state.remove_token(&token);
    }
}

impl XdgToplevelIconHandler for CompositorState {
    fn set_icon(
        &mut self,
        _toplevel: smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel::XdgToplevel,
        wl_surface: WlSurface,
    ) {
        self.xdg_toplevel_icon_sync_committed(&wl_surface);
    }
}

impl PointerConstraintsHandler for CompositorState {
    fn new_constraint(
        &mut self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
    ) {
        let pointer_root = self
            .surface_under(pointer.current_location())
            .map(|(hit, _)| self.pointer_constraint_root_surface(&hit))
            .or_else(|| {
                pointer
                    .current_focus()
                    .map(|focus| self.pointer_constraint_root_surface(&focus))
            });
        let pointer_root_window_id = pointer_root
            .as_ref()
            .and_then(|focus| self.windows.window_registry.window_id_for_wl_surface(focus));
        let surface_window_id = self
            .windows
            .window_registry
            .window_id_for_wl_surface(surface);
        let Some(current_focus) = pointer_root else {
            return;
        };
        let same_surface = match (pointer_root_window_id, surface_window_id) {
            (Some(focus_window_id), Some(surface_window_id)) => {
                focus_window_id == surface_window_id
            }
            _ => current_focus == *surface,
        };
        if !same_surface {
            return;
        }
        self.pointer_constraint_maybe_activate(surface, pointer, pointer.current_location());
    }

    fn cursor_position_hint(
        &mut self,
        surface: &WlSurface,
        pointer: &smithay::input::pointer::PointerHandle<Self>,
        location: Point<f64, Logical>,
    ) {
        let root = self.pointer_constraint_root_surface(surface);
        let active = with_pointer_constraint(&root, pointer, |constraint| {
            constraint.is_some_and(|constraint| constraint.is_active())
        });
        if !active {
            return;
        }
        let Some(origin) = self.pointer_constraint_surface_origin(&root) else {
            return;
        };
        pointer.set_location(origin + location);
    }
}

impl SelectionHandler for CompositorState {
    type SelectionUserData = std::sync::Arc<Vec<u8>>;

    fn new_selection(
        &mut self,
        ty: SelectionTarget,
        source: Option<SelectionSource>,
        _seat: Seat<Self>,
    ) {
        let Some((_, xwm)) = self.windows.x11_wm_slot.as_mut() else {
            return;
        };
        if let Err(error) = xwm.new_selection(ty, source.map(|source| source.mime_types())) {
            tracing::warn!(?error, ?ty, "failed to set xwayland selection");
        }
    }

    fn send_selection(
        &mut self,
        ty: smithay::wayland::selection::SelectionTarget,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
        _seat: Seat<Self>,
        user_data: &Self::SelectionUserData,
    ) {
        if user_data.is_empty() {
            let Some((_, xwm)) = self.windows.x11_wm_slot.as_mut() else {
                return;
            };
            if let Err(error) = xwm.send_selection(ty, mime_type, fd) {
                tracing::warn!(?error, "failed to send x11 clipboard to wayland");
            }
            return;
        }
        if ty != SelectionTarget::Clipboard || mime_type != "image/png" {
            return;
        }
        let mut file = std::fs::File::from(fd);
        if let Err(error) = file.write_all(user_data.as_slice()) {
            tracing::warn!(%error, "clipboard image write failed");
        }
    }
}

impl PrimarySelectionHandler for CompositorState {
    fn primary_selection_state(&mut self) -> &mut PrimarySelectionState {
        &mut self.input_routing.primary_selection_state
    }
}

impl DataDeviceHandler for CompositorState {
    fn data_device_state(&mut self) -> &mut DataDeviceState {
        &mut self.input_routing.data_device_state
    }
}

impl DataControlHandler for CompositorState {
    fn data_control_state(
        &mut self,
    ) -> &mut smithay::wayland::selection::wlr_data_control::DataControlState {
        &mut self.input_routing.data_control_state
    }
}

impl DndGrabHandler for CompositorState {
    fn dropped(
        &mut self,
        _target: Option<DndTarget<'_, Self>>,
        _validated: bool,
        _seat: Seat<Self>,
        _location: Point<f64, Logical>,
    ) {
        if let Some(drag) = self.input_routing.shell_toplevel_drag {
            self.input_routing
                .shell_toplevel_drag_drop_pending_window_id = Some(drag.window_id);
        }
        self.input_routing.xdg_toplevel_drag_allow_no_target_drop = None;
    }
}

impl WaylandDndGrabHandler for CompositorState {
    fn dnd_requested<S: Source>(
        &mut self,
        source: S,
        icon: Option<WlSurface>,
        seat: Seat<Self>,
        serial: Serial,
        type_: GrabType,
    ) {
        let allow_no_target_drop = Arc::new(AtomicBool::new(false));
        self.input_routing.xdg_toplevel_drag_allow_no_target_drop =
            Some(allow_no_target_drop.clone());
        let source = XdgToplevelDragAwareSource {
            inner: source,
            allow_no_target_drop,
        };
        drop(icon);
        match type_ {
            GrabType::Pointer => {
                let Some(pointer) = seat.get_pointer() else {
                    source.cancel();
                    return;
                };
                let Some(start_data) = pointer.grab_start_data() else {
                    source.cancel();
                    return;
                };
                let grab = DnDGrab::new_pointer(
                    &self.core.display_handle,
                    start_data,
                    source,
                    seat.clone(),
                );
                pointer.set_grab(self, grab, serial, Focus::Keep);
            }
            GrabType::Touch => {
                let Some(touch) = seat.get_touch() else {
                    source.cancel();
                    return;
                };
                let Some(start_data) = touch.grab_start_data() else {
                    source.cancel();
                    return;
                };
                let grab =
                    DnDGrab::new_touch(&self.core.display_handle, start_data, source, seat.clone());
                touch.set_grab(self, grab, serial);
            }
        }
    }
}

delegate_data_control!(crate::CompositorState);
delegate_data_device!(crate::CompositorState);
delegate_primary_selection!(crate::CompositorState);

impl OutputHandler for CompositorState {}
delegate_output!(crate::CompositorState);
delegate_layer_shell!(crate::CompositorState);
delegate_relative_pointer!(crate::CompositorState);
delegate_pointer_gestures!(crate::CompositorState);
delegate_pointer_constraints!(crate::CompositorState);
