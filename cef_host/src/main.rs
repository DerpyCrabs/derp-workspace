mod compositor_downlink;
mod control_server;
mod desktop_apps;
mod shell_uplink;

use std::{
    io::{self, Read},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, Once,
    },
    thread,
    time::{Duration, Instant},
};

use cef::{args::Args, rc::*, sys, *};
use clap::Parser;
#[cfg(unix)]
use signal_hook::{consts::SIGINT, consts::SIGTERM, flag};

use cef_host::osr_view_state::{
    OsrViewState, OSR_BOOTSTRAP_LOGICAL_HEIGHT, OSR_BOOTSTRAP_LOGICAL_WIDTH,
};

#[cfg(unix)]
static SHELL_USE_ACCELERATED_FRAMES: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
fn cef_color_to_drm_format(ct: ColorType) -> u32 {
    use drm_fourcc::DrmFourcc;
    if ct == ColorType::BGRA_8888 {
        DrmFourcc::Argb8888 as u32
    } else if ct == ColorType::RGBA_8888 {
        DrmFourcc::Abgr8888 as u32
    } else {
        DrmFourcc::Argb8888 as u32
    }
}

#[cfg(unix)]
static FIRST_ACCELERATED_PAINT_LOG: Once = Once::new();

#[derive(Parser, Debug)]
#[command(name = "cef_host", about = "CEF OSR → compositor shell IPC")]
struct Cli {
    #[arg(value_name = "URL")]
    url: String,
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
                cmd.append_switch(Some(&CefString::from("no-sandbox")));
                cmd.append_switch(Some(&CefString::from("allow-file-access-from-files")));
                cmd.append_switch(Some(&CefString::from("ignore-gpu-blocklist")));
                cmd.append_switch(Some(&CefString::from("enable-gpu-rasterization")));
                cmd.append_switch(Some(&CefString::from("enable-native-gpu-memory-buffers")));
                cmd.append_switch(Some(&CefString::from("disable-gpu-sandbox")));
                cmd.append_switch(Some(&CefString::from(
                    "disable-gpu-memory-buffer-video-frames",
                )));
                #[cfg(target_os = "linux")]
                {
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from("gl-egl")),
                    );
                    cmd.append_switch_with_value(
                        Some(&CefString::from("ozone-platform")),
                        Some(&CefString::from("wayland")),
                    );
                }
                #[cfg(not(target_os = "linux"))]
                {
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from(cef_host::angle_backend_for_osr())),
                    );
                }
                cmd.append_switch(Some(&CefString::from("in-process-gpu")));
            }
        }

        fn render_process_handler(&self) -> Option<RenderProcessHandler> {
            Some(shell_uplink::DerpRenderProcessHandler::new())
        }
    }
}

wrap_load_handler! {
    struct ShellLoadHandler {
        spawn_inject_js: Option<String>,
    }

    impl LoadHandler {
        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            let main = frame.map(|f| f.is_main() == 1).unwrap_or(false);
            let text = error_text.map(ToString::to_string).unwrap_or_default();
            let url = failed_url.map(ToString::to_string).unwrap_or_default();
            eprintln!(
                "cef_host: on_load_error (main_frame={main}) code={} text={text:?} url={url:?}",
                error_code.get_raw(),
            );
        }

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
            if let Some(ref js) = self.spawn_inject_js {
                frame.execute_java_script(
                    Some(&CefString::from(js.as_str())),
                    Some(&CefString::from("https://derp/spawn-url.js")),
                    0,
                );
            }
            let Some(browser) = browser else {
                return;
            };
            let Some(host) = browser.host() else {
                return;
            };
            host.notify_screen_info_changed();
            host.set_focus(1);
            host.invalidate(PaintElementType::VIEW);
        }
    }
}

wrap_life_span_handler! {
    struct CaptureBrowser {
        browser_holder: Arc<Mutex<Option<Browser>>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(b) = browser {
                if let Some(host) = b.host() {
                    host.set_focus(1);
                }
                if let Ok(mut g) = self.browser_holder.lock() {
                    *g = Some(b.clone());
                }
            }
        }
    }
}

wrap_render_handler! {
    struct OsrToCompositor {
        ipc: Arc<Mutex<UnixStream>>,
        view_state: Arc<Mutex<OsrViewState>>,
        frame_sink: Arc<Mutex<cef_host::frame_sink::ShellFrameSink>>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(r) = rect {
                r.x = 0;
                r.y = 0;
                let Ok(g) = self.view_state.lock() else {
                    return;
                };
                r.width = g.logical_width.max(1);
                r.height = g.logical_height.max(1);
            }
        }

        fn screen_info(
            &self,
            _browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> std::os::raw::c_int {
            let Some(si) = screen_info else {
                return 0;
            };
            let Ok(g) = self.view_state.lock() else {
                return 0;
            };
            let mut out = ScreenInfo::default();
            out.device_scale_factor = g.device_scale_factor();
            let w = g.logical_width.max(1);
            let h = g.logical_height.max(1);
            out.rect = Rect {
                x: 0,
                y: 0,
                width: w,
                height: h,
            };
            out.available_rect = out.rect.clone();
            *si = out;
            1
        }

        #[cfg(unix)]
        fn on_accelerated_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            info: Option<&AcceleratedPaintInfo>,
        ) {
            if type_ != PaintElementType::VIEW {
                return;
            }
            let Some(info) = info else {
                return;
            };
            let pc = info.plane_count as usize;
            if pc == 0 || pc > shell_wire::MAX_DMABUF_PLANES as usize {
                return;
            }
            let drm_fmt = cef_color_to_drm_format(info.format);
            let w = info.extra.coded_size.width as u32;
            let h = info.extra.coded_size.height as u32;
            FIRST_ACCELERATED_PAINT_LOG.call_once(|| {
                eprintln!(
                    "cef_host: OnAcceleratedPaint dma-buf {}x{} planes={} drm_format={:#x} modifier={:#x}",
                    w,
                    h,
                    pc,
                    drm_fmt,
                    info.modifier
                );
            });
            SHELL_USE_ACCELERATED_FRAMES.store(true, Ordering::Relaxed);
            let mut planes = Vec::with_capacity(pc);
            let mut fds: Vec<std::os::raw::c_int> = Vec::with_capacity(pc);
            for i in 0..pc {
                let p = &info.planes[i];
                planes.push(shell_wire::FrameDmabufPlane {
                    plane_idx: i as u32,
                    stride: p.stride,
                    offset: p.offset,
                });
                fds.push(p.fd);
            }
            let flags = 0u32;
            if let Err(e) = self.frame_sink.lock().expect("frame_sink").push_dmabuf_planes(
                w,
                h,
                drm_fmt,
                info.modifier,
                flags,
                &planes,
                &fds,
            ) {
                eprintln!("cef_host: dma-buf frame IPC: {e}");
            }
        }

        fn on_paint(
            &self,
            browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: std::os::raw::c_int,
            height: std::os::raw::c_int,
        ) {
            if type_ != PaintElementType::VIEW || width <= 0 || height <= 0 {
                return;
            }
            #[cfg(unix)]
            if SHELL_USE_ACCELERATED_FRAMES.load(Ordering::Relaxed) {
                return;
            }
            if buffer.is_null() {
                return;
            }
            let notify = {
                let Ok(mut g) = self.view_state.lock() else {
                    return;
                };
                let prev = g.physical_dimensions();
                g.set_physical_size(width, height);
                prev != g.physical_dimensions()
            };
            if notify {
                if let Some(b) = browser {
                    if let Some(host) = b.host() {
                        host.notify_screen_info_changed();
                    }
                }
            }
        }
    }
}

wrap_display_handler! {
    struct DerpJsConsoleDisplayHandler;

    impl DisplayHandler {
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: std::os::raw::c_int,
        ) -> std::os::raw::c_int {
            let Some(msg) = message else {
                return 0;
            };
            let text = msg.to_string();
            let src = source.map(|s| s.to_string()).unwrap_or_default();
            eprintln!(
                "cef_js_console: sev={} line={} src={src:?} msg={text}",
                level.get_raw(),
                line
            );
            0
        }
    }
}

wrap_client! {
    struct ShellClient {
        render_handler: RenderHandler,
        load_handler: LoadHandler,
        life_span_handler: LifeSpanHandler,
        compositor_ipc: Arc<Mutex<UnixStream>>,
        view_state: Arc<Mutex<OsrViewState>>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(DerpJsConsoleDisplayHandler::new())
        }

        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render_handler.clone())
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(self.load_handler.clone())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.life_span_handler.clone())
        }

        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> std::os::raw::c_int {
            if shell_uplink::on_browser_process_message(
                &self.compositor_ipc,
                _browser,
                source_process,
                message,
                Some(&self.view_state),
            ) {
                1
            } else {
                0
            }
        }
    }
}

fn main() {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let mut app = DerpApp::new();

    let cef_args = Args::new();
    let cmd = cef_args
        .as_cmd_line()
        .expect("cef_host: failed to build CEF command line from argv");

    let switch_type = CefString::from("type");
    let is_browser_process = cmd.has_switch(Some(&switch_type)) != 1;

    let exec_ret = execute_process(
        Some(cef_args.as_main_args()),
        Some(&mut app),
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

    eprintln!("cef_host: dma-buf OSR (shared texture → compositor)");
    #[cfg(target_os = "linux")]
    {
        eprintln!(
            "cef_host: forced --use-angle=gl-egl --ozone-platform=wayland DISPLAY={:?} WAYLAND_DISPLAY={:?}",
            std::env::var_os("DISPLAY"),
            std::env::var_os("WAYLAND_DISPLAY")
        );
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!(
            "cef_host: use-angle={}",
            cef_host::angle_backend_for_osr()
        );
        eprintln!("cef_host: ozone-platform not set on this target");
    }
    eprintln!("cef_host: --disable-gpu-sandbox --disable-gpu-memory-buffer-video-frames --in-process-gpu");

    let cef_path = std::env::var("CEF_PATH").ok().map(PathBuf::from);

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
    if let Some(ref root) = cef_path {
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
             hints: CEF_PATH must match this build’s libcef (Resources/, locales/)",
            cef_cache.display()
        );
        std::process::exit(1);
    }

    let sock_path = cef_host::runtime_dir().join("derp-shell.sock");
    let stream = UnixStream::connect(&sock_path).unwrap_or_else(|e| {
        eprintln!(
            "cef_host: connect {}: {e} (start compositor first)",
            sock_path.display()
        );
        std::process::exit(1);
    });
    cef_host::frame_sink::ShellFrameSink::tune_connected_stream(&stream);
    let read_stream = stream.try_clone().unwrap_or_else(|e| {
        eprintln!("cef_host: dup Unix socket for compositor→shell reads: {e}");
        std::process::exit(1);
    });
    let ipc = Arc::new(Mutex::new(stream));
    let frame_sink = Arc::new(Mutex::new(cef_host::frame_sink::ShellFrameSink::new(
        ipc.clone(),
        cef_host::runtime_dir(),
    )));

    let control_rx = control_server::start(ipc.clone());
    let port = control_rx.recv().unwrap_or_else(|_| {
        eprintln!("cef_host: control server thread exited before binding");
        std::process::exit(1);
    });
    let inject_js = format!(
        r#"window.__DERP_SPAWN_URL="http://127.0.0.1:{port}/spawn";window.__DERP_SHELL_HTTP="http://127.0.0.1:{port}";"#,
        port = port
    );

    let browser_holder: Arc<Mutex<Option<Browser>>> = Arc::new(Mutex::new(None));
    let capture = CaptureBrowser::new(browser_holder.clone());

    let (shell_ipc_tx, shell_ipc_rx) =
        mpsc::channel::<shell_wire::DecodedCompositorToShellMessage>();
    thread::spawn(move || {
        let mut read_stream = read_stream;
        let mut buf = Vec::<u8>::new();
        let mut tmp = [0u8; 8192];
        loop {
            match read_stream.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    eprintln!("cef_host: compositor socket read error: {e}");
                    break;
                }
            }
            loop {
                match shell_wire::pop_compositor_to_shell_message(&mut buf) {
                    Ok(Some(msg)) => {
                        let _ = shell_ipc_tx.send(msg);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        eprintln!(
                            "cef_host: compositor message decode error: {e:?}, dropping buffer"
                        );
                        buf.clear();
                        break;
                    }
                }
            }
        }
    });

    let view_state = Arc::new(Mutex::new(OsrViewState::new_bootstrap()));
    let rh = OsrToCompositor::new(ipc.clone(), view_state.clone(), frame_sink);
    let lh = ShellLoadHandler::new(Some(inject_js));
    let mut client = ShellClient::new(rh, lh, capture, ipc.clone(), view_state.clone());

    {
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            do_message_loop_work();
            match shell_ipc_rx.recv_timeout(Duration::from_millis(5)) {
                Ok(msg) => {
                    let is_geo = matches!(
                        &msg,
                        shell_wire::DecodedCompositorToShellMessage::OutputGeometry { .. }
                    );
                    compositor_downlink::apply_message(msg, &browser_holder, &view_state);
                    if is_geo {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        while let Ok(msg) = shell_ipc_rx.try_recv() {
            compositor_downlink::apply_message(msg, &browser_holder, &view_state);
        }
    }

    let mut window_info = WindowInfo::default();
    let (init_w, init_h) = view_state
        .lock()
        .map(|g| (g.logical_width, g.logical_height))
        .unwrap_or((OSR_BOOTSTRAP_LOGICAL_WIDTH, OSR_BOOTSTRAP_LOGICAL_HEIGHT));
    window_info.bounds.width = init_w;
    window_info.bounds.height = init_h;
    window_info.shared_texture_enabled = 1;
    let window_info = window_info.set_as_windowless(0);

    let mut browser_settings = BrowserSettings::default();
    browser_settings.windowless_frame_rate = 120;
    browser_settings.background_color = 0x0000_0000;

    browser_host_create_browser(
        Some(&window_info),
        Some(&mut client),
        Some(&CefString::from(cli.url.as_str())),
        Some(&browser_settings),
        None,
        None,
    );

    let shutdown_requested = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        if flag::register(SIGINT, Arc::clone(&shutdown_requested)).is_err()
            || flag::register(SIGTERM, Arc::clone(&shutdown_requested)).is_err()
        {
            eprintln!("cef_host: warning: could not register SIGINT/SIGTERM handlers");
        }
    }

    while !shutdown_requested.load(Ordering::Relaxed) {
        do_message_loop_work();
        let batch = cef_host::ipc_coalesce::recv_folded(&shell_ipc_rx);
        let had_ipc = !batch.is_empty();
        for msg in batch {
            if matches!(
                msg,
                shell_wire::DecodedCompositorToShellMessage::Ping
            ) {
                shell_uplink::write_shell_packet(&ipc, &shell_wire::encode_shell_pong());
                continue;
            }
            compositor_downlink::apply_message(msg, &browser_holder, &view_state);
        }
        if had_ipc {
            std::thread::sleep(Duration::from_millis(1));
        } else {
            std::thread::sleep(Duration::from_millis(4));
        }
    }

    if let Ok(g) = browser_holder.lock() {
        if let Some(ref browser) = *g {
            if let Some(host) = browser.host() {
                host.close_browser(1);
            }
        }
    }
    for _ in 0..750 {
        do_message_loop_work();
        thread::sleep(Duration::from_millis(4));
    }
    shutdown();
}
