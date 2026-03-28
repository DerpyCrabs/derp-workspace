//! Regression: `cef_host` must call CEF `execute_process` before `clap` parses argv.
//! Chromium subprocesses reuse the same binary with flags like `--type=gpu-process` and no `--url`.
//! If `Cli::parse()` runs first, clap exits with "required arguments were not provided: --url".
//!
//! This needs a built `libcef.so` (same as `cargo build -p cef_host`). Ignored by default so
//! `cargo test` stays usable without CEF. In CI or locally with a CEF build:
//!   RUN_CEF_INTEGRATION=1 cargo test -p cef_host --test subprocess_argv -- --ignored

use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("cef_host crate should live under workspace/")
        .to_path_buf()
}

fn find_libcef_so() -> Option<PathBuf> {
    let target = workspace_root().join("target");
    for profile in ["debug", "release"] {
        let build_dir = target.join(profile).join("build");
        let Ok(entries) = std::fs::read_dir(&build_dir) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with("cef-dll-sys-") {
                continue;
            }
            let out = e.path().join("out");
            let Ok(outs) = std::fs::read_dir(&out) else {
                continue;
            };
            for o in outs.flatten() {
                let lib = o.path().join("libcef.so");
                if lib.is_file() {
                    return Some(lib);
                }
            }
        }
    }
    None
}

#[test]
#[ignore = "needs libcef + explicit opt-in; run: RUN_CEF_INTEGRATION=1 cargo test -p cef_host --test subprocess_argv -- --ignored"]
fn chromium_subprocess_argv_is_not_rejected_by_clap_before_cef() {
    assert_eq!(
        std::env::var("RUN_CEF_INTEGRATION").ok().as_deref(),
        Some("1"),
        "set RUN_CEF_INTEGRATION=1 when running this test with --ignored"
    );

    let Some(libcef) = find_libcef_so() else {
        panic!(
            "libcef.so not found under target/*/build/cef-dll-sys-*/out/; run: cargo build -p cef_host"
        );
    };
    let cef_dir = libcef
        .parent()
        .expect("libcef.so in directory")
        .to_path_buf();

    let exe = PathBuf::from(env!("CARGO_BIN_EXE_cef_host"));

    let ld = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let ld = if ld.is_empty() {
        cef_dir.display().to_string()
    } else {
        format!("{}:{}", cef_dir.display(), ld)
    };

    // Typical helper-process invocation (argv subset); must not fail in clap before CEF runs.
    let out = Command::new(&exe)
        .env("LD_LIBRARY_PATH", &ld)
        .env("CEF_PATH", &cef_dir)
        .args([
            "--type=gpu-process",
            "--no-sandbox",
            "--headless=new",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ])
        .output()
        .expect("spawn cef_host");

    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("required arguments were not provided") && stderr.contains("--url") {
        panic!(
            "clap ran before CEF execute_process handled subprocess argv (regression).\nstderr:\n{stderr}"
        );
    }
}
