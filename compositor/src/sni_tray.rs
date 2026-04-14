use std::sync::{Arc, Mutex};
use std::time::Duration;

use smithay::reexports::calloop::channel::Sender;
use zbus::blocking::{connection::Builder, Connection, Proxy};
use zbus::interface;
use zbus::zvariant::{OwnedObjectPath, OwnedStructure, Signature, Value};

use shell_wire::{SniTrayLoopMsg, TraySniItemWire, TraySniMenuEntryWire, TraySniMenuWire};

pub enum SniTrayCmd {
    Activate {
        id: String,
    },
    OpenMenu {
        id: String,
        request_serial: u32,
    },
    MenuEvent {
        id: String,
        menu_path: String,
        item_id: i32,
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

fn dbus_name_has_owner(conn: &Connection, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let Ok(proxy) = Proxy::new(
        conn,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    ) else {
        return false;
    };
    let Ok(reply) = proxy.call_method("NameHasOwner", &(name,)) else {
        return false;
    };
    reply.body().deserialize::<bool>().unwrap_or(false)
}

fn retain_live_notifier_ids(
    conn: &Connection,
    own_items: &Arc<Mutex<Vec<String>>>,
    we_own_watcher: bool,
) -> Vec<String> {
    if we_own_watcher {
        if let Ok(mut g) = own_items.lock() {
            g.retain(|full| {
                let (dest, _) = notifier_dest_path(full);
                dbus_name_has_owner(conn, dest.as_str())
            });
        }
    }
    fetch_ids(own_items, we_own_watcher, conn)
        .into_iter()
        .filter(|full| {
            let (dest, _) = notifier_dest_path(full);
            dbus_name_has_owner(conn, dest.as_str())
        })
        .collect()
}

fn activate(conn: &Connection, full_id: &str) {
    let (dest, path) = notifier_dest_path(full_id);
    let Ok(proxy) = Proxy::new(
        conn,
        dest.as_str(),
        path.as_str(),
        "org.kde.StatusNotifierItem",
    ) else {
        return;
    };
    let _ = proxy.call_method("Activate", &(0i32, 0i32));
}

fn peel_value<'a>(v: &'a Value<'a>) -> &'a Value<'a> {
    match v {
        Value::Value(inner) => peel_value(inner),
        _ => v,
    }
}

fn value_as_str<'a>(v: &'a Value<'a>) -> Option<std::borrow::Cow<'a, str>> {
    match peel_value(v) {
        Value::Str(s) => Some(std::borrow::Cow::Borrowed(s.as_str())),
        _ => None,
    }
}

fn value_as_bool(v: &Value) -> Option<bool> {
    match peel_value(v) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

fn dbusmenu_peel_kind(v: &Value) -> &'static str {
    match peel_value(v) {
        Value::Structure(_) => "structure",
        Value::Array(_) => "array",
        Value::Dict(_) => "dict",
        Value::Value(_) => "variant",
        Value::Str(_) => "str",
        Value::Bool(_) => "bool",
        Value::ObjectPath(_) => "object_path",
        Value::Signature(_) => "signature",
        Value::U8(_)
        | Value::I16(_)
        | Value::U16(_)
        | Value::I32(_)
        | Value::U32(_)
        | Value::I64(_)
        | Value::U64(_) => "int",
        Value::F64(_) => "f64",
        _ => "other",
    }
}

fn visit_dbusmenu_node(
    v: &Value,
    out: &mut Vec<TraySniMenuEntryWire>,
    is_root: bool,
    log_nid: Option<&str>,
    depth: u8,
) {
    let v = peel_value(v);
    let Value::Structure(st) = v else {
        if is_root {
            if let Some(nid) = log_nid {
                tracing::warn!(
                    target: "derp_sni_menu",
                    notifier_id = %nid,
                    root_kind = dbusmenu_peel_kind(v),
                    "dbusmenu GetLayout root is not a structure"
                );
            }
        }
        return;
    };
    let fields = st.fields();
    if fields.len() < 3 {
        if is_root {
            if let Some(nid) = log_nid {
                tracing::warn!(
                    target: "derp_sni_menu",
                    notifier_id = %nid,
                    fields_len = fields.len(),
                    "dbusmenu GetLayout root structure has fewer than 3 fields"
                );
            }
        }
        return;
    }
    if is_root {
        visit_dbusmenu_children(&fields[2], out, log_nid, depth);
        return;
    }
    let id = match peel_value(&fields[0]) {
        Value::I32(x) => *x,
        Value::U32(x) => *x as i32,
        _ => return,
    };
    let mut label = String::new();
    let mut is_separator = false;
    let mut en: Option<bool> = None;
    let mut sens: Option<bool> = None;
    let mut visible = true;
    if let Value::Dict(dict) = peel_value(&fields[1]) {
        for (k, v) in dict.iter() {
            let key_str = match peel_value(k) {
                Value::Str(s) => s.as_str(),
                _ => continue,
            };
            match key_str {
                "label" => {
                    if let Some(s) = value_as_str(v) {
                        label = s.into_owned();
                    }
                }
                "text" | "accessible-name" => {
                    if label.is_empty() {
                        if let Some(s) = value_as_str(v) {
                            label = s.into_owned();
                        }
                    }
                }
                "type" => {
                    if let Some(s) = value_as_str(v) {
                        if s.as_ref() == "separator" {
                            is_separator = true;
                        }
                    }
                }
                "enabled" => {
                    en = value_as_bool(v);
                }
                "sensitive" => {
                    sens = value_as_bool(v);
                }
                "visible" => {
                    if let Some(b) = value_as_bool(v) {
                        visible = b;
                    }
                }
                _ => {}
            }
        }
    }
    if !visible {
        return;
    }
    let enabled = en.unwrap_or_else(|| sens.unwrap_or(true));
    if is_separator {
        out.push(TraySniMenuEntryWire {
            dbusmenu_id: id,
            label: String::new(),
            separator: true,
            enabled: true,
        });
    } else if !label.is_empty() {
        out.push(TraySniMenuEntryWire {
            dbusmenu_id: id,
            label,
            separator: false,
            enabled,
        });
    }
    visit_dbusmenu_children(&fields[2], out, log_nid, depth.saturating_add(1));
}

fn visit_dbusmenu_children(
    v: &Value,
    out: &mut Vec<TraySniMenuEntryWire>,
    log_nid: Option<&str>,
    depth: u8,
) {
    let v = peel_value(v);
    match v {
        Value::Array(arr) => {
            let n = arr.inner().len();
            if depth == 0 && n == 0 {
                if let Some(nid) = log_nid {
                    tracing::warn!(
                        target: "derp_sni_menu",
                        notifier_id = %nid,
                        "dbusmenu root children array is empty (layout has no child entries)"
                    );
                }
            }
            for child in arr.inner() {
                visit_dbusmenu_node(child, out, false, log_nid, depth.saturating_add(1));
            }
        }
        Value::Structure(_) => {
            visit_dbusmenu_node(v, out, false, log_nid, depth.saturating_add(1));
        }
        _ => {
            if let Some(nid) = log_nid {
                tracing::warn!(
                    target: "derp_sni_menu",
                    notifier_id = %nid,
                    depth,
                    kind = dbusmenu_peel_kind(v),
                    "dbusmenu children slot is not array or structure"
                );
            }
        }
    }
}

fn dbusmenu_parse_get_layout_reply(
    body: &zbus::message::Body,
    notifier_id: &str,
    dest: &str,
    menu_path: &str,
) -> Vec<TraySniMenuEntryWire> {
    let Some(full_sig) = body.signature() else {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            dest = %dest,
            menu_path = %menu_path,
            "dbusmenu GetLayout reply missing body signature"
        );
        return Vec::new();
    };
    let full = full_sig.as_str();
    let layout_sig = match full.strip_prefix('u') {
        Some(rest) => match Signature::try_from(rest) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    target: "derp_sni_menu",
                    notifier_id = %notifier_id,
                    dest = %dest,
                    menu_path = %menu_path,
                    body_sig = %full,
                    error = %e,
                    "dbusmenu GetLayout layout signature parse failed"
                );
                return Vec::new();
            }
        },
        None => {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                dest = %dest,
                menu_path = %menu_path,
                body_sig = %full,
                "dbusmenu GetLayout body signature does not start with u"
            );
            return Vec::new();
        }
    };
    let data = body.data();
    let (rev, n1) = match data
        .deserialize_for_dynamic_signature::<_, u32>(Signature::from_static_str_unchecked("u"))
    {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                dest = %dest,
                menu_path = %menu_path,
                body_sig = %full,
                error = %e,
                "dbusmenu GetLayout revision u deserialize failed"
            );
            return Vec::new();
        }
    };
    let layout_owned = match data
        .slice(n1..)
        .deserialize_for_dynamic_signature::<_, OwnedStructure>(layout_sig.clone())
    {
        Ok((layout, _)) => layout,
        Err(e) => {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                dest = %dest,
                menu_path = %menu_path,
                body_sig = %full,
                layout_sig = %layout_sig,
                error = %e,
                "dbusmenu GetLayout OwnedStructure deserialize failed"
            );
            return Vec::new();
        }
    };
    let v = Value::Structure(layout_owned.0);
    let peeled = peel_value(&v);
    let layout_sig = peeled.value_signature();
    let mut out = Vec::new();
    visit_dbusmenu_node(&v, &mut out, true, Some(notifier_id), 0);
    if out.is_empty() {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            dest = %dest,
            menu_path = %menu_path,
            revision = rev,
            layout_sig = %layout_sig,
            root_kind = dbusmenu_peel_kind(&v),
            "dbusmenu GetLayout parsed0 menu rows (check root_kind, empty children, or labels filtered)"
        );
    } else {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            dest = %dest,
            menu_path = %menu_path,
            revision = rev,
            n_entries = out.len(),
            layout_sig = %layout_sig,
            "dbusmenu GetLayout parsed rows ok"
        );
    }
    out
}

fn fetch_dbusmenu_entries(
    conn: &Connection,
    dest: &str,
    menu_path: &str,
    notifier_id: &str,
) -> Vec<TraySniMenuEntryWire> {
    let Ok(proxy) = Proxy::new(conn, dest, menu_path, "com.canonical.dbusmenu") else {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            dest = %dest,
            menu_path = %menu_path,
            "dbusmenu Proxy::new failed for com.canonical.dbusmenu"
        );
        return Vec::new();
    };
    if let Err(e) = proxy.call_method("AboutToShow", &(0i32)) {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            error = %e,
            "dbusmenu AboutToShow(0) failed"
        );
    }
    let opened_payload = Value::from(0i32);
    if let Err(e) = proxy.call_method("Event", &(0i32, "opened", &opened_payload, 0u32)) {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %notifier_id,
            error = %e,
            "dbusmenu Event(0, opened, …) failed"
        );
    }
    let props_named = vec![
        "label".to_string(),
        "type".to_string(),
        "enabled".to_string(),
        "visible".to_string(),
        "sensitive".to_string(),
        "children-display".to_string(),
    ];
    let parse = || -> Vec<TraySniMenuEntryWire> {
        let (which, reply) =
            match proxy.call_method("GetLayout", &(0i32, -1i32, &Vec::<String>::new())) {
                Ok(m) => ("empty_props", m),
                Err(e1) => match proxy.call_method("GetLayout", &(0i32, -1i32, &props_named)) {
                    Ok(m) => ("named_props", m),
                    Err(e2) => {
                        tracing::warn!(
                            target: "derp_sni_menu",
                            notifier_id = %notifier_id,
                            dest = %dest,
                            menu_path = %menu_path,
                            err_empty = %e1,
                            err_named = %e2,
                            "dbusmenu GetLayout failed (empty props and named props)"
                        );
                        return Vec::new();
                    }
                },
            };
        let out = dbusmenu_parse_get_layout_reply(&reply.body(), notifier_id, dest, menu_path);
        if out.is_empty() {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                get_layout_props = %which,
                "dbusmenu GetLayout returned layout that parsed to 0 rows"
            );
        }
        out
    };
    let mut out = parse();
    if out.is_empty() {
        if let Err(e) = proxy.call_method("AboutToShow", &(0i32)) {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                error = %e,
                "dbusmenu AboutToShow(0) retry failed"
            );
        }
        if let Err(e) = proxy.call_method("Event", &(0i32, "opened", &opened_payload, 0u32)) {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %notifier_id,
                error = %e,
                "dbusmenu Event opened retry failed"
            );
        }
        out = parse();
    }
    out
}

fn open_tray_sni_menu(conn: &Connection, full_id: &str, request_serial: u32) -> TraySniMenuWire {
    let (dest, path) = notifier_dest_path(full_id);
    let Ok(sni_proxy) = Proxy::new(
        conn,
        dest.as_str(),
        path.as_str(),
        "org.kde.StatusNotifierItem",
    ) else {
        tracing::warn!(
            target: "derp_sni_menu",
            notifier_id = %full_id,
            dest = %dest,
            sni_path = %path,
            "StatusNotifierItem proxy failed"
        );
        return TraySniMenuWire {
            request_serial,
            notifier_id: full_id.to_string(),
            menu_path: String::new(),
            entries: Vec::new(),
        };
    };
    let menu_path = match sni_proxy.get_property::<OwnedObjectPath>("Menu") {
        Ok(p) => {
            let s = p.as_str();
            if s.is_empty() {
                tracing::warn!(
                    target: "derp_sni_menu",
                    notifier_id = %full_id,
                    dest = %dest,
                    "StatusNotifierItem Menu property is empty"
                );
                String::new()
            } else {
                s.to_string()
            }
        }
        Err(e) => {
            tracing::warn!(
                target: "derp_sni_menu",
                notifier_id = %full_id,
                dest = %dest,
                error = %e,
                "StatusNotifierItem get_property Menu failed"
            );
            String::new()
        }
    };
    let entries = if menu_path.is_empty() {
        Vec::new()
    } else {
        fetch_dbusmenu_entries(conn, dest.as_str(), &menu_path, full_id)
    };
    TraySniMenuWire {
        request_serial,
        notifier_id: full_id.to_string(),
        menu_path,
        entries,
    }
}

fn menu_event(conn: &Connection, full_id: &str, menu_path: &str, item_id: i32) {
    if menu_path.is_empty() || item_id < 0 {
        return;
    }
    let (dest, _) = notifier_dest_path(full_id);
    let Ok(menu_proxy) = Proxy::new(conn, dest.as_str(), menu_path, "com.canonical.dbusmenu")
    else {
        return;
    };
    let data = Value::from(0i32);
    let ts = 0u32;
    let _ = menu_proxy.call_method("Event", &(item_id, "clicked", &data, ts));
}

pub fn spawn_sni_tray_thread(
    loop_tx: Sender<SniTrayLoopMsg>,
    cmd_rx: std::sync::mpsc::Receiver<SniTrayCmd>,
) {
    std::thread::Builder::new()
        .name("derp-sni-tray".into())
        .spawn(move || run_sni(loop_tx, cmd_rx))
        .ok();
}

fn run_sni(loop_tx: Sender<SniTrayLoopMsg>, cmd_rx: std::sync::mpsc::Receiver<SniTrayCmd>) {
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
                SniTrayCmd::Activate { id } => activate(&host_conn, &id),
                SniTrayCmd::OpenMenu { id, request_serial } => {
                    let menu = open_tray_sni_menu(&host_conn, &id, request_serial);
                    let _ = loop_tx.send(SniTrayLoopMsg::Menu(menu));
                }
                SniTrayCmd::MenuEvent {
                    id,
                    menu_path,
                    item_id,
                } => menu_event(&host_conn, &id, &menu_path, item_id),
            }
        }
        let ids = retain_live_notifier_ids(&watch_conn, &shared_items, we_own_watcher);
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
            let _ = loop_tx.send(SniTrayLoopMsg::Items(v));
        }
        std::thread::sleep(Duration::from_millis(350));
    }
}
