//! Draw the client cursor: `wl_surface` sprite, or the system / themed bitmap fallback for [`Named`].

use smithay::{
    backend::renderer::{
        element::{
            memory::MemoryRenderBufferRenderElement,
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

fn push_named_cursor_fallback(
    state: &CompositorState,
    renderer: &mut GlesRenderer,
    pos: Point<f64, Logical>,
    scale_f: f64,
    out: &mut Vec<Desk<'_>>,
) {
    let (hx, hy) = state.cursor_fallback_hotspot;
    let phys = Point::<f64, Physical>::from((
        ((pos.x - hx as f64) * scale_f),
        ((pos.y - hy as f64) * scale_f),
    ));
    match MemoryRenderBufferRenderElement::from_buffer(
        renderer,
        phys,
        &state.cursor_fallback_buffer,
        None,
        None,
        None,
        Kind::Cursor,
    ) {
        Ok(el) => out.push(DesktopStack::CursorTex(el)),
        Err(e) => tracing::warn!(?e, "cursor fallback MemoryRenderBufferRenderElement"),
    }
}

/// Append pointer layers. Caller should place these **first** in the `elements` slice passed to
/// [`smithay::backend::renderer::damage::OutputDamageTracker::render_output`] (front-to-back: cursor is frontmost).
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
            push_named_cursor_fallback(state, renderer, pos, scale_f, out);
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
                Kind::Cursor,
            ) {
                out.push(DesktopStack::Pointer(el));
            }
        }
    }
}
