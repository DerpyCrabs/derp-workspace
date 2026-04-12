use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cef::{Browser, CefString, ImplBrowser, ImplFrame};

use crate::cef::e2e_bridge;
use crate::cef::uplink::UplinkToCompositor;

struct PortalScreencastRequest {
    request_id: u64,
    types: Option<u32>,
    selection: Option<Option<String>>,
}

struct PortalScreencastState {
    next_request_id: u64,
    current: Option<PortalScreencastRequest>,
    last_confirmed: Option<PortalScreencastSelection>,
}

struct PortalScreencastSelection {
    types: Option<u32>,
    selection: String,
    confirmed_at: Instant,
}

fn portal_screencast_state() -> &'static (Mutex<PortalScreencastState>, Condvar) {
    static STATE: OnceLock<(Mutex<PortalScreencastState>, Condvar)> = OnceLock::new();
    STATE.get_or_init(|| {
        (
            Mutex::new(PortalScreencastState {
                next_request_id: 1,
                current: None,
                last_confirmed: None,
            }),
            Condvar::new(),
        )
    })
}

fn can_reuse_portal_screencast_selection(
    request_types: Option<u32>,
    cached_types: Option<u32>,
) -> bool {
    request_types == Some(2) && cached_types == Some(2)
}

fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
}

pub fn start(
    uplink: UplinkToCompositor,
    browser: Arc<Mutex<Option<Browser>>>,
) -> std::sync::mpsc::Receiver<Result<u16, String>> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    std::thread::spawn(move || run(uplink, browser, tx));
    rx
}

fn run(
    uplink: UplinkToCompositor,
    browser: Arc<Mutex<Option<Browser>>>,
    port_tx: std::sync::mpsc::Sender<Result<u16, String>>,
) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("compositor cef: control server bind: {e}");
            let _ = port_tx.send(Err(e.to_string()));
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = port_tx.send(Ok(port));
    std::thread::spawn(crate::cef::desktop_apps::warm_applications_cache);

    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
        let uplink_cl = uplink.clone();
        let browser_cl = browser.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            if let Err(e) = handle_one(&mut stream, &uplink_cl, &browser_cl) {
                let msg = e.replace('\r', "").replace('\n', "");
                let body = format!(r#"{{"error":"{}"}}"#, msg.replace('"', "'"));
                let _ = write_http_json_error(&mut stream, 500, &body);
            }
        });
    }
}

fn write_http_json_error(
    stream: &mut std::net::TcpStream,
    status: u16,
    json: &str,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} Error\r\n{}Content-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        cors_headers(),
        json.len(),
        json
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_http_ok_bytes(
    stream: &mut std::net::TcpStream,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\n{}Content-Type: {}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        cors_headers(),
        content_type,
        body.len(),
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_http_ok_json(stream: &mut std::net::TcpStream, json: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\n{}Content-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        cors_headers(),
        json.len(),
        json
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_http_no_content(stream: &mut std::net::TcpStream) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 204 No Content\r\n{}Connection: close\r\nContent-Length: 0\r\n\r\n",
        cors_headers()
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn split_path_query(path_with_query: &str) -> (&str, Option<&str>) {
    path_with_query
        .split_once('?')
        .map(|(p, q)| (p, Some(q)))
        .unwrap_or((path_with_query, None))
}

fn query_param_raw<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    for part in query.split('&') {
        let part = part.trim_end_matches('\r');
        if part.is_empty() {
            continue;
        }
        if let Some((k, v)) = part.split_once('=') {
            if k == key {
                return Some(v);
            }
        }
    }
    None
}

fn percent_decode_component(input: &str) -> Result<String, String> {
    let hex = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err("bad percent escape".into()),
        }
    };
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let b = input.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let v = (hex(b[i + 1])? << 4) | hex(b[i + 2])?;
            out.push(v);
            i += 3;
        } else if b[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn quote_js_string(input: &str) -> Result<String, String> {
    serde_json::to_string(input).map_err(|e| format!("serialize js string: {e}"))
}

fn execute_shell_bridge_js(
    browser: &Arc<Mutex<Option<Browser>>>,
    script: String,
) -> Result<(), String> {
    let guard = browser
        .lock()
        .map_err(|_| "shell browser lock poisoned".to_string())?;
    let browser = guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "shell browser is unavailable".to_string())?;
    let frame = browser
        .main_frame()
        .ok_or_else(|| "shell main frame is unavailable".to_string())?;
    frame.execute_java_script(Some(&CefString::from(script.as_str())), None, 0);
    Ok(())
}

fn request_shell_snapshot_json(browser: &Arc<Mutex<Option<Browser>>>) -> Result<String, String> {
    let request_id = e2e_bridge::next_request_id();
    execute_shell_bridge_js(
        browser,
        format!(
            "window.__DERP_E2E_REQUEST_SNAPSHOT&&window.__DERP_E2E_REQUEST_SNAPSHOT({request_id});"
        ),
    )?;
    e2e_bridge::wait_for_shell_snapshot(request_id, Duration::from_secs(3))
}

fn request_shell_html(
    browser: &Arc<Mutex<Option<Browser>>>,
    selector: Option<&str>,
) -> Result<String, String> {
    let request_id = e2e_bridge::next_request_id();
    let selector_js = match selector {
        Some(value) => quote_js_string(value)?,
        None => "null".to_string(),
    };
    execute_shell_bridge_js(
        browser,
        format!(
            "window.__DERP_E2E_REQUEST_HTML&&window.__DERP_E2E_REQUEST_HTML({request_id},{selector_js});"
        ),
    )?;
    e2e_bridge::wait_for_shell_html(request_id, Duration::from_secs(3))
}

fn open_shell_test_window(browser: &Arc<Mutex<Option<Browser>>>) -> Result<(), String> {
    execute_shell_bridge_js(
        browser,
        "window.__DERP_E2E_OPEN_TEST_WINDOW&&window.__DERP_E2E_OPEN_TEST_WINDOW();".to_string(),
    )
}

fn json_u64_field(v: &serde_json::Value, key: &str) -> Result<u64, String> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| format!("missing {key}"))
}

fn portal_screencast_request_json() -> String {
    let (lock, _) = portal_screencast_state();
    let state = lock.lock().expect("portal_screencast_state");
    if let Some(request) = state.current.as_ref() {
        if request.selection.is_none() {
            return match request.types {
                Some(types) => {
                    format!(
                        r#"{{"pending":true,"request_id":{},"types":{}}}"#,
                        request.request_id, types
                    )
                }
                None => format!(r#"{{"pending":true,"request_id":{}}}"#, request.request_id),
            };
        }
    }
    r#"{"pending":false}"#.to_string()
}

fn portal_screencast_pick(v: &serde_json::Value) -> String {
    let (lock, condvar) = portal_screencast_state();
    let mut state = lock.lock().expect("portal_screencast_state");
    let types = v
        .get("types")
        .and_then(|x| x.as_u64())
        .and_then(|x| u32::try_from(x).ok())
        .filter(|x| *x != 0);
    let reuse = state.last_confirmed.take().and_then(|cached| {
        if cached.confirmed_at.elapsed() <= Duration::from_secs(8)
            && can_reuse_portal_screencast_selection(types, cached.types)
        {
            Some(cached.selection)
        } else {
            None
        }
    });
    if let Some(selection) = reuse {
        return selection;
    }
    let request_id = state.next_request_id;
    state.next_request_id += 1;
    state.current = Some(PortalScreencastRequest {
        request_id,
        types,
        selection: None,
    });
    condvar.notify_all();
    let timeout = Duration::from_secs(90);
    let (mut state, _) = condvar
        .wait_timeout_while(state, timeout, |state| {
            state
                .current
                .as_ref()
                .map(|request| request.request_id == request_id && request.selection.is_none())
                .unwrap_or(false)
        })
        .expect("portal_screencast_state");
    let selection = match state.current.take() {
        Some(request) if request.request_id == request_id => request.selection.flatten(),
        Some(request) => {
            state.current = Some(request);
            None
        }
        None => None,
    };
    selection.unwrap_or_default()
}

fn portal_screencast_respond(v: &serde_json::Value) -> Result<(), String> {
    let request_id = json_u64_field(v, "request_id")?;
    let selection = match v.get("selection") {
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(serde_json::Value::Null) | None => None,
        _ => return Err("selection must be a string or null".into()),
    };
    let (lock, condvar) = portal_screencast_state();
    let mut state = lock.lock().expect("portal_screencast_state");
    let Some(current) = state.current.as_mut() else {
        return Ok(());
    };
    if current.request_id != request_id {
        return Ok(());
    }
    let current_types = current.types;
    current.selection = Some(selection.clone());
    if let Some(selection) = selection {
        state.last_confirmed = Some(PortalScreencastSelection {
            types: current_types,
            selection,
            confirmed_at: Instant::now(),
        });
    }
    condvar.notify_all();
    Ok(())
}

fn wallpaper_preview_allowed(canon: &Path) -> bool {
    let Some(s) = canon.to_str() else {
        return false;
    };
    if !s.starts_with("/usr/share/") {
        return false;
    }
    let ext_ok = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "gif" | "jxl"
            )
        })
        .unwrap_or(false);
    ext_ok && canon.is_file()
}

fn json_i32_field(v: &serde_json::Value, key: &str) -> Result<i32, String> {
    let raw = v
        .get(key)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| format!("missing {key}"))?;
    i32::try_from(raw).map_err(|_| format!("{key} out of range"))
}

fn json_f64_field(v: &serde_json::Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| format!("missing {key}"))
}

fn json_u32_field(v: &serde_json::Value, key: &str) -> Result<u32, String> {
    let raw = v
        .get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| format!("missing {key}"))?;
    u32::try_from(raw).map_err(|_| format!("{key} out of range"))
}

fn json_bool_field(v: &serde_json::Value, key: &str) -> Result<bool, String> {
    v.get(key)
        .and_then(|x| x.as_bool())
        .ok_or_else(|| format!("missing {key}"))
}

fn json_string_field(v: &serde_json::Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing {key}"))
}

fn json_optional_string_field(v: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match v.get(key) {
        Some(serde_json::Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Some(serde_json::Value::Null) | None => Ok(None),
        _ => Err(format!("{key} must be a string or null")),
    }
}

fn handle_one(
    stream: &mut std::net::TcpStream,
    uplink: &UplinkToCompositor,
    browser: &Arc<Mutex<Option<Browser>>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|e| e.to_string())?;
    let parts: Vec<&str> = first.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("bad request".into());
    }
    let method = parts[0];
    let path = parts[1];
    let (req_path, query_str) = split_path_query(path);

    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if line == "\r\n" || line == "\n" {
            break;
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if let Some(idx) = l.find(':') {
            if l[..idx].trim().eq_ignore_ascii_case("content-length") {
                content_length = l[idx + 1..].trim().parse().unwrap_or(0);
            }
        }
    }

    if method.eq_ignore_ascii_case("OPTIONS") {
        write_http_no_content(stream).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/test/state/compositor" {
        let json = uplink.test_compositor_snapshot_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/test/state/shell" {
        let json = request_shell_snapshot_json(browser)?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/test/state/html" {
        let selector = query_str
            .and_then(|query| query_param_raw(query, "selector"))
            .map(percent_decode_component)
            .transpose()?;
        let html = request_shell_html(browser, selector.as_deref())?;
        write_http_ok_bytes(stream, "text/html; charset=utf-8", html.as_bytes())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/desktop_applications" {
        let json = crate::cef::desktop_apps::list_applications_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/portal_screencast_request" {
        let json = portal_screencast_request_json();
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/desktop_app_usage" {
        let json = crate::desktop_app_usage::read_desktop_app_usage_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/gnome_desktop_background" {
        let json = crate::cef::gnome_background::read_gnome_desktop_background_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/gnome_wallpaper_choices" {
        let json = crate::cef::gnome_wallpaper_list::list_gnome_wallpapers_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/settings_theme" {
        let json = crate::settings_config::read_theme_settings_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/settings_keyboard" {
        let json = crate::settings_config::read_keyboard_settings_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/settings_user" {
        let json = crate::gdm_settings::read_gdm_autologin_settings_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/audio_state" {
        let json = crate::audio_control::read_audio_state_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/bluetooth_state" {
        let json = crate::bluetooth_control::read_bluetooth_state_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/wifi_state" {
        let json = crate::wifi_control::read_wifi_state_json()?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if method.eq_ignore_ascii_case("GET") && req_path == "/wallpaper_preview" {
        let q = query_str.ok_or_else(|| "wallpaper_preview: missing query".to_string())?;
        let p_enc =
            query_param_raw(q, "p").ok_or_else(|| "wallpaper_preview: missing p".to_string())?;
        let p_dec = percent_decode_component(p_enc)?;
        let pb = PathBuf::from(p_dec);
        let canon = pb
            .canonicalize()
            .map_err(|e| format!("wallpaper_preview: {e}"))?;
        if !wallpaper_preview_allowed(&canon) {
            write_http_json_error(stream, 403, r#"{"error":"forbidden"}"#)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        let jpeg = crate::desktop_background::encode_wallpaper_preview_jpeg(&canon)?;
        write_http_ok_bytes(stream, "image/jpeg", &jpeg).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if !method.eq_ignore_ascii_case("POST") {
        write_http_json_error(stream, 404, r#"{"error":"not_found"}"#)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if content_length > 8192 {
        return Err("body too large".into());
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    }
    let body_str = std::str::from_utf8(&body).map_err(|_| "invalid utf-8 body".to_string())?;
    let v: serde_json::Value = serde_json::from_str(body_str).unwrap_or(serde_json::Value::Null);

    if req_path == "/test/shell_window/open" {
        open_shell_test_window(browser)?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/portal_screencast_pick" {
        let selection = portal_screencast_pick(&v);
        write_http_ok_bytes(stream, "text/plain; charset=utf-8", selection.as_bytes())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/input/pointer_move" {
        uplink.test_pointer_move(json_f64_field(&v, "x")?, json_f64_field(&v, "y")?)?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/input/pointer_button" {
        let button = v
            .get("button")
            .and_then(|x| x.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0x110);
        let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("press");
        let pressed = match action {
            "press" => true,
            "release" => false,
            _ => return Err("pointer_button: action must be press or release".into()),
        };
        uplink.test_pointer_button(button, pressed)?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/input/click" {
        let button = v
            .get("button")
            .and_then(|x| x.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0x110);
        uplink.test_pointer_click(json_f64_field(&v, "x")?, json_f64_field(&v, "y")?, button)?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/input/drag" {
        let button = v
            .get("button")
            .and_then(|x| x.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0x110);
        let steps = v
            .get("steps")
            .and_then(|x| x.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(12);
        uplink.test_pointer_drag(
            json_f64_field(&v, "x0")?,
            json_f64_field(&v, "y0")?,
            json_f64_field(&v, "x1")?,
            json_f64_field(&v, "y1")?,
            button,
            steps,
        )?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/input/key" {
        let keycode = json_u32_field(&v, "keycode")?;
        let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("tap");
        match action {
            "press" => uplink.test_key(keycode, true)?,
            "release" => uplink.test_key(keycode, false)?,
            "tap" => {
                uplink.test_key(keycode, true)?;
                uplink.test_key(keycode, false)?;
            }
            _ => return Err("key: action must be press, release, or tap".into()),
        }
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/keybind" {
        let action = v
            .get("action")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "keybind: missing action".to_string())?;
        match action {
            "close_focused"
            | "toggle_fullscreen"
            | "toggle_maximize"
            | "launch_terminal"
            | "toggle_programs_menu"
            | "open_settings"
            | "tile_left"
            | "tile_right"
            | "tile_up"
            | "tile_down"
            | "tab_next"
            | "tab_previous"
            | "move_monitor_left"
            | "move_monitor_right" => {}
            _ => return Err("keybind: unsupported action".into()),
        }
        uplink.test_super_keybind(action.to_string())?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/window/close" {
        let window_id = json_u32_field(&v, "window_id")?;
        uplink.shell_close(window_id);
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/window/crash" {
        let window_id = json_u32_field(&v, "window_id")?;
        uplink.test_crash_window(window_id)?;
        write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
        return Ok(());
    }

    if req_path == "/test/screenshot" {
        let rect = match (
            v.get("x").and_then(|x| x.as_i64()),
            v.get("y").and_then(|x| x.as_i64()),
            v.get("width").and_then(|x| x.as_i64()),
            v.get("height").and_then(|x| x.as_i64()),
        ) {
            (Some(x), Some(y), Some(width), Some(height)) => Some(smithay::utils::Rectangle::new(
                (
                    i32::try_from(x).map_err(|_| "screenshot x out of range".to_string())?,
                    i32::try_from(y).map_err(|_| "screenshot y out of range".to_string())?,
                )
                    .into(),
                (
                    i32::try_from(width)
                        .map_err(|_| "screenshot width out of range".to_string())?,
                    i32::try_from(height)
                        .map_err(|_| "screenshot height out of range".to_string())?,
                )
                    .into(),
            )),
            (None, None, None, None) => None,
            _ => return Err("screenshot: provide x, y, width, and height together".into()),
        };
        let request_id = uplink.test_request_screenshot(rect)?;
        let result = crate::e2e::wait_for_screenshot_result(request_id, Duration::from_secs(5))?;
        let json = serde_json::to_string(&result)
            .map_err(|e| format!("serialize screenshot result: {e}"))?;
        write_http_ok_json(stream, &json).map_err(|e| e.to_string())?;
        return Ok(());
    }

    match req_path {
        "/session_quit" => uplink.quit_compositor(),
        "/session_power" => {
            let action = v
                .get("action")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "missing action".to_string())?;
            let sub = match action {
                "suspend" => "suspend",
                "reboot" => "reboot",
                "poweroff" => "poweroff",
                "hibernate" => "hibernate",
                _ => return Err("invalid action".into()),
            };
            uplink.session_power_systemctl(sub.to_string());
        }
        "/spawn" => {
            let command = v
                .get("command")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "missing command".to_string())?
                .to_string();
            uplink.spawn_wayland_client(command);
        }
        "/desktop_app_usage_launch" => {
            let key = v
                .get("key")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "missing key".to_string())?
                .to_string();
            crate::desktop_app_usage::increment_desktop_app_usage(key)?;
        }
        "/settings_theme" => {
            let theme = serde_json::from_value::<crate::settings_config::ThemeSettingsFile>(v)
                .map_err(|e| format!("invalid theme settings: {e}"))?;
            crate::settings_config::write_theme_settings(theme)?;
        }
        "/settings_keyboard" => {
            let keyboard =
                serde_json::from_value::<crate::settings_config::KeyboardSettingsFile>(v)
                    .map_err(|e| format!("invalid keyboard settings: {e}"))?;
            uplink.settings_keyboard_apply(keyboard)?;
        }
        "/settings_user" => {
            let update = serde_json::from_value::<crate::gdm_settings::GdmAutologinUpdate>(v)
                .map_err(|e| format!("invalid user settings: {e}"))?;
            crate::gdm_settings::write_gdm_autologin_settings(update)?;
        }
        "/audio_default" => {
            let id = json_u32_field(&v, "id")?;
            crate::audio_control::set_default_audio_device(id)?;
        }
        "/audio_volume" => {
            let id = json_u32_field(&v, "id")?;
            let volume_percent = json_u32_field(&v, "volume_percent")?;
            crate::audio_control::set_audio_volume_percent(id, volume_percent)?;
        }
        "/audio_mute" => {
            let id = json_u32_field(&v, "id")?;
            let muted = json_bool_field(&v, "muted")?;
            crate::audio_control::set_audio_mute(id, muted)?;
        }
        "/bluetooth_scan" => {
            crate::bluetooth_control::scan_bluetooth()?;
        }
        "/bluetooth_radio" => {
            let enabled = json_bool_field(&v, "enabled")?;
            crate::bluetooth_control::set_bluetooth_power(enabled)?;
        }
        "/bluetooth_pairable" => {
            let enabled = json_bool_field(&v, "enabled")?;
            crate::bluetooth_control::set_bluetooth_pairable(enabled)?;
        }
        "/bluetooth_discoverable" => {
            let enabled = json_bool_field(&v, "enabled")?;
            crate::bluetooth_control::set_bluetooth_discoverable(enabled)?;
        }
        "/bluetooth_pair_connect" => {
            let address = json_string_field(&v, "address")?;
            crate::bluetooth_control::pair_and_connect_bluetooth_device(&address)?;
        }
        "/bluetooth_connect" => {
            let address = json_string_field(&v, "address")?;
            crate::bluetooth_control::connect_bluetooth_device(&address)?;
        }
        "/bluetooth_disconnect" => {
            let address = json_string_field(&v, "address")?;
            crate::bluetooth_control::disconnect_bluetooth_device(&address)?;
        }
        "/bluetooth_trust" => {
            let address = json_string_field(&v, "address")?;
            let trusted = json_bool_field(&v, "trusted")?;
            crate::bluetooth_control::set_bluetooth_trust(&address, trusted)?;
        }
        "/bluetooth_forget" => {
            let address = json_string_field(&v, "address")?;
            crate::bluetooth_control::forget_bluetooth_device(&address)?;
        }
        "/wifi_scan" => {
            crate::wifi_control::scan_wifi()?;
        }
        "/wifi_radio" => {
            let enabled = json_bool_field(&v, "enabled")?;
            crate::wifi_control::set_wifi_radio(enabled)?;
        }
        "/wifi_connect" => {
            let ssid = json_string_field(&v, "ssid")?;
            let password = json_optional_string_field(&v, "password")?;
            crate::wifi_control::connect_wifi(&ssid, password.as_deref())?;
        }
        "/wifi_disconnect" => {
            let device = json_optional_string_field(&v, "device")?;
            crate::wifi_control::disconnect_wifi(device.as_deref())?;
        }
        "/screenshot_region" => {
            let x = json_i32_field(&v, "x")?;
            let y = json_i32_field(&v, "y")?;
            let width = json_i32_field(&v, "width")?;
            let height = json_i32_field(&v, "height")?;
            if width <= 0 || height <= 0 {
                return Err("screenshot_region: width and height must be positive".into());
            }
            uplink.screenshot_region(x, y, width, height);
        }
        "/screenshot_begin_region_mode" => {
            uplink.screenshot_begin_region_mode();
        }
        "/screenshot_cancel" => {
            uplink.screenshot_cancel();
        }
        "/portal_screencast_respond" => {
            portal_screencast_respond(&v)?;
        }
        _ => {
            write_http_json_error(stream, 404, r#"{"error":"not_found"}"#)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
    Ok(())
}
