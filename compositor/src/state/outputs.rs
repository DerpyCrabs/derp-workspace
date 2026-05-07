use super::*;

pub const SHELL_TITLEBAR_HEIGHT: i32 = 26;
pub const SHELL_TASKBAR_RESERVE_PX: i32 = 36;
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellTaskbarSide {
    Bottom,
    Top,
    Left,
    Right,
}

impl Default for ShellTaskbarSide {
    fn default() -> Self {
        Self::Bottom
    }
}

impl ShellTaskbarSide {
    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "bottom" => Some(Self::Bottom),
            "top" => Some(Self::Top),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    pub(crate) fn to_wire(self) -> u32 {
        match self {
            Self::Bottom => shell_wire::TASKBAR_SIDE_BOTTOM,
            Self::Top => shell_wire::TASKBAR_SIDE_TOP,
            Self::Left => shell_wire::TASKBAR_SIDE_LEFT,
            Self::Right => shell_wire::TASKBAR_SIDE_RIGHT,
        }
    }
}

pub(super) fn apply_taskbar_reserve_to_global_rect(
    rect: Rectangle<i32, Logical>,
    side: ShellTaskbarSide,
    reserve: i32,
) -> Rectangle<i32, Logical> {
    let tb = reserve.max(0);
    let (x, y, w, h) = match side {
        ShellTaskbarSide::Bottom => (
            rect.loc.x,
            rect.loc.y,
            rect.size.w.max(1),
            rect.size.h.saturating_sub(tb).max(1),
        ),
        ShellTaskbarSide::Top => (
            rect.loc.x,
            rect.loc.y.saturating_add(tb),
            rect.size.w.max(1),
            rect.size.h.saturating_sub(tb).max(1),
        ),
        ShellTaskbarSide::Left => (
            rect.loc.x.saturating_add(tb),
            rect.loc.y,
            rect.size.w.saturating_sub(tb).max(1),
            rect.size.h.max(1),
        ),
        ShellTaskbarSide::Right => (
            rect.loc.x,
            rect.loc.y,
            rect.size.w.saturating_sub(tb).max(1),
            rect.size.h.max(1),
        ),
    };
    Rectangle::new(Point::from((x, y)), Size::from((w, h)))
}
