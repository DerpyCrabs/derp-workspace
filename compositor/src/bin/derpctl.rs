#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    sync::atomic::{AtomicU64, Ordering},
};

use clap::{Parser, Subcommand};
use serde_json::{json, Value};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Parser, Debug)]
#[command(name = "derpctl", about = "Derp compositor external control")]
struct Cli {
    #[arg(long, default_value_t = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Schema,
    Commands,
    State {
        #[arg(long)]
        domains: Option<String>,
    },
    Events {
        #[arg(long)]
        domains: Option<String>,
    },
    Window {
        #[command(subcommand)]
        command: WindowCommand,
    },
    Layout {
        #[command(subcommand)]
        command: LayoutCommand,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    Settings {
        #[command(subcommand)]
        command: SettingsCommand,
    },
    Transaction {
        actions: String,
    },
}

#[derive(Subcommand, Debug)]
enum WindowCommand {
    Focus {
        window_id: u32,
    },
    Close {
        window_id: u32,
    },
    Minimize {
        window_id: u32,
    },
    Fullscreen {
        window_id: u32,
        #[arg(long)]
        enabled: Option<bool>,
    },
    Maximize {
        window_id: u32,
        #[arg(long)]
        enabled: Option<bool>,
    },
    Move {
        window_id: u32,
        #[arg(long)]
        x: i32,
        #[arg(long)]
        y: i32,
        #[arg(long)]
        width: i32,
        #[arg(long)]
        height: i32,
        #[arg(long, default_value = "floating")]
        layout: String,
    },
    MoveMonitor {
        window_id: u32,
        #[arg(long, default_value = "right")]
        direction: String,
    },
}

#[derive(Subcommand, Debug)]
enum LayoutCommand {
    SetMonitor {
        output_name: String,
        #[arg(long)]
        layout: String,
        #[arg(long)]
        params: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum WorkspaceCommand {
    Mutate { mutation: String },
}

#[derive(Subcommand, Debug)]
enum SettingsCommand {
    Set { section: String, value: String },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let _json = cli.json;
    let request = build_request(cli.command)?;
    if request["method"] == "events.subscribe" {
        stream_events(request)?;
        return Ok(());
    }
    let response = send_request(request)?;
    println!("{response}");
    let value: Value = serde_json::from_str(&response)?;
    if value["ok"] == false {
        std::process::exit(1);
    }
    Ok(())
}

fn build_request(command: Command) -> Result<Value, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let request = match command {
        Command::Schema => json!({ "id": id, "method": "schema.get", "params": {} }),
        Command::Commands => json!({ "id": id, "method": "commands.list", "params": {} }),
        Command::State { domains } => {
            json!({ "id": id, "method": "state.get", "params": domains_param(domains) })
        }
        Command::Events { domains } => {
            json!({ "id": id, "method": "events.subscribe", "params": domains_param(domains) })
        }
        Command::Window { command } => build_window_request(id, command),
        Command::Layout { command } => build_layout_request(id, command)?,
        Command::Workspace { command } => build_workspace_request(id, command)?,
        Command::Settings { command } => build_settings_request(id, command)?,
        Command::Transaction { actions } => build_transaction_request(id, actions)?,
    };
    Ok(request)
}

fn domains_param(domains: Option<String>) -> Value {
    match domains {
        Some(domains) => {
            json!({ "domains": domains.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>() })
        }
        None => json!({}),
    }
}

fn build_window_request(id: u64, command: WindowCommand) -> Value {
    match command {
        WindowCommand::Focus { window_id } => {
            json!({ "id": id, "method": "window.focus", "params": { "window_id": window_id } })
        }
        WindowCommand::Close { window_id } => {
            json!({ "id": id, "method": "window.close", "params": { "window_id": window_id } })
        }
        WindowCommand::Minimize { window_id } => {
            json!({ "id": id, "method": "window.minimize", "params": { "window_id": window_id } })
        }
        WindowCommand::Fullscreen { window_id, enabled } => {
            let enabled = enabled.unwrap_or(true);
            json!({ "id": id, "method": "window.set_fullscreen", "params": { "window_id": window_id, "enabled": enabled } })
        }
        WindowCommand::Maximize { window_id, enabled } => {
            let enabled = enabled.unwrap_or(true);
            json!({ "id": id, "method": "window.set_maximized", "params": { "window_id": window_id, "enabled": enabled } })
        }
        WindowCommand::Move {
            window_id,
            x,
            y,
            width,
            height,
            layout,
        } => json!({
            "id": id,
            "method": "window.set_geometry",
            "params": { "window_id": window_id, "x": x, "y": y, "width": width, "height": height, "layout": layout }
        }),
        WindowCommand::MoveMonitor {
            window_id,
            direction,
        } => {
            json!({ "id": id, "method": "window.move_monitor", "params": { "window_id": window_id, "direction": direction } })
        }
    }
}

fn build_layout_request(id: u64, command: LayoutCommand) -> Result<Value, String> {
    match command {
        LayoutCommand::SetMonitor {
            output_name,
            layout,
            params,
        } => {
            let params = match params {
                Some(raw) => serde_json::from_str::<Value>(&raw)
                    .map_err(|e| format!("invalid params json: {e}"))?,
                None => json!({}),
            };
            Ok(json!({
                "id": id,
                "method": "layout.set_monitor",
                "params": { "output_name": output_name, "layout": layout, "params": params }
            }))
        }
    }
}

fn build_workspace_request(id: u64, command: WorkspaceCommand) -> Result<Value, String> {
    match command {
        WorkspaceCommand::Mutate { mutation } => {
            serde_json::from_str::<Value>(&mutation)
                .map_err(|e| format!("invalid mutation json: {e}"))?;
            Ok(
                json!({ "id": id, "method": "workspace.mutate", "params": { "mutation_json": mutation } }),
            )
        }
    }
}

fn build_settings_request(id: u64, command: SettingsCommand) -> Result<Value, String> {
    match command {
        SettingsCommand::Set { section, value } => {
            let value = serde_json::from_str::<Value>(&value)
                .map_err(|e| format!("invalid value json: {e}"))?;
            Ok(
                json!({ "id": id, "method": "settings.set", "params": { "section": section, "value": value } }),
            )
        }
    }
}

fn build_transaction_request(id: u64, actions: String) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(&actions)
        .map_err(|e| format!("invalid transaction json: {e}"))?;
    let actions = if value.is_array() {
        value
    } else if value.get("actions").is_some() {
        value["actions"].clone()
    } else {
        return Err("transaction json must be an array or object with actions".into());
    };
    Ok(json!({ "id": id, "method": "transaction.apply", "params": { "actions": actions } }))
}

fn send_request(request: Value) -> Result<String, Box<dyn std::error::Error>> {
    let mut stream = connect()?;
    writeln!(stream, "{request}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(line.trim_end().to_string())
}

fn stream_events(request: Value) -> Result<(), Box<dyn std::error::Error>> {
    let mut stream = connect()?;
    writeln!(stream, "{request}")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        out.write_all(line.as_bytes())?;
        out.flush()?;
    }
    Ok(())
}

fn connect() -> Result<UnixStream, Box<dyn std::error::Error>> {
    let path = compositor::control::default_socket_path()?;
    Ok(UnixStream::connect(path)?)
}
