//! Stacking of Wayland workspace content vs the CEF/shell OSR plane.
//!
//! [`smithay::backend::renderer::damage::OutputDamageTracker::render_output`] takes elements in **front-to-back**
//! order (first = topmost). The DRM/winit paths build: **pointer → `Space` (toplevels) → shell OSR** so the
//! cursor draws above the Solid overlay, while native windows still stack above the full-screen shell plane.
//!
//! This enum is written out by hand: Smithay’s `render_elements!` pins `R = GlesRenderer`; [`DesktopStack`]
//! lists variants explicitly to match.

use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::renderer::{
    element::{
        memory::MemoryRenderBufferRenderElement, solid::SolidColorRenderElement,
        surface::WaylandSurfaceRenderElement, Element, Id, Kind, RenderElement, UnderlyingStorage,
    },
    gles::{GlesError, GlesFrame, GlesRenderer, GlesTexture},
    utils::{CommitCounter, DamageSet, OpaqueRegions},
    ContextId, Frame, ImportDma, Renderer,
};
use smithay::desktop::space::SpaceRenderElements;
use smithay::utils::user_data::UserDataMap;
use smithay::utils::{Buffer, Logical, Physical, Point, Rectangle, Scale, Size, Transform};
use std::convert::Infallible;
use std::sync::Arc;
use tracing::warn;

use crate::desktop::exclusion_clip;

pub(crate) fn fractional_output_damage_inflate_enabled(scale: f64) -> bool {
    (scale - scale.round()).abs() > 1e-6
}

fn inflate_phys_rect_1px(r: Rectangle<i32, Physical>) -> Rectangle<i32, Physical> {
    Rectangle::new(
        Point::from((r.loc.x - 1, r.loc.y - 1)),
        Size::from((r.size.w + 2, r.size.h + 2)),
    )
}

fn inflate_damage_set_phys(d: DamageSet<i32, Physical>) -> DamageSet<i32, Physical> {
    d.into_iter().map(inflate_phys_rect_1px).collect()
}

pub struct FractionalDamageSpaceElements<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    inner: SpaceRenderElements<GlesRenderer, E>,
    output_scale: f64,
}

impl<E> FractionalDamageSpaceElements<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    pub fn new(inner: SpaceRenderElements<GlesRenderer, E>, output_scale: f64) -> Self {
        Self {
            inner,
            output_scale,
        }
    }
}

impl<E> Element for FractionalDamageSpaceElements<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn id(&self) -> &Id {
        self.inner.id()
    }

    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }

    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(scale)
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.inner.src()
    }

    fn transform(&self) -> Transform {
        self.inner.transform()
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        let d = self.inner.damage_since(scale, commit);
        if fractional_output_damage_inflate_enabled(self.output_scale) {
            inflate_damage_set_phys(d)
        } else {
            d
        }
    }

    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        self.inner.opaque_regions(scale)
    }

    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl<E> RenderElement<GlesRenderer> for FractionalDamageSpaceElements<E>
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
        cache: Option<&UserDataMap>,
    ) -> Result<(), GlesError> {
        self.inner
            .draw(frame, src, dst, damage, opaque_regions, cache)
    }

    fn underlying_storage(&self, renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        self.inner.underlying_storage(renderer)
    }
}

pub struct SpaceExclusionClip<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    inner: FractionalDamageSpaceElements<E>,
    exclusion: Arc<exclusion_clip::ShellExclusionClipCtx>,
}

impl<E> SpaceExclusionClip<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    pub fn new(
        inner: SpaceRenderElements<GlesRenderer, E>,
        output_scale: f64,
        exclusion: Arc<exclusion_clip::ShellExclusionClipCtx>,
    ) -> Self {
        Self {
            inner: FractionalDamageSpaceElements::new(inner, output_scale),
            exclusion,
        }
    }
}

impl<E> Element for SpaceExclusionClip<E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn id(&self) -> &Id {
        self.inner.id()
    }

    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }

    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(scale)
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.inner.src()
    }

    fn transform(&self) -> Transform {
        self.inner.transform()
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        self.inner.damage_since(scale, commit)
    }

    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        if self.exclusion.zones.is_empty() {
            return self.inner.opaque_regions(scale);
        }
        let geom = self.inner.geometry(scale);
        let mut out: Vec<Rectangle<i32, Physical>> = Vec::new();
        for r in self.inner.opaque_regions(scale).iter() {
            if r.size.w <= 0 || r.size.h <= 0 {
                continue;
            }
            let mut r_out = *r;
            r_out.loc.x += geom.loc.x;
            r_out.loc.y += geom.loc.y;
            let g = self.exclusion.damage_output_phys_to_global_log(r_out);
            for piece in exclusion_clip::subtract_holes_from_rect_log(g, &self.exclusion.zones) {
                if piece.size.w <= 0 || piece.size.h <= 0 {
                    continue;
                }
                if let Some(local) = self
                    .exclusion
                    .global_log_rect_to_damage_local_phys(piece, geom)
                {
                    if local.size.w > 0 && local.size.h > 0 {
                        out.push(local);
                    }
                }
            }
        }
        OpaqueRegions::from_iter(out)
    }

    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl<E> RenderElement<GlesRenderer> for SpaceExclusionClip<E>
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
        cache: Option<&UserDataMap>,
    ) -> Result<(), GlesError> {
        if self.exclusion.zones.is_empty() {
            return self
                .inner
                .draw(frame, src, dst, damage, opaque_regions, cache);
        }
        let mut clipped: Vec<Rectangle<i32, Physical>> = Vec::new();
        for d in damage {
            if d.size.w <= 0 || d.size.h <= 0 {
                continue;
            }
            let mut d_out = *d;
            d_out.loc.x += dst.loc.x;
            d_out.loc.y += dst.loc.y;
            let g = self.exclusion.damage_output_phys_to_global_log(d_out);
            for piece in exclusion_clip::subtract_holes_from_rect_log(g, &self.exclusion.zones) {
                if piece.size.w <= 0 || piece.size.h <= 0 {
                    continue;
                }
                if let Some(pl) = self
                    .exclusion
                    .global_log_rect_to_damage_local_phys(piece, dst)
                {
                    if pl.size.w > 0 && pl.size.h > 0 {
                        clipped.push(pl);
                    }
                }
            }
        }
        if clipped.is_empty() {
            return Ok(());
        }
        self.inner
            .draw(frame, src, dst, &clipped, opaque_regions, cache)
    }

    fn underlying_storage(&self, renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        self.inner.underlying_storage(renderer)
    }
}

#[derive(Clone)]
pub struct ShellDmaElement {
    id: Id,
    context_id: ContextId<GlesTexture>,
    location: Point<f64, Physical>,
    dst_logical_size: Size<i32, Logical>,
    texture: GlesTexture,
    buffer_src: Rectangle<f64, Buffer>,
    commit: CommitCounter,
    damage_phys: Option<Vec<Rectangle<i32, Physical>>>,
    alpha: f32,
}

impl ShellDmaElement {
    pub(crate) fn wallpaper_quad(
        id: Id,
        context_id: ContextId<GlesTexture>,
        location: Point<f64, Physical>,
        dst_logical_size: Size<i32, Logical>,
        texture: GlesTexture,
        buffer_src: Rectangle<f64, Buffer>,
        commit: CommitCounter,
    ) -> Self {
        Self {
            id,
            context_id,
            location,
            dst_logical_size,
            texture,
            buffer_src,
            commit,
            damage_phys: None,
            alpha: 1.0,
        }
    }

    pub(crate) fn with_alpha(mut self, alpha: f32) -> Self {
        self.alpha = alpha.clamp(0.0, 1.0);
        self
    }

    fn physical_size(&self, scale: Scale<f64>) -> Size<i32, Physical> {
        let logical_size = self.dst_logical_size;
        ((logical_size.to_f64().to_physical(scale).to_point() + self.location).to_i32_round()
            - self.location.to_i32_round())
        .to_size()
    }
}

impl Element for ShellDmaElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.buffer_src
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        Rectangle::new(self.location.to_i32_round(), self.physical_size(scale))
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        let full_rect = Rectangle::new(
            Point::<i32, Physical>::from((0, 0)),
            self.physical_size(scale),
        );
        let set = match self.current_commit().distance(commit) {
            None => DamageSet::from_slice(&[full_rect]),
            Some(0) => DamageSet::default(),
            Some(1) => match &self.damage_phys {
                None => DamageSet::from_slice(&[full_rect]),
                Some(rects) => {
                    let v: Vec<_> = rects
                        .iter()
                        .filter_map(|r| r.intersection(full_rect))
                        .collect();
                    if v.is_empty() {
                        DamageSet::from_slice(&[full_rect])
                    } else {
                        v.into_iter().collect()
                    }
                }
            },
            Some(_) => DamageSet::from_slice(&[full_rect]),
        };
        if fractional_output_damage_inflate_enabled(scale.x) {
            inflate_damage_set_phys(set)
        } else {
            set
        }
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }

    fn alpha(&self) -> f32 {
        self.alpha
    }
}

impl RenderElement<GlesRenderer> for ShellDmaElement {
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), GlesError> {
        if frame.context_id() != self.context_id {
            warn!("trying to render texture from different renderer context");
            return Ok(());
        }
        Frame::render_texture_from_to(
            frame,
            &self.texture,
            src,
            dst,
            damage,
            opaque_regions,
            Transform::Normal,
            self.alpha,
        )
    }
}

pub type ShellCursorElement = MemoryRenderBufferRenderElement<GlesRenderer>;

pub struct FractionalDamageElement<E> {
    inner: E,
    output_scale: f64,
}

impl<E> FractionalDamageElement<E> {
    pub fn new(inner: E, output_scale: f64) -> Self {
        Self {
            inner,
            output_scale,
        }
    }
}

impl<E: Element> Element for FractionalDamageElement<E> {
    fn id(&self) -> &Id {
        self.inner.id()
    }

    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }

    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(scale)
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.inner.src()
    }

    fn transform(&self) -> Transform {
        self.inner.transform()
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }

    fn damage_since(
        &self,
        scale: Scale<f64>,
        commit: Option<CommitCounter>,
    ) -> DamageSet<i32, Physical> {
        let d = self.inner.damage_since(scale, commit);
        if fractional_output_damage_inflate_enabled(self.output_scale) {
            inflate_damage_set_phys(d)
        } else {
            d
        }
    }

    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        self.inner.opaque_regions(scale)
    }

    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl<E: RenderElement<GlesRenderer>> RenderElement<GlesRenderer> for FractionalDamageElement<E> {
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), GlesError> {
        self.inner
            .draw(frame, src, dst, damage, opaque_regions, cache)
    }

    fn underlying_storage(&self, renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        self.inner.underlying_storage(renderer)
    }
}

#[allow(clippy::large_enum_variant)]
pub enum DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    Space(FractionalDamageSpaceElements<E>),
    SpaceClip(SpaceExclusionClip<E>),
    ShellDma(&'a ShellDmaElement),
    Pointer(FractionalDamageElement<WaylandSurfaceRenderElement<GlesRenderer>>),
    CursorTex(FractionalDamageElement<ShellCursorElement>),
    TilePreview(SolidColorRenderElement),
    BackdropSolid(SolidColorRenderElement),
    BackdropTex(ShellDmaElement),
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
            DesktopStack::SpaceClip(x) => x.id(),
            DesktopStack::ShellDma(x) => (*x).id(),
            DesktopStack::Pointer(x) => x.id(),
            DesktopStack::CursorTex(x) => x.id(),
            DesktopStack::TilePreview(x) => x.id(),
            DesktopStack::BackdropSolid(x) => x.id(),
            DesktopStack::BackdropTex(x) => x.id(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn current_commit(&self) -> CommitCounter {
        match self {
            DesktopStack::Space(x) => x.current_commit(),
            DesktopStack::SpaceClip(x) => x.current_commit(),
            DesktopStack::ShellDma(x) => (*x).current_commit(),
            DesktopStack::Pointer(x) => x.current_commit(),
            DesktopStack::CursorTex(x) => x.current_commit(),
            DesktopStack::TilePreview(x) => x.current_commit(),
            DesktopStack::BackdropSolid(x) => x.current_commit(),
            DesktopStack::BackdropTex(x) => x.current_commit(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.location(scale),
            DesktopStack::SpaceClip(x) => x.location(scale),
            DesktopStack::ShellDma(x) => (*x).location(scale),
            DesktopStack::Pointer(x) => x.location(scale),
            DesktopStack::CursorTex(x) => x.location(scale),
            DesktopStack::TilePreview(x) => x.location(scale),
            DesktopStack::BackdropSolid(x) => x.location(scale),
            DesktopStack::BackdropTex(x) => x.location(scale),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        match self {
            DesktopStack::Space(x) => x.src(),
            DesktopStack::SpaceClip(x) => x.src(),
            DesktopStack::ShellDma(x) => (*x).src(),
            DesktopStack::Pointer(x) => x.src(),
            DesktopStack::CursorTex(x) => x.src(),
            DesktopStack::TilePreview(x) => x.src(),
            DesktopStack::BackdropSolid(x) => x.src(),
            DesktopStack::BackdropTex(x) => x.src(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn transform(&self) -> Transform {
        match self {
            DesktopStack::Space(x) => x.transform(),
            DesktopStack::SpaceClip(x) => x.transform(),
            DesktopStack::ShellDma(x) => (*x).transform(),
            DesktopStack::Pointer(x) => x.transform(),
            DesktopStack::CursorTex(x) => x.transform(),
            DesktopStack::TilePreview(x) => x.transform(),
            DesktopStack::BackdropSolid(x) => x.transform(),
            DesktopStack::BackdropTex(x) => x.transform(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.geometry(scale),
            DesktopStack::SpaceClip(x) => x.geometry(scale),
            DesktopStack::ShellDma(x) => (*x).geometry(scale),
            DesktopStack::Pointer(x) => x.geometry(scale),
            DesktopStack::CursorTex(x) => x.geometry(scale),
            DesktopStack::TilePreview(x) => x.geometry(scale),
            DesktopStack::BackdropSolid(x) => x.geometry(scale),
            DesktopStack::BackdropTex(x) => x.geometry(scale),
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
            DesktopStack::SpaceClip(x) => x.damage_since(scale, commit),
            DesktopStack::ShellDma(x) => (*x).damage_since(scale, commit),
            DesktopStack::Pointer(x) => x.damage_since(scale, commit),
            DesktopStack::CursorTex(x) => x.damage_since(scale, commit),
            DesktopStack::TilePreview(x) => x.damage_since(scale, commit),
            DesktopStack::BackdropSolid(x) => x.damage_since(scale, commit),
            DesktopStack::BackdropTex(x) => x.damage_since(scale, commit),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        match self {
            DesktopStack::Space(x) => x.opaque_regions(scale),
            DesktopStack::SpaceClip(x) => x.opaque_regions(scale),
            DesktopStack::ShellDma(x) => (*x).opaque_regions(scale),
            DesktopStack::Pointer(x) => x.opaque_regions(scale),
            DesktopStack::CursorTex(x) => x.opaque_regions(scale),
            DesktopStack::TilePreview(x) => x.opaque_regions(scale),
            DesktopStack::BackdropSolid(x) => x.opaque_regions(scale),
            DesktopStack::BackdropTex(x) => x.opaque_regions(scale),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn alpha(&self) -> f32 {
        match self {
            DesktopStack::Space(x) => x.alpha(),
            DesktopStack::SpaceClip(x) => x.alpha(),
            DesktopStack::ShellDma(x) => (*x).alpha(),
            DesktopStack::Pointer(x) => x.alpha(),
            DesktopStack::CursorTex(x) => x.alpha(),
            DesktopStack::TilePreview(x) => x.alpha(),
            DesktopStack::BackdropSolid(x) => x.alpha(),
            DesktopStack::BackdropTex(x) => x.alpha(),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn kind(&self) -> Kind {
        match self {
            DesktopStack::Space(x) => x.kind(),
            DesktopStack::SpaceClip(x) => x.kind(),
            DesktopStack::ShellDma(x) => (*x).kind(),
            DesktopStack::Pointer(x) => x.kind(),
            DesktopStack::CursorTex(x) => x.kind(),
            DesktopStack::TilePreview(x) => x.kind(),
            DesktopStack::BackdropSolid(x) => x.kind(),
            DesktopStack::BackdropTex(x) => x.kind(),
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
        cache: Option<&UserDataMap>,
    ) -> Result<(), smithay::backend::renderer::gles::GlesError> {
        match self {
            DesktopStack::Space(x) => x.draw(frame, src, dst, damage, opaque_regions, cache),
            DesktopStack::SpaceClip(x) => x.draw(frame, src, dst, damage, opaque_regions, cache),
            DesktopStack::ShellDma(x) => RenderElement::<GlesRenderer>::draw(
                x,
                frame,
                src,
                dst,
                damage,
                opaque_regions,
                cache,
            ),
            DesktopStack::Pointer(x) => x.draw(frame, src, dst, damage, opaque_regions, cache),
            DesktopStack::CursorTex(x) => x.draw(frame, src, dst, damage, opaque_regions, cache),
            DesktopStack::TilePreview(x) => RenderElement::<GlesRenderer>::draw(
                x,
                frame,
                src,
                dst,
                damage,
                opaque_regions,
                cache,
            ),
            DesktopStack::BackdropSolid(x) => RenderElement::<GlesRenderer>::draw(
                x,
                frame,
                src,
                dst,
                damage,
                opaque_regions,
                cache,
            ),
            DesktopStack::BackdropTex(x) => RenderElement::<GlesRenderer>::draw(
                x,
                frame,
                src,
                dst,
                damage,
                opaque_regions,
                cache,
            ),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }

    fn underlying_storage(&self, renderer: &mut GlesRenderer) -> Option<UnderlyingStorage<'_>> {
        match self {
            DesktopStack::Space(x) => x.underlying_storage(renderer),
            DesktopStack::SpaceClip(x) => x.underlying_storage(renderer),
            DesktopStack::ShellDma(x) => (*x).underlying_storage(renderer),
            DesktopStack::Pointer(x) => x.underlying_storage(renderer),
            DesktopStack::CursorTex(x) => x.underlying_storage(renderer),
            DesktopStack::TilePreview(x) => x.underlying_storage(renderer),
            DesktopStack::BackdropSolid(x) => x.underlying_storage(renderer),
            DesktopStack::BackdropTex(x) => x.underlying_storage(renderer),
            DesktopStack::_Catcher(_) => unreachable!(),
        }
    }
}

impl<'a, E> From<SpaceRenderElements<GlesRenderer, E>> for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn from(x: SpaceRenderElements<GlesRenderer, E>) -> Self {
        DesktopStack::Space(FractionalDamageSpaceElements::new(x, 1.0))
    }
}

impl<'a, E> From<ShellCursorElement> for DesktopStack<'a, E>
where
    E: Element + RenderElement<GlesRenderer>,
{
    fn from(x: ShellCursorElement) -> Self {
        DesktopStack::CursorTex(FractionalDamageElement::new(x, 1.0))
    }
}

pub fn shell_dmabuf_overlay_element(
    renderer: &mut GlesRenderer,
    dmabuf: &Dmabuf,
    overlay_id: Id,
    shell_loc_phys: Point<f64, Physical>,
    shell_size_logical: Size<i32, Logical>,
    buffer_src: Rectangle<f64, Buffer>,
    commit: CommitCounter,
    damage_phys: Option<Vec<Rectangle<i32, Physical>>>,
) -> Result<ShellDmaElement, GlesError> {
    let texture = renderer.import_dmabuf(dmabuf, None)?;
    let context_id = renderer.context_id();
    Ok(ShellDmaElement {
        id: overlay_id,
        context_id,
        location: shell_loc_phys,
        dst_logical_size: shell_size_logical,
        texture,
        buffer_src,
        commit,
        damage_phys,
        alpha: 1.0,
    })
}
