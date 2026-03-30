use std::sync::Arc;

use smithay::utils::{Logical, Physical, Point, Rectangle, Scale, Size};

pub(crate) struct ShellExclusionClipCtx {
    pub zones: Arc<[Rectangle<i32, Logical>]>,
    pub output_logical: Rectangle<i32, Logical>,
    pub scale_f: f64,
}

impl ShellExclusionClipCtx {
    pub(crate) fn damage_output_phys_to_global_log(
        &self,
        r: Rectangle<i32, Physical>,
    ) -> Rectangle<i32, Logical> {
        let scale = Scale::<f64>::from(self.scale_f);
        let out = &self.output_logical;
        let gtl = out.loc
            + Point::<f64, Physical>::from((r.loc.x as f64, r.loc.y as f64))
                .to_logical(scale)
                .to_i32_round();
        let gbr = out.loc
            + Point::<f64, Physical>::from((
                (r.loc.x + r.size.w) as f64,
                (r.loc.y + r.size.h) as f64,
            ))
            .to_logical(scale)
                .to_i32_round();
        let w = (gbr.x - gtl.x).max(1);
        let h = (gbr.y - gtl.y).max(1);
        Rectangle::new(gtl, Size::from((w, h)))
    }

    pub(crate) fn global_log_rect_to_damage_local_phys(
        &self,
        g: Rectangle<i32, Logical>,
        dst: Rectangle<i32, Physical>,
    ) -> Option<Rectangle<i32, Physical>> {
        let scale = Scale::<f64>::from(self.scale_f);
        let Some(on_out) = g.intersection(self.output_logical) else {
            return None;
        };
        if on_out.size.w <= 0 || on_out.size.h <= 0 {
            return None;
        }
        let oloc = Point::from((
            on_out.loc.x - self.output_logical.loc.x,
            on_out.loc.y - self.output_logical.loc.y,
        ));
        let ol = Rectangle::new(oloc, on_out.size);
        let p0: Point<i32, Physical> = ol.loc.to_physical_precise_round(scale);
        let br_log = ol.loc + ol.size;
        let p1: Point<i32, Physical> = br_log.to_physical_precise_round(scale);
        let pw = (p1.x - p0.x).max(1);
        let ph = (p1.y - p0.y).max(1);
        let phys_out = Rectangle::new(p0, Size::from((pw, ph)));
        Some(Rectangle::new(
            Point::from((phys_out.loc.x - dst.loc.x, phys_out.loc.y - dst.loc.y)),
            phys_out.size,
        ))
    }
}

pub(crate) fn subtract_hole_from_rect_log(
    r: Rectangle<i32, Logical>,
    hole: Rectangle<i32, Logical>,
) -> Vec<Rectangle<i32, Logical>> {
    let Some(i) = r.intersection(hole) else {
        return vec![r];
    };
    let mut out = Vec::new();
    let rx = r.loc.x;
    let ry = r.loc.y;
    let rw = r.size.w;
    let rh = r.size.h;
    let ix = i.loc.x;
    let iy = i.loc.y;
    let iw = i.size.w;
    let ih = i.size.h;
    if iy > ry {
        let h = iy - ry;
        if h > 0 && rw > 0 {
            out.push(Rectangle::new(Point::from((rx, ry)), Size::from((rw, h))));
        }
    }
    let bot = iy + ih;
    let rbot = ry + rh;
    if bot < rbot {
        let h = rbot - bot;
        if h > 0 && rw > 0 {
            out.push(Rectangle::new(Point::from((rx, bot)), Size::from((rw, h))));
        }
    }
    if ix > rx {
        let w = ix - rx;
        if w > 0 && ih > 0 {
            out.push(Rectangle::new(Point::from((rx, iy)), Size::from((w, ih))));
        }
    }
    let ir = ix + iw;
    let rr = rx + rw;
    if ir < rr {
        let w = rr - ir;
        if w > 0 && ih > 0 {
            out.push(Rectangle::new(Point::from((ir, iy)), Size::from((w, ih))));
        }
    }
    out
}

pub(crate) fn subtract_holes_from_rect_log(
    r: Rectangle<i32, Logical>,
    holes: &[Rectangle<i32, Logical>],
) -> Vec<Rectangle<i32, Logical>> {
    let mut queue = vec![r];
    for h in holes {
        let mut next = Vec::new();
        for piece in queue {
            next.extend(subtract_hole_from_rect_log(piece, *h));
        }
        queue = next;
        if queue.is_empty() {
            break;
        }
    }
    queue
}
