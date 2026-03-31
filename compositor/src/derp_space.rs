//! Workspace elements: Wayland xdg toplevels and Xwayland (X11) surfaces.

use smithay::{
    backend::renderer::{
        element::{
            surface::{render_elements_from_surface_tree, WaylandSurfaceRenderElement},
            utils::CropRenderElement,
            AsRenderElements, Element, Kind,
        },
        ImportAll, Renderer, Texture,
    },
    desktop::{space::SpaceElement, PopupManager, Window, WindowSurface},
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
            DerpSpaceElem::Wayland(w) => w.bbox_with_popups(),
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

fn wayland_window_needs_geometry_clip(window: &Window) -> bool {
    let geo = window.geometry();
    let bbox = window.bbox();
    if bbox.size.w == 0 || bbox.size.h == 0 {
        return false;
    }
    bbox.size.w != geo.size.w
        || bbox.size.h != geo.size.h
        || geo.loc.x != 0
        || geo.loc.y != 0
        || bbox.loc.x != 0
        || bbox.loc.y != 0
}

fn crop_wrap_wayland_surface_element<R>(
    el: WaylandSurfaceRenderElement<R>,
    scale: Scale<f64>,
    global_clip_phys: Option<Rectangle<i32, Physical>>,
) -> Option<CropRenderElement<WaylandSurfaceRenderElement<R>>>
where
    R: Renderer + ImportAll,
    R::TextureId: Clone + Texture + 'static,
{
    let crop = match global_clip_phys {
             Some(r) => r,
             None => el.geometry(scale),
         };
    CropRenderElement::from_element(el, scale, crop)
}

impl<R> AsRenderElements<R> for DerpSpaceElem
where
    R: Renderer + ImportAll,
    R::TextureId: Clone + Texture + 'static,
{
    type RenderElement = CropRenderElement<WaylandSurfaceRenderElement<R>>;

    fn render_elements<C: From<CropRenderElement<WaylandSurfaceRenderElement<R>>>>(
        &self,
        renderer: &mut R,
        location: Point<i32, Physical>,
        scale: Scale<f64>,
        alpha: f32,
    ) -> Vec<C> {
        match self {
            DerpSpaceElem::Wayland(window) => match window.underlying_surface() {
                WindowSurface::Wayland(s) => {
                    let surface = s.wl_surface();
                    let mut out: Vec<C> = Vec::new();
                    let popup_render_elements =
                        PopupManager::popups_for_surface(surface).flat_map(|(popup, popup_offset)| {
                            let offset = (window.geometry().loc + popup_offset - popup.geometry().loc)
                                .to_physical_precise_round(scale);
                            render_elements_from_surface_tree(
                                renderer,
                                popup.wl_surface(),
                                location + offset,
                                scale,
                                alpha,
                                Kind::Unspecified,
                            )
                        });
                    for el in popup_render_elements {
                        if let Some(w) = crop_wrap_wayland_surface_element(el, scale, None) {
                            out.push(C::from(w));
                        }
                    }
                    let main_els = render_elements_from_surface_tree(
                        renderer,
                        surface,
                        location,
                        scale,
                        alpha,
                        Kind::Unspecified,
                    );
                    let global_clip = wayland_window_needs_geometry_clip(window).then(|| {
                        let wg = window.geometry();
                        let loc = location + wg.loc.to_physical_precise_round(scale);
                        let size = wg.size.to_physical_precise_round(scale);
                        Rectangle::new(loc, size)
                    });
                    for el in main_els {
                        if let Some(w) =
                            crop_wrap_wayland_surface_element(el, scale, global_clip)
                        {
                            out.push(C::from(w));
                        }
                    }
                    out
                }
                WindowSurface::X11(x11) => AsRenderElements::render_elements(x11, renderer, location, scale, alpha)
                    .into_iter()
                    .filter_map(|el| crop_wrap_wayland_surface_element(el, scale, None).map(C::from))
                    .collect(),
            },
            DerpSpaceElem::X11(x11) => AsRenderElements::render_elements(x11, renderer, location, scale, alpha)
                .into_iter()
                .filter_map(|el| crop_wrap_wayland_surface_element(el, scale, None).map(C::from))
                .collect(),
        }
    }
}
