use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct FixtureManifest {
    version: u32,
    root_dir_name: String,
    entries: Vec<FixtureEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FixtureEntryKind {
    Directory,
    Text,
    Asset,
}

#[derive(Debug, Deserialize)]
struct FixtureEntry {
    id: String,
    path: String,
    kind: FixtureEntryKind,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    asset: Option<String>,
    #[serde(default)]
    read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct FileBrowserFixturePaths {
    pub root_path: String,
    pub empty_dir: String,
    pub hidden_dir: String,
    pub nested_dir: String,
    pub hidden_file: String,
    pub hidden_dir_file: String,
    pub writable_text: String,
    pub read_only_text: String,
    pub nested_text: String,
    pub image_file: String,
    pub image_file_green: String,
    pub pdf_file: String,
    pub video_file: String,
    pub unsupported_file: String,
}

fn fixture_source_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("shell")
        .join("e2e")
        .join("fixtures")
        .join("file-browser")
}

fn fixture_manifest_path() -> PathBuf {
    fixture_source_root().join("manifest.json")
}

fn e2e_state_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    Ok(home.join(".local").join("state").join("derp").join("e2e"))
}

fn generated_fixture_root(manifest: &FixtureManifest) -> Result<PathBuf, String> {
    Ok(e2e_state_root()?
        .join("file-browser-fixtures")
        .join(&manifest.root_dir_name))
}

fn validate_relative_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if path.as_os_str().is_empty() {
        return Err(format!("{label}: path is empty"));
    }
    if path.is_absolute() {
        return Err(format!("{label}: path must be relative"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("{label}: path contains unsupported components")),
        }
    }
    Ok(path)
}

fn read_manifest() -> Result<FixtureManifest, String> {
    let manifest_path = fixture_manifest_path();
    let body = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read fixture manifest {}: {e}", manifest_path.display()))?;
    serde_json::from_str(&body)
        .map_err(|e| format!("parse fixture manifest {}: {e}", manifest_path.display()))
}

fn write_fixture_file(path: &Path, bytes: &[u8], read_only: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create fixture parent {}: {e}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|e| format!("write fixture file {}: {e}", path.display()))?;
    if read_only {
        let metadata =
            fs::metadata(path).map_err(|e| format!("stat fixture file {}: {e}", path.display()))?;
        let mut permissions = metadata.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o444);
        }
        #[cfg(not(unix))]
        {
            permissions.set_readonly(true);
        }
        fs::set_permissions(path, permissions)
            .map_err(|e| format!("set fixture permissions {}: {e}", path.display()))?;
    }
    Ok(())
}

fn read_asset_bytes(asset_relative_path: &str) -> Result<Vec<u8>, String> {
    let asset_relative_path = validate_relative_path(asset_relative_path, "fixture asset")?;
    let asset_path = fixture_source_root().join(&asset_relative_path);
    let encoded = fs::read_to_string(&asset_path)
        .map_err(|e| format!("read fixture asset {}: {e}", asset_path.display()))?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("decode fixture asset {}: {e}", asset_path.display()))
}

fn canonical_path_string(abs: &Path) -> Result<String, String> {
    abs.canonicalize()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("canonicalize {}: {error}", abs.display()))
}

fn collect_fixture_paths(
    root: &Path,
    entries: &[FixtureEntry],
) -> Result<FileBrowserFixturePaths, String> {
    let mut by_id = BTreeMap::new();
    for entry in entries {
        let relative_path =
            validate_relative_path(&entry.path, &format!("fixture entry {}", entry.id))?;
        let abs = root.join(relative_path);
        by_id.insert(entry.id.clone(), canonical_path_string(&abs)?);
    }
    let required = |id: &str| {
        by_id
            .get(id)
            .cloned()
            .ok_or_else(|| format!("fixture manifest missing required id {id}"))
    };
    Ok(FileBrowserFixturePaths {
        root_path: canonical_path_string(root)?,
        empty_dir: required("empty_dir")?,
        hidden_dir: required("hidden_dir")?,
        nested_dir: required("nested_dir")?,
        hidden_file: required("hidden_file")?,
        hidden_dir_file: required("hidden_dir_file")?,
        writable_text: required("writable_text")?,
        read_only_text: required("read_only_text")?,
        nested_text: required("nested_text")?,
        image_file: required("image_file")?,
        image_file_green: required("image_file_green")?,
        pdf_file: required("pdf_file")?,
        video_file: required("video_file")?,
        unsupported_file: required("unsupported_file")?,
    })
}

fn recreate_fixture_tree() -> Result<FileBrowserFixturePaths, String> {
    let manifest = read_manifest()?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported fixture manifest version {}",
            manifest.version
        ));
    }
    let root = generated_fixture_root(&manifest)?;
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|e| format!("remove existing fixture root {}: {e}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .map_err(|e| format!("create fixture root {}: {e}", root.display()))?;
    for entry in &manifest.entries {
        let relative_path =
            validate_relative_path(&entry.path, &format!("fixture entry {}", entry.id))?;
        let target_path = root.join(&relative_path);
        match entry.kind {
            FixtureEntryKind::Directory => {
                fs::create_dir_all(&target_path).map_err(|e| {
                    format!("create fixture directory {}: {e}", target_path.display())
                })?;
            }
            FixtureEntryKind::Text => {
                let text = entry
                    .text
                    .as_deref()
                    .ok_or_else(|| format!("fixture entry {} is missing text", entry.id))?;
                write_fixture_file(&target_path, text.as_bytes(), entry.read_only)?;
            }
            FixtureEntryKind::Asset => {
                let asset = entry
                    .asset
                    .as_deref()
                    .ok_or_else(|| format!("fixture entry {} is missing asset", entry.id))?;
                let bytes = read_asset_bytes(asset)?;
                write_fixture_file(&target_path, &bytes, entry.read_only)?;
            }
        }
    }
    collect_fixture_paths(&root, &manifest.entries)
}

pub(crate) fn prepare_file_browser_fixtures_json() -> Result<String, String> {
    serde_json::to_string(&recreate_fixture_tree()?)
        .map_err(|e| format!("serialize file browser fixtures: {e}"))
}

pub(crate) fn reset_file_browser_fixtures_json() -> Result<String, String> {
    serde_json::to_string(&recreate_fixture_tree()?)
        .map_err(|e| format!("serialize file browser fixtures: {e}"))
}
