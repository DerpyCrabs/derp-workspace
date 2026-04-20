use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Debug)]
pub(crate) struct FileBrowserHttpError {
    pub status: u16,
    pub body: String,
    pub content_range_total: Option<u64>,
}

#[derive(Serialize)]
struct FileBrowserErrorResponse {
    error: FileBrowserErrorDetail,
}

#[derive(Serialize)]
struct FileBrowserErrorDetail {
    code: &'static str,
    message: String,
    path: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct FileBrowserRootEntry {
    pub label: String,
    pub path: String,
    pub kind: &'static str,
}

#[derive(Serialize)]
pub(crate) struct FileBrowserRootsResponse {
    pub roots: Vec<FileBrowserRootEntry>,
}

#[derive(Serialize)]
pub(crate) struct FileBrowserEntry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub hidden: bool,
    pub symlink: bool,
    pub writable: Option<bool>,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

#[derive(Serialize)]
pub(crate) struct FileBrowserListResponse {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<FileBrowserEntry>,
}

#[derive(Serialize)]
pub(crate) struct FileBrowserStatResponse {
    pub entry: FileBrowserEntry,
}

fn http_error(
    status: u16,
    code: &'static str,
    message: impl Into<String>,
    path: Option<&Path>,
) -> FileBrowserHttpError {
    let body = serde_json::to_string(&FileBrowserErrorResponse {
        error: FileBrowserErrorDetail {
            code,
            message: message.into(),
            path: path.map(|value| value.to_string_lossy().into_owned()),
        },
    })
    .unwrap_or_else(|_| {
        format!(
            r#"{{"error":{{"code":"{code}","message":"failed to serialize error","path":null}}}}"#
        )
    });
    FileBrowserHttpError {
        status,
        body,
        content_range_total: None,
    }
}

fn canonicalize_existing_path(raw_path: &str) -> Result<PathBuf, FileBrowserHttpError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(http_error(400, "invalid_path", "path is required", None));
    }
    let path = PathBuf::from(trimmed);
    path.canonicalize().map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => 404,
            std::io::ErrorKind::PermissionDenied => 403,
            _ => 500,
        };
        http_error(
            status,
            code,
            format!("failed to access {}: {error}", path.display()),
            Some(&path),
        )
    })
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn hidden_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.starts_with('.'))
        .unwrap_or(false)
}

fn writable_flag(path: &Path, metadata: &fs::Metadata) -> Option<bool> {
    if metadata.permissions().readonly() {
        return Some(false);
    }
    if metadata.is_dir() {
        return Some(fs::read_dir(path).is_ok());
    }
    Some(true)
}

fn classify_entry(
    path: &Path,
    symlink_metadata: &fs::Metadata,
) -> (&'static str, bool, Option<fs::Metadata>) {
    let symlink = symlink_metadata.file_type().is_symlink();
    if !symlink {
        if symlink_metadata.is_dir() {
            return ("directory", false, None);
        }
        if symlink_metadata.is_file() {
            return ("file", false, None);
        }
        return ("other", false, None);
    }
    match fs::metadata(path) {
        Ok(target_metadata) => {
            if target_metadata.is_dir() {
                ("directory", true, Some(target_metadata))
            } else if target_metadata.is_file() {
                ("file", true, Some(target_metadata))
            } else {
                ("other", true, Some(target_metadata))
            }
        }
        Err(_) => ("other", true, None),
    }
}

fn build_entry(path: &Path) -> Result<FileBrowserEntry, FileBrowserHttpError> {
    let symlink_metadata = fs::symlink_metadata(path).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => 404,
            std::io::ErrorKind::PermissionDenied => 403,
            _ => 500,
        };
        http_error(
            status,
            code,
            format!("failed to stat {}: {error}", path.display()),
            Some(path),
        )
    })?;
    let (kind, symlink, target_metadata) = classify_entry(path, &symlink_metadata);
    let effective_metadata = target_metadata.as_ref().unwrap_or(&symlink_metadata);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    Ok(FileBrowserEntry {
        path: path.to_string_lossy().into_owned(),
        name,
        kind,
        hidden: hidden_name(path),
        symlink,
        writable: writable_flag(path, effective_metadata),
        size: if effective_metadata.is_file() {
            Some(effective_metadata.len())
        } else {
            None
        },
        modified_ms: modified_ms(effective_metadata),
    })
}

fn standard_root_candidates() -> Vec<FileBrowserRootEntry> {
    let mut entries = Vec::new();
    let mut push = |label: &str, kind: &'static str, path: Option<PathBuf>| {
        let Some(path) = path else {
            return;
        };
        if !path.is_absolute() || !path.exists() {
            return;
        }
        entries.push(FileBrowserRootEntry {
            label: label.to_string(),
            path: path.to_string_lossy().into_owned(),
            kind,
        });
    };
    push("Home", "home", dirs::home_dir());
    push("Desktop", "desktop", dirs::desktop_dir());
    push("Documents", "documents", dirs::document_dir());
    push("Downloads", "downloads", dirs::download_dir());
    push("Pictures", "pictures", dirs::picture_dir());
    push("Videos", "videos", dirs::video_dir());
    entries.push(FileBrowserRootEntry {
        label: "Computer".to_string(),
        path: "/".to_string(),
        kind: "computer",
    });
    entries
}

fn decode_mount_path(input: &str) -> PathBuf {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let slice = &input[index + 1..index + 4];
            if let Ok(value) = u8::from_str_radix(slice, 8) {
                out.push(char::from(value));
                index += 4;
                continue;
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    PathBuf::from(out)
}

fn mounted_volume_roots() -> Vec<FileBrowserRootEntry> {
    let Ok(body) = fs::read_to_string("/proc/mounts") else {
        return Vec::new();
    };
    let ignored_types = [
        "proc",
        "sysfs",
        "tmpfs",
        "devtmpfs",
        "devpts",
        "cgroup",
        "cgroup2",
        "overlay",
        "squashfs",
        "nsfs",
        "mqueue",
        "tracefs",
        "fusectl",
        "securityfs",
        "pstore",
        "debugfs",
        "configfs",
        "ramfs",
        "autofs",
    ];
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let _source = parts.next();
        let Some(raw_mount_path) = parts.next() else {
            continue;
        };
        let Some(fs_type) = parts.next() else {
            continue;
        };
        if ignored_types.contains(&fs_type) {
            continue;
        }
        let mount_path = decode_mount_path(raw_mount_path);
        if mount_path == Path::new("/") || !mount_path.is_absolute() || !mount_path.exists() {
            continue;
        }
        let mount_str = mount_path.to_string_lossy();
        if !mount_str.starts_with("/mnt/")
            && !mount_str.starts_with("/media/")
            && !mount_str.starts_with("/run/media/")
        {
            continue;
        }
        if !seen.insert(mount_path.clone()) {
            continue;
        }
        let label = mount_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| mount_path.to_string_lossy().into_owned());
        out.push(FileBrowserRootEntry {
            label,
            path: mount_path.to_string_lossy().into_owned(),
            kind: "mount",
        });
    }
    out
}

pub(crate) fn file_browser_roots_json() -> Result<String, String> {
    let mut roots = standard_root_candidates();
    let mut seen = BTreeSet::new();
    roots.retain(|entry| seen.insert(entry.path.clone()));
    for mount in mounted_volume_roots() {
        if seen.insert(mount.path.clone()) {
            roots.push(mount);
        }
    }
    serde_json::to_string(&FileBrowserRootsResponse { roots })
        .map_err(|error| format!("serialize file browser roots: {error}"))
}

pub(crate) fn file_browser_list_directory_json(
    raw_path: &str,
    include_hidden: bool,
) -> Result<String, FileBrowserHttpError> {
    let canonical = canonicalize_existing_path(raw_path)?;
    if !canonical.is_dir() {
        return Err(http_error(
            400,
            "not_directory",
            format!("path is not a directory: {}", canonical.display()),
            Some(&canonical),
        ));
    }
    let read_dir = fs::read_dir(&canonical).map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::PermissionDenied {
            403
        } else {
            500
        };
        let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
            "permission_denied"
        } else {
            "io_error"
        };
        http_error(
            status,
            code,
            format!("failed to list {}: {error}", canonical.display()),
            Some(&canonical),
        )
    })?;
    let mut entries = Vec::new();
    for row in read_dir {
        let row = row.map_err(|error| {
            http_error(
                500,
                "io_error",
                format!(
                    "failed to read directory entry in {}: {error}",
                    canonical.display()
                ),
                Some(&canonical),
            )
        })?;
        let entry_path = row.path();
        if !include_hidden && hidden_name(&entry_path) {
            continue;
        }
        entries.push(build_entry(&entry_path)?);
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "directory";
        let b_dir = b.kind == "directory";
        b_dir
            .cmp(&a_dir)
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
            .then_with(|| a.path.cmp(&b.path))
    });
    let response = FileBrowserListResponse {
        path: canonical.to_string_lossy().into_owned(),
        parent_path: canonical
            .parent()
            .map(|value| value.to_string_lossy().into_owned()),
        entries,
    };
    serde_json::to_string(&response).map_err(|error| {
        http_error(
            500,
            "io_error",
            format!("serialize list response: {error}"),
            Some(&canonical),
        )
    })
}

pub(crate) fn file_browser_stat_path_json(raw_path: &str) -> Result<String, FileBrowserHttpError> {
    let canonical = canonicalize_existing_path(raw_path)?;
    let response = FileBrowserStatResponse {
        entry: build_entry(&canonical)?,
    };
    serde_json::to_string(&response).map_err(|error| {
        http_error(
            500,
            "io_error",
            format!("serialize stat response: {error}"),
            Some(&canonical),
        )
    })
}

const FILE_BROWSER_READ_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn content_type_for_file_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "heic" | "heif" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

pub(crate) fn file_browser_read_file_bytes(raw_path: &str) -> Result<(Vec<u8>, &'static str), FileBrowserHttpError> {
    let canonical = canonicalize_existing_path(raw_path)?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => 404,
            std::io::ErrorKind::PermissionDenied => 403,
            _ => 500,
        };
        http_error(
            status,
            code,
            format!("failed to stat {}: {error}", canonical.display()),
            Some(&canonical),
        )
    })?;
    if !metadata.is_file() {
        return Err(http_error(
            400,
            "not_file",
            format!("path is not a regular file: {}", canonical.display()),
            Some(&canonical),
        ));
    }
    let len = metadata.len();
    if len > FILE_BROWSER_READ_MAX_BYTES {
        return Err(http_error(
            413,
            "too_large",
            format!("file exceeds {} bytes", FILE_BROWSER_READ_MAX_BYTES),
            Some(&canonical),
        ));
    }
    let bytes = fs::read(&canonical).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        let status = if error.kind() == std::io::ErrorKind::PermissionDenied {
            403
        } else {
            500
        };
        http_error(
            status,
            code,
            format!("failed to read {}: {error}", canonical.display()),
            Some(&canonical),
        )
    })?;
    let content_type = content_type_for_file_path(&canonical);
    Ok((bytes, content_type))
}

fn video_content_type_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogg" => Some("video/ogg"),
        "mov" => Some("video/quicktime"),
        "avi" => Some("video/x-msvideo"),
        "mkv" => Some("video/x-matroska"),
        "m4v" => Some("video/x-m4v"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParsedVideoRange {
    Full,
    Partial { start: u64, end_inclusive: u64 },
    Unsatisfiable,
}

fn parse_video_range_header(range_header: Option<&str>, total: u64) -> ParsedVideoRange {
    let Some(raw) = range_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return ParsedVideoRange::Full;
    };
    let lower = raw.to_ascii_lowercase();
    if !lower.starts_with("bytes=") {
        return ParsedVideoRange::Full;
    }
    let spec = raw.get(6..).unwrap_or("").trim();
    let first = spec.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        return ParsedVideoRange::Full;
    }
    let Some((left, right)) = first.split_once('-') else {
        return ParsedVideoRange::Full;
    };
    let left = left.trim();
    let right = right.trim();
    if total == 0 {
        return ParsedVideoRange::Unsatisfiable;
    }
    let last = total - 1;
    if left.is_empty() {
        let Ok(suffix_len) = right.parse::<u64>() else {
            return ParsedVideoRange::Full;
        };
        if suffix_len == 0 {
            return ParsedVideoRange::Full;
        }
        let start = total.saturating_sub(suffix_len);
        return ParsedVideoRange::Partial {
            start,
            end_inclusive: last,
        };
    }
    let Ok(start) = left.parse::<u64>() else {
        return ParsedVideoRange::Full;
    };
    if start >= total {
        return ParsedVideoRange::Unsatisfiable;
    }
    let end_inclusive = if right.is_empty() {
        last
    } else {
        let Ok(end) = right.parse::<u64>() else {
            return ParsedVideoRange::Full;
        };
        end.min(last)
    };
    if end_inclusive < start {
        return ParsedVideoRange::Unsatisfiable;
    }
    ParsedVideoRange::Partial {
        start,
        end_inclusive,
    }
}

pub(crate) struct FileBrowserVideoStream {
    pub status: u16,
    pub content_type: &'static str,
    pub total_len: u64,
    pub send_start: u64,
    pub send_end_inclusive: u64,
    pub file: File,
}

impl FileBrowserVideoStream {
    pub fn body_len(&self) -> u64 {
        if self.total_len == 0 {
            return 0;
        }
        self.send_end_inclusive
            .saturating_sub(self.send_start)
            .saturating_add(1)
    }
}

pub(crate) fn file_browser_open_video_stream(
    raw_path: &str,
    range_header: Option<&str>,
) -> Result<FileBrowserVideoStream, FileBrowserHttpError> {
    let canonical = canonicalize_existing_path(raw_path)?;
    let symlink_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io_error",
        };
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => 404,
            std::io::ErrorKind::PermissionDenied => 403,
            _ => 500,
        };
        http_error(
            status,
            code,
            format!("failed to stat {}: {error}", canonical.display()),
            Some(&canonical),
        )
    })?;
    if !symlink_metadata.is_file() {
        return Err(http_error(
            400,
            "not_file",
            format!("path is not a regular file: {}", canonical.display()),
            Some(&canonical),
        ));
    }
    let Some(content_type) = video_content_type_for_path(&canonical) else {
        return Err(http_error(
            415,
            "not_video",
            "file extension is not a supported video type",
            Some(&canonical),
        ));
    };
    let total_len = symlink_metadata.len();
    let parsed = parse_video_range_header(range_header, total_len);
    let file = File::open(&canonical).map_err(|error| {
        http_error(
            500,
            "io_error",
            format!("failed to open {}: {error}", canonical.display()),
            Some(&canonical),
        )
    })?;
    match parsed {
        ParsedVideoRange::Unsatisfiable => {
            let body = serde_json::to_string(&FileBrowserErrorResponse {
                error: FileBrowserErrorDetail {
                    code: "range_not_satisfiable",
                    message: "range not satisfiable".into(),
                    path: Some(canonical.to_string_lossy().into_owned()),
                },
            })
            .unwrap_or_else(|_| {
                r#"{"error":{"code":"range_not_satisfiable","message":"range not satisfiable","path":null}}"#
                    .into()
            });
            return Err(FileBrowserHttpError {
                status: 416,
                body,
                content_range_total: Some(total_len),
            });
        }
        ParsedVideoRange::Full => Ok(FileBrowserVideoStream {
            status: 200,
            content_type,
            total_len,
            send_start: 0,
            send_end_inclusive: if total_len == 0 {
                0
            } else {
                total_len - 1
            },
            file,
        }),
        ParsedVideoRange::Partial {
            start,
            end_inclusive,
        } => Ok(FileBrowserVideoStream {
            status: 206,
            content_type,
            total_len,
            send_start: start,
            send_end_inclusive: end_inclusive,
            file,
        }),
    }
}

#[cfg(test)]
mod video_stream_tests {
    use super::*;

    #[test]
    fn parse_range_full_when_missing() {
        assert!(matches!(
            parse_video_range_header(None, 100),
            ParsedVideoRange::Full
        ));
    }

    #[test]
    fn parse_range_suffix() {
        match parse_video_range_header(Some("bytes=-10"), 100) {
            ParsedVideoRange::Partial {
                start,
                end_inclusive,
            } => {
                assert_eq!(start, 90);
                assert_eq!(end_inclusive, 99);
            }
            _ => panic!("expected partial"),
        }
    }

    #[test]
    fn parse_range_open_end() {
        match parse_video_range_header(Some("bytes=10-"), 100) {
            ParsedVideoRange::Partial {
                start,
                end_inclusive,
            } => {
                assert_eq!(start, 10);
                assert_eq!(end_inclusive, 99);
            }
            _ => panic!("expected partial"),
        }
    }

    #[test]
    fn parse_range_closed() {
        match parse_video_range_header(Some("bytes=0-9"), 100) {
            ParsedVideoRange::Partial {
                start,
                end_inclusive,
            } => {
                assert_eq!(start, 0);
                assert_eq!(end_inclusive, 9);
            }
            _ => panic!("expected partial"),
        }
    }

    #[test]
    fn parse_range_unsat_when_start_past_end() {
        assert!(matches!(
            parse_video_range_header(Some("bytes=1000-"), 100),
            ParsedVideoRange::Unsatisfiable
        ));
    }
}
