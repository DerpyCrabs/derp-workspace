//! Loopback HTTP control plane: POST `/spawn`, `/window_move_*` → [`shell_wire`] on the compositor Unix stream.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
}

/// Spawn a background thread listening on `127.0.0.1:0`. Receive the port from the returned channel.
pub fn start(ipc: Arc<Mutex<UnixStream>>) -> std::sync::mpsc::Receiver<u16> {
    let (tx, rx) = std::sync::mpsc::channel::<u16>();
    std::thread::spawn(move || run(ipc, tx));
    rx
}

fn run(ipc: Arc<Mutex<UnixStream>>, port_tx: std::sync::mpsc::Sender<u16>) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cef_host: control server bind: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let _ = port_tx.send(port);

    for conn in listener.incoming() {
        let mut stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
        if let Err(e) = handle_one(&mut stream, &ipc) {
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

fn handle_one(
    stream: &mut std::net::TcpStream,
    ipc: &Arc<Mutex<UnixStream>>,
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

    let packet: Vec<u8> = match path {
        "/session_quit" => shell_wire::encode_shell_quit_compositor(),
        "/spawn" => {
            let command = v
                .get("command")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "missing command".to_string())?
                .to_string();
            shell_wire::encode_spawn_wayland_client(&command)
                .ok_or_else(|| "invalid command".to_string())?
        }
        "/window_move_begin" => {
            let window_id = v
                .get("window_id")
                .and_then(|x| x.as_u64())
                .ok_or_else(|| "missing window_id".to_string())?;
            if window_id > u32::MAX as u64 {
                return Err("window_id too large".into());
            }
            shell_wire::encode_shell_move_begin(window_id as u32)
        }
        "/window_move_delta" => {
            let dx = v
                .get("dx")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "missing dx".to_string())?;
            let dy = v
                .get("dy")
                .and_then(|x| x.as_i64())
                .ok_or_else(|| "missing dy".to_string())?;
            if dx < i32::MIN as i64
                || dx > i32::MAX as i64
                || dy < i32::MIN as i64
                || dy > i32::MAX as i64
            {
                return Err("delta out of range".into());
            }
            shell_wire::encode_shell_move_delta(dx as i32, dy as i32)
        }
        "/window_move_end" => {
            let window_id = v
                .get("window_id")
                .and_then(|x| x.as_u64())
                .ok_or_else(|| "missing window_id".to_string())?;
            if window_id > u32::MAX as u64 {
                return Err("window_id too large".into());
            }
            shell_wire::encode_shell_move_end(window_id as u32)
        }
        _ => {
            write_http_json_error(stream, 404, r#"{"error":"not_found"}"#)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    };

    {
        let mut g = ipc.lock().expect("ipc");
        g.write_all(&packet).map_err(|e| e.to_string())?;
        g.flush().map_err(|e| e.to_string())?;
    }

    write_http_ok_json(stream, r#"{"ok":true}"#).map_err(|e| e.to_string())?;
    Ok(())
}
