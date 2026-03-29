//! Stacking of Wayland workspace content vs the CEF/shell OSR plane.
//!
//! [`smithay::backend::renderer::damage::OutputDamageTracker::render_output`] takes elements in **front-to-back**
//! order (first = topmost). The DRM/winit paths build: **pointer → `Space` (toplevels) → shell OSR** so the
//! cursor draws above the Solid overlay, while native windows still stack above the full-screen shell plane.
//!
//! This enum is written out by hand: Smithay’s `render_elements!` with [`TextureRenderElement<GlesTexture>`]
//! pins `R = GlesRenderer`; [`DesktopStack`] lists variants explicitly to match.

use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::renderer::{
    element::{
        memory::MemoryRenderBufferRenderElement,
        texture::TextureRenderElement,
        Element, Id, Kind, RenderElement, UnderlyingStorage,
    },
    gles::{GlesError, GlesFrame, GlesRenderer, GlesTexture},
    utils::{CommitCounter, DamageSet, OpaqueRegions},
    ImportDma, Renderer,
};
use smithay::desktop::space::SpaceRenderElements;
use smithay::utils::{Buffer, Logical, Physical, Point, Rectangle, Scale, Size, Transform};
use std::convert::Infallible;

/// Dma-buf-backed shell plane (`TextureRenderElement` over an imported GLES texture).
pub type ShellDmaElement = TextureRenderElement<GlesTexture>;
pub type ShellCursorElement = MemoryRenderBufferRenderElement<GlesRenderer>;

#[allow(clippy::large_enum_variant)]
pub enum DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    Space(SpaceRenderElements<GlesRenderer, E>),
    ShellDma(&'a ShellDmaElement),
    Pointer(E),
    CursorTex(ShellCursorElement),
    #[doc(hidden)]
    _Catcher(Infallible),
}

impl<'a, E> Element for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn id(&self) -> &Id {
        match self {
            DesktopStack::Space(x) => x.id(),
            DesktopStack::ShellDma(x) => (*x).id(),
            DesktopStack::Pointer(x) => x.id(),
            DesktopStack::CursorTex(x) => x.id(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn current_commit(&self) -> CommitCounter {
        match self {
            DesktopStack::Space(x) => x.current_commit(),
            DesktopStack::ShellDma(x) => (*x).current_commit(),
            DesktopStack::Pointer(x) => x.current_commit(),
            DesktopStack::CursorTex(x) => x.current_commit(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.location(scale),
            DesktopStack::ShellDma(x) => (*x).location(scale),
            DesktopStack::Pointer(x) => x.location(scale),
            DesktopStack::CursorTex(x) => x.location(scale),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        match self {
            DesktopStack::Space(x) => x.src(),
            DesktopStack::ShellDma(x) => (*x).src(),
            DesktopStack::Pointer(x) => x.src(),
            DesktopStack::CursorTex(x) => x.src(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn transform(&self) -> Transform {
        match self {
            DesktopStack::Space(x) => x.transform(),
            DesktopStack::ShellDma(x) => (*x).transform(),
            DesktopStack::Pointer(x) => x.transform(),
            DesktopStack::CursorTex(x) => x.transform(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.geometry(scale),
            DesktopStack::ShellDma(x) => (*x).geometry(scale),
            DesktopStack::Pointer(x) => x.geometry(scale),
            DesktopStack::CursorTex(x) => x.geometry(scale),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.damage_since(scale, commit),
            DesktopStack::ShellDma(x) => (*x).damage_since(scale, commit),
            DesktopStack::Pointer(x) => x.damage_since(scale, commit),
            DesktopStack::CursorTex(x) => x.damage_since(scale, commit),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.opaque_regions(scale),
            DesktopStack::ShellDma(x) => (*x).opaque_regions(scale),
            DesktopStack::Pointer(x) => x.opaque_regions(scale),
            DesktopStack::CursorTex(x) => x.opaque_regions(scale),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn alpha(&self) -> f32 {
        match self {
            DesktopStack::Space(x) => x.alpha(),
            DesktopStack::ShellDma(x) => (*x).alpha(),
            DesktopStack::Pointer(x) => x.alpha(),
            DesktopStack::CursorTex(x) => x.alpha(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn kind(&self) -> Kind {
        match self {
            DesktopStack::Space(x) => x.kind(),
            DesktopStack::ShellDma(x) => (*x).kind(),
            DesktopStack::Pointer(x) => x.kind(),
            DesktopStack::CursorTex(x) => x.kind(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }
}

impl<'a, E> RenderElement<GlesRenderer> for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
    ) -> Result<(), smithay::backend::renderer::gles::GlesError> {
        match self {
            DesktopStack::Space(x) => x.draw(frame, src, dst, damage, opaque_regions),
            DesktopStack::ShellDma(x) => {
                RenderElement::<GlesRenderer>::draw(x, frame, src, dst, damage, opaque_regions)
            }
            DesktopStack::Pointer(x) => x.draw(frame, src, dst, damage, opaque_regions),
            DesktopStack::CursorTex(x) => x.draw(frame, src, dst, damage, opaque_regions),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn underlying_storage(
        &self,
        renderer: &mut GlesRenderer,
    ) -> Option<UnderlyingStorage<'_>> {
        match self {
            DesktopStack::Space(x) => x.underlying_storage(renderer),
            DesktopStack::ShellDma(x) => (*x).underlying_storage(renderer),
            DesktopStack::Pointer(x) => x.underlying_storage(renderer),
            DesktopStack::CursorTex(x) => x.underlying_storage(renderer),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }
}

impl<'a, E> From<SpaceRenderElements<GlesRenderer, E>> for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn from(x: SpaceRenderElements<GlesRenderer, E>) -> Self {
        DesktopStack::Space(x)
    }
}

impl<'a, E> From<ShellCursorElement> for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn from(x: ShellCursorElement) -> Self {
        DesktopStack::CursorTex(x)
    }
}

/// Letterboxed dma-buf shell plane: [`GlesRenderer::import_dmabuf`] + [`TextureRenderElement::from_static_texture`].
pub fn shell_dmabuf_overlay_element(
    renderer: &mut GlesRenderer,
    dmabuf: &Dmabuf,
    overlay_id: Id,
    shell_loc_phys: Point<f64, Physical>,
    shell_size_logical: Size<i32, Logical>,
    src_full_buffer: Option<Rectangle<f64, Logical>>,
) -> Result<ShellDmaElement, GlesError> {
    let texture = renderer.import_dmabuf(dmabuf, None)?;
    let context_id = renderer.context_id();
    Ok(TextureRenderElement::from_static_texture(
        overlay_id,
        context_id,
        shell_loc_phys,
        texture,
        1,
        Transform::Normal,
        None,
        src_full_buffer,
        Some(shell_size_logical),
        None,
        Kind::Unspecified,
    ))
}
