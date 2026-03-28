//! Draw the client cursor: `wl_surface` sprite, or a solid fallback for `wp_cursor_shape` [`Named`] icons.

use smithay::{
    backend::renderer::{
        element::{
            memory::MemoryRenderBufferRenderElement,
            solid::SolidColorRenderElement,
            surface::render_elements_from_surface_tree,
            AsRenderElements, Kind,
        },
        gles::GlesRenderer,
    },
    desktop::Window,
    input::pointer::{CursorImageStatus, CursorImageSurfaceData},
    output::Output,
    utils::{IsAlive, Logical, Point, Physical, Scale},
    wayland::compositor,
};

use crate::{desktop_stack::DesktopStack, CompositorState};

type WinEl = <Window as AsRenderElements<GlesRenderer>>::RenderElement;
type Desk<'a> = DesktopStack<
    'a,
    GlesRenderer,
    WinEl,
    MemoryRenderBufferRenderElement<GlesRenderer>,
>;

/// Append cursor layers (topmost) to the render list: Wayland surface and/or solid fallback for themed cursors.
pub fn append_pointer_desktop_elements(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    output: &Output,
    out: &mut Vec<Desk<'_>>,
) {
    let Some(pointer) = state.seat.get_pointer() else {
        return;
    };
    let pos = pointer.current_location();
    let scale_f = output.current_scale().fractional_scale();

    match &state.pointer_cursor_image {
        CursorImageStatus::Hidden => {}
        CursorImageStatus::Named(_) => {
            let phys = Point::<i32, Physical>::from((
                (pos.x * scale_f).round() as i32,
                (pos.y * scale_f).round() as i32,
            ));
            let el = SolidColorRenderElement::from_buffer(
                &state.cursor_fallback_buffer,
                phys,
                Scale::from(scale_f),
                1.0,
                Kind::Unspecified,
            );
            out.push(DesktopStack::CursorFb(el));
        }
        CursorImageStatus::Surface(surface) => {
            if !surface.alive() {
                return;
            }
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
            for el in render_elements_from_surface_tree(
                renderer,
                surface,
                phys,
                Scale::from(scale_f),
                1.0,
                Kind::Unspecified,
            ) {
                out.push(DesktopStack::Pointer(el));
            }
        }
    }
}
