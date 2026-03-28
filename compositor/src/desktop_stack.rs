//! Stacking of Wayland workspace content vs the CEF/shell OSR plane.
//!
//! Smithay’s [`render_output`](smithay::desktop::space::render_output) prepends `custom_elements`, making them
//! **frontmost**. We need the shell plane **behind** native toplevels so CEF never composites over client
//! pixels (translucent Solid UI must not reveal window contents). [`DesktopStack`] mirrors Smithay’s
//! internal layout with a reorderable `Space` → `Shell` variant order.

use smithay::backend::renderer::{
    element::{render_elements, solid::SolidColorRenderElement},
    ImportAll,
};
use smithay::desktop::space::SpaceRenderElements;

render_elements! {
    pub DesktopStack<'a, R, E, C> where
        R: ImportAll;
    Space=SpaceRenderElements<R, E>,
    Shell=&'a C,
    /// Client cursor (wl_surface).
    Pointer=E,
    /// Themed/name-only cursor (`wp_cursor_shape`): no wl_surface bitmap — draw a solid fallback.
    CursorFb=SolidColorRenderElement,
}
