use super::*;

use std::os::fd::AsRawFd;

type VirtualKeyboardManager =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1;
type VirtualKeyboard =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1;
type VirtualKeyboardManagerRequest =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_manager_v1::Request;
type VirtualKeyboardRequest =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_v1::Request;
type VirtualKeyboardManagerError =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_manager_v1::Error;
type VirtualKeyboardError =
    wayland_protocols_misc::zwp_virtual_keyboard_v1::server::zwp_virtual_keyboard_v1::Error;
type XdgToplevelDragManager =
    smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_manager_v1::XdgToplevelDragManagerV1;
type XdgToplevelDrag =
    smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_v1::XdgToplevelDragV1;
type XdgToplevelDragManagerRequest =
    smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_manager_v1::Request;
type XdgToplevelDragRequest =
    smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_v1::Request;
type XdgDecorationManager =
    smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_decoration_manager_v1::ZxdgDecorationManagerV1;
type XdgToplevelDecoration =
    smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::ZxdgToplevelDecorationV1;
type XdgDecorationMode =
    smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode;
type XdgDecorationRequest =
    smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Request;
type XdgDecorationManagerRequest =
    smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_decoration_manager_v1::Request;

pub(crate) struct VirtualKeyboardState {
    seat: Seat<CompositorState>,
    keymap_set: AtomicBool,
    pressed_keys: Mutex<HashSet<u32>>,
    modifiers: Mutex<(u32, u32, u32, u32)>,
}

impl VirtualKeyboardState {
    fn new(seat: Seat<CompositorState>) -> Self {
        Self {
            seat,
            keymap_set: AtomicBool::new(false),
            pressed_keys: Mutex::new(HashSet::new()),
            modifiers: Mutex::new((0, 0, 0, 0)),
        }
    }
}

fn virtual_keyboard_client_allowed(client: &Client) -> bool {
    client
        .get_data::<ClientState>()
        .is_some_and(|data| data.virtual_keyboard_allowed)
}

fn virtual_keyboard_keymap_is_valid(format: u32, fd: OwnedFd, size: u32) -> bool {
    if format
        != smithay::reexports::wayland_server::protocol::wl_keyboard::KeymapFormat::XkbV1 as u32
    {
        return false;
    }
    let Ok(len) = usize::try_from(size) else {
        return false;
    };
    if len == 0 || len > 1024 * 1024 {
        return false;
    }
    unsafe {
        let ptr = libc::mmap(
            std::ptr::null_mut(),
            len,
            libc::PROT_READ,
            libc::MAP_PRIVATE,
            fd.as_raw_fd(),
            0,
        );
        if ptr == libc::MAP_FAILED {
            return false;
        }
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), len);
        let valid = std::str::from_utf8(bytes)
            .ok()
            .is_some_and(|text| text.contains("xkb_keymap"));
        let _ = libc::munmap(ptr, len);
        valid
    }
}

impl CompositorState {
    fn virtual_keyboard_release_pressed(&mut self, data: &VirtualKeyboardState) {
        let keys = match data.pressed_keys.lock() {
            Ok(mut pressed) => pressed.drain().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        let loop_handle = self.core.loop_handle.clone();
        for key in keys {
            let _ = self.keyboard_input_from_source(
                "virtual_keyboard",
                key.saturating_add(8).into(),
                KeyState::Released,
                SERIAL_COUNTER.next_serial(),
                0,
                &loop_handle,
            );
        }
    }
}

impl smithay::reexports::wayland_server::GlobalDispatch<VirtualKeyboardManager, (), CompositorState>
    for CompositorState
{
    fn bind(
        _state: &mut CompositorState,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: smithay::reexports::wayland_server::New<VirtualKeyboardManager>,
        _global_data: &(),
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }

    fn can_view(client: Client, _global_data: &()) -> bool {
        virtual_keyboard_client_allowed(&client)
    }
}

impl smithay::reexports::wayland_server::Dispatch<VirtualKeyboardManager, (), CompositorState>
    for CompositorState
{
    fn request(
        state: &mut CompositorState,
        client: &Client,
        resource: &VirtualKeyboardManager,
        request: VirtualKeyboardManagerRequest,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            VirtualKeyboardManagerRequest::CreateVirtualKeyboard { seat, id } => {
                if !virtual_keyboard_client_allowed(client) {
                    resource.post_error(
                        VirtualKeyboardManagerError::Unauthorized,
                        "client is not authorized",
                    );
                    return;
                }
                let Some(seat) = Seat::<CompositorState>::from_resource(&seat) else {
                    resource.post_error(
                        VirtualKeyboardManagerError::Unauthorized,
                        "seat is not available",
                    );
                    return;
                };
                if seat != state.input_routing.seat {
                    resource.post_error(
                        VirtualKeyboardManagerError::Unauthorized,
                        "seat is not authorized",
                    );
                    return;
                }
                data_init.init(id, VirtualKeyboardState::new(seat));
            }
            _ => unreachable!(),
        }
    }
}

impl
    smithay::reexports::wayland_server::Dispatch<
        VirtualKeyboard,
        VirtualKeyboardState,
        CompositorState,
    > for CompositorState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &VirtualKeyboard,
        request: VirtualKeyboardRequest,
        data: &VirtualKeyboardState,
        _dh: &DisplayHandle,
        _data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            VirtualKeyboardRequest::Keymap { format, fd, size } => {
                data.keymap_set.store(
                    virtual_keyboard_keymap_is_valid(format, fd, size),
                    Ordering::SeqCst,
                );
            }
            VirtualKeyboardRequest::Key {
                time,
                key,
                state: key_state,
            } => {
                if !data.keymap_set.load(Ordering::SeqCst) {
                    resource.post_error(VirtualKeyboardError::NoKeymap, "`key` sent before keymap");
                    return;
                }
                if data.seat != state.input_routing.seat {
                    return;
                }
                let key_state = if key_state == 1 {
                    KeyState::Pressed
                } else {
                    KeyState::Released
                };
                if let Ok(mut pressed) = data.pressed_keys.lock() {
                    match key_state {
                        KeyState::Pressed => {
                            pressed.insert(key);
                        }
                        KeyState::Released => {
                            pressed.remove(&key);
                        }
                    }
                }
                let loop_handle = state.core.loop_handle.clone();
                let _ = state.keyboard_input_from_source(
                    "virtual_keyboard",
                    key.saturating_add(8).into(),
                    key_state,
                    SERIAL_COUNTER.next_serial(),
                    time,
                    &loop_handle,
                );
            }
            VirtualKeyboardRequest::Modifiers {
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
            } => {
                if !data.keymap_set.load(Ordering::SeqCst) {
                    resource.post_error(
                        VirtualKeyboardError::NoKeymap,
                        "`modifiers` sent before keymap",
                    );
                    return;
                }
                if let Ok(mut modifiers) = data.modifiers.lock() {
                    *modifiers = (mods_depressed, mods_latched, mods_locked, group);
                }
            }
            VirtualKeyboardRequest::Destroy => {
                state.virtual_keyboard_release_pressed(data);
            }
            _ => unreachable!(),
        }
    }

    fn destroyed(
        state: &mut CompositorState,
        _client: ClientId,
        _resource: &VirtualKeyboard,
        data: &VirtualKeyboardState,
    ) {
        state.virtual_keyboard_release_pressed(data);
    }
}

pub(crate) struct XdgToplevelDragState {
    data_source: WlDataSource,
    source_state: Arc<XdgToplevelDragSourceState>,
}

impl smithay::reexports::wayland_server::GlobalDispatch<XdgToplevelDragManager, (), CompositorState>
    for CompositorState
{
    fn bind(
        _state: &mut CompositorState,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: smithay::reexports::wayland_server::New<XdgToplevelDragManager>,
        _global_data: &(),
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl smithay::reexports::wayland_server::Dispatch<XdgToplevelDragManager, (), CompositorState>
    for CompositorState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &XdgToplevelDragManager,
        request: XdgToplevelDragManagerRequest,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            XdgToplevelDragManagerRequest::GetXdgToplevelDrag { id, data_source } => {
                if state
                    .input_routing
                    .xdg_toplevel_drag_sources
                    .contains_key(&data_source)
                {
                    resource.post_error(
                        smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_manager_v1::Error::InvalidSource,
                        "invalid_source: data_source already used for xdg_toplevel_drag",
                    );
                    return;
                }
                let source_state = Arc::new(XdgToplevelDragSourceState::new());
                state
                    .input_routing
                    .xdg_toplevel_drag_sources
                    .insert(data_source.clone(), source_state.clone());
                data_init.init(
                    id,
                    XdgToplevelDragState {
                        data_source,
                        source_state,
                    },
                );
            }
            XdgToplevelDragManagerRequest::Destroy => {}
            _ => unreachable!(),
        }
    }
}

impl
    smithay::reexports::wayland_server::Dispatch<
        XdgToplevelDrag,
        XdgToplevelDragState,
        CompositorState,
    > for CompositorState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &XdgToplevelDrag,
        request: XdgToplevelDragRequest,
        data: &XdgToplevelDragState,
        _dh: &DisplayHandle,
        _data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            XdgToplevelDragRequest::Attach {
                toplevel,
                x_offset,
                y_offset,
            } => {
                if data.source_state.phase() != XdgToplevelDragPhase::Active {
                    return;
                }
                let Some(toplevel) = state.xdg_shell_state.get_toplevel(&toplevel) else {
                    return;
                };
                let wl = toplevel.wl_surface().clone();
                let Some(window_id) = state.windows.window_registry.window_id_for_wl_surface(&wl)
                else {
                    return;
                };
                let Ok(mut attached) = data.source_state.attached_window_id.lock() else {
                    return;
                };
                if attached.is_some() {
                    resource.post_error(
                        smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_v1::Error::ToplevelAttached,
                        "toplevel_attached: a toplevel is already attached",
                    );
                    return;
                }
                *attached = Some(window_id);
                data.source_state
                    .allow_no_target_drop
                    .store(true, Ordering::SeqCst);
                state.xdg_force_map_pending_deferred_toplevel(&wl);
                state.shell_toplevel_drag_attach(window_id, x_offset, y_offset);
            }
            XdgToplevelDragRequest::Destroy => {
                if data.source_state.phase() != XdgToplevelDragPhase::Ended {
                    resource.post_error(
                        smithay::reexports::wayland_protocols::xdg::toplevel_drag::v1::server::xdg_toplevel_drag_v1::Error::OngoingDrag,
                        "ongoing_drag: drag has not ended",
                    );
                    return;
                }
                state
                    .input_routing
                    .xdg_toplevel_drag_sources
                    .remove(&data.data_source);
            }
            _ => unreachable!(),
        }
    }

    fn destroyed(
        state: &mut CompositorState,
        _client: ClientId,
        _resource: &XdgToplevelDrag,
        data: &XdgToplevelDragState,
    ) {
        state
            .input_routing
            .xdg_toplevel_drag_sources
            .remove(&data.data_source);
    }
}

fn configure_xdg_decoration(
    toplevel: &ToplevelSurface,
    decoration: &XdgToplevelDecoration,
    mode: u32,
) {
    if mode == 0 {
        let _ = decoration.send_event(
            smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Event::Configure {
                mode: smithay::reexports::wayland_server::WEnum::Unknown(0),
            },
        );
    } else {
        let mode = if mode == 1 {
            XdgDecorationMode::ClientSide
        } else {
            XdgDecorationMode::ServerSide
        };
        decoration.configure(mode);
        toplevel.with_pending_state(|state| {
            state.decoration_mode = Some(mode);
        });
    }
    toplevel.send_configure();
}

fn set_xdg_decoration_mode(state: &mut CompositorState, toplevel: &ToplevelSurface, mode: u32) {
    let wl = toplevel.wl_surface().clone();
    let decoration = smithay::wayland::compositor::with_states(&wl, |states| {
        states
            .data_map
            .get::<XdgDecorationSurfaceData>()
            .and_then(|data| {
                if let Ok(mut current) = data.mode.lock() {
                    *current = Some(mode);
                }
                data.resource
                    .lock()
                    .ok()
                    .and_then(|resource| resource.clone())
            })
    });
    if let Some(decoration) = decoration {
        configure_xdg_decoration(toplevel, &decoration, mode);
    }
    if let Some(window_id) = state.windows.window_registry.window_id_for_wl_surface(&wl) {
        if let Some(window) = state.wayland_window_containing_surface(&wl) {
            state.notify_geometry_for_window(&window, true);
        } else if let Some(info) = state.windows.window_registry.window_info(window_id) {
            state.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
        }
    }
}

impl smithay::reexports::wayland_server::GlobalDispatch<XdgDecorationManager, (), CompositorState>
    for CompositorState
{
    fn bind(
        _state: &mut CompositorState,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: smithay::reexports::wayland_server::New<XdgDecorationManager>,
        _global_data: &(),
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        data_init.init(resource, ());
    }
}

impl smithay::reexports::wayland_server::Dispatch<XdgDecorationManager, (), CompositorState>
    for CompositorState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        resource: &XdgDecorationManager,
        request: XdgDecorationManagerRequest,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            XdgDecorationManagerRequest::GetToplevelDecoration { id, toplevel } => {
                let Some(toplevel) = state.xdg_shell_state.get_toplevel(&toplevel) else {
                    resource.post_error(
                        smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Error::Orphaned,
                        "toplevel is already destroyed",
                    );
                    return;
                };
                let wl = toplevel.wl_surface().clone();
                let already_constructed =
                    smithay::wayland::compositor::with_states(&wl, |states| {
                        states
                            .data_map
                            .insert_if_missing_threadsafe(XdgDecorationSurfaceData::default);
                        states
                            .data_map
                            .get::<XdgDecorationSurfaceData>()
                            .and_then(|data| {
                                data.resource.lock().ok().map(|resource| resource.is_some())
                            })
                            .unwrap_or(false)
                    });
                if already_constructed {
                    resource.post_error(
                        smithay::reexports::wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Error::AlreadyConstructed,
                        "toplevel decoration is already constructed",
                    );
                    return;
                }
                let decoration = data_init.init(id, toplevel.clone());
                smithay::wayland::compositor::with_states(&wl, |states| {
                    if let Some(data) = states.data_map.get::<XdgDecorationSurfaceData>() {
                        if let Ok(mut resource) = data.resource.lock() {
                            *resource = Some(decoration.clone());
                        }
                    }
                });
                set_xdg_decoration_mode(state, &toplevel, 2);
            }
            XdgDecorationManagerRequest::Destroy => {}
            _ => unreachable!(),
        }
    }
}

impl
    smithay::reexports::wayland_server::Dispatch<
        XdgToplevelDecoration,
        ToplevelSurface,
        CompositorState,
    > for CompositorState
{
    fn request(
        state: &mut CompositorState,
        _client: &Client,
        _resource: &XdgToplevelDecoration,
        request: XdgDecorationRequest,
        data: &ToplevelSurface,
        _dh: &DisplayHandle,
        _data_init: &mut smithay::reexports::wayland_server::DataInit<'_, CompositorState>,
    ) {
        match request {
            XdgDecorationRequest::SetMode { mode } => {
                let mode = match mode {
                    smithay::reexports::wayland_server::WEnum::Value(
                        XdgDecorationMode::ClientSide,
                    ) => 1,
                    smithay::reexports::wayland_server::WEnum::Value(
                        XdgDecorationMode::ServerSide,
                    ) => 2,
                    smithay::reexports::wayland_server::WEnum::Unknown(0) => 0,
                    _ => 2,
                };
                set_xdg_decoration_mode(state, data, mode);
            }
            XdgDecorationRequest::UnsetMode => {
                set_xdg_decoration_mode(state, data, 2);
            }
            XdgDecorationRequest::Destroy => {
                let wl = data.wl_surface().clone();
                smithay::wayland::compositor::with_states(&wl, |states| {
                    if let Some(data) = states.data_map.get::<XdgDecorationSurfaceData>() {
                        if let Ok(mut resource) = data.resource.lock() {
                            *resource = None;
                        }
                        if let Ok(mut mode) = data.mode.lock() {
                            *mode = None;
                        }
                    }
                });
            }
            _ => unreachable!(),
        }
    }
}

impl XdgForeignHandler for CompositorState {
    fn xdg_foreign_state(&mut self) -> &mut XdgForeignState {
        &mut self.xdg_foreign_state
    }
}

impl KdeDecorationHandler for CompositorState {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.kde_decoration_state
    }

    fn new_decoration(
        &mut self,
        surface: &WlSurface,
        decoration: &wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::OrgKdeKwinServerDecoration,
    ) {
        smithay::wayland::compositor::with_states(surface, |states| {
            states
                .data_map
                .insert_if_missing_threadsafe(KdeServerDecorationSurfaceData::default);
        });
        decoration.mode(
            wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::Server,
        );
    }

    fn request_mode(
        &mut self,
        surface: &WlSurface,
        decoration: &wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::OrgKdeKwinServerDecoration,
        mode: smithay::reexports::wayland_server::WEnum<
            wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode,
        >,
    ) {
        let mode = match mode {
            smithay::reexports::wayland_server::WEnum::Value(mode) => mode,
            smithay::reexports::wayland_server::WEnum::Unknown(0) => {
                wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::None
            }
            smithay::reexports::wayland_server::WEnum::Unknown(1) => {
                wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::Client
            }
            _ => wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::Mode::Server,
        };
        smithay::wayland::compositor::with_states(surface, |states| {
            states
                .data_map
                .insert_if_missing_threadsafe(KdeServerDecorationSurfaceData::default);
            if let Some(data) = states.data_map.get::<KdeServerDecorationSurfaceData>() {
                if let Ok(mut current) = data.mode.lock() {
                    *current = Some(mode);
                }
            }
        });
        decoration.mode(mode);
        if let Some(window_id) = self
            .windows
            .window_registry
            .window_id_for_wl_surface(surface)
        {
            if let Some(window) = self.wayland_window_containing_surface(surface) {
                self.notify_geometry_for_window(&window, true);
            } else if let Some(info) = self.windows.window_registry.window_info(window_id) {
                self.shell_emit_chrome_event(ChromeEvent::WindowGeometryChanged { info });
            }
        }
    }

    fn release(
        &mut self,
        _decoration: &wayland_protocols_misc::server_decoration::server::org_kde_kwin_server_decoration::OrgKdeKwinServerDecoration,
        surface: &WlSurface,
    ) {
        smithay::wayland::compositor::with_states(surface, |states| {
            if let Some(data) = states.data_map.get::<KdeServerDecorationSurfaceData>() {
                if let Ok(mut current) = data.mode.lock() {
                    *current = None;
                }
            }
        });
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
        &mut self.capture.dmabuf_state
    }

    fn dmabuf_imported(
        &mut self,
        _global: &DmabufGlobal,
        dmabuf: Dmabuf,
        notifier: ImportNotifier,
    ) {
        if let Some(weak) = self.capture.dmabuf_import_renderer.as_ref() {
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
        self.capture.drm_syncobj_state.as_mut()
    }
}

smithay::delegate_xdg_activation!(crate::CompositorState);
smithay::delegate_xdg_foreign!(crate::CompositorState);
smithay::delegate_xdg_toplevel_icon!(crate::CompositorState);
smithay::delegate_kde_decoration!(crate::CompositorState);
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
