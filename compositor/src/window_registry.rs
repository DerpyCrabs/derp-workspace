//! Window list keyed by `(ClientId, protocol_id)` — Wayland protocol ids are per-client, not globally unique.

use std::collections::HashMap;

use smithay::reexports::wayland_server::backend::ClientId;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource;
use smithay::utils::{Logical, Rectangle};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Native,
    ShellHosted,
}

#[derive(Debug, Clone)]
pub struct WindowRecord {
    pub info: WindowInfo,
    pub kind: WindowKind,
    pub shell_hosted_float_restore: Option<Rectangle<i32, Logical>>,
}

impl WindowRecord {
    fn native(info: WindowInfo) -> Self {
        Self {
            info,
            kind: WindowKind::Native,
            shell_hosted_float_restore: None,
        }
    }

    fn shell_hosted(
        info: WindowInfo,
        shell_hosted_float_restore: Option<Rectangle<i32, Logical>>,
    ) -> Self {
        Self {
            info,
            kind: WindowKind::ShellHosted,
            shell_hosted_float_restore,
        }
    }
}

#[derive(Debug, Default)]
pub struct WindowRegistry {
    next_id: WindowId,
    next_surface_token: u32,
    by_surface: HashMap<Key, WindowId>,
    records: HashMap<WindowId, WindowRecord>,
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
        while self.records.contains_key(&self.next_id) {
            self.next_id = self.next_id.saturating_add(1);
        }
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
        self.records.insert(window_id, WindowRecord::native(info));
        window_id
    }

    pub fn register_shell_hosted(
        &mut self,
        window_id: WindowId,
        title: String,
        app_id: String,
        output_name: String,
        client_global: Rectangle<i32, Logical>,
    ) -> Option<bool> {
        if window_id == 0 {
            return None;
        }
        if let Some(record) = self.records.get(&window_id) {
            return (record.kind == WindowKind::ShellHosted).then_some(false);
        }
        let info = WindowInfo {
            window_id,
            surface_id: window_id,
            title,
            app_id,
            wayland_client_pid: None,
            x: client_global.loc.x,
            y: client_global.loc.y,
            width: client_global.size.w.max(1),
            height: client_global.size.h.max(1),
            output_name,
            minimized: false,
            maximized: false,
            fullscreen: false,
            client_side_decoration: false,
        };
        self.records.insert(
            window_id,
            WindowRecord::shell_hosted(info, Some(client_global)),
        );
        Some(true)
    }

    pub fn remove_by_wl_surface(&mut self, wl: &WlSurface) -> Option<WindowId> {
        let k = key(wl)?;
        let wid = self.by_surface.remove(&k)?;
        self.records.remove(&wid);
        Some(wid)
    }

    pub fn native_infos_for_client(&self, client_id: &ClientId) -> Vec<WindowInfo> {
        self.by_surface
            .iter()
            .filter(|((cid, _), _)| cid == client_id)
            .filter_map(|(_, wid)| self.records.get(wid))
            .filter(|record| record.kind == WindowKind::Native)
            .map(|record| record.info.clone())
            .collect()
    }

    pub fn remove_by_client_id(&mut self, client_id: &ClientId) -> Vec<WindowInfo> {
        let doomed: Vec<_> = self
            .by_surface
            .keys()
            .filter(|(cid, _)| cid == client_id)
            .cloned()
            .collect();
        let mut removed = Vec::new();
        for key in doomed {
            let Some(window_id) = self.by_surface.remove(&key) else {
                continue;
            };
            let Some(record) = self.records.remove(&window_id) else {
                continue;
            };
            if record.kind == WindowKind::Native {
                removed.push(record.info);
            }
        }
        removed
    }

    pub fn highest_allocated_window_id(&self) -> WindowId {
        self.records
            .values()
            .filter(|record| record.kind == WindowKind::Native)
            .map(|record| record.info.window_id)
            .max()
            .unwrap_or_else(|| self.next_id.saturating_sub(1))
    }

    pub fn window_id_for_wl_surface(&self, wl: &WlSurface) -> Option<WindowId> {
        self.by_surface.get(&key(wl)?).copied()
    }

    pub fn window_id_for_shell_surface(&self, shell_surface_id: u32) -> Option<WindowId> {
        self.records
            .values()
            .find(|record| record.info.surface_id == shell_surface_id)
            .map(|record| record.info.window_id)
    }

    pub fn set_title(&mut self, wl: &WlSurface, title: String) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = &mut self.records.get_mut(&wid)?.info;
        let changed = info.title != title;
        info.title = title;
        Some(changed)
    }

    pub fn set_app_id(&mut self, wl: &WlSurface, app_id: String) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = &mut self.records.get_mut(&wid)?.info;
        let changed = info.app_id != app_id;
        info.app_id = app_id;
        Some(changed)
    }

    pub fn set_output_name_for_wl(&mut self, wl: &WlSurface, output_name: String) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = &mut self.records.get_mut(&wid)?.info;
        let changed = info.output_name != output_name;
        info.output_name = output_name;
        Some(changed)
    }

    pub fn set_shell_layout(
        &mut self,
        wl: &WlSurface,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        output_name: String,
    ) -> Option<bool> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        let info = &mut self.records.get_mut(&wid)?.info;
        let changed = info.x != x
            || info.y != y
            || info.width != width
            || info.height != height
            || info.output_name != output_name;
        info.x = x;
        info.y = y;
        info.width = width;
        info.height = height;
        info.output_name = output_name;
        Some(changed)
    }

    pub fn snapshot_for_wl_surface(&self, wl: &WlSurface) -> Option<WindowInfo> {
        let wid = *self.by_surface.get(&key(wl)?)?;
        self.records.get(&wid).map(|record| record.info.clone())
    }

    pub fn surface_id_for_window(&self, window_id: WindowId) -> Option<u32> {
        self.records
            .get(&window_id)
            .map(|record| record.info.surface_id)
    }

    pub fn window_info(&self, window_id: WindowId) -> Option<WindowInfo> {
        self.records
            .get(&window_id)
            .map(|record| record.info.clone())
    }

    pub fn window_kind(&self, window_id: WindowId) -> Option<WindowKind> {
        self.records.get(&window_id).map(|record| record.kind)
    }

    pub fn is_shell_hosted(&self, window_id: WindowId) -> bool {
        self.window_kind(window_id) == Some(WindowKind::ShellHosted)
    }

    pub fn remove_shell_hosted(&mut self, window_id: WindowId) -> Option<WindowInfo> {
        self.is_shell_hosted(window_id)
            .then(|| self.records.remove(&window_id))
            .flatten()
            .map(|record| record.info)
    }

    pub fn update_shell_hosted<F, T>(&mut self, window_id: WindowId, f: F) -> Option<T>
    where
        F: FnOnce(&mut WindowInfo, &mut Option<Rectangle<i32, Logical>>) -> T,
    {
        let record = self.records.get_mut(&window_id)?;
        if record.kind != WindowKind::ShellHosted {
            return None;
        }
        Some(f(&mut record.info, &mut record.shell_hosted_float_restore))
    }

    pub fn shell_hosted_infos(&self) -> Vec<WindowInfo> {
        self.records
            .values()
            .filter(|record| record.kind == WindowKind::ShellHosted)
            .map(|record| record.info.clone())
            .collect()
    }

    pub fn all_records(&self) -> Vec<WindowRecord> {
        self.records.values().cloned().collect()
    }

    pub fn all_infos(&self) -> Vec<WindowInfo> {
        self.records
            .values()
            .map(|record| record.info.clone())
            .collect()
    }

    pub fn set_minimized(&mut self, window_id: WindowId, minimized: bool) -> Option<()> {
        let info = &mut self.records.get_mut(&window_id)?.info;
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
        let info = &mut self.records.get_mut(&wid)?.info;
        let changed = info.maximized != maximized || info.fullscreen != fullscreen;
        info.maximized = maximized;
        info.fullscreen = fullscreen;
        Some(changed)
    }
}
