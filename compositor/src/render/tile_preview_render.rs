use smithay::{
    backend::renderer::{
        element::{solid::SolidColorRenderElement, Kind},
        gles::GlesRenderer,
        Color32F,
    },
    output::Output,
    utils::Scale,
};

use crate::derp_space::DerpSpaceElem;
use crate::desktop::desktop_stack::DesktopStack;
use crate::CompositorState;
use smithay::backend::renderer::element::AsRenderElements;

type WinEl = <DerpSpaceElem as AsRenderElements<GlesRenderer>>::RenderElement;

const PREVIEW_COLOR: Color32F = Color32F::new(0.2, 0.55, 0.95, 0.58);

pub(crate) fn append_tile_preview_for_output<'a>(
    state: &mut CompositorState,
    output: &Output,
    render_elements: &mut Vec<DesktopStack<'a, WinEl>>,
) {
    let Some(global) = state.tile_preview_rect_global else {
        return;
    };
    let Some(output_geo) = state.space.output_geometry(output) else {
        return;
    };
    let Some(inter) = global.intersection(output_geo) else {
        return;
    };
    if inter.size.w <= 0 || inter.size.h <= 0 {
        return;
    }
    let scale_f = output.current_scale().fractional_scale();
    let loc_out = inter.loc - output_geo.loc;
    state.tile_preview_solid.update(inter.size, PREVIEW_COLOR);
    let phys_loc = loc_out.to_physical_precise_round(Scale::from(scale_f));
    let el = SolidColorRenderElement::from_buffer(
        &state.tile_preview_solid,
        phys_loc,
        scale_f,
        1.0,
        Kind::Unspecified,
    );
    render_elements.push(DesktopStack::TilePreview(el));
}
