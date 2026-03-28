//! Pure layout helpers (unit-tested without Wayland or GPU).

/// Logical point in compositor space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Inclusive-min, exclusive-max rectangle in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn contains(self, p: Point) -> bool {
        p.x >= self.x
            && p.y >= self.y
            && p.x < self.x + self.width
            && p.y < self.y + self.height
    }
}

/// Clamp dimensions to `[min, max]` where `max == 0` means unbounded (caller uses `i32::MAX`).
pub fn clamp_size(width: i32, height: i32, min: (i32, i32), max: (i32, i32)) -> (i32, i32) {
    let min_w = min.0.max(1);
    let min_h = min.1.max(1);
    let max_w = if max.0 == 0 { i32::MAX } else { max.0.max(min_w) };
    let max_h = if max.1 == 0 { i32::MAX } else { max.1.max(min_h) };
    (width.max(min_w).min(max_w), height.max(min_h).min(max_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_contains() {
        let r = Rect {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
        };
        assert!(r.contains(Point { x: 10, y: 20 }));
        assert!(r.contains(Point { x: 109, y: 69 }));
        assert!(!r.contains(Point { x: 9, y: 20 }));
        assert!(!r.contains(Point { x: 110, y: 20 }));
    }

    #[test]
    fn clamp_size_respects_bounds() {
        assert_eq!(clamp_size(50, 50, (80, 60), (0, 0)), (80, 60));
        assert_eq!(clamp_size(200, 200, (1, 1), (100, 100)), (100, 100));
    }
}
