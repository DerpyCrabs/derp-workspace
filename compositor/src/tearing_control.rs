use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use smithay::reexports::{
    wayland_protocols::wp::tearing_control::v1::server::{
        wp_tearing_control_manager_v1::{self, WpTearingControlManagerV1},
        wp_tearing_control_v1::{self, WpTearingControlV1},
    },
    wayland_server::{
        backend::GlobalId, protocol::wl_surface::WlSurface, Dispatch, DisplayHandle,
        GlobalDispatch, Resource, Weak,
    },
};
use smithay::wayland::compositor::{with_states, Cacheable};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TearingPresentationHint {
    Vsync,
    Async,
}

impl TearingPresentationHint {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Vsync => "vsync",
            Self::Async => "async",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TearingControlSurfaceCachedState {
    hint: TearingPresentationHint,
}

impl TearingControlSurfaceCachedState {
    pub(crate) fn hint(&self) -> TearingPresentationHint {
        self.hint
    }
}

impl Default for TearingControlSurfaceCachedState {
    fn default() -> Self {
        Self {
            hint: TearingPresentationHint::Vsync,
        }
    }
}

impl Cacheable for TearingControlSurfaceCachedState {
    fn commit(&mut self, _dh: &DisplayHandle) -> Self {
        *self
    }

    fn merge_into(self, into: &mut Self, _dh: &DisplayHandle) {
        *into = self;
    }
}

#[derive(Debug)]
struct TearingControlSurfaceData {
    attached: AtomicBool,
}

impl TearingControlSurfaceData {
    fn new() -> Self {
        Self {
            attached: AtomicBool::new(false),
        }
    }

    fn set_attached(&self, attached: bool) {
        self.attached.store(attached, Ordering::Release);
    }

    fn attached(&self) -> bool {
        self.attached.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
pub(crate) struct TearingControlUserData(Mutex<Weak<WlSurface>>);

impl TearingControlUserData {
    fn new(surface: WlSurface) -> Self {
        Self(Mutex::new(surface.downgrade()))
    }

    fn surface(&self) -> Option<WlSurface> {
        self.0.lock().ok()?.upgrade().ok()
    }
}

#[derive(Debug)]
pub(crate) struct TearingControlState {
    _global: GlobalId,
}

impl TearingControlState {
    pub(crate) fn new<D>(display: &DisplayHandle) -> Self
    where
        D: GlobalDispatch<WpTearingControlManagerV1, ()>
            + Dispatch<WpTearingControlManagerV1, ()>
            + Dispatch<WpTearingControlV1, TearingControlUserData>
            + 'static,
    {
        Self {
            _global: display.create_global::<D, WpTearingControlManagerV1, _>(1, ()),
        }
    }
}

impl<D> GlobalDispatch<WpTearingControlManagerV1, (), D> for TearingControlState
where
    D: GlobalDispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlV1, TearingControlUserData>
        + 'static,
{
    fn bind(
        _state: &mut D,
        _handle: &DisplayHandle,
        _client: &smithay::reexports::wayland_server::Client,
        resource: smithay::reexports::wayland_server::New<WpTearingControlManagerV1>,
        _global_data: &(),
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, D>,
    ) {
        data_init.init(resource, ());
    }
}

impl<D> Dispatch<WpTearingControlManagerV1, (), D> for TearingControlState
where
    D: GlobalDispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlV1, TearingControlUserData>
        + 'static,
{
    fn request(
        _state: &mut D,
        _client: &smithay::reexports::wayland_server::Client,
        resource: &WpTearingControlManagerV1,
        request: <WpTearingControlManagerV1 as Resource>::Request,
        _data: &(),
        _dhandle: &DisplayHandle,
        data_init: &mut smithay::reexports::wayland_server::DataInit<'_, D>,
    ) {
        match request {
            wp_tearing_control_manager_v1::Request::Destroy => {}
            wp_tearing_control_manager_v1::Request::GetTearingControl { id, surface } => {
                let already_attached = with_states(&surface, |states| {
                    states
                        .data_map
                        .insert_if_missing_threadsafe(TearingControlSurfaceData::new);
                    let data = states.data_map.get::<TearingControlSurfaceData>().unwrap();
                    if data.attached() {
                        true
                    } else {
                        data.set_attached(true);
                        false
                    }
                });
                if already_attached {
                    resource.post_error(
                        wp_tearing_control_manager_v1::Error::TearingControlExists,
                        "surface already has a tearing-control object",
                    );
                    return;
                }
                data_init.init(id, TearingControlUserData::new(surface));
            }
            _ => unreachable!(),
        }
    }
}

impl<D> Dispatch<WpTearingControlV1, TearingControlUserData, D> for TearingControlState
where
    D: GlobalDispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlManagerV1, ()>
        + Dispatch<WpTearingControlV1, TearingControlUserData>
        + 'static,
{
    fn request(
        _state: &mut D,
        _client: &smithay::reexports::wayland_server::Client,
        _resource: &WpTearingControlV1,
        request: <WpTearingControlV1 as Resource>::Request,
        data: &TearingControlUserData,
        _dhandle: &DisplayHandle,
        _data_init: &mut smithay::reexports::wayland_server::DataInit<'_, D>,
    ) {
        match request {
            wp_tearing_control_v1::Request::Destroy => {
                if let Some(surface) = data.surface() {
                    with_states(&surface, |states| {
                        states
                            .cached_state
                            .get::<TearingControlSurfaceCachedState>()
                            .pending()
                            .hint = TearingPresentationHint::Vsync;
                        if let Some(surface_data) =
                            states.data_map.get::<TearingControlSurfaceData>()
                        {
                            surface_data.set_attached(false);
                        }
                    });
                }
            }
            wp_tearing_control_v1::Request::SetPresentationHint { hint } => {
                if let Some(surface) = data.surface() {
                    let hint = match hint {
                        smithay::reexports::wayland_server::WEnum::Value(
                            wp_tearing_control_v1::PresentationHint::Async,
                        ) => TearingPresentationHint::Async,
                        _ => TearingPresentationHint::Vsync,
                    };
                    with_states(&surface, |states| {
                        states
                            .cached_state
                            .get::<TearingControlSurfaceCachedState>()
                            .pending()
                            .hint = hint;
                    });
                }
            }
            _ => unreachable!(),
        }
    }

    fn destroyed(
        _state: &mut D,
        _client: smithay::reexports::wayland_server::backend::ClientId,
        _resource: &WpTearingControlV1,
        data: &TearingControlUserData,
    ) {
        if let Some(surface) = data.surface() {
            with_states(&surface, |states| {
                if let Some(surface_data) = states.data_map.get::<TearingControlSurfaceData>() {
                    surface_data.set_attached(false);
                }
            });
        }
    }
}

#[macro_export]
macro_rules! delegate_tearing_control {
    ($ty: ty) => {
        smithay::reexports::wayland_server::delegate_global_dispatch!($ty: [
            smithay::reexports::wayland_protocols::wp::tearing_control::v1::server::wp_tearing_control_manager_v1::WpTearingControlManagerV1: ()
        ] => $crate::tearing_control::TearingControlState);
        smithay::reexports::wayland_server::delegate_dispatch!($ty: [
            smithay::reexports::wayland_protocols::wp::tearing_control::v1::server::wp_tearing_control_manager_v1::WpTearingControlManagerV1: ()
        ] => $crate::tearing_control::TearingControlState);
        smithay::reexports::wayland_server::delegate_dispatch!($ty: [
            smithay::reexports::wayland_protocols::wp::tearing_control::v1::server::wp_tearing_control_v1::WpTearingControlV1: $crate::tearing_control::TearingControlUserData
        ] => $crate::tearing_control::TearingControlState);
    };
}
