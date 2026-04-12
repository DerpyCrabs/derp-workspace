use std::sync::{Arc, Mutex};
use std::time::Duration;

use smithay::reexports::calloop::channel::Sender;
use zbus::blocking::{connection::Builder, Connection, Proxy};
use zbus::interface;

use shell_wire::TraySniItemWire;

pub enum SniTrayCmd {
    Activate {
        id: String,
        context_menu: bool,
    },
}

struct WatcherState {
    items: Arc<Mutex<Vec<String>>>,
}

#[interface(name = "org.kde.StatusNotifierWatcher", spawn = false)]
impl WatcherState {
    #[zbus(property, name = "ProtocolVersion")]
    fn protocol_version(&self) -> i32 {
        0
    }

    #[zbus(property, name = "RegisteredStatusNotifierItems")]
    fn registered_items(&self) -> Vec<String> {
        self.items.lock().map(|g| g.clone()).unwrap_or_default()
    }

    #[zbus(property, name = "IsStatusNotifierHostRegistered")]
    fn host_registered(&self) -> bool {
        true
    }

    #[zbus(name = "RegisterStatusNotifierHost")]
    fn register_host(&mut self, _service: &str) {}

    #[zbus(signal, name = "StatusNotifierItemRegistered")]
    async fn status_notifier_item_registered(
        signal_ctxt: &zbus::SignalContext<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal, name = "StatusNotifierItemUnregistered")]
    async fn status_notifier_item_unregistered(
        signal_ctxt: &zbus::SignalContext<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(name = "RegisterStatusNotifierItem")]
    fn register_item(
        &mut self,
        service: &str,
        #[zbus(signal_context)] ctxt: zbus::SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        if let Ok(mut g) = self.items.lock() {
            if !g.iter().any(|s| s == service) {
                g.push(service.to_string());
            }
        }
        zbus::block_on(Self::status_notifier_item_registered(&ctxt, service))
            .map_err(|e: zbus::Error| zbus::fdo::Error::Failed(e.to_string()))
    }

    #[zbus(name = "UnregisterStatusNotifierItem")]
    fn unregister_item(
        &mut self,
        service: &str,
        #[zbus(signal_context)] ctxt: zbus::SignalContext<'_>,
    ) -> zbus::fdo::Result<()> {
        if let Ok(mut g) = self.items.lock() {
            g.retain(|s| s != service);
        }
        zbus::block_on(Self::status_notifier_item_unregistered(&ctxt, service))
            .map_err(|e: zbus::Error| zbus::fdo::Error::Failed(e.to_string()))
    }
}

fn parse_service_path(s: &str) -> Option<(String, String)> {
    if let Some((a, b)) = s.split_once('/') {
        if !a.is_empty() && !b.is_empty() {
            return Some((a.to_string(), format!("/{}", b)));
        }
    }
    None
}

fn notifier_dest_path(full: &str) -> (String, String) {
    if let Some((d, p)) = parse_service_path(full) {
        (d, p)
    } else {
        (full.to_string(), "/StatusNotifierItem".to_string())
    }
}

fn argb_to_png(w: u32, h: u32, argb: &[u8]) -> Option<Vec<u8>> {
    let need = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
    if argb.len() < need {
        return None;
    }
    let mut rgba = Vec::with_capacity(need);
    for px in argb[..need].chunks_exact(4) {
        rgba.push(px[1]);
        rgba.push(px[2]);
        rgba.push(px[3]);
        rgba.push(px[0]);
    }
    let img = image::RgbaImage::from_raw(w, h, rgba)?;
    let mut cur = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut cur, image::ImageFormat::Png)
        .ok()?;
    Some(cur.into_inner())
}

fn pixmap_wire_to_png(pix: &[(i32, i32, Vec<u8>)]) -> Vec<u8> {
    let mut best: Option<(u32, u32, &[u8])> = None;
    for (w, h, bytes) in pix {
        if *w < 1 || *h < 1 {
            continue;
        }
        let area = (*w as i64).saturating_mul(*h as i64);
        let cur = best.map(|b| b.0 as i64 * b.1 as i64).unwrap_or(0);
        if area >= cur {
            best = Some((*w as u32, *h as u32, bytes.as_slice()));
        }
    }
    if let Some((w, h, b)) = best {
        if let Some(png) = argb_to_png(w, h, b) {
            return png;
        }
    }
    Vec::new()
}

fn fetch_item_png(conn: &Connection, full_id: &str, title_out: &mut String) -> Vec<u8> {
    let (dest, path) = notifier_dest_path(full_id);
    let Ok(proxy) = Proxy::new(
        conn,
        dest.as_str(),
        path.as_str(),
        "org.kde.StatusNotifierItem",
    ) else {
        return Vec::new();
    };
    if let Ok(t) = proxy.get_property::<String>("Title") {
        if !t.is_empty() {
            *title_out = t;
        }
    }
    let Ok(rows) = proxy.get_property::<Vec<(i32, i32, Vec<u8>)>>("IconPixmap") else {
        return Vec::new();
    };
    pixmap_wire_to_png(&rows)
}

fn fetch_ids(
    own_items: &Arc<Mutex<Vec<String>>>,
    we_own_watcher: bool,
    conn: &Connection,
) -> Vec<String> {
    if we_own_watcher {
        return own_items.lock().map(|g| g.clone()).unwrap_or_default();
    }
    let Ok(p) = Proxy::new(
        conn,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    ) else {
        return Vec::new();
    };
    p.get_property::<Vec<String>>("RegisteredStatusNotifierItems")
        .unwrap_or_default()
}

fn activate(conn: &Connection, full_id: &str, context_menu: bool) {
    let (dest, path) = notifier_dest_path(full_id);
    let Ok(proxy) = Proxy::new(
        conn,
        dest.as_str(),
        path.as_str(),
        "org.kde.StatusNotifierItem",
    ) else {
        return;
    };
    if context_menu {
        let _ = proxy.call_method("ContextMenu", &(0i32, 0i32));
    } else {
        let _ = proxy.call_method("Activate", &(0i32, 0i32));
    }
}

pub fn spawn_sni_tray_thread(
    loop_tx: Sender<Vec<TraySniItemWire>>,
    cmd_rx: std::sync::mpsc::Receiver<SniTrayCmd>,
) {
    std::thread::Builder::new()
        .name("derp-sni-tray".into())
        .spawn(move || run_sni(loop_tx, cmd_rx))
        .ok();
}

fn run_sni(loop_tx: Sender<Vec<TraySniItemWire>>, cmd_rx: std::sync::mpsc::Receiver<SniTrayCmd>) {
    let shared_items: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (watch_conn, we_own_watcher) = match Builder::session().and_then(|b| {
        let w = WatcherState {
            items: shared_items.clone(),
        };
        b.name("org.kde.StatusNotifierWatcher")?
            .serve_at("/StatusNotifierWatcher", w)?
            .build()
    }) {
        Ok(c) => (c, true),
        Err(e) => {
            tracing::warn!(
                ?e,
                "sni: could not own org.kde.StatusNotifierWatcher; using existing session watcher"
            );
            match Connection::session() {
                Ok(c) => (c, false),
                Err(e2) => {
                    tracing::warn!(?e2, "sni: session dbus failed");
                    return;
                }
            }
        }
    };
    let host_unique = format!("org.kde.StatusNotifierHost-{}", std::process::id());
    let host_conn = match Builder::session().and_then(|b| b.name(host_unique.as_str())?.build()) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(?e, "sni: status notifier host name failed");
            return;
        }
    };
    if let Err(e) = Proxy::new(
        &host_conn,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
    )
    .and_then(|p| p.call_method("RegisterStatusNotifierHost", &(host_unique.as_str(),)))
    {
        tracing::warn!(
            ?e,
            "sni: RegisterStatusNotifierHost failed (tray icons may not register)"
        );
    }
    let mut last_sent: Vec<TraySniItemWire> = Vec::new();
    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SniTrayCmd::Activate {
                    id,
                    context_menu,
                } => activate(&host_conn, &id, context_menu),
            }
        }
        let ids = fetch_ids(&shared_items, we_own_watcher, &watch_conn);
        let mut v: Vec<TraySniItemWire> = Vec::new();
        for full in ids {
            let mut title = String::new();
            let png = fetch_item_png(&host_conn, &full, &mut title);
            if title.is_empty() {
                title = full.clone();
            }
            v.push(TraySniItemWire {
                id: full,
                title,
                icon_png: png,
            });
        }
        v.sort_by(|a, b| a.id.cmp(&b.id));
        if v != last_sent {
            last_sent = v.clone();
            let _ = loop_tx.send(v);
        }
        std::thread::sleep(Duration::from_millis(350));
    }
}
