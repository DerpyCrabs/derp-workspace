//! Draw the client’s `wl_pointer` cursor surface (required on KMS; optional but consistent in nested mode).

use smithay::{
    backend::renderer::{
        element::{
            surface::{render_elements_from_surface_tree, WaylandSurfaceRenderElement},
            Kind,
        },
        ImportAll, Renderer,
    },
    input::pointer::{CursorImageStatus, CursorImageSurfaceData},
    output::Output,
    utils::{IsAlive, Logical, Point, Physical, Scale},
    wayland::compositor,
};

use crate::CompositorState;

pub fn pointer_render_elements<R: Renderer + ImportAll>(
    state: &CompositorState,
    renderer: &mut R,
    output: &Output,
) -> Vec<WaylandSurfaceRenderElement<R>>
where
    R::TextureId: Clone + 'static,
{
    let CursorImageStatus::Surface(surface) = &state.pointer_cursor_image else {
        return Vec::new();
    };
    if !surface.alive() {
        return Vec::new();
    }
    let Some(pointer) = state.seat.get_pointer() else {
        return Vec::new();
    };
    let pos = pointer.current_location();
    let scale_f = output.current_scale().fractional_scale();
    let hotspot: Point<i32, Logical> = compositor::with_states(surface, |states| {
        states
            .data_map
            .get::<CursorImageSurfaceData>()
            .map(|m| m.lock().unwrap().hotspot)
            .unwrap_or_default()
    });
    let phys = Point::<i32, Physical>::from((
        ((pos.x - hotspot.x as f64) * scale_f).round() as i32,
        ((pos.y - hotspot.y as f64) * scale_f).round() as i32,
    ));
    render_elements_from_surface_tree(
        renderer,
        surface,
        phys,
        Scale::from(scale_f),
        1.0,
        Kind::Unspecified,
    )
}
