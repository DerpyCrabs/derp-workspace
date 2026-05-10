use crate::{derp_space::DerpSpaceElem, CompositorState};
use smithay::{
    desktop::Space,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point, Rectangle, Size},
    wayland::compositor,
};
use std::cell::RefCell;

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct ResizeEdge: u32 {
        const TOP          = 0b0001;
        const BOTTOM       = 0b0010;
        const LEFT         = 0b0100;
        const RIGHT        = 0b1000;

        const TOP_LEFT     = Self::TOP.bits() | Self::LEFT.bits();
        const BOTTOM_LEFT  = Self::BOTTOM.bits() | Self::LEFT.bits();

        const TOP_RIGHT    = Self::TOP.bits() | Self::RIGHT.bits();
        const BOTTOM_RIGHT = Self::BOTTOM.bits() | Self::RIGHT.bits();
    }
}

pub fn compute_clamped_resize_size(
    data: &CompositorState,
    wl_surface: &WlSurface,
    edges: ResizeEdge,
    initial_size: Size<i32, Logical>,
    accum_dx: f64,
    accum_dy: f64,
) -> Size<i32, Logical> {
    let mut delta_x = accum_dx;
    let mut delta_y = accum_dy;

    if edges.intersects(ResizeEdge::LEFT | ResizeEdge::RIGHT) && edges.intersects(ResizeEdge::LEFT)
    {
        delta_x = -delta_x;
    }

    if edges.intersects(ResizeEdge::TOP | ResizeEdge::BOTTOM) && edges.intersects(ResizeEdge::TOP) {
        delta_y = -delta_y;
    }

    let mut new_window_width = initial_size.w;
    let mut new_window_height = initial_size.h;

    if edges.intersects(ResizeEdge::LEFT | ResizeEdge::RIGHT) {
        new_window_width = (initial_size.w as f64 + delta_x) as i32;
    }

    if edges.intersects(ResizeEdge::TOP | ResizeEdge::BOTTOM) {
        new_window_height = (initial_size.h as f64 + delta_y) as i32;
    }

    data.clamp_wayland_toplevel_content_size(wl_surface, new_window_width, new_window_height)
}

pub fn resize_tracking_set_resizing(
    surface: &WlSurface,
    edges: ResizeEdge,
    initial_rect: Rectangle<i32, Logical>,
) {
    ResizeSurfaceState::with(surface, |state| {
        *state = ResizeSurfaceState::Resizing {
            edges,
            initial_rect,
        };
    });
}

pub fn resize_tracking_set_waiting_last_commit(
    surface: &WlSurface,
    edges: ResizeEdge,
    initial_rect: Rectangle<i32, Logical>,
) {
    ResizeSurfaceState::with(surface, |state| {
        *state = ResizeSurfaceState::WaitingForLastCommit {
            edges,
            initial_rect,
        };
    });
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum ResizeSurfaceState {
    #[default]
    Idle,
    Resizing {
        edges: ResizeEdge,
        initial_rect: Rectangle<i32, Logical>,
    },
    WaitingForLastCommit {
        edges: ResizeEdge,
        initial_rect: Rectangle<i32, Logical>,
    },
}

impl ResizeSurfaceState {
    fn with<F, T>(surface: &WlSurface, cb: F) -> T
    where
        F: FnOnce(&mut Self) -> T,
    {
        compositor::with_states(surface, |states| {
            states.data_map.insert_if_missing(RefCell::<Self>::default);
            let state = states.data_map.get::<RefCell<Self>>().unwrap();

            cb(&mut state.borrow_mut())
        })
    }

    fn commit(&mut self) -> Option<(ResizeEdge, Rectangle<i32, Logical>)> {
        match *self {
            Self::Resizing {
                edges,
                initial_rect,
            } => Some((edges, initial_rect)),
            Self::WaitingForLastCommit {
                edges,
                initial_rect,
            } => {
                *self = Self::Idle;
                Some((edges, initial_rect))
            }
            Self::Idle => None,
        }
    }
}

pub fn handle_commit(space: &mut Space<DerpSpaceElem>, surface: &WlSurface) -> Option<()> {
    let window = space.elements().find_map(|e| {
        if let DerpSpaceElem::Wayland(w) = e {
            (w.toplevel().unwrap().wl_surface() == surface).then_some(w.clone())
        } else {
            None
        }
    })?;

    let mut window_loc = space.element_location(&DerpSpaceElem::Wayland(window.clone()))?;
    let geometry = window.geometry();

    let new_loc: Point<Option<i32>, Logical> = ResizeSurfaceState::with(surface, |state| {
        state
            .commit()
            .and_then(|(edges, initial_rect)| {
                edges.intersects(ResizeEdge::TOP_LEFT).then(|| {
                    let new_x = edges
                        .intersects(ResizeEdge::LEFT)
                        .then_some(initial_rect.loc.x + (initial_rect.size.w - geometry.size.w));

                    let new_y = edges
                        .intersects(ResizeEdge::TOP)
                        .then_some(initial_rect.loc.y + (initial_rect.size.h - geometry.size.h));

                    (new_x, new_y).into()
                })
            })
            .unwrap_or_default()
    });

    if let Some(new_x) = new_loc.x {
        window_loc.x = new_x;
    }
    if let Some(new_y) = new_loc.y {
        window_loc.y = new_y;
    }

    if new_loc.x.is_some() || new_loc.y.is_some() {
        space.map_element(DerpSpaceElem::Wayland(window), window_loc, false);
    }

    Some(())
}
