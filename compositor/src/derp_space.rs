//! Workspace elements: Wayland xdg toplevels and Xwayland (X11) surfaces.

use smithay::{
    backend::renderer::{
        element::{surface::WaylandSurfaceRenderElement, AsRenderElements},
        ImportAll, Renderer,
    },
    desktop::{space::SpaceElement, Window},
    output::Output,
    utils::{IsAlive, Logical, Physical, Point, Rectangle, Scale},
    xwayland::X11Surface,
};

#[derive(Debug, Clone)]
pub enum DerpSpaceElem {
    Wayland(Window),
    X11(X11Surface),
}

impl PartialEq for DerpSpaceElem {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Wayland(a), Self::Wayland(b)) => a == b,
            (Self::X11(a), Self::X11(b)) => a == b,
            _ => false,
        }
    }
}

impl IsAlive for DerpSpaceElem {
    fn alive(&self) -> bool {
        match self {
            DerpSpaceElem::Wayland(w) => w.alive(),
            DerpSpaceElem::X11(x) => x.alive(),
        }
    }
}

impl SpaceElement for DerpSpaceElem {
    fn geometry(&self) -> Rectangle<i32, Logical> {
        match self {
            DerpSpaceElem::Wayland(w) => w.geometry(),
            DerpSpaceElem::X11(x) => x.geometry(),
        }
    }

    fn bbox(&self) -> Rectangle<i32, Logical> {
        match self {
            DerpSpaceElem::Wayland(w) => w.bbox(),
            DerpSpaceElem::X11(x) => x.bbox(),
        }
    }

    fn is_in_input_region(&self, point: &Point<f64, Logical>) -> bool {
        match self {
            DerpSpaceElem::Wayland(w) => w.is_in_input_region(point),
            DerpSpaceElem::X11(x) => x.is_in_input_region(point),
        }
    }

    fn z_index(&self) -> u8 {
        match self {
            DerpSpaceElem::Wayland(w) => w.z_index(),
            DerpSpaceElem::X11(x) => x.z_index(),
        }
    }

    fn set_activate(&self, activated: bool) {
        match self {
            DerpSpaceElem::Wayland(w) => w.set_activate(activated),
            DerpSpaceElem::X11(x) => x.set_activate(activated),
        }
    }

    fn output_enter(&self, output: &Output, overlap: Rectangle<i32, Logical>) {
        match self {
            DerpSpaceElem::Wayland(w) => w.output_enter(output, overlap),
            DerpSpaceElem::X11(x) => x.output_enter(output, overlap),
        }
    }

    fn output_leave(&self, output: &Output) {
        match self {
            DerpSpaceElem::Wayland(w) => w.output_leave(output),
            DerpSpaceElem::X11(x) => x.output_leave(output),
        }
    }

    fn refresh(&self) {
        match self {
            DerpSpaceElem::Wayland(w) => w.refresh(),
            DerpSpaceElem::X11(x) => x.refresh(),
        }
    }
}

impl<R> AsRenderElements<R> for DerpSpaceElem
where
    R: Renderer + ImportAll,
    R::TextureId: Clone + smithay::backend::renderer::Texture + 'static,
{
    type RenderElement = WaylandSurfaceRenderElement<R>;

    fn render_elements<C: From<WaylandSurfaceRenderElement<R>>>(
        &self,
        renderer: &mut R,
        location: Point<i32, Physical>,
        scale: Scale<f64>,
        alpha: f32,
    ) -> Vec<C> {
        match self {
            DerpSpaceElem::Wayland(window) => {
                AsRenderElements::render_elements(window, renderer, location, scale, alpha)
            }
            DerpSpaceElem::X11(x11) => {
                AsRenderElements::render_elements(x11, renderer, location, scale, alpha)
            }
        }
    }
}
