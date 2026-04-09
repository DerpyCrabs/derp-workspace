use serde::Serialize;
use std::process::Command;

const SCHEMA: &str = "org.gnome.desktop.background";

#[derive(Serialize)]
pub struct GnomeDesktopBackground {
    pub schema: &'static str,
    pub picture_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture_uri_dark: Option<String>,
    pub picture_options: String,
    pub primary_color: String,
    pub secondary_color: String,
    pub color_shading_type: String,
}

fn trim_stdout(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

fn parse_gsettings_line(raw: &str) -> String {
    let s = raw.trim();
    if s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2 {
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut it = inner.chars().peekable();
        while let Some(c) = it.next() {
            if c == '\\' && it.peek() == Some(&'\'') {
                it.next();
                out.push('\'');
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if let Some(r) = s.strip_prefix("uint32 ") {
        return r.trim().to_string();
    }
    if let Some(r) = s.strip_prefix("int32 ") {
        return r.trim().to_string();
    }
    s.to_string()
}

fn gsettings_get(schema: &str, key: &str) -> Result<String, String> {
    let out = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .map_err(|e| format!("gsettings: {e}"))?;
    if !out.status.success() {
        let err = trim_stdout(&out.stderr);
        let hint = if err.is_empty() {
            trim_stdout(&out.stdout)
        } else {
            err
        };
        return Err(format!("gsettings get {schema} {key}: {hint}"));
    }
    Ok(parse_gsettings_line(&trim_stdout(&out.stdout)))
}

fn gsettings_get_optional(schema: &str, key: &str) -> Option<String> {
    gsettings_get(schema, key).ok().filter(|s| !s.is_empty())
}

pub fn read_gnome_desktop_background_json() -> Result<String, String> {
    let picture_uri = gsettings_get(SCHEMA, "picture-uri")?;
    let picture_options = gsettings_get(SCHEMA, "picture-options")?;
    let primary_color = gsettings_get(SCHEMA, "primary-color")?;
    let secondary_color = gsettings_get(SCHEMA, "secondary-color")?;
    let color_shading_type = gsettings_get(SCHEMA, "color-shading-type")?;
    let picture_uri_dark = gsettings_get_optional(SCHEMA, "picture-uri-dark");
    let payload = GnomeDesktopBackground {
        schema: SCHEMA,
        picture_uri,
        picture_uri_dark,
        picture_options,
        primary_color,
        secondary_color,
        color_shading_type,
    };
    serde_json::to_string(&payload).map_err(|e| e.to_string())
}
