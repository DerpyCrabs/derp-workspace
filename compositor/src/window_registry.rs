//! Window list keyed by `(ClientId, protocol_id)` — Wayland protocol ids are per-client, not globally unique.

use std::collections::HashMap;

use smithay::reexports::wayland_server::backend::ClientId;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;

use crate::chrome_bridge::WindowInfo;

pub type WindowId = u32;

type Key = (ClientId, u32);

pub(crate) fn wl_surface_key(wl: &WlSurface) -> Option<Key> {
    key(wl)
}

fn key(wl: &WlSurface) -> Option<Key> {
    let c = wl.client()?;
    Some((c.id(), wl.id().protocol_id()))
}

#[derive(Debug, Default)]
pub struct WindowRegistry {
    next_id: WindowId,
    next_surface_token: u32,
    by_surface: HashMap<Key, WindowId>,
    records: HashMap<WindowId, WindowInfo>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            next_surface_token: 1,
            ..Default::default()
        }
    }

    pub fn register_toplevel(
        &mut self,
        wl: &WlSurface,
        title: String,
        app_id: String,
        wayland_client_pid: Option<i32>,
    ) -> WindowId {
        let k = key(wl).expect("register_toplevel: surface has no client");
        let window_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let surface_id = self.next_surface_token;
        self.next_surface_token = self.next_surface_token.saturating_add(1);
        let info = WindowInfo {
            window_id,
            surface_id,
            title,
            app_id,
            wayland_client_pid,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            output_name: String::new(),
            minimized: false,
            maximized: false,
            fullscreen: false,
            client_side_decoration: false,
        };
        self.by_surface.insert(k, window_id);
        self.records.insert(window_id, info);
        window_id
    }

    pub fn remove_by_wl_surface(&mut self, wl: &WlSurface) -> Option<WindowId> {
        let k = key(wl)?;
        let wid = self.by_surface.remove(&k)?;
        self.records.remove(&wid);
        Some(wid)
    }

    pub fn highest_allocated_window_id(&self) -> WindowId {
        self.next_id.saturating_sub(1)
    }

    pub fn window_id_for_wl_surface(&self, wl: &WlSurface) -> Option<WindowId> {
        self.by_surface.get(&key(wl)?).copied()
    }

    pub fn window_id_for_shell_surface(&self, shell_surface_id: u32) -> Option<WindowId> {
        self.records
            .values()
            .find(|i| i.surface_id == shell_surface_id)
            .map(|i| i.window_id)
    }

    pub fn set_title(&mut self, wl: &WlSurface, title: String) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.title != title;
        info.title = title;
        Some(changed)
    }

    pub fn set_app_id(&mut self, wl: &WlSurface, app_id: String) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.app_id != app_id;
        info.app_id = app_id;
        Some(changed)
    }

    pub fn set_shell_layout(
        &mut self,
        wl: &WlSurface,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        client_side_decoration: bool,
        output_name: String,
    ) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.x != x
            || info.y != y
            || info.width != width
            || info.height != height
            || info.client_side_decoration != client_side_decoration
            || info.output_name != output_name;
        info.x = x;
        info.y = y;
        info.width = width;
        info.height = height;
        info.client_side_decoration = client_side_decoration;
        info.output_name = output_name;
        Some(changed)
    }

    pub fn snapshot_for_wl_surface(&self, wl: &WlSurface) -> Option<WindowInfo> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        self.records.get(&wid).cloned()
    }

    pub fn surface_id_for_window(&self, window_id: WindowId) -> Option<u32> {
        self.records.get(&window_id).map(|i| i.surface_id)
    }

    pub fn window_info(&self, window_id: WindowId) -> Option<WindowInfo> {
        self.records.get(&window_id).cloned()
    }

    pub fn all_infos(&self) -> Vec<WindowInfo> {
        self.records.values().cloned().collect()
    }

    pub fn set_minimized(&mut self, window_id: WindowId, minimized: bool) -> Option<()> {
        let info = self.records.get_mut(&window_id)?;
        info.minimized = minimized;
        Some(())
    }

    pub fn set_tiling_state(
        &mut self,
        wl: &WlSurface,
        maximized: bool,
        fullscreen: bool,
    ) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = self.records.get_mut(&wid)?;
        let changed = info.maximized != maximized || info.fullscreen != fullscreen;
        info.maximized = maximized;
        info.fullscreen = fullscreen;
        Some(changed)
    }
}
