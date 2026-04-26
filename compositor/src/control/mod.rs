use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::mpsc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use smithay::reexports::calloop::channel;

use crate::{
    cef::compositor_tx::CefToCompositor,
    state::{transform_to_wire, CompositorState},
    window_ops::WindowLayoutMode,
    window_registry::WindowKind,
};

const DOMAINS: &[&str] = &["outputs", "windows", "workspace", "settings"];
const COMMANDS: &[&str] = &[
    "schema",
    "commands",
    "state",
    "events",
    "window focus",
    "window close",
    "window minimize",
    "window fullscreen",
    "window maximize",
    "window move",
    "window move-monitor",
    "layout set-monitor",
    "workspace mutate",
    "settings set",
    "transaction",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ControlDomains {
    outputs: bool,
    windows: bool,
    workspace: bool,
    settings: bool,
}

impl ControlDomains {
    pub fn all() -> Self {
        Self {
            outputs: true,
            windows: true,
            workspace: true,
            settings: true,
        }
    }

    pub fn parse_csv(raw: Option<&str>) -> Result<Self, String> {
        match raw {
            Some(raw) => {
                parse_domain_names(raw.split(',').map(str::trim).filter(|s| !s.is_empty()))
            }
            None => Ok(Self::all()),
        }
    }

    fn from_params(params: Option<&Value>) -> Result<Self, String> {
        let Some(params) = params else {
            return Ok(Self::all());
        };
        let Some(domains) = params.get("domains") else {
            return Ok(Self::all());
        };
        if let Some(raw) = domains.as_str() {
            return Self::parse_csv(Some(raw));
        }
        let Some(values) = domains.as_array() else {
            return Err("domains must be a string or array".into());
        };
        parse_domain_names(values.iter().map(|v| v.as_str().unwrap_or_default()))
    }

    fn names(self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.outputs {
            out.push("outputs");
        }
        if self.windows {
            out.push("windows");
        }
        if self.workspace {
            out.push("workspace");
        }
        if self.settings {
            out.push("settings");
        }
        out
    }

    fn is_empty(self) -> bool {
        !self.outputs && !self.windows && !self.workspace && !self.settings
    }

    fn intersection(self, other: Self) -> Self {
        Self {
            outputs: self.outputs && other.outputs,
            windows: self.windows && other.windows,
            workspace: self.workspace && other.workspace,
            settings: self.settings && other.settings,
        }
    }
}

fn parse_domain_names<'a>(values: impl Iterator<Item = &'a str>) -> Result<ControlDomains, String> {
    let mut domains = ControlDomains::default();
    for value in values {
        match value {
            "outputs" => domains.outputs = true,
            "windows" => domains.windows = true,
            "workspace" => domains.workspace = true,
            "settings" => domains.settings = true,
            "all" => return Ok(ControlDomains::all()),
            "" => {}
            other => return Err(format!("unknown domain {other}")),
        }
    }
    if domains.is_empty() {
        Ok(ControlDomains::all())
    } else {
        Ok(domains)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct ControlRevisions {
    outputs: u64,
    windows: u64,
    workspace: u64,
    settings: u64,
}

impl ControlRevisions {
    fn overall(self) -> u64 {
        self.outputs
            .max(self.windows)
            .max(self.workspace)
            .max(self.settings)
    }

    fn changed_since(self, previous: Self) -> ControlDomains {
        ControlDomains {
            outputs: self.outputs != previous.outputs,
            windows: self.windows != previous.windows,
            workspace: self.workspace != previous.workspace,
            settings: self.settings != previous.settings,
        }
    }
}

pub(crate) struct ControlSubscriber {
    domains: ControlDomains,
    revisions: ControlRevisions,
    tx: mpsc::Sender<String>,
}

#[derive(Default)]
pub(crate) struct ControlEventHub {
    subscribers: Vec<ControlSubscriber>,
}

impl ControlEventHub {
    fn subscribe(
        &mut self,
        domains: ControlDomains,
        revisions: ControlRevisions,
    ) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel();
        self.subscribers.push(ControlSubscriber {
            domains,
            revisions,
            tx,
        });
        rx
    }
}

#[derive(Debug, Deserialize)]
struct ControlRequest {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

pub fn default_socket_path() -> Result<PathBuf, String> {
    default_socket_path_from_env(
        std::env::var("DERP_CONTROL_SOCKET").ok(),
        std::env::var("XDG_RUNTIME_DIR").ok(),
    )
}

pub fn default_socket_path_from_env(
    socket: Option<String>,
    runtime_dir: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(socket) = socket {
        if !socket.is_empty() {
            return Ok(PathBuf::from(socket));
        }
    }
    let runtime_dir = runtime_dir
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "XDG_RUNTIME_DIR is not set".to_string())?;
    Ok(PathBuf::from(runtime_dir).join("derp").join("control.sock"))
}

pub fn start_control_server(tx: channel::Sender<CefToCompositor>) -> Result<PathBuf, String> {
    let path = default_socket_path()?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let thread_path = path.clone();
    std::thread::Builder::new()
        .name("derp-control".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let tx = tx.clone();
                        std::thread::Builder::new()
                            .name("derp-control-client".into())
                            .spawn(move || {
                                handle_client(stream, tx);
                            })
                            .ok();
                    }
                    Err(e) => tracing::warn!(target: "derp_control", ?e, path = %thread_path.display(), "control accept failed"),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(path)
}

fn handle_client(mut stream: UnixStream, tx: channel::Sender<CefToCompositor>) {
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(e) => {
            let _ = writeln!(stream, "{}", error_reply(Value::Null, "io", e.to_string()));
            return;
        }
    };
    let mut reader = BufReader::new(reader_stream);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let request = match parse_request(trimmed) {
                    Ok(request) => request,
                    Err(message) => {
                        let _ = writeln!(stream, "{}", error_reply(Value::Null, "parse", message));
                        continue;
                    }
                };
                if request.method == "events.subscribe" {
                    handle_subscribe(stream, tx, request);
                    break;
                }
                let id = request.id.clone();
                let response = match run_on_compositor(&tx, move |state| {
                    let result = apply_request(state, request);
                    state.control_publish_if_changed();
                    result
                }) {
                    Ok(Ok(result)) => ok_reply(id, result),
                    Ok(Err(message)) => error_reply(id, "request", message),
                    Err(message) => error_reply(id, "transport", message),
                };
                if writeln!(stream, "{response}").is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn handle_subscribe(
    mut stream: UnixStream,
    tx: channel::Sender<CefToCompositor>,
    request: ControlRequest,
) {
    let id = request.id.clone();
    let result = run_on_compositor(&tx, move |state| {
        let domains = ControlDomains::from_params(request.params.as_ref())?;
        let revisions = state.control_revision_snapshot();
        let snapshot = state.control_state_value(domains)?;
        let rx = state.control_event_hub.subscribe(domains, revisions);
        let line = json!({
            "event": "snapshot",
            "revision": revisions.overall(),
            "domains": domains.names(),
            "state": snapshot,
        })
        .to_string();
        Ok((line, rx))
    });
    match result {
        Ok(Ok((snapshot, rx))) => {
            if writeln!(stream, "{snapshot}").is_err() {
                return;
            }
            for line in rx {
                if writeln!(stream, "{line}").is_err() {
                    break;
                }
            }
        }
        Ok(Err(message)) => {
            let _ = writeln!(stream, "{}", error_reply(id, "request", message));
        }
        Err(message) => {
            let _ = writeln!(stream, "{}", error_reply(id, "transport", message));
        }
    }
}

fn parse_request(line: &str) -> Result<ControlRequest, String> {
    serde_json::from_str(line).map_err(|e| e.to_string())
}

fn run_on_compositor<T: Send + 'static>(
    tx: &channel::Sender<CefToCompositor>,
    f: impl FnOnce(&mut CompositorState) -> T + Send + 'static,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    tx.send(CefToCompositor::Run(Box::new(move |state| {
        let _ = reply_tx.send(f(state));
    })))
    .map_err(|_| "compositor event loop is unavailable".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "compositor request timed out".to_string())
}

fn ok_reply(id: Value, result: Value) -> String {
    json!({ "id": id, "ok": true, "result": result }).to_string()
}

fn error_reply(id: Value, code: &str, message: String) -> String {
    json!({ "id": id, "ok": false, "error": { "code": code, "message": message } }).to_string()
}

fn apply_request(state: &mut CompositorState, request: ControlRequest) -> Result<Value, String> {
    match request.method.as_str() {
        "schema.get" => Ok(schema_json()),
        "commands.list" => Ok(commands_json()),
        "state.get" => {
            let domains = ControlDomains::from_params(request.params.as_ref())?;
            state.control_state_value(domains)
        }
        "transaction.apply" => apply_transaction(state, request.params.as_ref()),
        "window.focus" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            ensure_window(state, id)?;
            state.window_op_focus(id);
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.close" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            ensure_window(state, id)?;
            state.window_op_close(id);
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.minimize" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            ensure_window(state, id)?;
            state.window_op_minimize(id);
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.set_fullscreen" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            let enabled = bool_param(request.params.as_ref(), "enabled", true)?;
            ensure_window(state, id)?;
            state.window_op_set_fullscreen(id, enabled);
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.set_maximized" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            let enabled = bool_param(request.params.as_ref(), "enabled", true)?;
            ensure_window(state, id)?;
            state.window_op_set_maximized(id, enabled);
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.set_geometry" => {
            let params = request.params.as_ref();
            let id = required_u32(params, "window_id")?;
            let x = required_i32(params, "x")?;
            let y = required_i32(params, "y")?;
            let width = required_i32(params, "width")?.max(1);
            let height = required_i32(params, "height")?.max(1);
            let layout = string_param(params, "layout").unwrap_or_else(|| "floating".to_string());
            let mode = match layout.as_str() {
                "floating" => WindowLayoutMode::Floating,
                "maximized" => WindowLayoutMode::Maximized,
                other => return Err(format!("unknown layout mode {other}")),
            };
            ensure_window(state, id)?;
            let (ox, oy) = state.shell_canvas_logical_origin;
            state.window_op_set_geometry(
                id,
                x.saturating_sub(ox),
                y.saturating_sub(oy),
                width,
                height,
                mode,
            );
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "window.move_monitor" => {
            let id = required_u32(request.params.as_ref(), "window_id")?;
            let direction = string_param(request.params.as_ref(), "direction")
                .unwrap_or_else(|| "right".into());
            ensure_window(state, id)?;
            match direction.as_str() {
                "left" => state.super_move_window_to_adjacent_monitor(id, false)?,
                "right" => state.super_move_window_to_adjacent_monitor(id, true)?,
                other => return Err(format!("unknown direction {other}")),
            }
            state.control_bump_windows_revision();
            Ok(json!({ "accepted": true }))
        }
        "workspace.mutate" => {
            let mutation = workspace_mutation_param(request.params.as_ref())?;
            validate_workspace_mutation_json(&mutation)?;
            state.apply_workspace_mutation_json(&mutation);
            state.control_bump_workspace_revision();
            Ok(json!({ "accepted": true }))
        }
        "layout.set_monitor" => {
            let output_name = required_string(request.params.as_ref(), "output_name")?;
            let layout = required_string(request.params.as_ref(), "layout")?;
            let params = request
                .params
                .as_ref()
                .and_then(|p| p.get("params").cloned())
                .unwrap_or_else(|| json!({}));
            let output_id = state
                .workspace_output_identity_for_name(&output_name)
                .unwrap_or_default();
            let mutation = json!({
                "mutation": {
                    "type": "set_monitor_layout",
                    "outputId": output_id,
                    "outputName": output_name,
                    "layout": layout,
                    "params": params,
                }
            });
            let mutation = mutation.to_string();
            validate_workspace_mutation_json(&mutation)?;
            state.apply_workspace_mutation_json(&mutation);
            state.control_bump_workspace_revision();
            Ok(json!({ "accepted": true }))
        }
        "settings.set" => {
            let section = required_string(request.params.as_ref(), "section")?;
            let value = request
                .params
                .as_ref()
                .and_then(|p| p.get("value"))
                .cloned()
                .ok_or_else(|| "missing value".to_string())?;
            state.control_apply_settings(&section, value)?;
            Ok(json!({ "accepted": true }))
        }
        method => Err(format!("unknown method {method}")),
    }
}

fn apply_transaction(state: &mut CompositorState, params: Option<&Value>) -> Result<Value, String> {
    let actions = params
        .and_then(|p| p.get("actions"))
        .and_then(Value::as_array)
        .ok_or_else(|| "missing actions".to_string())?;
    if actions.is_empty() {
        return Err("actions must not be empty".into());
    }
    let mut results = Vec::with_capacity(actions.len());
    for (index, action) in actions.iter().enumerate() {
        let method = action
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("action {index} missing method"))?;
        if !transaction_method_allowed(method) {
            return Err(format!(
                "action {index} method {method} is not allowed in transactions"
            ));
        }
        let params = action.get("params").cloned();
        let result = apply_request(
            state,
            ControlRequest {
                id: Value::Null,
                method: method.to_string(),
                params,
            },
        )?;
        results.push(json!({ "method": method, "result": result }));
    }
    Ok(json!({ "accepted": true, "results": results }))
}

fn transaction_method_allowed(method: &str) -> bool {
    matches!(
        method,
        "window.focus"
            | "window.close"
            | "window.minimize"
            | "window.set_fullscreen"
            | "window.set_maximized"
            | "window.set_geometry"
            | "window.move_monitor"
            | "workspace.mutate"
            | "layout.set_monitor"
            | "settings.set"
    )
}

fn schema_json() -> Value {
    json!({
        "version": 1,
        "protocol": "ndjson-json-rpc-lite",
        "domains": DOMAINS,
        "methods": [
            { "method": "state.get", "params": { "domains": ["outputs", "windows", "workspace", "settings"] } },
            { "method": "events.subscribe", "params": { "domains": ["outputs", "windows", "workspace", "settings"] } },
            { "method": "window.focus", "params": { "window_id": "u32" } },
            { "method": "window.close", "params": { "window_id": "u32" } },
            { "method": "window.minimize", "params": { "window_id": "u32" } },
            { "method": "window.set_fullscreen", "params": { "window_id": "u32", "enabled": "bool" } },
            { "method": "window.set_maximized", "params": { "window_id": "u32", "enabled": "bool" } },
            { "method": "window.set_geometry", "params": { "window_id": "u32", "x": "i32", "y": "i32", "width": "i32", "height": "i32", "layout": "floating|maximized" } },
            { "method": "window.move_monitor", "params": { "window_id": "u32", "direction": "left|right" } },
            { "method": "layout.set_monitor", "params": { "output_name": "string", "layout": "manual-snap|master-stack|columns|grid|custom-auto", "params": "object" } },
            { "method": "workspace.mutate", "params": { "mutation": "WorkspaceMutation json" } },
            { "method": "settings.set", "params": { "section": "theme|keyboard|default_applications|files|scratchpads|notifications", "value": "object" } },
            { "method": "transaction.apply", "params": { "actions": [{ "method": "window.focus", "params": { "window_id": "u32" } }] } }
        ],
    })
}

fn commands_json() -> Value {
    json!({ "commands": COMMANDS })
}

fn required_u32(params: Option<&Value>, name: &str) -> Result<u32, String> {
    let value = params
        .and_then(|p| p.get(name))
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing {name}"))?;
    u32::try_from(value).map_err(|_| format!("{name} is out of range"))
}

fn required_i32(params: Option<&Value>, name: &str) -> Result<i32, String> {
    let value = params
        .and_then(|p| p.get(name))
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("missing {name}"))?;
    i32::try_from(value).map_err(|_| format!("{name} is out of range"))
}

fn required_string(params: Option<&Value>, name: &str) -> Result<String, String> {
    params
        .and_then(|p| p.get(name))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {name}"))
}

fn string_param(params: Option<&Value>, name: &str) -> Option<String> {
    params
        .and_then(|p| p.get(name))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn bool_param(params: Option<&Value>, name: &str, default: bool) -> Result<bool, String> {
    match params.and_then(|p| p.get(name)) {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| format!("{name} must be a bool")),
        None => Ok(default),
    }
}

fn workspace_mutation_param(params: Option<&Value>) -> Result<String, String> {
    let Some(params) = params else {
        return Err("missing mutation".into());
    };
    if let Some(raw) = params.get("mutation_json").and_then(Value::as_str) {
        serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())?;
        return Ok(raw.to_string());
    }
    if let Some(raw) = params.get("mutation").and_then(Value::as_str) {
        serde_json::from_str::<Value>(raw).map_err(|e| e.to_string())?;
        return Ok(raw.to_string());
    }
    let Some(value) = params.get("mutation") else {
        return Err("missing mutation".into());
    };
    Ok(value.to_string())
}

fn validate_workspace_mutation_json(raw: &str) -> Result<(), String> {
    #[derive(Deserialize)]
    struct WorkspaceMutationEnvelope {
        mutation: crate::session::workspace_model::WorkspaceMutation,
    }
    serde_json::from_str::<WorkspaceMutationEnvelope>(raw)
        .map(|envelope| {
            let _ = envelope.mutation;
        })
        .or_else(|_| {
            serde_json::from_str::<crate::session::workspace_model::WorkspaceMutation>(raw)
                .map(|_| ())
        })
        .map_err(|e| format!("invalid workspace mutation: {e}"))
}

fn ensure_window(state: &CompositorState, window_id: u32) -> Result<(), String> {
    state
        .window_registry
        .window_info(window_id)
        .map(|_| ())
        .ok_or_else(|| format!("unknown window {window_id}"))
}

impl CompositorState {
    pub(crate) fn control_revision_snapshot(&self) -> ControlRevisions {
        ControlRevisions {
            outputs: self.shell_output_topology_revision,
            windows: self
                .shell_window_domain_revision
                .max(self.window_registry.revision())
                .max(self.control_windows_revision),
            workspace: self
                .shell_workspace_revision
                .max(self.control_workspace_revision),
            settings: self.control_settings_revision,
        }
    }

    fn control_bump_windows_revision(&mut self) {
        self.control_windows_revision = self.control_windows_revision.wrapping_add(1).max(1);
    }

    fn control_bump_workspace_revision(&mut self) {
        self.control_workspace_revision = self.control_workspace_revision.wrapping_add(1).max(1);
    }

    pub(crate) fn control_state_value(&self, domains: ControlDomains) -> Result<Value, String> {
        let revisions = self.control_revision_snapshot();
        let mut state = serde_json::Map::new();
        state.insert("revision".into(), json!(revisions.overall()));
        state.insert("domains".into(), json!(domains.names()));
        if domains.outputs {
            state.insert("outputs".into(), self.control_outputs_value());
        }
        if domains.windows {
            state.insert("windows".into(), self.control_windows_value());
        }
        if domains.workspace {
            state.insert(
                "workspace".into(),
                serde_json::to_value(self.workspace_state_for_shell())
                    .map_err(|e| e.to_string())?,
            );
        }
        if domains.settings {
            state.insert("settings".into(), control_settings_value()?);
        }
        Ok(Value::Object(state))
    }

    fn control_outputs_value(&self) -> Value {
        let outputs = self
            .space
            .outputs()
            .filter_map(|output| {
                let geometry = self.space.output_geometry(output)?;
                let mode = output.current_mode();
                let name = output.name();
                let primary = self.shell_primary_output_name.as_deref() == Some(name.as_str());
                Some(json!({
                    "name": name,
                    "identity": Self::shell_output_identity(output),
                    "x": geometry.loc.x,
                    "y": geometry.loc.y,
                    "width": geometry.size.w.max(1),
                    "height": geometry.size.h.max(1),
                    "scale": output.current_scale().fractional_scale(),
                    "transform": transform_to_wire(output.current_transform()),
                    "refresh_milli_hz": mode.map(|m| m.refresh.max(1)).unwrap_or(1),
                    "primary": primary,
                }))
            })
            .collect::<Vec<_>>();
        Value::Array(outputs)
    }

    fn control_windows_value(&self) -> Value {
        let focused = self.logical_focused_window_id();
        let mut records = self.window_registry.all_records();
        records.sort_by_key(|record| record.info.window_id);
        let windows = records
            .into_iter()
            .map(|record| {
                let info = record.info;
                json!({
                    "window_id": info.window_id,
                    "surface_id": info.surface_id,
                    "kind": match record.kind { WindowKind::Native => "native", WindowKind::ShellHosted => "shell_hosted" },
                    "shell_hosted": record.kind == WindowKind::ShellHosted,
                    "title": info.title,
                    "app_id": info.app_id,
                    "wayland_client_pid": info.wayland_client_pid,
                    "x": info.x,
                    "y": info.y,
                    "width": info.width,
                    "height": info.height,
                    "output_name": info.output_name,
                    "minimized": info.minimized,
                    "maximized": info.maximized,
                    "fullscreen": info.fullscreen,
                    "focused": focused == Some(info.window_id),
                    "client_side_decoration": info.client_side_decoration,
                })
            })
            .collect::<Vec<_>>();
        Value::Array(windows)
    }

    pub fn control_publish_if_changed(&mut self) {
        if self.control_event_hub.subscribers.is_empty() {
            return;
        }
        let revisions = self.control_revision_snapshot();
        let mut subscribers = std::mem::take(&mut self.control_event_hub.subscribers);
        let mut keep = Vec::with_capacity(subscribers.len());
        for mut subscriber in subscribers.drain(..) {
            let changed = revisions
                .changed_since(subscriber.revisions)
                .intersection(subscriber.domains);
            if changed.is_empty() {
                keep.push(subscriber);
                continue;
            }
            let line = match self.control_state_value(changed) {
                Ok(state) => json!({
                    "event": "changed",
                    "revision": revisions.overall(),
                    "domains": changed.names(),
                    "state": state,
                })
                .to_string(),
                Err(message) => json!({
                    "event": "error",
                    "revision": revisions.overall(),
                    "error": { "code": "state", "message": message },
                })
                .to_string(),
            };
            subscriber.revisions = revisions;
            if subscriber.tx.send(line).is_ok() {
                keep.push(subscriber);
            }
        }
        self.control_event_hub.subscribers = keep;
    }

    pub(crate) fn control_apply_settings(
        &mut self,
        section: &str,
        value: Value,
    ) -> Result<(), String> {
        match section {
            "theme" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::ThemeSettingsFile,
                >(value)
                .map_err(|e| format!("invalid theme settings: {e}"))?;
                crate::session::settings_config::write_theme_settings(settings)?;
            }
            "keyboard" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::KeyboardSettingsFile,
                >(value)
                .map_err(|e| format!("invalid keyboard settings: {e}"))?;
                self.keyboard_apply_settings(&settings)?;
                crate::session::settings_config::write_keyboard_settings(settings)?;
            }
            "default_applications" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::DefaultApplicationsFile,
                >(value)
                .map_err(|e| format!("invalid default applications settings: {e}"))?;
                crate::session::settings_config::write_default_applications_settings(settings)?;
            }
            "files" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::FilesSettingsFile,
                >(value)
                .map_err(|e| format!("invalid files settings: {e}"))?;
                crate::session::settings_config::write_files_settings(settings)?;
            }
            "scratchpads" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::ScratchpadSettingsFile,
                >(value)
                .map_err(|e| format!("invalid scratchpad settings: {e}"))?;
                self.apply_scratchpad_settings(settings)?;
            }
            "notifications" => {
                let settings = serde_json::from_value::<
                    crate::session::settings_config::NotificationsSettingsFile,
                >(value)
                .map_err(|e| format!("invalid notifications settings: {e}"))?;
                self.notifications_set_enabled(settings.enabled)?;
                crate::session::settings_config::write_notifications_settings(settings)?;
            }
            other => return Err(format!("unknown settings section {other}")),
        }
        self.control_settings_revision = self.control_settings_revision.wrapping_add(1).max(1);
        Ok(())
    }
}

fn control_settings_value() -> Result<Value, String> {
    Ok(json!({
        "theme": serde_json::from_str::<Value>(&crate::session::settings_config::read_theme_settings_json()?).map_err(|e| e.to_string())?,
        "keyboard": serde_json::from_str::<Value>(&crate::session::settings_config::read_keyboard_settings_json()?).map_err(|e| e.to_string())?,
        "default_applications": serde_json::from_str::<Value>(&crate::session::settings_config::read_default_applications_settings_json()?).map_err(|e| e.to_string())?,
        "files": serde_json::from_str::<Value>(&crate::session::settings_config::read_files_settings_json()?).map_err(|e| e.to_string())?,
        "scratchpads": serde_json::from_str::<Value>(&crate::session::settings_config::read_scratchpad_settings_json()?).map_err(|e| e.to_string())?,
        "notifications": serde_json::to_value(crate::session::settings_config::read_notifications_settings()).map_err(|e| e.to_string())?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_parse_csv() {
        let domains = ControlDomains::parse_csv(Some("windows,workspace")).unwrap();
        assert!(!domains.outputs);
        assert!(domains.windows);
        assert!(domains.workspace);
        assert!(!domains.settings);
    }

    #[test]
    fn domains_reject_unknown() {
        assert!(ControlDomains::parse_csv(Some("windows,bogus")).is_err());
    }

    #[test]
    fn socket_path_prefers_env() {
        let path =
            default_socket_path_from_env(Some("/tmp/derp.sock".into()), Some("/run/user/1".into()))
                .unwrap();
        assert_eq!(path, PathBuf::from("/tmp/derp.sock"));
    }

    #[test]
    fn socket_path_uses_runtime_dir() {
        let path = default_socket_path_from_env(None, Some("/run/user/1".into())).unwrap();
        assert_eq!(path, PathBuf::from("/run/user/1/derp/control.sock"));
    }

    #[test]
    fn error_envelope_has_ok_false() {
        let value: Value =
            serde_json::from_str(&error_reply(json!(7), "bad", "no".into())).unwrap();
        assert_eq!(value["id"], json!(7));
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["error"]["code"], json!("bad"));
    }

    #[test]
    fn schema_contains_state_get() {
        let schema = schema_json();
        let methods = schema["methods"].as_array().unwrap();
        assert!(methods.iter().any(|m| m["method"] == "state.get"));
    }

    #[test]
    fn transaction_allows_window_mutations_only() {
        assert!(transaction_method_allowed("window.focus"));
        assert!(transaction_method_allowed("layout.set_monitor"));
        assert!(!transaction_method_allowed("state.get"));
        assert!(!transaction_method_allowed("events.subscribe"));
    }

    #[test]
    fn invalid_method_returns_error() {
        let request = parse_request(r#"{"id":1,"method":"missing"}"#).unwrap();
        assert_eq!(request.method, "missing");
    }
}
