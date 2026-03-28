//! Stable compositor window ids and metadata keyed by Wayland surface protocol id.

use std::collections::HashMap;

use crate::chrome_bridge::WindowInfo;

/// Compositor-assigned id (distinct from `WlSurface` protocol id).
pub type WindowId = u32;

#[derive(Debug, Default)]
pub struct WindowRegistry {
    next_id: WindowId,
    by_surface: HashMap<u32, WindowId>,
    records: HashMap<WindowId, WindowInfo>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            ..Default::default()
        }
    }

    /// Register a new toplevel; returns the assigned [`WindowId`].
    pub fn register_toplevel(
        &mut self,
        surface_id: u32,
        title: String,
        app_id: String,
    ) -> WindowId {
        let window_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let info = WindowInfo {
            window_id,
            surface_id,
            title,
            app_id,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        self.by_surface.insert(surface_id, window_id);
        self.records.insert(window_id, info);
        window_id
    }

    /// Remove a toplevel by surface id. Returns the removed [`WindowId`] if it existed.
    pub fn remove_by_surface(&mut self, surface_id: u32) -> Option<WindowId> {
        let window_id = self.by_surface.remove(&surface_id)?;
        self.records.remove(&window_id);
        Some(window_id)
    }

    pub fn window_id_for_surface(&self, surface_id: u32) -> Option<WindowId> {
        self.by_surface.get(&surface_id).copied()
    }

    /// Sets title; returns `Some(true)` if the value changed, `Some(false)` if unchanged, `None` if unknown surface.
    pub fn set_title(&mut self, surface_id: u32, title: String) -> Option<bool> {
        let wid = *self.by_surface.get(&surface_id)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.title != title;
        info.title = title;
        Some(changed)
    }

    /// Sets app_id; returns `Some(true)` if the value changed, `Some(false)` if unchanged, `None` if unknown surface.
    pub fn set_app_id(&mut self, surface_id: u32, app_id: String) -> Option<bool> {
        let wid = *self.by_surface.get(&surface_id)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.app_id != app_id;
        info.app_id = app_id;
        Some(changed)
    }

    /// Sets geometry in compositor logical space; returns change status like [`Self::set_title`].
    pub fn set_geometry(
        &mut self,
        surface_id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Option<bool> {
        let wid = *self.by_surface.get(&surface_id)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.x != x || info.y != y || info.width != width || info.height != height;
        info.x = x;
        info.y = y;
        info.width = width;
        info.height = height;
        Some(changed)
    }

    pub fn snapshot_for_surface(&self, surface_id: u32) -> Option<WindowInfo> {
        let wid = self.by_surface.get(&surface_id).copied()?;
        self.records.get(&wid).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_assigns_incrementing_ids() {
        let mut r = WindowRegistry::new();
        let a = r.register_toplevel(10, "a".into(), "".into());
        let b = r.register_toplevel(20, "b".into(), "".into());
        assert_eq!(a, 1);
        assert_eq!(b, 2);
        assert_eq!(r.window_id_for_surface(10), Some(1));
        assert_eq!(r.window_id_for_surface(20), Some(2));
    }

    #[test]
    fn remove_clears_lookups() {
        let mut r = WindowRegistry::new();
        r.register_toplevel(5, "t".into(), "app".into());
        assert_eq!(r.remove_by_surface(5), Some(1));
        assert_eq!(r.window_id_for_surface(5), None);
        assert_eq!(r.snapshot_for_surface(5), None);
    }

    #[test]
    fn set_title_reports_change() {
        let mut r = WindowRegistry::new();
        r.register_toplevel(1, "old".into(), "".into());
        assert_eq!(r.set_title(1, "old".into()), Some(false));
        assert_eq!(r.set_title(1, "new".into()), Some(true));
        assert_eq!(
            r.snapshot_for_surface(1).unwrap().title,
            "new"
        );
    }

    #[test]
    fn set_app_id_reports_change() {
        let mut r = WindowRegistry::new();
        r.register_toplevel(1, "".into(), "a".into());
        assert_eq!(r.set_app_id(1, "a".into()), Some(false));
        assert_eq!(r.set_app_id(1, "b".into()), Some(true));
    }

    #[test]
    fn unknown_surface_returns_none() {
        let mut r = WindowRegistry::new();
        assert_eq!(r.set_title(99, "x".into()), None);
        assert_eq!(r.set_geometry(99, 0, 0, 1, 1), None);
        assert_eq!(r.remove_by_surface(99), None);
    }

    #[test]
    fn set_geometry_reports_change() {
        let mut r = WindowRegistry::new();
        r.register_toplevel(1, "".into(), "".into());
        assert_eq!(r.set_geometry(1, 0, 0, 0, 0), Some(false));
        assert_eq!(r.set_geometry(1, 10, 20, 100, 80), Some(true));
        let s = r.snapshot_for_surface(1).unwrap();
        assert_eq!((s.x, s.y, s.width, s.height), (10, 20, 100, 80));
        assert_eq!(r.set_geometry(1, 10, 20, 100, 80), Some(false));
    }

    #[test]
    fn register_starts_with_zero_geometry() {
        let mut r = WindowRegistry::new();
        r.register_toplevel(7, "t".into(), "a".into());
        let s = r.snapshot_for_surface(7).unwrap();
        assert_eq!((s.x, s.y, s.width, s.height), (0, 0, 0, 0));
    }
}
