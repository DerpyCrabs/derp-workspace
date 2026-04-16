use smithay::{
    backend::renderer::{
        element::{solid::SolidColorRenderElement, Id, Kind},
        gles::GlesRenderer,
        utils::CommitCounter,
        Color32F,
    },
    output::Output,
    utils::{Logical, Physical, Point, Rectangle, Scale, Size},
};

use crate::derp_space::DerpSpaceElem;
use crate::desktop::desktop_stack::DesktopStack;
use crate::CompositorState;
use smithay::backend::renderer::element::AsRenderElements;

type WinEl = <DerpSpaceElem as AsRenderElements<GlesRenderer>>::RenderElement;

const DIMMER_COLOR: Color32F = Color32F::new(0.0, 0.0, 0.0, 0.45);
const BORDER_COLOR: Color32F = Color32F::new(1.0, 1.0, 1.0, 0.95);
const BORDER_THICKNESS: i32 = 2;

fn push_rect_phys<'a>(
    rect: Rectangle<i32, Physical>,
    color: Color32F,
    render_elements: &mut Vec<DesktopStack<'a, WinEl>>,
) {
    if rect.size.w <= 0 || rect.size.h <= 0 {
        return;
    }
    render_elements.push(DesktopStack::BackdropSolid(SolidColorRenderElement::new(
        Id::new(),
        rect,
        CommitCounter::default(),
        color,
        Kind::Unspecified,
    )));
}

fn logical_rect_to_output_phys(
    output_geo: Rectangle<i32, Logical>,
    scale_f: f64,
    rect: Rectangle<i32, Logical>,
) -> Option<Rectangle<i32, Physical>> {
    let Some(intersection) = rect.intersection(output_geo) else {
        return None;
    };
    if intersection.size.w <= 0 || intersection.size.h <= 0 {
        return None;
    }
    let scale = Scale::from(scale_f);
    let local = Rectangle::new(intersection.loc - output_geo.loc, intersection.size);
    let p0: Point<i32, Physical> = local.loc.to_physical_precise_round(scale);
    let p1: Point<i32, Physical> = (local.loc + local.size).to_physical_precise_round(scale);
    Some(Rectangle::new(
        p0,
        Size::from(((p1.x - p0.x).max(1), (p1.y - p0.y).max(1))),
    ))
}

pub(crate) fn append_screenshot_overlay_for_output<'a>(
    state: &CompositorState,
    output: &Output,
    render_elements: &mut Vec<DesktopStack<'a, WinEl>>,
) {
    if !state.screenshot_selection_active() {
        return;
    }
    let Some(output_geo) = state.space.output_geometry(output) else {
        return;
    };
    let scale_f = output.current_scale().fractional_scale();
    let Some(output_phys) = logical_rect_to_output_phys(output_geo, scale_f, output_geo) else {
        return;
    };
    let selection = state.screenshot_selection_rect();
    match selection {
        Some(selection) => {
            let Some(visible_selection) =
                logical_rect_to_output_phys(output_geo, scale_f, selection)
            else {
                push_rect_phys(output_phys, DIMMER_COLOR, render_elements);
                return;
            };
            let left = visible_selection.loc.x;
            let right = visible_selection.loc.x + visible_selection.size.w;
            let top = visible_selection.loc.y;
            let bottom = visible_selection.loc.y + visible_selection.size.h;
            push_rect_phys(
                Rectangle::new(Point::from((0, 0)), Size::from((output_phys.size.w, top))),
                DIMMER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((0, bottom)),
                    Size::from((
                        output_phys.size.w,
                        output_phys.size.h.saturating_sub(bottom),
                    )),
                ),
                DIMMER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((0, top)),
                    Size::from((left, visible_selection.size.h)),
                ),
                DIMMER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((right, top)),
                    Size::from((
                        output_phys.size.w.saturating_sub(right),
                        visible_selection.size.h,
                    )),
                ),
                DIMMER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((left, top)),
                    Size::from((
                        visible_selection.size.w,
                        BORDER_THICKNESS.min(visible_selection.size.h),
                    )),
                ),
                BORDER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((
                        left,
                        bottom - BORDER_THICKNESS.min(visible_selection.size.h),
                    )),
                    Size::from((
                        visible_selection.size.w,
                        BORDER_THICKNESS.min(visible_selection.size.h),
                    )),
                ),
                BORDER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((left, top)),
                    Size::from((
                        BORDER_THICKNESS.min(visible_selection.size.w),
                        visible_selection.size.h,
                    )),
                ),
                BORDER_COLOR,
                render_elements,
            );
            push_rect_phys(
                Rectangle::new(
                    Point::from((right - BORDER_THICKNESS.min(visible_selection.size.w), top)),
                    Size::from((
                        BORDER_THICKNESS.min(visible_selection.size.w),
                        visible_selection.size.h,
                    )),
                ),
                BORDER_COLOR,
                render_elements,
            );
        }
        None => {
            push_rect_phys(output_phys, DIMMER_COLOR, render_elements);
        }
    }
}
