use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use crate::cef::uplink::UplinkToCompositor;

fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
}

pub fn start(uplink: UplinkToCompositor) -> std::sync::mpsc::Receiver<Result<u16, String>> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    std::thread::spawn(move || run(uplink, tx));
    rx
}

fn run(uplink: UplinkToCompositor, port_tx: std::sync::mpsc::Sender<Result<u16, String>>) {
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

    for conn in listener.incoming() {
        let mut stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
        let uplink_cl = uplink.clone();
        if let Err(e) = handle_one(&mut stream, &uplink_cl) {
            let msg = e.replace('\r', "").replace('\n', "");
            let body = format!(r#"{{"error":"{}"}}"#, msg.replace('"', "'"));
            let _ = write_http_json_error(&mut stream, 500, &body);
        }
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

fn handle_one(stream: &mut std::net::TcpStream, uplink: &UplinkToCompositor) -> Result<(), String> {
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

    if method.eq_ignore_ascii_case("GET") && req_path == "/desktop_applications" {
        let json = crate::cef::desktop_apps::list_applications_json()?;
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
        "/settings_theme" => {
            let theme = serde_json::from_value::<crate::settings_config::ThemeSettingsFile>(v)
                .map_err(|e| format!("invalid theme settings: {e}"))?;
            crate::settings_config::write_theme_settings(theme)?;
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
        _ => {
            write_http_json_error(stream, 404, r#"{"error":"not_found"}"#)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
    Ok(())
}
