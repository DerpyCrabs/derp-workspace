use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use cef::{args::Args, rc::*, sys, *};
use signal_hook::{consts::SIGINT, consts::SIGTERM, flag};
use smithay::reexports::calloop::channel::Sender;

use crate::cef::cef_userfree_string_to_string;
use crate::cef::bridge::ShellToCefLink;
use crate::cef::compositor_tx::CefToCompositor;
use crate::cef::frame_sink::DirectDmabufSink;
use crate::cef::osr_view_state::{
    OsrViewState, OSR_BOOTSTRAP_LOGICAL_HEIGHT, OSR_BOOTSTRAP_LOGICAL_WIDTH,
};
use crate::cef::shell_uplink;
use crate::cef::uplink::UplinkToCompositor;

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
static FIRST_ACCELERATED_PAINT_LOG: std::sync::Once = std::sync::Once::new();

#[cfg(unix)]
fn cef_dirty_rects_for_dmabuf(
    dirty_rects: Option<&[Rect]>,
    buf_w: u32,
    buf_h: u32,
) -> Option<Vec<(i32, i32, i32, i32)>> {
    let bw = buf_w as i64;
    let bh = buf_h as i64;
    let rects = dirty_rects?;
    if rects.is_empty() {
        return None;
    }
    let mut v = Vec::new();
    for r in rects {
        if r.width <= 0 || r.height <= 0 {
            continue;
        }
        let x0 = r.x as i64;
        let y0 = r.y as i64;
        let x1 = x0 + r.width as i64;
        let y1 = y0 + r.height as i64;
        let x0c = x0.clamp(0, bw);
        let y0c = y0.clamp(0, bh);
        let x1c = x1.clamp(0, bw);
        let y1c = y1.clamp(0, bh);
        if x1c <= x0c || y1c <= y0c {
            continue;
        }
        v.push((
            x0c as i32,
            y0c as i32,
            (x1c - x0c) as i32,
            (y1c - y0c) as i32,
        ));
    }
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
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
                cmd.append_switch(Some(&CefString::from("disable-gpu-vsync")));
                cmd.append_switch(Some(&CefString::from("disable-frame-rate-limit")));
                #[cfg(target_os = "linux")]
                {
                    cmd.append_switch(Some(&CefString::from("enable-media-stream")));
                    cmd.append_switch(Some(&CefString::from("enable-webrtc-pipewire-capturer")));
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from("gl-egl")),
                    );
                    cmd.append_switch_with_value(
                        Some(&CefString::from("ozone-platform")),
                        Some(&CefString::from("wayland")),
                    );
                    cmd.append_switch_with_value(
                        Some(&CefString::from("disable-features")),
                        Some(&CefString::from("WaylandFractionalScaleV1")),
                    );
                }
                #[cfg(not(target_os = "linux"))]
                {
                    cmd.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from(crate::cef::angle_backend_for_osr())),
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
        cef_tx: Sender<CefToCompositor>,
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
            tracing::warn!(
                main_frame = main,
                code = error_code.get_raw(),
                text = %text,
                url = %url,
                "cef: on_load_error"
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
            tracing::warn!(
                target: "derp_shell_boot",
                url = %cef_userfree_string_to_string(&frame.url()),
                has_inject_js = self.spawn_inject_js.is_some(),
                "cef main frame load end"
            );
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
            let _ = self.cef_tx.send(CefToCompositor::Run(Box::new(|state| {
                if let Ok(g) = state.shell_to_cef.lock() {
                    if let Some(link) = g.as_ref() {
                        link.set_delivery_ready(false);
                    }
                }
                state.shell_ipc_on_shell_load_success();
            })));
        }
    }
}

wrap_life_span_handler! {
    struct CaptureBrowser {
        browser_holder: Arc<Mutex<Option<Browser>>>,
        cef_tx: Sender<CefToCompositor>,
        handshake: Arc<AtomicBool>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(b) = browser {
                tracing::warn!(
                    target: "derp_shell_boot",
                    browser_id = b.identifier(),
                    is_popup = b.is_popup(),
                    "cef browser created"
                );
                if let Some(host) = b.host() {
                    host.set_focus(1);
                }
                if let Ok(mut g) = self.browser_holder.lock() {
                    *g = Some(b.clone());
                }
            }
            self.handshake.store(true, Ordering::SeqCst);
            let _ = self.cef_tx.send(CefToCompositor::Run(Box::new(|state| {
                if let Ok(g) = state.shell_to_cef.lock() {
                    if let Some(link) = g.as_ref() {
                        link.set_delivery_ready(false);
                    }
                }
            })));
        }
    }
}

wrap_render_handler! {
    struct OsrToCompositor {
        view_state: Arc<Mutex<OsrViewState>>,
        frame_sink: Arc<Mutex<DirectDmabufSink>>,
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
            dirty_rects: Option<&[Rect]>,
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
                tracing::debug!(
                    target: "derp_shell_osr",
                    w,
                    h,
                    planes = pc,
                    drm_format = drm_fmt,
                    modifier = info.modifier,
                    "cef: OnAcceleratedPaint dma-buf"
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
            let dirty_buffer = cef_dirty_rects_for_dmabuf(dirty_rects, w, h);
            if let Err(e) = self.frame_sink.lock().expect("frame_sink").push_dmabuf_planes(
                w,
                h,
                drm_fmt,
                info.modifier,
                flags,
                planes,
                fds,
                dirty_buffer,
            ) {
                tracing::warn!(target: "derp_shell_osr", "cef: dma-buf frame: {e}");
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
            let raw = level.get_raw();
            if raw >= LogSeverity::WARNING.get_raw() {
                tracing::warn!(
                    target: "derp_shell_js",
                    raw_sev = raw,
                    line,
                    src = %src,
                    msg = %text,
                    "cef_js_console"
                );
            } else {
                tracing::debug!(
                    target: "derp_shell_js",
                    raw_sev = raw,
                    line,
                    src = %src,
                    msg = %text,
                    "cef_js_console"
                );
            }
            0
        }
    }
}

wrap_client! {
    struct ShellClient {
        render_handler: RenderHandler,
        load_handler: LoadHandler,
        life_span_handler: LifeSpanHandler,
        uplink: UplinkToCompositor,
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
                &self.uplink,
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

pub fn maybe_run_cef_subprocess_only() -> Option<i32> {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let mut app = DerpApp::new();
    let cef_args = Args::new();
    let cmd = cef_args
        .as_cmd_line()
        .expect("cef: failed to build CEF command line from argv");
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
            "cef: browser process expected execute_process to return -1, got {exec_ret}"
        );
        None
    } else {
        assert!(
            exec_ret >= 0,
            "cef: subprocess execute_process failed with {exec_ret}"
        );
        Some(exec_ret)
    }
}

pub fn spawn_cef_ui_thread(
    url: String,
    cef_tx: Sender<CefToCompositor>,
    shell_slot: Arc<Mutex<Option<Arc<ShellToCefLink>>>>,
    handshake: Arc<AtomicBool>,
    shutdown_from_main: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        run_cef(url, cef_tx, shell_slot, handshake, shutdown_from_main);
    })
}

fn run_cef(
    url: String,
    cef_tx: Sender<CefToCompositor>,
    shell_slot: Arc<Mutex<Option<Arc<ShellToCefLink>>>>,
    handshake: Arc<AtomicBool>,
    shutdown_from_main: Arc<AtomicBool>,
) {
    tracing::debug!(target: "derp_shell_osr", "cef: dma-buf OSR (in-process)");
    #[cfg(target_os = "linux")]
    {
        tracing::debug!(
            target: "derp_shell_osr",
            display = ?std::env::var_os("DISPLAY"),
            wayland_display = ?std::env::var_os("WAYLAND_DISPLAY"),
            "cef: ANGLE/Wayland env"
        );
    }
    let cef_path = std::env::var("CEF_PATH").ok().map(PathBuf::from);

    let mut settings = Settings::default();
    settings.no_sandbox = 1;
    settings.windowless_rendering_enabled = 1;
    settings.external_message_pump = 1;
    settings.log_severity = LogSeverity::WARNING;

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

    let cef_cache = crate::cef::cef_user_data_dir();
    let _ = std::fs::create_dir_all(&cef_cache);
    if let Some(s) = cef_cache.to_str() {
        let s = CefString::from(s);
        settings.root_cache_path = s.clone();
        settings.cache_path = s;
    }

    let cef_args = Args::new();
    let mut app = DerpApp::new();
    let init_ret = initialize(
        Some(cef_args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    if init_ret != 1 {
        let exit_code = get_exit_code();
        tracing::error!(
            ret = init_ret,
            exit_code,
            cache = %cef_cache.display(),
            "cef: CefInitialize failed; CEF_PATH must match libcef (Resources/, locales/)"
        );
        return;
    }

    let browser_holder: Arc<Mutex<Option<Browser>>> = Arc::new(Mutex::new(None));
    let view_state = Arc::new(Mutex::new(OsrViewState::new_bootstrap()));
    let frame_sink = Arc::new(Mutex::new(DirectDmabufSink::new(cef_tx.clone())));
    let link = Arc::new(ShellToCefLink::new(
        browser_holder.clone(),
        view_state.clone(),
    ));
    let snapshot_path = link
        .shared_snapshot_path()
        .and_then(|path| path.to_str().map(|s| s.to_string()));
    {
        let mut g = shell_slot.lock().expect("shell_slot");
        *g = Some(link.clone());
    }
    let uplink = UplinkToCompositor::new(cef_tx.clone());
    let control_rx = crate::cef::control_server::start(uplink.clone(), browser_holder.clone());
    let inject_js = match control_rx.recv() {
        Ok(Ok(port)) => {
            let base = format!("http://127.0.0.1:{port}");
            let url_path = crate::cef::runtime_dir().join("derp-shell-http-url");
            tracing::warn!(
                target: "derp_shell_boot",
                port,
                base = %base,
                url_path = %url_path.display(),
                "cef control server bound"
            );
            match std::fs::write(&url_path, &base) {
                Ok(()) => tracing::warn!(
                    target: "derp_shell_boot",
                    base = %base,
                    url_path = %url_path.display(),
                    "wrote derp-shell-http-url"
                ),
                Err(error) => tracing::warn!(
                    target: "derp_shell_boot",
                    %error,
                    base = %base,
                    url_path = %url_path.display(),
                    "failed to write derp-shell-http-url"
                ),
            }
            let base_js = serde_json::to_string(&base).unwrap_or_else(|_| "\"\"".to_string());
            let spawn_js = serde_json::to_string(&format!("{base}/spawn"))
                .unwrap_or_else(|_| "\"\"".to_string());
            let snapshot_path_js =
                serde_json::to_string(&snapshot_path).unwrap_or_else(|_| "null".to_string());
            let exclusion_state_path_js = serde_json::to_string(
                &crate::cef::shared_state::path_for_kind(
                    crate::cef::runtime_dir(),
                    crate::cef::shared_state::SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
                ),
            )
            .unwrap_or_else(|_| "null".to_string());
            let ui_windows_state_path_js = serde_json::to_string(
                &crate::cef::shared_state::path_for_kind(
                    crate::cef::runtime_dir(),
                    crate::cef::shared_state::SHELL_SHARED_STATE_KIND_UI_WINDOWS,
                ),
            )
            .unwrap_or_else(|_| "null".to_string());
            let floating_layers_state_path_js = serde_json::to_string(
                &crate::cef::shared_state::path_for_kind(
                    crate::cef::runtime_dir(),
                    crate::cef::shared_state::SHELL_SHARED_STATE_KIND_FLOATING_LAYERS,
                ),
            )
            .unwrap_or_else(|_| "null".to_string());
            Some(format!(
                "window.__DERP_SPAWN_URL={spawn_js};window.__DERP_SHELL_HTTP={base_js};window.__DERP_COMPOSITOR_SNAPSHOT_PATH={snapshot_path_js};window.__DERP_COMPOSITOR_SNAPSHOT_ABI={};window.__DERP_SHELL_EXCLUSION_STATE_PATH={exclusion_state_path_js};window.__DERP_SHELL_UI_WINDOWS_STATE_PATH={ui_windows_state_path_js};window.__DERP_SHELL_FLOATING_LAYERS_STATE_PATH={floating_layers_state_path_js};window.__DERP_SHELL_SHARED_STATE_ABI={};",
                shell_wire::SHELL_SHARED_SNAPSHOT_ABI_VERSION,
                crate::cef::shared_state::SHELL_SHARED_STATE_ABI_VERSION,
            ))
        }
        Ok(Err(error)) => {
            tracing::error!(%error, "cef: control server failed before binding");
            None
        }
        Err(_) => {
            tracing::error!("cef: control server thread exited before binding");
            None
        }
    };
    let capture = CaptureBrowser::new(browser_holder.clone(), cef_tx.clone(), handshake.clone());
    let deadline = Instant::now() + Duration::from_millis(800);
    while !handshake.load(Ordering::SeqCst) && Instant::now() < deadline {
        do_message_loop_work();
        thread::sleep(Duration::from_millis(1));
    }
    for _ in 0..32 {
        do_message_loop_work();
    }

    let rh = OsrToCompositor::new(view_state.clone(), frame_sink);
    let lh = ShellLoadHandler::new(inject_js, cef_tx.clone());
    let mut client = ShellClient::new(rh, lh, capture, uplink.clone(), view_state.clone());

    let mut window_info = WindowInfo::default();
    let (init_w, init_h) = view_state
        .lock()
        .map(|g| (g.logical_width, g.logical_height))
        .unwrap_or((OSR_BOOTSTRAP_LOGICAL_WIDTH, OSR_BOOTSTRAP_LOGICAL_HEIGHT));
    window_info.bounds.width = init_w;
    window_info.bounds.height = init_h;
    window_info.shared_texture_enabled = 1;
    let mut window_info = window_info.set_as_windowless(0);
    window_info.external_begin_frame_enabled = 1;
    tracing::debug!(
        target: "derp_cef_begin_frame",
        "browser create: window_info.external_begin_frame_enabled=1 (compositor drives BeginFrame)"
    );

    let mut browser_settings = BrowserSettings::default();
    browser_settings.windowless_frame_rate = 60;
    browser_settings.background_color = 0x0000_0000;

    tracing::warn!(
        target: "derp_shell_boot",
        url = %url,
        init_w,
        init_h,
        "creating CEF browser"
    );
    browser_host_create_browser(
        Some(&window_info),
        Some(&mut client),
        Some(&CefString::from(url.as_str())),
        Some(&browser_settings),
        None,
        None,
    );

    let shutdown_requested = Arc::new(AtomicBool::new(false));
    if flag::register(SIGINT, Arc::clone(&shutdown_requested)).is_err()
        || flag::register(SIGTERM, Arc::clone(&shutdown_requested)).is_err()
    {
        tracing::warn!("cef: could not register SIGINT/SIGTERM handlers");
    }

    while !shutdown_requested.load(Ordering::Relaxed) && !shutdown_from_main.load(Ordering::SeqCst)
    {
        do_message_loop_work();
        thread::sleep(Duration::from_millis(if link.has_pending_shell_updates() { 1 } else { 4 }));
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
    if let Ok(mut g) = shell_slot.lock() {
        *g = None;
    }
    shutdown();
}
