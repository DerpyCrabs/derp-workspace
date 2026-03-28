//! Chromium Embedded Framework host: windowless (OSR) browser → [`shell_wire`] → compositor Unix socket.
//!
//! Requires a matching CEF binary distribution (see workspace README). Set `CEF_PATH` to the
//! unpack directory (Resources, locales, `libcef.so`). The binary embeds `RUNPATH` for `libcef.so`;
//! use `XDG_RUNTIME_DIR` for the compositor Unix socket.
//!
//! Ozone defaults to `headless` (see [`cef_host::ozone_platform_headless_for_osr`]) so a nested
//! compositor’s `WAYLAND_DISPLAY` does not become Chromium’s display while OSR is active; set
//! `CEF_HOST_USE_WAYLAND_PLATFORM=1` to experiment.

use std::{
    io::Write,
    os::unix::net::UnixStream,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use cef::{args::Args, rc::*, sys, *};
use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "cef_host", about = "CEF OSR → compositor shell IPC")]
struct Cli {
    /// Page URL (`file://...` to `shell/dist/index.html` or any http(s) URL).
    #[arg(long)]
    url: String,

    /// Shell IPC socket *name* under `XDG_RUNTIME_DIR` (matches compositor `--shell-ipc-socket`).
    #[arg(long, default_value = "derp-shell.sock")]
    compositor_socket: String,

    /// OSR view width in pixels.
    #[arg(long, default_value_t = 800)]
    width: i32,

    /// OSR view height in pixels.
    #[arg(long, default_value_t = 600)]
    height: i32,
}

wrap_app! {
    struct DerpApp;
    impl App {
        fn on_before_command_line_processing(
            &self,
            _process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            if let Some(cmd) = command_line {
                cmd.append_switch(Some(&CefString::from("allow-file-access-from-files")));
                if cef_host::ozone_platform_headless_for_osr() {
                    cmd.append_switch_with_value(
                        Some(&CefString::from("ozone-platform")),
                        Some(&CefString::from("headless")),
                    );
                }
                // Prefer ANGLE SwiftShader when not using the system GPU. `--disable-gpu` alone
                // often yields an all-zero OSR buffer with Ozone headless; native EGL (e.g. NVIDIA
                // in nested compositors) may also fail to create a context.
                if std::env::var("CEF_HOST_USE_GPU").as_deref() != Ok("1") {
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-gl")),
                        Some(&CefString::from("angle")),
                    );
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from("swiftshader")),
                    );
                }
            }
        }
    }
}

wrap_load_handler! {
    struct InvalidateViewOnLoad;
    impl LoadHandler {
        fn on_load_end(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _http_status_code: std::os::raw::c_int,
        ) {
            let Some(frame) = frame else {
                return;
            };
            if frame.is_main() != 1 {
                return;
            }
            let Some(browser) = browser else {
                return;
            };
            let Some(host) = browser.host() else {
                return;
            };
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

wrap_render_handler! {
    struct OsrToCompositor {
        view_w: i32,
        view_h: i32,
        ipc: Arc<Mutex<UnixStream>>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(r) = rect {
                r.x = 0;
                r.y = 0;
                r.width = self.view_w;
                r.height = self.view_h;
            }
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: std::os::raw::c_int,
            height: std::os::raw::c_int,
        ) {
            if type_ != PaintElementType::VIEW || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            let stride = width * 4;
            let len = (stride * height) as usize;
            let pix = unsafe { std::slice::from_raw_parts(buffer, len) };
            let Some(frame) =
                shell_wire::encode_frame_bgra(width as u32, height as u32, stride as u32, pix)
            else {
                return;
            };
            let mut g = self.ipc.lock().expect("ipc lock");
            let _ = g.write_all(&frame);
            let _ = g.flush();
        }
    }
}

wrap_client! {
    struct ShellClient {
        render_handler: RenderHandler,
        load_handler: LoadHandler,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render_handler.clone())
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(self.load_handler.clone())
        }
    }
}

fn main() {
    // Multiprocess bootstrap matches tauri-apps/cef-rs `examples/cefsimple` (`shared/run_main`):
    // - Touch API hash before any Cef C++ wrapper runs (binds to the loaded libcef).
    // - `execute_process` with **no** `App` — subprocesses must not construct CefApp; only the
    //   browser process calls `initialize` with `DerpApp`.
    // - Parse our CLI only in the browser process (subprocess argv has no `--url`).

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let cef_args = Args::new();
    let cmd = cef_args
        .as_cmd_line()
        .expect("cef_host: failed to build CEF command line from argv");

    let switch_type = CefString::from("type");
    let is_browser_process = cmd.has_switch(Some(&switch_type)) != 1;

    let exec_ret = execute_process(
        Some(cef_args.as_main_args()),
        None,
        std::ptr::null_mut(),
    );

    if is_browser_process {
        assert_eq!(
            exec_ret, -1,
            "cef_host: browser process expected execute_process to return -1, got {exec_ret}"
        );
    } else {
        assert!(
            exec_ret >= 0,
            "cef_host: subprocess execute_process failed with {exec_ret}"
        );
        std::process::exit(exec_ret);
    }

    let cli = Cli::parse();

    let mut settings = Settings::default();
    settings.no_sandbox = 1;
    settings.windowless_rendering_enabled = 1;
    settings.external_message_pump = 1;
    settings.log_severity = LogSeverity::INFO;

    if let Ok(exe) = std::env::current_exe() {
        if let Some(s) = exe.to_str() {
            settings.browser_subprocess_path = CefString::from(s);
        }
    }
    if let Ok(cef) = std::env::var("CEF_PATH") {
        let root = Path::new(&cef);
        settings.resources_dir_path = CefString::from(root.to_str().unwrap_or(""));
        let locales = root.join("locales");
        settings.locales_dir_path = CefString::from(locales.to_str().unwrap_or(""));
    }

    let cef_cache = cef_host::cef_user_data_dir();
    let _ = std::fs::create_dir_all(&cef_cache);
    if let Some(s) = cef_cache.to_str() {
        let s = CefString::from(s);
        settings.root_cache_path = s.clone();
        settings.cache_path = s;
    }

    let mut app = DerpApp::new();

    let init_ret = initialize(
        Some(cef_args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    if init_ret != 1 {
        let exit_code = get_exit_code();
        eprintln!(
            "cef_host: CefInitialize failed (ret={init_ret}, exit_code={exit_code}), cache={}\n\
             hints: CEF_PATH must match this build’s libcef (Resources/, locales/); \
             for singleton lock / \"Opening in existing browser session\" try CEF_HOST_CACHE_DIR=\"$(mktemp -d)\"",
            cef_cache.display()
        );
        std::process::exit(1);
    }

    let sock_path = cef_host::runtime_dir().join(&cli.compositor_socket);
    let stream = UnixStream::connect(&sock_path).unwrap_or_else(|e| {
        eprintln!("cef_host: connect {}: {e} (start compositor first)", sock_path.display());
        std::process::exit(1);
    });
    let ipc = Arc::new(Mutex::new(stream));

    let rh = OsrToCompositor::new(cli.width, cli.height, ipc);
    let lh = InvalidateViewOnLoad::new();
    let mut client = ShellClient::new(rh, lh);

    let mut window_info = WindowInfo::default();
    window_info.bounds.width = cli.width;
    window_info.bounds.height = cli.height;
    let window_info = window_info.set_as_windowless(0);

    let mut browser_settings = BrowserSettings::default();
    browser_settings.windowless_frame_rate = 60;
    // Default `BrowserSettings` is zero-initialized; `background_color == 0` is fully transparent
    // in windowless mode, so the OSR buffer stays cleared to black until (if ever) pixels are
    // composited — screenshots and the compositor look "nothing drawn".
    browser_settings.background_color = 0xFF_FF_FF_FF;

    browser_host_create_browser(
        Some(&window_info),
        Some(&mut client),
        Some(&CefString::from(cli.url.as_str())),
        Some(&browser_settings),
        None,
        None,
    );

    loop {
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(4));
    }
}

