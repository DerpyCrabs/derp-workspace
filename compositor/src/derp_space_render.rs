use smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement;
use smithay::backend::renderer::element::{AsRenderElements, Wrap};
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::desktop::layer_map_for_output;
use smithay::desktop::space::{Space, SpaceElement, SpaceRenderElements};
use smithay::output::Output;
use smithay::utils::Scale;
use smithay::wayland::shell::wlr_layer::Layer;

use crate::derp_space::{render_window_elements_with_exclusion_mode, DerpSpaceElem};
use crate::state::CompositorState;

pub(crate) type DerpWinRenderEl = <DerpSpaceElem as AsRenderElements<GlesRenderer>>::RenderElement;

pub(crate) fn derp_space_render_elements_with_window_ids(
    space: &Space<DerpSpaceElem>,
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output: &Output,
    alpha: f32,
) -> Vec<(
    SpaceRenderElements<GlesRenderer, DerpWinRenderEl>,
    Option<u32>,
    bool,
)> {
    let mut out: Vec<(
        SpaceRenderElements<GlesRenderer, DerpWinRenderEl>,
        Option<u32>,
        bool,
    )> = Vec::new();
    let output_scale = output.current_scale().fractional_scale();

    let layer_map = layer_map_for_output(output);
    let lower: Vec<_> = {
        let (lower, upper): (Vec<_>, Vec<_>) = layer_map
            .layers()
            .rev()
            .partition(|s| matches!(s.layer(), Layer::Background | Layer::Bottom));

        for surface in upper.into_iter() {
            let Some(loc) = layer_map.layer_geometry(surface).map(|g| g.loc) else {
                continue;
            };
            for el in AsRenderElements::<GlesRenderer>::render_elements::<
                WaylandSurfaceRenderElement<GlesRenderer>,
            >(
                surface,
                renderer,
                loc.to_physical_precise_round(Scale::from(output_scale)),
                Scale::from(output_scale),
                alpha,
            ) {
                out.push((SpaceRenderElements::Surface(el), None, true));
            }
        }
        lower
    };

    if let Some(output_geo) = space.output_geometry(output) {
        for elem in space.elements_for_output(output).rev() {
            let Some(elem_bbox) = space.element_bbox(elem) else {
                continue;
            };
            if !output_geo.overlaps(elem_bbox) {
                continue;
            }
            let Some(eloc) = space.element_location(elem) else {
                continue;
            };
            let wid = state.derp_elem_window_id(elem);
            let render_origin = eloc - elem.geometry().loc;
            let location = render_origin - output_geo.loc;
            match elem {
                DerpSpaceElem::Wayland(window) => {
                    let scale = Scale::from(output_scale);
                    let loc_phys = location.to_physical_precise_round(scale);
                    for (el, include_self_decor) in render_window_elements_with_exclusion_mode(
                        window,
                        renderer,
                        loc_phys,
                        scale,
                        alpha,
                    ) {
                        out.push((
                            SpaceRenderElements::Element(Wrap::from(el)),
                            wid,
                            include_self_decor,
                        ));
                    }
                }
                DerpSpaceElem::X11(_) => {
                    let scale = Scale::from(output_scale);
                    let loc_phys = location.to_physical_precise_round(scale);
                    for el in AsRenderElements::render_elements::<DerpWinRenderEl>(
                        elem,
                        renderer,
                        loc_phys,
                        scale,
                        alpha,
                    ) {
                        out.push((SpaceRenderElements::Element(Wrap::from(el)), wid, true));
                    }
                }
            }
        }
    }

    for surface in lower {
        let Some(loc) = layer_map.layer_geometry(surface).map(|g| g.loc) else {
            continue;
        };
        for el in AsRenderElements::<GlesRenderer>::render_elements::<
            WaylandSurfaceRenderElement<GlesRenderer>,
        >(
            surface,
            renderer,
            loc.to_physical_precise_round(Scale::from(output_scale)),
            Scale::from(output_scale),
            alpha,
        ) {
            out.push((SpaceRenderElements::Surface(el), None, true));
        }
    }

    out
}
