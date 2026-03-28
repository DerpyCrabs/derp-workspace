//! Stacking of Wayland workspace content vs the CEF/shell OSR plane.
//!
//! [`smithay::backend::renderer::damage::OutputDamageTracker::render_output`] takes elements in **front-to-back**
//! order (first = topmost). The DRM/winit paths build: **pointer → `Space` (toplevels) → shell OSR** so the
//! cursor draws above the Solid overlay, while native windows still stack above the full-screen shell plane.

use smithay::backend::renderer::{
    element::{memory::MemoryRenderBufferRenderElement, render_elements},
    ImportAll, ImportMem,
};
use smithay::desktop::space::SpaceRenderElements;

render_elements! {
    pub DesktopStack<'a, R, E, C> where
        R: ImportAll + ImportMem;
    Space=SpaceRenderElements<R, E>,
    Shell=&'a C,
    /// Client cursor (wl_surface).
    Pointer=E,
    /// Themed named cursor or system fallback (`MemoryRenderBuffer` from X11 theme / builtin).
    CursorTex=MemoryRenderBufferRenderElement<R>,
}
