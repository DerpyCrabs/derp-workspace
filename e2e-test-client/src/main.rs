use clap::Parser;
use smithay_client_toolkit::{
    activation::{ActivationHandler, ActivationState, RequestData},
    compositor::{CompositorHandler, CompositorState},
    delegate_activation, delegate_compositor, delegate_keyboard, delegate_output, delegate_pointer,
    delegate_pointer_constraints, delegate_registry, delegate_relative_pointer, delegate_seat,
    delegate_shm, delegate_touch, delegate_xdg_popup, delegate_xdg_shell, delegate_xdg_window,
    globals::ProvidesBoundGlobal,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyEvent, KeyboardHandler, Keysym, Modifiers, RawModifiers, RepeatInfo},
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        pointer_constraints::{PointerConstraintsHandler, PointerConstraintsState},
        relative_pointer::{RelativeMotionEvent, RelativePointerHandler, RelativePointerState},
        touch::TouchHandler,
        Capability, SeatHandler, SeatState,
    },
    shell::{
        xdg::{
            popup::{Popup, PopupConfigure, PopupHandler},
            window::{Window, WindowConfigure, WindowDecorations, WindowHandler},
            XdgPositioner, XdgShell, XdgSurface,
        },
        WaylandSurface,
    },
    shm::{
        slot::{Buffer, SlotPool},
        Shm, ShmHandler,
    },
};
use std::fs;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use wayland_client::{
    delegate_noop,
    globals::registry_queue_init,
    protocol::{
        wl_buffer, wl_data_device, wl_data_device_manager, wl_data_source, wl_keyboard, wl_output,
        wl_pointer, wl_seat, wl_surface, wl_touch,
    },
    Connection, Dispatch, Proxy, QueueHandle,
};
use wayland_protocols::ext::{
    image_capture_source::v1::client::{
        ext_image_capture_source_v1::ExtImageCaptureSourceV1,
        ext_output_image_capture_source_manager_v1::ExtOutputImageCaptureSourceManagerV1,
    },
    image_copy_capture::v1::client::{
        ext_image_copy_capture_frame_v1::{self, ExtImageCopyCaptureFrameV1},
        ext_image_copy_capture_manager_v1::{self, ExtImageCopyCaptureManagerV1},
        ext_image_copy_capture_session_v1::{self, ExtImageCopyCaptureSessionV1},
    },
};
use wayland_protocols::wp::{
    content_type::v1::client::{
        wp_content_type_manager_v1::WpContentTypeManagerV1, wp_content_type_v1,
    },
    cursor_shape::v1::client::{
        wp_cursor_shape_device_v1::{Shape as CursorShape, WpCursorShapeDeviceV1},
        wp_cursor_shape_manager_v1::WpCursorShapeManagerV1,
    },
    fifo::v1::client::{wp_fifo_manager_v1::WpFifoManagerV1, wp_fifo_v1::WpFifoV1},
    linux_dmabuf::zv1::client::{
        zwp_linux_buffer_params_v1, zwp_linux_dmabuf_v1::ZwpLinuxDmabufV1,
    },
    linux_drm_syncobj::v1::client::{
        wp_linux_drm_syncobj_manager_v1::WpLinuxDrmSyncobjManagerV1,
        wp_linux_drm_syncobj_surface_v1::WpLinuxDrmSyncobjSurfaceV1,
        wp_linux_drm_syncobj_timeline_v1::WpLinuxDrmSyncobjTimelineV1,
    },
    pointer_constraints::zv1::client::{
        zwp_confined_pointer_v1, zwp_locked_pointer_v1, zwp_pointer_constraints_v1,
    },
    pointer_gestures::zv1::client::{
        zwp_pointer_gesture_hold_v1, zwp_pointer_gesture_pinch_v1, zwp_pointer_gesture_swipe_v1,
        zwp_pointer_gestures_v1::ZwpPointerGesturesV1,
    },
    presentation_time::client::{wp_presentation::WpPresentation, wp_presentation_feedback},
    relative_pointer::zv1::client::zwp_relative_pointer_v1,
    tearing_control::v1::client::{
        wp_tearing_control_manager_v1::WpTearingControlManagerV1, wp_tearing_control_v1,
    },
};
use wayland_protocols::xdg::decoration::zv1::client::{
    zxdg_decoration_manager_v1::ZxdgDecorationManagerV1,
    zxdg_toplevel_decoration_v1::{
        Mode as XdgDecorationMode, Request as XdgDecorationRequest, ZxdgToplevelDecorationV1,
    },
};
use wayland_protocols::xdg::shell::client::xdg_positioner;
use wayland_protocols::xdg::toplevel_drag::v1::client::{
    xdg_toplevel_drag_manager_v1::XdgToplevelDragManagerV1, xdg_toplevel_drag_v1::XdgToplevelDragV1,
};
use wayland_protocols::xdg::toplevel_icon::v1::client::{
    xdg_toplevel_icon_manager_v1::XdgToplevelIconManagerV1, xdg_toplevel_icon_v1::XdgToplevelIconV1,
};
use wayland_protocols_misc::server_decoration::client::{
    org_kde_kwin_server_decoration::{Mode as KdeServerDecorationMode, OrgKdeKwinServerDecoration},
    org_kde_kwin_server_decoration_manager::OrgKdeKwinServerDecorationManager,
};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1::{Layer as WlrLayer, ZwlrLayerShellV1},
    zwlr_layer_surface_v1::{Anchor, Event as LayerSurfaceEvent, ZwlrLayerSurfaceV1},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointerConstraintMode {
    None,
    Lock,
    Confine,
}

impl PointerConstraintMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Ok(Self::None),
            "lock" | "locked" => Ok(Self::Lock),
            "confine" | "confined" => Ok(Self::Confine),
            other => Err(format!("unsupported --pointer-constraint value: {other}")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Lock => "lock",
            Self::Confine => "confine",
        }
    }
}

enum PointerConstraintHandle {
    Locked(zwp_locked_pointer_v1::ZwpLockedPointerV1),
    Confined(zwp_confined_pointer_v1::ZwpConfinedPointerV1),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentTypeArg {
    None,
    Photo,
    Video,
    Game,
}

impl ContentTypeArg {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Ok(Self::None),
            "photo" => Ok(Self::Photo),
            "video" => Ok(Self::Video),
            "game" => Ok(Self::Game),
            other => Err(format!("unsupported --content-type value: {other}")),
        }
    }

    fn protocol(self) -> wp_content_type_v1::Type {
        match self {
            Self::None => wp_content_type_v1::Type::None,
            Self::Photo => wp_content_type_v1::Type::Photo,
            Self::Video => wp_content_type_v1::Type::Video,
            Self::Game => wp_content_type_v1::Type::Game,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TearingHintArg {
    Vsync,
    Async,
}

impl TearingHintArg {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "vsync" => Ok(Self::Vsync),
            "async" => Ok(Self::Async),
            other => Err(format!("unsupported --tearing-hint value: {other}")),
        }
    }

    fn protocol(self) -> wp_tearing_control_v1::PresentationHint {
        match self {
            Self::Vsync => wp_tearing_control_v1::PresentationHint::Vsync,
            Self::Async => wp_tearing_control_v1::PresentationHint::Async,
        }
    }
}

impl PointerConstraintHandle {
    fn destroy(self) {
        match self {
            Self::Locked(handle) => handle.destroy(),
            Self::Confined(handle) => handle.destroy(),
        }
    }
}

#[derive(Parser, Debug, Clone)]
struct Args {
    #[arg(long, default_value = "Derp E2E Native Test")]
    title: String,
    #[arg(long, default_value = "derp.e2e.native")]
    app_id: String,
    #[arg(long, default_value = "default")]
    token: String,
    #[arg(long, default_value = "auto")]
    strip: String,
    #[arg(long, default_value_t = 480)]
    width: u32,
    #[arg(long, default_value_t = 320)]
    height: u32,
    #[arg(long, default_value_t = false)]
    drop_buffer_after_draw: bool,
    #[arg(long, default_value = "none")]
    pointer_constraint: String,
    #[arg(long)]
    spawn_on_press_command: Option<String>,
    #[arg(long)]
    activation_app_id: Option<String>,
    #[arg(long)]
    activation_token_file: Option<String>,
    #[arg(long, default_value_t = false)]
    activation_omit_surface: bool,
    #[arg(long, default_value_t = false)]
    request_token_on_pointer_enter: bool,
    #[arg(long, default_value_t = false)]
    fifo_smoke: bool,
    #[arg(long, default_value_t = false)]
    cursor_shape_pointer: bool,
    #[arg(long, default_value_t = false)]
    presentation_smoke: bool,
    #[arg(long, default_value = "none")]
    content_type: String,
    #[arg(long, default_value = "vsync")]
    tearing_hint: String,
    #[arg(long, default_value_t = 1)]
    burst_frames: u32,
    #[arg(long = "require-global")]
    require_global: Vec<String>,
    #[arg(long, default_value_t = false)]
    list_globals: bool,
    #[arg(long)]
    explicit_sync_error: Option<String>,
    #[arg(long, default_value_t = false)]
    explicit_sync_dmabuf: bool,
    #[arg(long, default_value_t = 0)]
    explicit_sync_dmabuf_stress_frames: u32,
    #[arg(long, default_value_t = false)]
    explicit_sync_dmabuf_wait_control: bool,
    #[arg(long)]
    status_json: Option<String>,
    #[arg(long)]
    control_socket: Option<String>,
    #[arg(long, default_value_t = false)]
    layer_panel: bool,
    #[arg(long, default_value_t = 48)]
    exclusive_zone: i32,
    #[arg(long, default_value_t = false)]
    ext_image_copy_capture_output: bool,
    #[arg(long, default_value_t = 3)]
    ext_image_copy_capture_frames: u32,
    #[arg(long)]
    xdg_icon_name: Option<String>,
    #[arg(long, default_value_t = false)]
    xdg_icon_shm: bool,
    #[arg(long, default_value_t = false)]
    xdg_toplevel_drag_attach: bool,
    #[arg(long, default_value_t = false)]
    xdg_toplevel_drag_source: bool,
    #[arg(long, default_value_t = 64)]
    xdg_toplevel_drag_x_offset: i32,
    #[arg(long, default_value_t = 32)]
    xdg_toplevel_drag_y_offset: i32,
    #[arg(long, default_value_t = false)]
    kde_decoration_none: bool,
    #[arg(long, default_value_t = false)]
    xdg_decoration_raw_none: bool,
    #[arg(long, default_value_t = false)]
    xdg_decoration_client_side: bool,
    #[arg(long, default_value_t = false)]
    move_on_header_press: bool,
    #[arg(long, default_value_t = false)]
    rounded_corners: bool,
    #[arg(long, default_value_t = false)]
    no_border: bool,
    #[arg(long, default_value_t = false)]
    solid_client: bool,
    #[arg(long)]
    gesture_status_json: Option<String>,
    #[arg(long)]
    touch_status_json: Option<String>,
    #[arg(long)]
    cursor_shape_status_json: Option<String>,
    #[arg(long, default_value_t = false)]
    xdg_popup_grab_probe: bool,
    #[arg(long)]
    xdg_popup_grab_status_json: Option<String>,
}

fn main() {
    let args = Args::parse();
    let pointer_constraint_mode = PointerConstraintMode::parse(&args.pointer_constraint)
        .unwrap_or_else(|error| panic!("{error}"));
    let content_type_arg =
        ContentTypeArg::parse(&args.content_type).unwrap_or_else(|error| panic!("{error}"));
    let tearing_hint_arg =
        TearingHintArg::parse(&args.tearing_hint).unwrap_or_else(|error| panic!("{error}"));
    let strip_color = parse_strip_color(&args.strip, &args.token)
        .unwrap_or_else(|error| panic!("invalid --strip value: {error}"));
    let conn = Connection::connect_to_env().expect("connect to wayland compositor");
    let (globals, mut event_queue) = registry_queue_init(&conn).expect("init registry");
    let qh = event_queue.handle();

    if args.list_globals || !args.require_global.is_empty() {
        let globals_list = globals.contents().clone_list();
        if args.list_globals {
            for global in &globals_list {
                println!("{} {}", global.interface, global.version);
            }
        }
        for required in &args.require_global {
            if !globals_list
                .iter()
                .any(|global| global.interface == *required)
            {
                panic!("missing required global {required}");
            }
        }
        return;
    }

    if let Some(mode) = args.explicit_sync_error.as_deref() {
        run_explicit_sync_protocol_error(mode, &args);
        return;
    }

    if args.explicit_sync_dmabuf {
        run_explicit_sync_dmabuf(&args);
        return;
    }

    if args.layer_panel {
        run_layer_panel(&args);
        return;
    }

    if args.ext_image_copy_capture_output {
        run_ext_image_copy_capture_output(&args);
        return;
    }

    let compositor_state = CompositorState::bind(&globals, &qh).expect("bind wl_compositor");
    let shm_state = Shm::bind(&globals, &qh).expect("bind wl_shm");
    let xdg_shell_state = XdgShell::bind(&globals, &qh).expect("bind xdg_shell");
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);
    let seat_state = SeatState::new(&globals, &qh);
    let relative_pointer_state = RelativePointerState::bind(&globals, &qh);
    let pointer_constraint_state = PointerConstraintsState::bind(&globals, &qh);
    let fifo_manager = if args.fifo_smoke {
        Some(
            globals
                .bind::<WpFifoManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind wp_fifo_manager_v1"),
        )
    } else {
        None
    };
    let cursor_shape_manager = if args.cursor_shape_pointer {
        Some(
            globals
                .bind::<WpCursorShapeManagerV1, _, _>(&qh, 1..=2, ())
                .expect("bind wp_cursor_shape_manager_v1"),
        )
    } else {
        None
    };
    let presentation = if args.presentation_smoke {
        Some(
            globals
                .bind::<WpPresentation, _, _>(&qh, 1..=2, ())
                .expect("bind wp_presentation"),
        )
    } else {
        None
    };
    let content_type_manager = if content_type_arg != ContentTypeArg::None {
        Some(
            globals
                .bind::<WpContentTypeManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind wp_content_type_manager_v1"),
        )
    } else {
        None
    };
    let tearing_control_manager = if tearing_hint_arg != TearingHintArg::Vsync {
        Some(
            globals
                .bind::<WpTearingControlManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind wp_tearing_control_manager_v1"),
        )
    } else {
        None
    };
    let xdg_toplevel_icon_manager = if args.xdg_icon_name.is_some() || args.xdg_icon_shm {
        Some(
            globals
                .bind::<XdgToplevelIconManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind xdg_toplevel_icon_manager_v1"),
        )
    } else {
        None
    };
    let xdg_toplevel_drag_manager = if args.xdg_toplevel_drag_attach {
        Some(
            globals
                .bind::<XdgToplevelDragManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind xdg_toplevel_drag_manager_v1"),
        )
    } else {
        None
    };
    let pointer_gestures = if args.gesture_status_json.is_some() {
        Some(
            globals
                .bind::<ZwpPointerGesturesV1, _, _>(&qh, 1..=3, ())
                .expect("bind zwp_pointer_gestures_v1"),
        )
    } else {
        None
    };
    let kde_server_decoration_manager = if args.kde_decoration_none {
        Some(
            globals
                .bind::<OrgKdeKwinServerDecorationManager, _, _>(&qh, 1..=1, ())
                .expect("bind org_kde_kwin_server_decoration_manager"),
        )
    } else {
        None
    };
    let xdg_decoration_manager = if args.xdg_decoration_raw_none || args.xdg_decoration_client_side
    {
        Some(
            globals
                .bind::<ZxdgDecorationManagerV1, _, _>(&qh, 1..=1, ())
                .expect("bind zxdg_decoration_manager_v1"),
        )
    } else {
        None
    };
    let activation_state = ActivationState::bind(&globals, &qh).ok();
    let startup_activation_token = std::env::var("XDG_ACTIVATION_TOKEN").ok();
    if startup_activation_token.is_some() {
        std::env::remove_var("XDG_ACTIVATION_TOKEN");
    }

    let surface = compositor_state.create_surface(&qh);
    let window_decorations = if args.xdg_decoration_raw_none || args.xdg_decoration_client_side {
        WindowDecorations::None
    } else {
        WindowDecorations::RequestServer
    };
    let window = xdg_shell_state.create_window(surface, window_decorations, &qh);
    window.set_title(args.title.clone());
    window.set_app_id(args.app_id.clone());
    window.set_min_size(Some((args.width, args.height)));
    window.set_max_size(Some((args.width, args.height)));
    if let Some(manager) = xdg_decoration_manager.as_ref() {
        let decoration = manager.get_toplevel_decoration(window.xdg_toplevel(), &qh, ());
        let mode = if args.xdg_decoration_raw_none {
            wayland_client::WEnum::Unknown(0)
        } else {
            wayland_client::WEnum::Value(XdgDecorationMode::ClientSide)
        };
        decoration
            .send_request(XdgDecorationRequest::SetMode { mode })
            .expect("send xdg decoration mode");
    }
    if let Some(manager) = kde_server_decoration_manager.as_ref() {
        let decoration = manager.create(window.wl_surface(), &qh, ());
        decoration.request_mode(KdeServerDecorationMode::None);
    }
    let mut icon_pool = None;
    let mut icon_buffer = None;
    let mut toplevel_icon = None;
    if let Some(manager) = xdg_toplevel_icon_manager.as_ref() {
        let icon = manager.create_icon(&qh, ());
        if let Some(name) = args.xdg_icon_name.as_ref() {
            icon.set_name(name.clone());
        }
        if args.xdg_icon_shm {
            let icon_size = 16;
            let mut pool = SlotPool::new((icon_size * icon_size * 4) as usize, &shm_state)
                .expect("create icon shared memory pool");
            let (buffer, canvas) = pool
                .create_buffer(
                    icon_size as i32,
                    icon_size as i32,
                    (icon_size * 4) as i32,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create icon buffer");
            for y in 0..icon_size {
                for x in 0..icon_size {
                    let index = ((y * icon_size + x) * 4) as usize;
                    canvas[index] = if x < 8 { 0x30 } else { 0xf0 };
                    canvas[index + 1] = if y < 8 { 0x40 } else { 0xd0 };
                    canvas[index + 2] = 0xc0;
                    canvas[index + 3] = 0xff;
                }
            }
            icon.add_buffer(buffer.wl_buffer(), 1);
            icon_pool = Some(pool);
            icon_buffer = Some(buffer);
        }
        manager.set_icon(window.xdg_toplevel(), Some(&icon));
        toplevel_icon = Some(icon);
    }
    let xdg_toplevel_drag = None;
    let mut xdg_toplevel_drag_data_device_manager = None;
    let xdg_toplevel_drag_data_source = None;
    let xdg_toplevel_drag_data_device = None;
    if args.xdg_toplevel_drag_attach || args.xdg_toplevel_drag_source {
        let data_device_manager = globals
            .bind::<wl_data_device_manager::WlDataDeviceManager, _, _>(&qh, 1..=3, ())
            .expect("bind wl_data_device_manager");
        xdg_toplevel_drag_data_device_manager = Some(data_device_manager);
    }
    let mut xdg_toplevel_drag = xdg_toplevel_drag;
    let mut xdg_toplevel_drag_data_source = xdg_toplevel_drag_data_source;
    if let Some(manager) = xdg_toplevel_drag_manager.as_ref() {
        let data_source = xdg_toplevel_drag_data_device_manager
            .as_ref()
            .expect("xdg toplevel drag data device manager")
            .create_data_source(&qh, ());
        let drag = manager.get_xdg_toplevel_drag(&data_source, &qh, ());
        drag.attach(
            window.xdg_toplevel(),
            args.xdg_toplevel_drag_x_offset,
            args.xdg_toplevel_drag_y_offset,
        );
        xdg_toplevel_drag_data_source = Some(data_source);
        xdg_toplevel_drag = Some(drag);
    }
    window.commit();
    let fifo = fifo_manager
        .as_ref()
        .map(|manager| manager.get_fifo(window.wl_surface(), &qh, ()));
    let content_type = content_type_manager.as_ref().map(|manager| {
        let content_type = manager.get_surface_content_type(window.wl_surface(), &qh, ());
        content_type.set_content_type(content_type_arg.protocol());
        content_type
    });
    let tearing_control = tearing_control_manager.as_ref().map(|manager| {
        let tearing_control = manager.get_tearing_control(window.wl_surface(), &qh, ());
        tearing_control.set_presentation_hint(tearing_hint_arg.protocol());
        tearing_control
    });
    if content_type.is_some() || tearing_control.is_some() {
        window.wl_surface().commit();
    }

    let pool = SlotPool::new((args.width * args.height * 4) as usize, &shm_state)
        .expect("create shared memory pool");

    let mut state = TestClient {
        registry_state,
        output_state,
        seat_state,
        _compositor_state: compositor_state,
        shm_state,
        _xdg_shell_state: xdg_shell_state,
        activation_state,
        relative_pointer_state,
        pointer_constraint_state,
        pool,
        window,
        buffer: None,
        width: args.width,
        height: args.height,
        configured: false,
        needs_redraw: false,
        exit: false,
        base_title: args.title,
        app_id: args.app_id,
        token: args.token,
        strip_color,
        drop_buffer_after_draw: args.drop_buffer_after_draw,
        buffer_dropped: false,
        pending_presentation_loops: 0,
        startup_activation_token,
        startup_activation_sent: false,
        spawn_on_press_command: args.spawn_on_press_command,
        activation_app_id: args.activation_app_id,
        activation_token_file: args.activation_token_file,
        activation_omit_surface: args.activation_omit_surface,
        request_token_on_pointer_enter: args.request_token_on_pointer_enter,
        spawn_on_press_requested: false,
        move_on_header_press: args.move_on_header_press,
        rounded_corners: args.rounded_corners,
        no_border: args.no_border,
        solid_client: args.solid_client,
        pointer_constraint_mode,
        fifo,
        presentation,
        _content_type: content_type,
        _tearing_control: tearing_control,
        _xdg_toplevel_icon_manager: xdg_toplevel_icon_manager,
        _xdg_toplevel_drag_manager: xdg_toplevel_drag_manager,
        _xdg_toplevel_drag: xdg_toplevel_drag,
        _xdg_toplevel_drag_data_device_manager: xdg_toplevel_drag_data_device_manager,
        _xdg_toplevel_drag_data_source: xdg_toplevel_drag_data_source,
        _xdg_toplevel_drag_data_device: xdg_toplevel_drag_data_device,
        xdg_toplevel_drag_started: false,
        xdg_toplevel_drag_source: args.xdg_toplevel_drag_source,
        xdg_toplevel_drag_x_offset: args.xdg_toplevel_drag_x_offset,
        xdg_toplevel_drag_y_offset: args.xdg_toplevel_drag_y_offset,
        _toplevel_icon: toplevel_icon,
        _icon_pool: icon_pool,
        _icon_buffer: icon_buffer,
        cursor_shape_manager,
        cursor_shape_device: None,
        fifo_smoke_draws: 0,
        presentation_presented: 0,
        presentation_discarded: 0,
        presentation_smoke: args.presentation_smoke,
        burst_frames_remaining: args.burst_frames.saturating_sub(1),
        keyboard: None,
        keyboard_seat: None,
        pointer: None,
        pointer_seat: None,
        touch: None,
        touch_seat: None,
        relative_pointer: None,
        pointer_gestures,
        gesture_swipe: None,
        gesture_pinch: None,
        gesture_hold: None,
        gesture_ready_pending: false,
        gesture_ready: false,
        gesture_status_json: args.gesture_status_json,
        gesture_status: GestureStatus::default(),
        touch_status_json: args.touch_status_json,
        touch_status: TouchStatus::default(),
        cursor_shape_status_json: args.cursor_shape_status_json,
        cursor_shape_ready_pending: false,
        cursor_shape_ready: false,
        cursor_shape_pointer_enter: 0,
        cursor_shape_set: 0,
        pointer_constraint: None,
        constraint_locked: false,
        constraint_confined: false,
        last_relative: (0.0, 0.0),
        total_relative: (0.0, 0.0),
        xdg_popup_grab_probe: args.xdg_popup_grab_probe,
        xdg_popup_grab_status_json: args.xdg_popup_grab_status_json,
        xdg_popup_parent: None,
        xdg_popup_child: None,
        xdg_popup_status: PopupProbeStatus::default(),
    };
    state.write_touch_status();

    while !state.exit {
        event_queue
            .blocking_dispatch(&mut state)
            .expect("dispatch wayland events");
        if state.gesture_ready_pending {
            state.gesture_ready_pending = false;
            event_queue
                .roundtrip(&mut state)
                .expect("roundtrip pointer gesture setup");
            state.gesture_ready = true;
            state.write_gesture_status();
        }
        if state.cursor_shape_ready_pending {
            state.cursor_shape_ready_pending = false;
            event_queue
                .roundtrip(&mut state)
                .expect("roundtrip cursor shape setup");
            state.cursor_shape_ready = true;
            state.write_cursor_shape_status();
        }
    }
}

struct LayerPanelClient {
    registry_state: RegistryState,
    output_state: OutputState,
    _compositor_state: CompositorState,
    shm_state: Shm,
    pool: SlotPool,
    surface: wl_surface::WlSurface,
    _layer_shell: ZwlrLayerShellV1,
    _layer_surface: ZwlrLayerSurfaceV1,
    buffer: Option<Buffer>,
    width: u32,
    height: u32,
    token: String,
    configured: bool,
}

fn run_layer_panel(args: &Args) {
    let conn = Connection::connect_to_env().expect("connect to wayland compositor");
    let (globals, mut event_queue) = registry_queue_init(&conn).expect("init registry");
    let qh = event_queue.handle();
    let compositor_state = CompositorState::bind(&globals, &qh).expect("bind wl_compositor");
    let shm_state = Shm::bind(&globals, &qh).expect("bind wl_shm");
    let output_state = OutputState::new(&globals, &qh);
    let registry_state = RegistryState::new(&globals);
    let layer_shell = globals
        .bind::<ZwlrLayerShellV1, _, _>(&qh, 1..=4, ())
        .expect("bind zwlr_layer_shell_v1");
    let surface = compositor_state.create_surface(&qh);
    let layer_surface = layer_shell.get_layer_surface(
        &surface,
        None::<&wl_output::WlOutput>,
        WlrLayer::Top,
        "derp-e2e-exclusive-panel".to_string(),
        &qh,
        (),
    );
    let zone = args.exclusive_zone.max(1);
    layer_surface.set_size(0, zone as u32);
    layer_surface.set_anchor(Anchor::Top | Anchor::Left | Anchor::Right);
    layer_surface.set_exclusive_zone(zone);
    surface.commit();
    let pool = SlotPool::new((args.width.max(1) * zone as u32 * 4) as usize, &shm_state)
        .expect("create shared memory pool");
    let mut state = LayerPanelClient {
        registry_state,
        output_state,
        _compositor_state: compositor_state,
        shm_state,
        pool,
        surface,
        _layer_shell: layer_shell,
        _layer_surface: layer_surface,
        buffer: None,
        width: args.width.max(1),
        height: zone as u32,
        token: args.token.clone(),
        configured: false,
    };
    loop {
        event_queue
            .blocking_dispatch(&mut state)
            .expect("dispatch wayland layer panel events");
    }
}

impl LayerPanelClient {
    fn draw(&mut self) {
        if !self.configured {
            return;
        }
        let stride = (self.width * 4) as i32;
        let required_len = (self.width * self.height * 4) as usize;
        if self.pool.len() < required_len {
            self.pool.resize(required_len).expect("resize pool");
        }
        if self.buffer.is_none() {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create layer buffer");
            self.buffer = Some(buffer);
        }
        let needs_replacement = {
            let buffer = self.buffer.as_mut().expect("buffer allocated");
            self.pool.canvas(buffer).is_none()
        };
        if needs_replacement {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create fallback layer buffer");
            self.buffer = Some(buffer);
        }
        let buffer = self.buffer.as_mut().expect("buffer ready");
        let canvas = self.pool.canvas(buffer).expect("buffer canvas");
        draw_pattern(
            canvas,
            self.width,
            self.height,
            &self.token,
            [40, 180, 220, 255],
            false,
            false,
            false,
        );
        self.surface
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        buffer
            .attach_to(&self.surface)
            .expect("attach layer buffer");
        self.surface.commit();
    }
}

struct TestClient {
    registry_state: RegistryState,
    output_state: OutputState,
    seat_state: SeatState,
    _compositor_state: CompositorState,
    shm_state: Shm,
    _xdg_shell_state: XdgShell,
    activation_state: Option<ActivationState>,
    relative_pointer_state: RelativePointerState,
    pointer_constraint_state: PointerConstraintsState,
    pool: SlotPool,
    window: Window,
    buffer: Option<Buffer>,
    width: u32,
    height: u32,
    configured: bool,
    needs_redraw: bool,
    exit: bool,
    base_title: String,
    app_id: String,
    token: String,
    strip_color: [u8; 4],
    drop_buffer_after_draw: bool,
    buffer_dropped: bool,
    pending_presentation_loops: u32,
    startup_activation_token: Option<String>,
    startup_activation_sent: bool,
    spawn_on_press_command: Option<String>,
    activation_app_id: Option<String>,
    activation_token_file: Option<String>,
    activation_omit_surface: bool,
    request_token_on_pointer_enter: bool,
    spawn_on_press_requested: bool,
    move_on_header_press: bool,
    rounded_corners: bool,
    no_border: bool,
    solid_client: bool,
    pointer_constraint_mode: PointerConstraintMode,
    fifo: Option<WpFifoV1>,
    presentation: Option<WpPresentation>,
    _content_type: Option<wp_content_type_v1::WpContentTypeV1>,
    _tearing_control: Option<wp_tearing_control_v1::WpTearingControlV1>,
    _xdg_toplevel_icon_manager: Option<XdgToplevelIconManagerV1>,
    _xdg_toplevel_drag_manager: Option<XdgToplevelDragManagerV1>,
    _xdg_toplevel_drag: Option<XdgToplevelDragV1>,
    _xdg_toplevel_drag_data_device_manager: Option<wl_data_device_manager::WlDataDeviceManager>,
    _xdg_toplevel_drag_data_source: Option<wl_data_source::WlDataSource>,
    _xdg_toplevel_drag_data_device: Option<wl_data_device::WlDataDevice>,
    xdg_toplevel_drag_started: bool,
    xdg_toplevel_drag_source: bool,
    xdg_toplevel_drag_x_offset: i32,
    xdg_toplevel_drag_y_offset: i32,
    _toplevel_icon: Option<XdgToplevelIconV1>,
    _icon_pool: Option<SlotPool>,
    _icon_buffer: Option<Buffer>,
    cursor_shape_manager: Option<WpCursorShapeManagerV1>,
    cursor_shape_device: Option<WpCursorShapeDeviceV1>,
    fifo_smoke_draws: u32,
    presentation_presented: u32,
    presentation_discarded: u32,
    presentation_smoke: bool,
    burst_frames_remaining: u32,
    keyboard: Option<wl_keyboard::WlKeyboard>,
    keyboard_seat: Option<wl_seat::WlSeat>,
    pointer: Option<wl_pointer::WlPointer>,
    pointer_seat: Option<wl_seat::WlSeat>,
    touch: Option<wl_touch::WlTouch>,
    touch_seat: Option<wl_seat::WlSeat>,
    relative_pointer: Option<zwp_relative_pointer_v1::ZwpRelativePointerV1>,
    pointer_gestures: Option<ZwpPointerGesturesV1>,
    gesture_swipe: Option<zwp_pointer_gesture_swipe_v1::ZwpPointerGestureSwipeV1>,
    gesture_pinch: Option<zwp_pointer_gesture_pinch_v1::ZwpPointerGesturePinchV1>,
    gesture_hold: Option<zwp_pointer_gesture_hold_v1::ZwpPointerGestureHoldV1>,
    gesture_ready_pending: bool,
    gesture_ready: bool,
    gesture_status_json: Option<String>,
    gesture_status: GestureStatus,
    touch_status_json: Option<String>,
    touch_status: TouchStatus,
    cursor_shape_status_json: Option<String>,
    cursor_shape_ready_pending: bool,
    cursor_shape_ready: bool,
    cursor_shape_pointer_enter: u32,
    cursor_shape_set: u32,
    pointer_constraint: Option<PointerConstraintHandle>,
    constraint_locked: bool,
    constraint_confined: bool,
    last_relative: (f64, f64),
    total_relative: (f64, f64),
    xdg_popup_grab_probe: bool,
    xdg_popup_grab_status_json: Option<String>,
    xdg_popup_parent: Option<PopupProbeSurface>,
    xdg_popup_child: Option<PopupProbeSurface>,
    xdg_popup_status: PopupProbeStatus,
}

struct PopupProbeSurface {
    popup: Popup,
    buffer: Option<Buffer>,
    width: u32,
    height: u32,
    configured: bool,
}

#[derive(Default)]
struct PopupProbeStatus {
    parent_configured: u32,
    child_configured: u32,
    parent_done: u32,
    child_done: u32,
    pointer_enters: u32,
    pointer_presses: u32,
    keyboard_enters: u32,
    escape_pressed: u32,
    keyboard_enter_surface: String,
    last_pointer_surface: String,
    last_press_surface: String,
}

#[derive(Default)]
struct GestureStatus {
    swipe_begin: u32,
    swipe_update: u32,
    swipe_end: u32,
    pinch_begin: u32,
    pinch_update: u32,
    pinch_end: u32,
    hold_begin: u32,
    hold_end: u32,
    pointer_enter: u32,
    last_swipe_delta: (f64, f64),
    last_pinch_delta: (f64, f64),
    last_pinch_scale: f64,
    last_pinch_rotation: f64,
    last_cancelled: bool,
}

#[derive(Default)]
struct TouchStatus {
    device_ready: bool,
    down: u32,
    motion: u32,
    up: u32,
    frame: u32,
    cancel: u32,
    pointer_press: u32,
    last_id: i32,
    last_surface: String,
    last_x: f64,
    last_y: f64,
}

impl TestClient {
    fn popup_status_escape(value: &str) -> String {
        value.replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn xdg_popup_open_depth(&self) -> u32 {
        u32::from(self.xdg_popup_parent.is_some()) + u32::from(self.xdg_popup_child.is_some())
    }

    fn write_xdg_popup_status(&self) {
        let Some(path) = self.xdg_popup_grab_status_json.as_ref() else {
            return;
        };
        let status = &self.xdg_popup_status;
        let json = format!(
            "{{\"parent_configured\":{},\"child_configured\":{},\"parent_done\":{},\"child_done\":{},\"pointer_enters\":{},\"pointer_presses\":{},\"keyboard_enters\":{},\"escape_pressed\":{},\"open_depth\":{},\"keyboard_enter_surface\":\"{}\",\"last_pointer_surface\":\"{}\",\"last_press_surface\":\"{}\"}}",
            status.parent_configured,
            status.child_configured,
            status.parent_done,
            status.child_done,
            status.pointer_enters,
            status.pointer_presses,
            status.keyboard_enters,
            status.escape_pressed,
            self.xdg_popup_open_depth(),
            Self::popup_status_escape(&status.keyboard_enter_surface),
            Self::popup_status_escape(&status.last_pointer_surface),
            Self::popup_status_escape(&status.last_press_surface),
        );
        let _ = std::fs::write(path, json);
    }

    fn popup_surface_label(&self, surface: &wl_surface::WlSurface) -> &'static str {
        if self.window.wl_surface() == surface {
            return "toplevel";
        }
        if self
            .xdg_popup_child
            .as_ref()
            .is_some_and(|entry| entry.popup.wl_surface() == surface)
        {
            return "child";
        }
        if self
            .xdg_popup_parent
            .as_ref()
            .is_some_and(|entry| entry.popup.wl_surface() == surface)
        {
            return "parent";
        }
        "other"
    }

    fn make_xdg_popup_positioner(&self, x: i32, y: i32, width: u32, height: u32) -> XdgPositioner {
        let positioner = XdgPositioner::new(&self._xdg_shell_state).expect("create positioner");
        positioner.set_size(width as i32, height as i32);
        positioner.set_anchor_rect(x, y, 1, 1);
        positioner.set_anchor(xdg_positioner::Anchor::TopLeft);
        positioner.set_gravity(xdg_positioner::Gravity::BottomRight);
        positioner
    }

    fn open_xdg_popup_parent(
        &mut self,
        qh: &QueueHandle<Self>,
        seat: &wl_seat::WlSeat,
        serial: u32,
    ) {
        if self.xdg_popup_parent.is_some() {
            return;
        }
        let width = 170;
        let height = 110;
        let positioner = self.make_xdg_popup_positioner(24, 44, width, height);
        let surface = self._compositor_state.create_surface(qh);
        let popup = Popup::from_surface(
            Some(self.window.xdg_surface()),
            &positioner,
            qh,
            surface,
            &self._xdg_shell_state,
        )
        .expect("create parent popup");
        popup.xdg_popup().grab(seat, serial);
        popup.wl_surface().commit();
        self.xdg_popup_parent = Some(PopupProbeSurface {
            popup,
            buffer: None,
            width,
            height,
            configured: false,
        });
        self.write_xdg_popup_status();
    }

    fn open_xdg_popup_child(
        &mut self,
        qh: &QueueHandle<Self>,
        seat: &wl_seat::WlSeat,
        serial: u32,
    ) {
        if self.xdg_popup_child.is_some() {
            return;
        }
        let Some(parent) = self.xdg_popup_parent.as_ref() else {
            return;
        };
        let parent_surface = parent.popup.xdg_surface().clone();
        let width = 150;
        let height = 90;
        let positioner = self.make_xdg_popup_positioner(122, 26, width, height);
        let surface = self._compositor_state.create_surface(qh);
        let popup = Popup::from_surface(
            Some(&parent_surface),
            &positioner,
            qh,
            surface,
            &self._xdg_shell_state,
        )
        .expect("create child popup");
        popup.xdg_popup().grab(seat, serial);
        popup.wl_surface().commit();
        self.xdg_popup_child = Some(PopupProbeSurface {
            popup,
            buffer: None,
            width,
            height,
            configured: false,
        });
        self.write_xdg_popup_status();
    }

    fn destroy_topmost_xdg_popup(&mut self) {
        if self.xdg_popup_child.take().is_some() {
            self.write_xdg_popup_status();
            return;
        }
        if self.xdg_popup_parent.take().is_some() {
            self.write_xdg_popup_status();
        }
    }

    fn draw_popup_probe(pool: &mut SlotPool, popup: &mut PopupProbeSurface, color: [u8; 4]) {
        let stride = (popup.width * 4) as i32;
        let required_len = (popup.width * popup.height * 4) as usize;
        if pool.len() < required_len {
            pool.resize(required_len).expect("resize popup pool");
        }
        if popup.buffer.is_none() {
            pool.resize(pool.len() + required_len)
                .expect("reserve popup buffer");
            let (buffer, _) = pool
                .create_buffer(
                    popup.width as i32,
                    popup.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create popup buffer");
            popup.buffer = Some(buffer);
        }
        let buffer = popup.buffer.as_mut().expect("popup buffer");
        let canvas = pool.canvas(buffer).expect("popup canvas");
        for y in 0..popup.height {
            for x in 0..popup.width {
                let index = ((y * popup.width + x) * 4) as usize;
                let edge = x < 3 || y < 3 || x + 3 >= popup.width || y + 3 >= popup.height;
                canvas[index] = if edge { 0x20 } else { color[0] };
                canvas[index + 1] = if edge { 0x20 } else { color[1] };
                canvas[index + 2] = if edge { 0x20 } else { color[2] };
                canvas[index + 3] = color[3];
            }
        }
        popup
            .popup
            .wl_surface()
            .damage_buffer(0, 0, popup.width as i32, popup.height as i32);
        buffer
            .attach_to(popup.popup.wl_surface())
            .expect("attach popup buffer");
        popup.popup.wl_surface().commit();
    }

    fn configure_xdg_popup_probe(&mut self, popup: &Popup) {
        if let Some(parent) = self.xdg_popup_parent.as_mut() {
            if &parent.popup == popup {
                parent.configured = true;
                self.xdg_popup_status.parent_configured =
                    self.xdg_popup_status.parent_configured.saturating_add(1);
                Self::draw_popup_probe(&mut self.pool, parent, [0x48, 0x88, 0xe8, 0xff]);
                self.write_xdg_popup_status();
                return;
            }
        }
        if let Some(child) = self.xdg_popup_child.as_mut() {
            if &child.popup == popup {
                child.configured = true;
                self.xdg_popup_status.child_configured =
                    self.xdg_popup_status.child_configured.saturating_add(1);
                Self::draw_popup_probe(&mut self.pool, child, [0xe8, 0xc2, 0x42, 0xff]);
                self.write_xdg_popup_status();
            }
        }
    }

    fn xdg_popup_probe_done(&mut self, popup: &Popup) {
        if self
            .xdg_popup_child
            .as_ref()
            .is_some_and(|entry| &entry.popup == popup)
        {
            self.xdg_popup_child = None;
            self.xdg_popup_status.child_done = self.xdg_popup_status.child_done.saturating_add(1);
            self.write_xdg_popup_status();
            return;
        }
        if self
            .xdg_popup_parent
            .as_ref()
            .is_some_and(|entry| &entry.popup == popup)
        {
            self.xdg_popup_child = None;
            self.xdg_popup_parent = None;
            self.xdg_popup_status.parent_done = self.xdg_popup_status.parent_done.saturating_add(1);
            self.write_xdg_popup_status();
        }
    }

    fn maybe_start_xdg_toplevel_drag(&mut self, qh: &QueueHandle<Self>, serial: u32) {
        if self.xdg_toplevel_drag_started {
            return;
        }
        if !self.xdg_toplevel_drag_source && self._xdg_toplevel_drag.is_some() {
            return;
        }
        if !self.xdg_toplevel_drag_source && self._xdg_toplevel_drag_manager.is_none() {
            return;
        }
        let Some(data_device) = self._xdg_toplevel_drag_data_device.as_ref() else {
            return;
        };
        self.xdg_toplevel_drag_started = true;
        let data_source = self
            ._xdg_toplevel_drag_data_device_manager
            .as_ref()
            .expect("xdg toplevel drag data device manager")
            .create_data_source(qh, ());
        data_source.offer("application/x-derp-toplevel-drag".to_string());
        let drag = self._xdg_toplevel_drag_manager.as_ref().map(|manager| {
            let drag = manager.get_xdg_toplevel_drag(&data_source, qh, ());
            drag.attach(
                self.window.xdg_toplevel(),
                self.xdg_toplevel_drag_x_offset,
                self.xdg_toplevel_drag_y_offset,
            );
            drag
        });
        data_device.start_drag(Some(&data_source), self.window.wl_surface(), None, serial);
        self._xdg_toplevel_drag_data_source = Some(data_source);
        self._xdg_toplevel_drag = drag;
    }

    fn draw(&mut self, _conn: &Connection, qh: &QueueHandle<Self>) {
        if !self.configured || !self.needs_redraw {
            return;
        }

        let stride = (self.width * 4) as i32;
        let required_len = (self.width * self.height * 4) as usize;
        if self.pool.len() < required_len {
            self.pool.resize(required_len).expect("resize pool");
        }

        if self.buffer.is_none() {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create buffer");
            self.buffer = Some(buffer);
        }

        let needs_replacement = {
            let buffer = self.buffer.as_mut().expect("buffer allocated");
            self.pool.canvas(buffer).is_none()
        };
        if needs_replacement {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    self.width as i32,
                    self.height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create fallback buffer");
            self.buffer = Some(buffer);
        }

        let buffer = self.buffer.as_mut().expect("buffer ready");
        let canvas = self.pool.canvas(buffer).expect("buffer canvas");

        draw_pattern(
            canvas,
            self.width,
            self.height,
            &self.token,
            self.strip_color,
            self.rounded_corners,
            self.no_border,
            self.solid_client,
        );

        self.window
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.window
            .wl_surface()
            .frame(qh, self.window.wl_surface().clone());
        if let Some(presentation) = self.presentation.as_ref() {
            presentation.feedback(self.window.wl_surface(), qh, ());
        }
        if let Some(fifo) = self.fifo.as_ref() {
            if self.fifo_smoke_draws > 0 {
                fifo.wait_barrier();
            }
            fifo.set_barrier();
            self.fifo_smoke_draws = self.fifo_smoke_draws.saturating_add(1);
        }
        buffer
            .attach_to(self.window.wl_surface())
            .expect("attach buffer");
        if self.fifo.is_some() || self.presentation_smoke {
            self.update_status_title();
        }
        self.window.wl_surface().commit();
        self.maybe_activate_from_startup_token();
        self.needs_redraw = false;
    }

    fn drop_buffer(&mut self) {
        if self.buffer_dropped {
            return;
        }
        self.window.wl_surface().attach(None, 0, 0);
        self.window.wl_surface().commit();
        self.buffer = None;
        self.buffer_dropped = true;
    }

    fn ensure_game_pointer_state(&mut self, qh: &QueueHandle<Self>) {
        if self.pointer_constraint_mode == PointerConstraintMode::None {
            return;
        }
        if self.pointer_constraint.is_some() {
            return;
        }
        let Some(pointer) = self.pointer.as_ref() else {
            return;
        };
        if self.pointer_constraint_state.bound_global().is_err() {
            return;
        }
        let surface = self.window.wl_surface();
        self.pointer_constraint = match self.pointer_constraint_mode {
            PointerConstraintMode::Lock => self
                .pointer_constraint_state
                .lock_pointer(
                    surface,
                    pointer,
                    None,
                    zwp_pointer_constraints_v1::Lifetime::Persistent,
                    qh,
                )
                .ok()
                .map(PointerConstraintHandle::Locked),
            PointerConstraintMode::Confine => self
                .pointer_constraint_state
                .confine_pointer(
                    surface,
                    pointer,
                    None,
                    zwp_pointer_constraints_v1::Lifetime::Persistent,
                    qh,
                )
                .ok()
                .map(PointerConstraintHandle::Confined),
            PointerConstraintMode::None => None,
        };
    }

    fn ensure_gesture_pointer_state(&mut self, qh: &QueueHandle<Self>) {
        if self.gesture_swipe.is_some() {
            return;
        }
        let (Some(manager), Some(pointer)) =
            (self.pointer_gestures.as_ref(), self.pointer.as_ref())
        else {
            return;
        };
        self.gesture_swipe = Some(manager.get_swipe_gesture(pointer, qh, ()));
        self.gesture_pinch = Some(manager.get_pinch_gesture(pointer, qh, ()));
        self.gesture_hold = Some(manager.get_hold_gesture(pointer, qh, ()));
        self.gesture_ready = false;
        self.gesture_ready_pending = true;
    }

    fn ensure_cursor_shape_pointer_state(&mut self, qh: &QueueHandle<Self>) {
        if self.cursor_shape_device.is_some() {
            return;
        }
        let (Some(manager), Some(pointer)) =
            (self.cursor_shape_manager.as_ref(), self.pointer.as_ref())
        else {
            return;
        };
        self.cursor_shape_device = Some(manager.get_pointer(pointer, qh, ()));
        self.cursor_shape_ready = false;
        self.cursor_shape_ready_pending = true;
    }

    fn write_cursor_shape_status(&self) {
        let Some(path) = self.cursor_shape_status_json.as_ref() else {
            return;
        };
        let json = format!(
            "{{\"device_ready\":{},\"pointer_enter\":{},\"shape_set\":{}}}",
            if self.cursor_shape_ready { 1 } else { 0 },
            self.cursor_shape_pointer_enter,
            self.cursor_shape_set
        );
        let _ = std::fs::write(path, json);
    }

    fn write_gesture_status(&self) {
        let Some(path) = self.gesture_status_json.as_ref() else {
            return;
        };
        let status = &self.gesture_status;
        let json = format!(
            concat!(
                "{{",
                "\"swipe_begin\":{},\"swipe_update\":{},\"swipe_end\":{},",
                "\"pinch_begin\":{},\"pinch_update\":{},\"pinch_end\":{},",
                "\"hold_begin\":{},\"hold_end\":{},",
                "\"pointer_enter\":{},",
                "\"last_swipe_delta\":[{:.3},{:.3}],",
                "\"last_pinch_delta\":[{:.3},{:.3}],",
                "\"last_pinch_scale\":{:.6},\"last_pinch_rotation\":{:.6},",
                "\"last_cancelled\":{}",
                "}}\n"
            ),
            status.swipe_begin,
            status.swipe_update,
            status.swipe_end,
            status.pinch_begin,
            status.pinch_update,
            status.pinch_end,
            status.hold_begin,
            status.hold_end,
            status.pointer_enter,
            status.last_swipe_delta.0,
            status.last_swipe_delta.1,
            status.last_pinch_delta.0,
            status.last_pinch_delta.1,
            status.last_pinch_scale,
            status.last_pinch_rotation,
            if status.last_cancelled {
                "true"
            } else {
                "false"
            },
        );
        fs::write(path, json).expect("write gesture status json");
    }

    fn write_touch_status(&self) {
        let Some(path) = self.touch_status_json.as_ref() else {
            return;
        };
        let status = &self.touch_status;
        let json = format!(
            concat!(
                "{{",
                "\"device_ready\":{},\"down\":{},\"motion\":{},\"up\":{},\"frame\":{},\"cancel\":{},",
                "\"pointer_press\":{},\"last_id\":{},\"last_surface\":\"{}\",\"last_position\":[{:.3},{:.3}]",
                "}}\n"
            ),
            if status.device_ready { "true" } else { "false" },
            status.down,
            status.motion,
            status.up,
            status.frame,
            status.cancel,
            status.pointer_press,
            status.last_id,
            Self::popup_status_escape(&status.last_surface),
            status.last_x,
            status.last_y,
        );
        fs::write(path, json).expect("write touch status json");
    }

    fn maybe_activate_from_startup_token(&mut self) {
        if self.startup_activation_sent {
            return;
        }
        let Some(token) = self.startup_activation_token.take() else {
            return;
        };
        let Some(activation_state) = self.activation_state.as_ref() else {
            self.startup_activation_token = Some(token);
            return;
        };
        activation_state.activate::<Self>(self.window.wl_surface(), token);
        self.startup_activation_sent = true;
    }

    fn request_spawn_activation(
        &mut self,
        qh: &QueueHandle<Self>,
        serial: u32,
        seat: wl_seat::WlSeat,
        surface: wl_surface::WlSurface,
    ) {
        if self.spawn_on_press_command.is_none() && self.activation_token_file.is_none() {
            return;
        }
        let Some(activation_state) = self.activation_state.as_ref() else {
            panic!("spawn-on-press requires xdg-activation support");
        };
        activation_state.request_token(
            qh,
            RequestData {
                app_id: Some(
                    self.activation_app_id
                        .clone()
                        .unwrap_or_else(|| self.app_id.clone()),
                ),
                seat_and_serial: Some((seat, serial)),
                surface: (!self.activation_omit_surface).then_some(surface),
            },
        );
    }

    fn update_status_title(&self) {
        let mut title = self.base_title.clone();
        if self.fifo.is_some() {
            title.push_str(&format!(" | fifo={}", self.fifo_smoke_draws));
        }
        if self.presentation_smoke {
            title.push_str(&format!(
                " | presented={} discarded={}",
                self.presentation_presented, self.presentation_discarded
            ));
        }
        if self.pointer_constraint_mode != PointerConstraintMode::None {
            title.push_str(&format!(
                " | mode={} lock={} confine={} last={:.0},{:.0} total={:.0},{:.0}",
                self.pointer_constraint_mode.label(),
                u8::from(self.constraint_locked),
                u8::from(self.constraint_confined),
                self.last_relative.0.round(),
                self.last_relative.1.round(),
                self.total_relative.0.round(),
                self.total_relative.1.round(),
            ));
        }
        self.window.set_title(title);
    }
}

fn ioc(dir: libc::c_ulong, nr: libc::c_ulong, size: libc::c_ulong) -> libc::c_ulong {
    const NRSHIFT: libc::c_ulong = 0;
    const TYPESHIFT: libc::c_ulong = 8;
    const SIZESHIFT: libc::c_ulong = 16;
    const DIRSHIFT: libc::c_ulong = 30;
    (dir << DIRSHIFT)
        | ((b'd' as libc::c_ulong) << TYPESHIFT)
        | (nr << NRSHIFT)
        | (size << SIZESHIFT)
}

fn iowr<T>(nr: libc::c_ulong) -> libc::c_ulong {
    ioc(3, nr, std::mem::size_of::<T>() as libc::c_ulong)
}

#[repr(C)]
struct DrmSyncobjCreate {
    handle: u32,
    flags: u32,
}

#[repr(C)]
struct DrmSyncobjHandle {
    handle: u32,
    flags: u32,
    fd: i32,
    pad: u32,
}

#[repr(C)]
struct DrmSyncobjTimelineWait {
    handles: u64,
    points: u64,
    timeout_nsec: i64,
    count_handles: u32,
    flags: u32,
    first_signaled: u32,
    pad: u32,
}

#[repr(C)]
struct DrmSyncobjTimelineArray {
    handles: u64,
    points: u64,
    count_handles: u32,
    flags: u32,
}

#[repr(C)]
struct DrmModeCreateDumb {
    height: u32,
    width: u32,
    bpp: u32,
    flags: u32,
    handle: u32,
    pitch: u32,
    size: u64,
}

#[repr(C)]
struct DrmModeMapDumb {
    handle: u32,
    pad: u32,
    offset: u64,
}

#[repr(C)]
struct DrmModeDestroyDumb {
    handle: u32,
}

#[repr(C)]
struct DrmPrimeHandle {
    handle: u32,
    flags: u32,
    fd: i32,
}

struct DrmTimeline {
    drm: std::fs::File,
    handle: u32,
    fd: OwnedFd,
}

struct DumbDmabuf {
    drm: std::fs::File,
    handle: u32,
    fd: OwnedFd,
    map: *mut libc::c_void,
    size: usize,
    pitch: u32,
}

impl Drop for DumbDmabuf {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.map, self.size);
        }
        let mut destroy = DrmModeDestroyDumb {
            handle: self.handle,
        };
        unsafe {
            libc::ioctl(
                self.drm.as_raw_fd(),
                iowr::<DrmModeDestroyDumb>(0xB4),
                &mut destroy,
            );
        }
    }
}

fn open_drm_node() -> std::fs::File {
    for path in [
        "/dev/dri/card0",
        "/dev/dri/card1",
        "/dev/dri/renderD128",
        "/dev/dri/renderD129",
    ] {
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
        {
            return file;
        }
    }
    panic!("unable to open a DRM node for syncobj test");
}

fn create_syncobj_timeline() -> DrmTimeline {
    let drm = open_drm_node();
    let mut create = DrmSyncobjCreate {
        handle: 0,
        flags: 0,
    };
    let rc = unsafe { libc::ioctl(drm.as_raw_fd(), iowr::<DrmSyncobjCreate>(0xBF), &mut create) };
    if rc != 0 {
        panic!(
            "DRM_IOCTL_SYNCOBJ_CREATE failed: {}",
            std::io::Error::last_os_error()
        );
    }
    let mut handle = DrmSyncobjHandle {
        handle: create.handle,
        flags: 0,
        fd: -1,
        pad: 0,
    };
    let rc = unsafe { libc::ioctl(drm.as_raw_fd(), iowr::<DrmSyncobjHandle>(0xC1), &mut handle) };
    if rc != 0 || handle.fd < 0 {
        panic!(
            "DRM_IOCTL_SYNCOBJ_HANDLE_TO_FD failed: {}",
            std::io::Error::last_os_error()
        );
    }
    DrmTimeline {
        drm,
        handle: create.handle,
        fd: unsafe { OwnedFd::from_raw_fd(handle.fd) },
    }
}

fn create_syncobj_timeline_fd() -> OwnedFd {
    create_syncobj_timeline().fd
}

fn signal_syncobj_point(drm: &std::fs::File, handle: u32, point: u64) {
    let handles = [handle];
    let points = [point];
    let mut signal = DrmSyncobjTimelineArray {
        handles: handles.as_ptr() as u64,
        points: points.as_ptr() as u64,
        count_handles: 1,
        flags: 0,
    };
    let rc = unsafe {
        libc::ioctl(
            drm.as_raw_fd(),
            iowr::<DrmSyncobjTimelineArray>(0xCD),
            &mut signal,
        )
    };
    if rc != 0 {
        panic!(
            "DRM_IOCTL_SYNCOBJ_TIMELINE_SIGNAL failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

fn wait_syncobj_point(drm: &std::fs::File, handle: u32, point: u64, timeout_nsec: i64) -> bool {
    let handles = [handle];
    let points = [point];
    let mut wait = DrmSyncobjTimelineWait {
        handles: handles.as_ptr() as u64,
        points: points.as_ptr() as u64,
        timeout_nsec,
        count_handles: 1,
        flags: 1 | 2,
        first_signaled: 0,
        pad: 0,
    };
    let rc = unsafe {
        libc::ioctl(
            drm.as_raw_fd(),
            iowr::<DrmSyncobjTimelineWait>(0xCA),
            &mut wait,
        )
    };
    if rc == 0 {
        true
    } else {
        let error = std::io::Error::last_os_error();
        matches!(error.raw_os_error(), Some(code) if code == libc::ETIME || code == libc::EAGAIN)
            .then_some(false)
            .unwrap_or_else(|| panic!("DRM_IOCTL_SYNCOBJ_TIMELINE_WAIT failed: {error}"))
    }
}

fn create_dumb_dmabuf(width: u32, height: u32, rgba: [u8; 4]) -> DumbDmabuf {
    let drm = open_drm_node();
    let mut create = DrmModeCreateDumb {
        height,
        width,
        bpp: 32,
        flags: 0,
        handle: 0,
        pitch: 0,
        size: 0,
    };
    let rc = unsafe {
        libc::ioctl(
            drm.as_raw_fd(),
            iowr::<DrmModeCreateDumb>(0xB2),
            &mut create,
        )
    };
    if rc != 0 {
        panic!(
            "DRM_IOCTL_MODE_CREATE_DUMB failed: {}",
            std::io::Error::last_os_error()
        );
    }
    let mut prime = DrmPrimeHandle {
        handle: create.handle,
        flags: libc::O_CLOEXEC as u32,
        fd: -1,
    };
    let rc = unsafe { libc::ioctl(drm.as_raw_fd(), iowr::<DrmPrimeHandle>(0x2D), &mut prime) };
    if rc != 0 || prime.fd < 0 {
        panic!(
            "DRM_IOCTL_PRIME_HANDLE_TO_FD failed: {}",
            std::io::Error::last_os_error()
        );
    }
    let mut map = DrmModeMapDumb {
        handle: create.handle,
        pad: 0,
        offset: 0,
    };
    let rc = unsafe { libc::ioctl(drm.as_raw_fd(), iowr::<DrmModeMapDumb>(0xB3), &mut map) };
    if rc != 0 {
        panic!(
            "DRM_IOCTL_MODE_MAP_DUMB failed: {}",
            std::io::Error::last_os_error()
        );
    }
    let mapped = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            create.size as usize,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            drm.as_raw_fd(),
            map.offset as libc::off_t,
        )
    };
    if mapped == libc::MAP_FAILED {
        panic!(
            "mmap dumb buffer failed: {}",
            std::io::Error::last_os_error()
        );
    }
    let mut buffer = DumbDmabuf {
        drm,
        handle: create.handle,
        fd: unsafe { OwnedFd::from_raw_fd(prime.fd) },
        map: mapped,
        size: create.size as usize,
        pitch: create.pitch,
    };
    fill_dumb_dmabuf(&mut buffer, width, height, rgba);
    buffer
}

fn fill_dumb_dmabuf(buffer: &mut DumbDmabuf, width: u32, height: u32, rgba: [u8; 4]) {
    let data = unsafe { std::slice::from_raw_parts_mut(buffer.map as *mut u8, buffer.size) };
    for y in 0..height as usize {
        let row = y * buffer.pitch as usize;
        for x in 0..width as usize {
            let index = row + x * 4;
            data[index] = rgba[2];
            data[index + 1] = rgba[1];
            data[index + 2] = rgba[0];
            data[index + 3] = rgba[3];
        }
    }
}

struct ProtocolProbe {
    registry_state: RegistryState,
    output_state: OutputState,
    shm_state: Shm,
    pool: SlotPool,
    buffer: Option<Buffer>,
}

impl ProtocolProbe {
    fn attach_buffer(&mut self, surface: &wl_surface::WlSurface, width: u32, height: u32) {
        let stride = (width * 4) as i32;
        let required_len = (width * height * 4) as usize;
        if self.pool.len() < required_len {
            self.pool
                .resize(required_len)
                .expect("resize protocol pool");
        }
        if self.buffer.is_none() {
            let (buffer, _) = self
                .pool
                .create_buffer(
                    width as i32,
                    height as i32,
                    stride,
                    wayland_client::protocol::wl_shm::Format::Argb8888,
                )
                .expect("create protocol buffer");
            self.buffer = Some(buffer);
        }
        let buffer = self.buffer.as_mut().expect("protocol buffer");
        let canvas = self.pool.canvas(buffer).expect("protocol buffer canvas");
        for chunk in canvas.chunks_exact_mut(4) {
            chunk[0] = 0x20;
            chunk[1] = 0x60;
            chunk[2] = 0xa0;
            chunk[3] = 0xff;
        }
        buffer.attach_to(surface).expect("attach protocol buffer");
    }
}

#[derive(Clone, Default)]
struct ExplicitSyncDmabufStatus {
    configured: bool,
    frame_a_committed: bool,
    frame_b_committed: bool,
    acquire_b_signaled: bool,
    release_a_observed: bool,
    release_b_observed: bool,
    stress_total: u32,
    stress_committed: u32,
    stress_release_observed: u32,
    stress_release_failed: bool,
}

struct ExplicitSyncDmabufClient {
    registry_state: RegistryState,
    output_state: OutputState,
    _compositor_state: CompositorState,
    _xdg_shell_state: XdgShell,
    window: Window,
    dmabuf: ZwpLinuxDmabufV1,
    sync_surface: WpLinuxDrmSyncobjSurfaceV1,
    timeline_proxy: WpLinuxDrmSyncobjTimelineV1,
    timeline: DrmTimeline,
    width: u32,
    height: u32,
    base_title: String,
    buffer_a: Option<DumbDmabuf>,
    buffer_b: Option<DumbDmabuf>,
    wl_buffer_a: Option<wl_buffer::WlBuffer>,
    wl_buffer_b: Option<wl_buffer::WlBuffer>,
    configured: bool,
    committed: bool,
    stress_frames: u32,
    wait_control: bool,
    ready_committed: bool,
    control_triggered: std::sync::Arc<AtomicBool>,
    exit: bool,
    status_path: Option<String>,
    status: std::sync::Arc<Mutex<ExplicitSyncDmabufStatus>>,
}

fn write_explicit_sync_status(
    path: &Option<String>,
    status: &std::sync::Arc<Mutex<ExplicitSyncDmabufStatus>>,
) {
    let Some(path) = path.as_ref() else {
        return;
    };
    let Ok(status) = status.lock() else {
        return;
    };
    let tmp = format!("{path}.tmp");
    let body = format!(
        "{{\"configured\":{},\"frame_a_committed\":{},\"frame_b_committed\":{},\"acquire_b_signaled\":{},\"release_a_observed\":{},\"release_b_observed\":{},\"stress_total\":{},\"stress_committed\":{},\"stress_release_observed\":{},\"stress_release_failed\":{}}}\n",
        status.configured,
        status.frame_a_committed,
        status.frame_b_committed,
        status.acquire_b_signaled,
        status.release_a_observed,
        status.release_b_observed,
        status.stress_total,
        status.stress_committed,
        status.stress_release_observed,
        status.stress_release_failed,
    );
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

fn update_explicit_sync_status(
    path: &Option<String>,
    status: &std::sync::Arc<Mutex<ExplicitSyncDmabufStatus>>,
    update: impl FnOnce(&mut ExplicitSyncDmabufStatus),
) {
    if let Ok(mut guard) = status.lock() {
        update(&mut guard);
    }
    write_explicit_sync_status(path, status);
}

impl ExplicitSyncDmabufClient {
    fn create_dmabuf_buffer(
        &self,
        qh: &QueueHandle<Self>,
        buffer: &DumbDmabuf,
    ) -> wl_buffer::WlBuffer {
        const DRM_FORMAT_ARGB8888: u32 = 0x34325241;
        let params = self.dmabuf.create_params(qh, ());
        params.add(buffer.fd.as_fd(), 0, 0, buffer.pitch, 0, 0);
        params.create_immed(
            self.width as i32,
            self.height as i32,
            DRM_FORMAT_ARGB8888,
            zwp_linux_buffer_params_v1::Flags::empty(),
            qh,
            (),
        )
    }

    fn commit_frames(&mut self, qh: &QueueHandle<Self>) {
        if !self.configured || self.committed {
            return;
        }
        if self.stress_frames > 0
            && self.wait_control
            && !self.control_triggered.load(Ordering::SeqCst)
        {
            if !self.ready_committed {
                self.commit_ready_frame(qh);
            }
            return;
        }
        if self.stress_frames > 0 {
            self.commit_stress_frames(qh);
            return;
        }
        let buffer_a = create_dumb_dmabuf(self.width, self.height, [224, 36, 36, 255]);
        let buffer_b = create_dumb_dmabuf(self.width, self.height, [32, 190, 76, 255]);
        let wl_buffer_a = self.create_dmabuf_buffer(qh, &buffer_a);
        let wl_buffer_b = self.create_dmabuf_buffer(qh, &buffer_b);
        signal_syncobj_point(&self.timeline.drm, self.timeline.handle, 1);
        self.sync_surface
            .set_acquire_point(&self.timeline_proxy, 0, 1);
        self.sync_surface
            .set_release_point(&self.timeline_proxy, 0, 2);
        self.window.wl_surface().attach(Some(&wl_buffer_a), 0, 0);
        self.window
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.window.wl_surface().commit();
        self.window
            .set_title(format!("{} | pending acquire", self.base_title));
        self.sync_surface
            .set_acquire_point(&self.timeline_proxy, 0, 3);
        self.sync_surface
            .set_release_point(&self.timeline_proxy, 0, 4);
        self.window.wl_surface().attach(Some(&wl_buffer_b), 0, 0);
        self.window
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.window.wl_surface().commit();
        self.buffer_a = Some(buffer_a);
        self.buffer_b = Some(buffer_b);
        self.wl_buffer_a = Some(wl_buffer_a);
        self.wl_buffer_b = Some(wl_buffer_b);
        self.committed = true;
        update_explicit_sync_status(&self.status_path, &self.status, |status| {
            status.frame_a_committed = true;
            status.frame_b_committed = true;
        });
    }

    fn commit_ready_frame(&mut self, qh: &QueueHandle<Self>) {
        let buffer_a = create_dumb_dmabuf(self.width, self.height, [226, 42, 42, 255]);
        let wl_buffer_a = self.create_dmabuf_buffer(qh, &buffer_a);
        signal_syncobj_point(&self.timeline.drm, self.timeline.handle, 1);
        self.sync_surface
            .set_acquire_point(&self.timeline_proxy, 0, 1);
        self.sync_surface
            .set_release_point(&self.timeline_proxy, 0, 2);
        self.window.wl_surface().attach(Some(&wl_buffer_a), 0, 0);
        self.window
            .wl_surface()
            .damage_buffer(0, 0, self.width as i32, self.height as i32);
        self.window.wl_surface().commit();
        self.window
            .set_title(format!("{} | ready", self.base_title));
        self.buffer_a = Some(buffer_a);
        self.wl_buffer_a = Some(wl_buffer_a);
        self.ready_committed = true;
        update_explicit_sync_status(&self.status_path, &self.status, |status| {
            status.frame_a_committed = true;
        });
    }

    fn commit_stress_frames(&mut self, qh: &QueueHandle<Self>) {
        let buffer_a = create_dumb_dmabuf(self.width, self.height, [226, 42, 42, 255]);
        let buffer_b = create_dumb_dmabuf(self.width, self.height, [42, 112, 226, 255]);
        let wl_buffer_a = self.create_dmabuf_buffer(qh, &buffer_a);
        let wl_buffer_b = self.create_dmabuf_buffer(qh, &buffer_b);
        for frame in 0..self.stress_frames {
            let acquire = 1000 + u64::from(frame) * 2;
            let release = acquire + 1;
            signal_syncobj_point(&self.timeline.drm, self.timeline.handle, acquire);
            self.sync_surface
                .set_acquire_point(&self.timeline_proxy, 0, acquire as u32);
            self.sync_surface
                .set_release_point(&self.timeline_proxy, 0, release as u32);
            let buffer = if frame % 2 == 0 {
                &wl_buffer_a
            } else {
                &wl_buffer_b
            };
            self.window.wl_surface().attach(Some(buffer), 0, 0);
            self.window
                .wl_surface()
                .damage_buffer(0, 0, self.width as i32, self.height as i32);
            self.window.wl_surface().commit();
        }
        self.window.set_title(format!(
            "{} | stress={}",
            self.base_title, self.stress_frames
        ));
        self.buffer_a = Some(buffer_a);
        self.buffer_b = Some(buffer_b);
        self.wl_buffer_a = Some(wl_buffer_a);
        self.wl_buffer_b = Some(wl_buffer_b);
        self.committed = true;
        update_explicit_sync_status(&self.status_path, &self.status, |status| {
            status.stress_total = self.stress_frames;
            status.stress_committed = self.stress_frames;
        });
    }
}

impl CompositorHandler for ExplicitSyncDmabufClient {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl WindowHandler for ExplicitSyncDmabufClient {
    fn request_close(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _window: &Window) {
        self.exit = true;
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        _window: &Window,
        _configure: WindowConfigure,
        _serial: u32,
    ) {
        self.configured = true;
        update_explicit_sync_status(&self.status_path, &self.status, |status| {
            status.configured = true;
        });
        self.commit_frames(qh);
    }
}

impl OutputHandler for ExplicitSyncDmabufClient {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl ProvidesRegistryState for ExplicitSyncDmabufClient {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState);
}

#[derive(Clone, Default)]
struct ExtImageCopyFrameStatus {
    index: u32,
    ready: bool,
    failed: Option<String>,
    damage: Vec<(i32, i32, i32, i32)>,
    checksum: u64,
    nonzero_pixels: u32,
}

#[derive(Clone, Default)]
struct ExtImageCopyStatus {
    buffer_width: u32,
    buffer_height: u32,
    constraints_done: bool,
    stopped: bool,
    frames: Vec<ExtImageCopyFrameStatus>,
}

struct ExtImageCopyClient {
    registry_state: RegistryState,
    output_state: OutputState,
    shm_state: Shm,
    pool: SlotPool,
    _output_source_manager: ExtOutputImageCaptureSourceManagerV1,
    _copy_manager: ExtImageCopyCaptureManagerV1,
    _source: ExtImageCaptureSourceV1,
    session: ExtImageCopyCaptureSessionV1,
    active_frame: Option<ExtImageCopyCaptureFrameV1>,
    active_buffer: Option<Buffer>,
    frame_index: u32,
    target_frames: u32,
    exit: bool,
    status_path: Option<String>,
    status: ExtImageCopyStatus,
}

fn write_ext_image_copy_status(path: &Option<String>, status: &ExtImageCopyStatus) {
    let Some(path) = path.as_ref() else {
        return;
    };
    let tmp = format!("{path}.tmp");
    let frames = status
        .frames
        .iter()
        .map(|frame| {
            let damage = frame
                .damage
                .iter()
                .map(|(x, y, w, h)| format!("{{\"x\":{x},\"y\":{y},\"width\":{w},\"height\":{h}}}"))
                .collect::<Vec<_>>()
                .join(",");
            let failed = frame
                .failed
                .as_ref()
                .map(|value| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")))
                .unwrap_or_else(|| "null".to_string());
            format!(
                "{{\"index\":{},\"ready\":{},\"failed\":{},\"checksum\":{},\"nonzero_pixels\":{},\"damage\":[{}]}}",
                frame.index, frame.ready, failed, frame.checksum, frame.nonzero_pixels, damage
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let body = format!(
        "{{\"buffer_width\":{},\"buffer_height\":{},\"constraints_done\":{},\"stopped\":{},\"frames\":[{}]}}\n",
        status.buffer_width, status.buffer_height, status.constraints_done, status.stopped, frames
    );
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

impl ExtImageCopyClient {
    fn maybe_capture_next(&mut self, qh: &QueueHandle<Self>) {
        if self.exit || self.active_frame.is_some() || !self.status.constraints_done {
            return;
        }
        if self.frame_index >= self.target_frames {
            self.exit = true;
            return;
        }
        let width = self.status.buffer_width.max(1);
        let height = self.status.buffer_height.max(1);
        let required_len = (width * height * 4) as usize;
        if self.pool.len() < required_len {
            self.pool
                .resize(required_len)
                .expect("resize ext image copy pool");
        }
        let (mut buffer, _) = self
            .pool
            .create_buffer(
                width as i32,
                height as i32,
                (width * 4) as i32,
                wayland_client::protocol::wl_shm::Format::Xrgb8888,
            )
            .expect("create ext image copy buffer");
        if let Some(canvas) = self.pool.canvas(&mut buffer) {
            for byte in canvas {
                *byte = 0;
            }
        }
        let frame = self.session.create_frame(qh, ());
        frame.attach_buffer(buffer.wl_buffer());
        if self.frame_index == 1 {
            frame.damage_buffer(0, 0, width as i32, height as i32);
        } else if self.frame_index > 1 {
            frame.damage_buffer(0, 0, (width as i32).min(32), (height as i32).min(32));
        }
        frame.capture();
        self.status.frames.push(ExtImageCopyFrameStatus {
            index: self.frame_index,
            ..ExtImageCopyFrameStatus::default()
        });
        self.active_buffer = Some(buffer);
        self.active_frame = Some(frame);
    }

    fn finish_active_frame(&mut self, ready: bool, failed: Option<String>, qh: &QueueHandle<Self>) {
        let index = self.frame_index;
        if let Some(frame) = self
            .status
            .frames
            .iter_mut()
            .find(|frame| frame.index == index)
        {
            frame.ready = ready;
            frame.failed = failed;
            if ready {
                if let Some(buffer) = self.active_buffer.as_mut() {
                    if let Some(canvas) = self.pool.canvas(buffer) {
                        let mut checksum = 0u64;
                        let mut nonzero = 0u32;
                        for pixel in canvas.chunks_exact(4) {
                            let value = u32::from(pixel[0])
                                | (u32::from(pixel[1]) << 8)
                                | (u32::from(pixel[2]) << 16)
                                | (u32::from(pixel[3]) << 24);
                            checksum = checksum
                                .wrapping_mul(16_777_619)
                                .wrapping_add(u64::from(value));
                            if value != 0 {
                                nonzero = nonzero.saturating_add(1);
                            }
                        }
                        frame.checksum = checksum;
                        frame.nonzero_pixels = nonzero;
                    }
                }
            }
        }
        self.active_frame = None;
        self.active_buffer = None;
        self.frame_index = self.frame_index.saturating_add(1);
        write_ext_image_copy_status(&self.status_path, &self.status);
        self.maybe_capture_next(qh);
    }
}

impl CompositorHandler for ExtImageCopyClient {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl ShmHandler for ExtImageCopyClient {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl OutputHandler for ExtImageCopyClient {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl Dispatch<ExtImageCopyCaptureSessionV1, ()> for ExtImageCopyClient {
    fn event(
        state: &mut Self,
        _proxy: &ExtImageCopyCaptureSessionV1,
        event: ext_image_copy_capture_session_v1::Event,
        _data: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            ext_image_copy_capture_session_v1::Event::BufferSize { width, height } => {
                state.status.buffer_width = width;
                state.status.buffer_height = height;
                write_ext_image_copy_status(&state.status_path, &state.status);
            }
            ext_image_copy_capture_session_v1::Event::Done => {
                state.status.constraints_done = true;
                write_ext_image_copy_status(&state.status_path, &state.status);
                state.maybe_capture_next(qh);
            }
            ext_image_copy_capture_session_v1::Event::Stopped => {
                state.status.stopped = true;
                state.exit = true;
                write_ext_image_copy_status(&state.status_path, &state.status);
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, ()> for ExtImageCopyClient {
    fn event(
        state: &mut Self,
        _proxy: &ExtImageCopyCaptureFrameV1,
        event: ext_image_copy_capture_frame_v1::Event,
        _data: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            ext_image_copy_capture_frame_v1::Event::Damage {
                x,
                y,
                width,
                height,
            } => {
                if let Some(frame) = state.status.frames.last_mut() {
                    frame.damage.push((x, y, width, height));
                    write_ext_image_copy_status(&state.status_path, &state.status);
                }
            }
            ext_image_copy_capture_frame_v1::Event::Ready => {
                state.finish_active_frame(true, None, qh);
            }
            ext_image_copy_capture_frame_v1::Event::Failed { reason } => {
                state.finish_active_frame(false, Some(format!("{reason:?}")), qh);
            }
            _ => {}
        }
    }
}

impl ProvidesRegistryState for ExtImageCopyClient {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState);
}

fn run_ext_image_copy_capture_output(args: &Args) {
    let conn = Connection::connect_to_env().expect("connect ext image copy capture client");
    let (globals, mut event_queue) =
        registry_queue_init::<ExtImageCopyClient>(&conn).expect("init ext image copy registry");
    let qh = event_queue.handle();
    let registry_state = RegistryState::new(&globals);
    let output_state = OutputState::new(&globals, &qh);
    let shm_state = Shm::bind(&globals, &qh).expect("bind wl_shm");
    let output = globals
        .bind::<wl_output::WlOutput, _, _>(&qh, 1..=4, ())
        .expect("bind capture wl_output");
    let output_source_manager = globals
        .bind::<ExtOutputImageCaptureSourceManagerV1, _, _>(&qh, 1..=1, ())
        .expect("bind ext_output_image_capture_source_manager_v1");
    let copy_manager = globals
        .bind::<ExtImageCopyCaptureManagerV1, _, _>(&qh, 1..=1, ())
        .expect("bind ext_image_copy_capture_manager_v1");
    let source = output_source_manager.create_source(&output, &qh, ());
    let session = copy_manager.create_session(
        &source,
        ext_image_copy_capture_manager_v1::Options::empty(),
        &qh,
        (),
    );
    let pool = SlotPool::new(4, &shm_state).expect("create ext image copy pool");
    let mut state = ExtImageCopyClient {
        registry_state,
        output_state,
        shm_state,
        pool,
        _output_source_manager: output_source_manager,
        _copy_manager: copy_manager,
        _source: source,
        session,
        active_frame: None,
        active_buffer: None,
        frame_index: 0,
        target_frames: args.ext_image_copy_capture_frames,
        exit: false,
        status_path: args.status_json.clone(),
        status: ExtImageCopyStatus::default(),
    };
    write_ext_image_copy_status(&state.status_path, &state.status);
    conn.flush().expect("flush initial ext image copy capture");
    while !state.exit {
        event_queue
            .blocking_dispatch(&mut state)
            .expect("dispatch ext image copy capture");
        conn.flush().expect("flush ext image copy capture");
    }
}

fn start_explicit_sync_control(
    socket_path: Option<String>,
    status_path: Option<String>,
    status: std::sync::Arc<Mutex<ExplicitSyncDmabufStatus>>,
    control_triggered: std::sync::Arc<AtomicBool>,
    drm: std::fs::File,
    handle: u32,
) {
    let Some(socket_path) = socket_path else {
        return;
    };
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind explicit sync control socket");
    std::thread::Builder::new()
        .name("derp-explicit-sync-client-control".to_string())
        .spawn(move || {
            if listener.accept().is_ok() {
                control_triggered.store(true, Ordering::SeqCst);
                signal_syncobj_point(&drm, handle, 3);
                update_explicit_sync_status(&status_path, &status, |status| {
                    status.acquire_b_signaled = true;
                });
            }
        })
        .expect("spawn explicit sync control thread");
}

fn start_explicit_sync_release_watcher(
    status_path: Option<String>,
    status: std::sync::Arc<Mutex<ExplicitSyncDmabufStatus>>,
    drm: std::fs::File,
    handle: u32,
    stress_frames: u32,
) {
    std::thread::Builder::new()
        .name("derp-explicit-sync-client-release".to_string())
        .spawn(move || {
            if stress_frames > 0 {
                for frame in 0..stress_frames {
                    let release = 1001 + u64::from(frame) * 2;
                    if wait_syncobj_point(&drm, handle, release, i64::MAX) {
                        update_explicit_sync_status(&status_path, &status, |status| {
                            status.stress_release_observed =
                                status.stress_release_observed.saturating_add(1);
                        });
                    } else {
                        update_explicit_sync_status(&status_path, &status, |status| {
                            status.stress_release_failed = true;
                        });
                        break;
                    }
                }
                return;
            }
            if wait_syncobj_point(&drm, handle, 2, i64::MAX) {
                update_explicit_sync_status(&status_path, &status, |status| {
                    status.release_a_observed = true;
                });
            }
            if wait_syncobj_point(&drm, handle, 4, i64::MAX) {
                update_explicit_sync_status(&status_path, &status, |status| {
                    status.release_b_observed = true;
                });
            }
        })
        .expect("spawn explicit sync release watcher");
}

fn run_explicit_sync_dmabuf(args: &Args) {
    let conn = Connection::connect_to_env().expect("connect explicit sync dmabuf client");
    let (globals, mut event_queue) =
        registry_queue_init::<ExplicitSyncDmabufClient>(&conn).expect("init dmabuf registry");
    let qh = event_queue.handle();
    let compositor_state = CompositorState::bind(&globals, &qh).expect("bind wl_compositor");
    let xdg_shell_state = XdgShell::bind(&globals, &qh).expect("bind xdg_shell");
    let registry_state = RegistryState::new(&globals);
    let output_state = OutputState::new(&globals, &qh);
    let dmabuf = globals
        .bind::<ZwpLinuxDmabufV1, _, _>(&qh, 1..=4, ())
        .expect("bind zwp_linux_dmabuf_v1");
    let sync_manager = globals
        .bind::<WpLinuxDrmSyncobjManagerV1, _, _>(&qh, 1..=1, ())
        .expect("bind wp_linux_drm_syncobj_manager_v1");
    let timeline = create_syncobj_timeline();
    let timeline_proxy = sync_manager.import_timeline(timeline.fd.as_fd(), &qh, ());
    let surface = compositor_state.create_surface(&qh);
    let sync_surface = sync_manager.get_surface(&surface, &qh, ());
    let window = xdg_shell_state.create_window(surface, WindowDecorations::RequestServer, &qh);
    window.set_title(args.title.clone());
    window.set_app_id(args.app_id.clone());
    window.set_min_size(Some((args.width, args.height)));
    window.set_max_size(Some((args.width, args.height)));
    window.commit();
    let status = std::sync::Arc::new(Mutex::new(ExplicitSyncDmabufStatus::default()));
    let control_triggered = std::sync::Arc::new(AtomicBool::new(false));
    write_explicit_sync_status(&args.status_json, &status);
    start_explicit_sync_control(
        args.control_socket.clone(),
        args.status_json.clone(),
        status.clone(),
        control_triggered.clone(),
        timeline.drm.try_clone().expect("clone syncobj drm fd"),
        timeline.handle,
    );
    start_explicit_sync_release_watcher(
        args.status_json.clone(),
        status.clone(),
        timeline.drm.try_clone().expect("clone release drm fd"),
        timeline.handle,
        args.explicit_sync_dmabuf_stress_frames,
    );
    let mut state = ExplicitSyncDmabufClient {
        registry_state,
        output_state,
        _compositor_state: compositor_state,
        _xdg_shell_state: xdg_shell_state,
        window,
        dmabuf,
        sync_surface,
        timeline_proxy,
        timeline,
        width: args.width,
        height: args.height,
        base_title: args.title.clone(),
        buffer_a: None,
        buffer_b: None,
        wl_buffer_a: None,
        wl_buffer_b: None,
        configured: false,
        committed: false,
        stress_frames: args.explicit_sync_dmabuf_stress_frames,
        wait_control: args.explicit_sync_dmabuf_wait_control,
        ready_committed: false,
        control_triggered,
        exit: false,
        status_path: args.status_json.clone(),
        status,
    };
    conn.flush().expect("flush initial explicit sync dmabuf");
    while !state.exit {
        if state.wait_control
            && state.stress_frames > 0
            && !state.committed
            && state.ready_committed
        {
            event_queue
                .dispatch_pending(&mut state)
                .expect("dispatch pending explicit sync dmabuf");
            if state.control_triggered.load(Ordering::SeqCst) {
                state.commit_frames(&qh);
            } else {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        } else {
            event_queue
                .blocking_dispatch(&mut state)
                .expect("dispatch explicit sync dmabuf");
        }
        conn.flush().expect("flush explicit sync dmabuf");
    }
}

impl CompositorHandler for ProtocolProbe {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl ShmHandler for ProtocolProbe {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl OutputHandler for ProtocolProbe {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl ProvidesRegistryState for ProtocolProbe {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState);
}

fn run_explicit_sync_protocol_error(mode: &str, args: &Args) {
    let conn = Connection::connect_to_env().expect("connect explicit sync probe");
    let (globals, mut event_queue) =
        registry_queue_init::<ProtocolProbe>(&conn).expect("init explicit sync registry");
    let qh = event_queue.handle();
    let compositor_state = CompositorState::bind(&globals, &qh).expect("bind wl_compositor");
    let shm_state = Shm::bind(&globals, &qh).expect("bind wl_shm");
    let registry_state = RegistryState::new(&globals);
    let output_state = OutputState::new(&globals, &qh);
    let sync_manager = globals
        .bind::<WpLinuxDrmSyncobjManagerV1, _, _>(&qh, 1..=1, ())
        .expect("bind wp_linux_drm_syncobj_manager_v1");
    let surface = compositor_state.create_surface(&qh);
    let sync_surface = sync_manager.get_surface(&surface, &qh, ());
    let timeline_fd = create_syncobj_timeline_fd();
    let timeline = sync_manager.import_timeline(timeline_fd.as_fd(), &qh, ());
    let pool = SlotPool::new((args.width * args.height * 4) as usize, &shm_state)
        .expect("create protocol pool");
    let mut state = ProtocolProbe {
        registry_state,
        output_state,
        shm_state,
        pool,
        buffer: None,
    };
    match mode {
        "no-buffer" => {
            sync_surface.set_acquire_point(&timeline, 0, 1);
            sync_surface.set_release_point(&timeline, 0, 2);
            surface.commit();
        }
        "no-acquire" => {
            sync_surface.set_release_point(&timeline, 0, 2);
            state.attach_buffer(&surface, args.width, args.height);
            surface.damage_buffer(0, 0, args.width as i32, args.height as i32);
            surface.commit();
        }
        "no-release" => {
            sync_surface.set_acquire_point(&timeline, 0, 1);
            state.attach_buffer(&surface, args.width, args.height);
            surface.damage_buffer(0, 0, args.width as i32, args.height as i32);
            surface.commit();
        }
        "unsupported-buffer" => {
            sync_surface.set_acquire_point(&timeline, 0, 1);
            sync_surface.set_release_point(&timeline, 0, 2);
            state.attach_buffer(&surface, args.width, args.height);
            surface.damage_buffer(0, 0, args.width as i32, args.height as i32);
            surface.commit();
        }
        "conflicting-points" => {
            sync_surface.set_acquire_point(&timeline, 0, 1);
            sync_surface.set_release_point(&timeline, 0, 1);
            state.attach_buffer(&surface, args.width, args.height);
            surface.damage_buffer(0, 0, args.width as i32, args.height as i32);
            surface.commit();
        }
        other => panic!("unsupported --explicit-sync-error mode: {other}"),
    }
    loop {
        match event_queue.blocking_dispatch(&mut state) {
            Ok(_) => {}
            Err(error) => {
                eprintln!("dispatch explicit sync protocol error: {error:?}");
                std::process::exit(101);
            }
        }
    }
}

fn draw_pattern(
    canvas: &mut [u8],
    width: u32,
    height: u32,
    token: &str,
    strip_color: [u8; 4],
    rounded_corners: bool,
    no_border: bool,
    solid_client: bool,
) {
    let seed = hash_token(token);
    let bg = color(seed, 0x10);
    let accent_a = color(seed.rotate_left(11), 0x28);
    let accent_b = color(seed.rotate_left(23), 0x34);
    let accent_c = color(seed.rotate_left(37), 0x40);
    let border = [18, 18, 22, 255];
    let light = [244, 244, 248, 255];
    let width_i = width as usize;
    let height_i = height as usize;
    let border_px = if no_border {
        0
    } else {
        (width.min(height) / 40).max(3) as usize
    };
    let header_h = (height / 7).max(24) as usize;
    let strip_h = (height / 16).max(18) as usize;
    let footer_h = (height / 8).max(28) as usize;
    let grid_top = header_h + border_px;
    let grid_bottom = height_i.saturating_sub(footer_h + border_px);
    let grid_h = grid_bottom.saturating_sub(grid_top).max(1);
    let cell_w = (width_i.saturating_sub(border_px * 2) / 8).max(1);
    let cell_h = (grid_h / 4).max(1);
    let bars = token.as_bytes();

    for y in 0..height_i {
        for x in 0..width_i {
            let mut rgba = if solid_client {
                strip_color
            } else if x < border_px
                || y < border_px
                || x >= width_i.saturating_sub(border_px)
                || y >= height_i.saturating_sub(border_px)
            {
                border
            } else if y < strip_h {
                strip_color
            } else if y < header_h {
                mix(accent_a, accent_b, x as u32, width.max(1))
            } else if y >= height_i.saturating_sub(footer_h) {
                footer_color(
                    x, y, width_i, height_i, footer_h, bars, accent_b, accent_c, light,
                )
            } else {
                let gx = (x.saturating_sub(border_px)) / cell_w;
                let gy = (y.saturating_sub(grid_top)) / cell_h;
                let cell_seed = seed
                    ^ ((gx as u64).wrapping_mul(0x9e37_79b9))
                    ^ ((gy as u64).wrapping_mul(0x85eb_ca6b));
                let base = if (gx + gy) % 2 == 0 {
                    color(cell_seed.rotate_left(7), 0x30)
                } else {
                    color(cell_seed.rotate_left(19), 0x50)
                };
                let mut rgba = brighten(base, if (gx + gy) % 3 == 0 { 22 } else { 0 });
                let cx = width_i / 2;
                let cy = grid_top + grid_h / 2;
                let dx = x.abs_diff(cx);
                let dy = y.abs_diff(cy);
                if dx < border_px * 2 || dy < border_px * 2 {
                    rgba = light;
                }
                if dx < border_px || dy < border_px {
                    rgba = border;
                }
                if (x + y + ((seed >> 8) as usize)) % 29 == 0 {
                    rgba = brighten(bg, 18);
                }
                rgba
            };
            if rounded_corners {
                let radius = (width.min(height) / 9).clamp(18, 64) as usize;
                let left = x < radius;
                let right = x >= width_i.saturating_sub(radius);
                let top = y < radius;
                let bottom = y >= height_i.saturating_sub(radius);
                if (left || right) && (top || bottom) {
                    let cx = if left {
                        radius
                    } else {
                        width_i.saturating_sub(radius + 1)
                    };
                    let cy = if top {
                        radius
                    } else {
                        height_i.saturating_sub(radius + 1)
                    };
                    let dx = x.abs_diff(cx);
                    let dy = y.abs_diff(cy);
                    let dist2 = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
                    let outer = radius.saturating_mul(radius);
                    let inner = radius
                        .saturating_sub(2)
                        .saturating_mul(radius.saturating_sub(2));
                    if dist2 > outer {
                        rgba = [0, 0, 0, 0];
                    } else if dist2 > inner {
                        rgba[3] = 128;
                    }
                }
            }
            put_pixel(canvas, width_i, x, y, rgba);
        }
    }
}

fn footer_color(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    footer_h: usize,
    bars: &[u8],
    accent_a: [u8; 4],
    accent_b: [u8; 4],
    light: [u8; 4],
) -> [u8; 4] {
    let local_y = y.saturating_sub(height.saturating_sub(footer_h));
    let bar_width = (width / bars.len().max(1)).max(1);
    let idx = (x / bar_width).min(bars.len().saturating_sub(1));
    let byte = bars.get(idx).copied().unwrap_or(0);
    let threshold = ((byte as usize) % footer_h.max(1)).max(3);
    if local_y >= footer_h.saturating_sub(threshold) {
        if byte.count_ones() % 2 == 0 {
            accent_a
        } else {
            accent_b
        }
    } else if local_y % 7 == 0 {
        light
    } else {
        [28, 28, 34, 255]
    }
}

fn mix(a: [u8; 4], b: [u8; 4], pos: u32, span: u32) -> [u8; 4] {
    let t = pos.min(span) as u64;
    let span = span.max(1) as u64;
    [
        (((a[0] as u64) * (span - t) + (b[0] as u64) * t) / span) as u8,
        (((a[1] as u64) * (span - t) + (b[1] as u64) * t) / span) as u8,
        (((a[2] as u64) * (span - t) + (b[2] as u64) * t) / span) as u8,
        255,
    ]
}

fn brighten(mut color: [u8; 4], amount: u8) -> [u8; 4] {
    color[0] = color[0].saturating_add(amount);
    color[1] = color[1].saturating_add(amount);
    color[2] = color[2].saturating_add(amount);
    color
}

fn color(seed: u64, bias: u8) -> [u8; 4] {
    [
        ((seed & 0xff) as u8).saturating_div(2).saturating_add(bias),
        (((seed >> 8) & 0xff) as u8)
            .saturating_div(2)
            .saturating_add(bias),
        (((seed >> 16) & 0xff) as u8)
            .saturating_div(2)
            .saturating_add(bias),
        255,
    ]
}

fn parse_strip_color(strip: &str, token: &str) -> Result<[u8; 4], String> {
    let trimmed = strip.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        let seed = hash_token(token).rotate_left(5);
        return Ok(color(seed, 0x60));
    }
    let named = match trimmed.to_ascii_lowercase().as_str() {
        "red" => Some([220, 60, 60, 255]),
        "green" => Some([50, 190, 90, 255]),
        "blue" => Some([70, 110, 230, 255]),
        "yellow" => Some([220, 190, 60, 255]),
        "orange" => Some([230, 130, 50, 255]),
        "purple" => Some([150, 90, 220, 255]),
        "pink" => Some([230, 90, 170, 255]),
        "cyan" => Some([60, 190, 210, 255]),
        "white" => Some([235, 235, 235, 255]),
        "gray" | "grey" => Some([140, 140, 150, 255]),
        "black" => Some([30, 30, 34, 255]),
        _ => None,
    };
    if let Some(color) = named {
        return Ok(color);
    }
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "expected auto, a named color, or #RRGGBB, got {trimmed}"
        ));
    }
    let r = u8::from_str_radix(&hex[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&hex[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&hex[4..6], 16).map_err(|e| e.to_string())?;
    Ok([r, g, b, 255])
}

fn hash_token(token: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in token.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn put_pixel(canvas: &mut [u8], width: usize, x: usize, y: usize, rgba: [u8; 4]) {
    let idx = (y * width + x) * 4;
    canvas[idx] = rgba[2];
    canvas[idx + 1] = rgba[1];
    canvas[idx + 2] = rgba[0];
    canvas[idx + 3] = rgba[3];
}

impl CompositorHandler for TestClient {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        conn: &Connection,
        qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
        if self.drop_buffer_after_draw && !self.buffer_dropped {
            self.pending_presentation_loops = self.pending_presentation_loops.saturating_add(1);
            if self.pending_presentation_loops < 20 {
                self.window
                    .wl_surface()
                    .frame(qh, self.window.wl_surface().clone());
                self.window.wl_surface().commit();
                return;
            }
            self.drop_buffer();
            return;
        }
        if self.burst_frames_remaining > 0 {
            self.burst_frames_remaining = self.burst_frames_remaining.saturating_sub(1);
            self.needs_redraw = true;
            self.draw(conn, qh);
        }
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for TestClient {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl WindowHandler for TestClient {
    fn request_close(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _window: &Window) {
        self.exit = true;
    }

    fn configure(
        &mut self,
        conn: &Connection,
        qh: &QueueHandle<Self>,
        _window: &Window,
        configure: WindowConfigure,
        _serial: u32,
    ) {
        self.buffer = None;
        if let Some(width) = configure.new_size.0.map(|v| v.get()) {
            self.width = width;
        }
        if let Some(height) = configure.new_size.1.map(|v| v.get()) {
            self.height = height;
        }
        self.configured = true;
        self.needs_redraw = true;
        if !(self.drop_buffer_after_draw && !self.buffer_dropped) {
            self.pending_presentation_loops = 0;
        }
        self.ensure_game_pointer_state(qh);
        self.draw(conn, qh);
    }
}

impl PopupHandler for TestClient {
    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        popup: &Popup,
        _config: PopupConfigure,
    ) {
        self.configure_xdg_popup_probe(popup);
    }

    fn done(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, popup: &Popup) {
        self.xdg_popup_probe_done(popup);
    }
}

impl ActivationHandler for TestClient {
    type RequestData = RequestData;

    fn new_token(&mut self, token: String, _data: &Self::RequestData) {
        if self.spawn_on_press_requested {
            return;
        }
        if let Some(path) = self.activation_token_file.as_ref() {
            std::fs::write(path, &token).expect("write activation token file");
        }
        let Some(command) = self.spawn_on_press_command.as_ref() else {
            return;
        };
        self.spawn_on_press_requested = true;
        let mut child = std::process::Command::new("/bin/sh");
        child
            .arg("-c")
            .arg(command)
            .env("XDG_ACTIVATION_TOKEN", token);
        child.spawn().expect("spawn-on-press child");
    }
}

impl KeyboardHandler for TestClient {
    fn enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        surface: &wl_surface::WlSurface,
        _serial: u32,
        _raw: &[u32],
        _keysyms: &[Keysym],
    ) {
        if self.xdg_popup_grab_probe {
            self.xdg_popup_status.keyboard_enters =
                self.xdg_popup_status.keyboard_enters.saturating_add(1);
            self.xdg_popup_status.keyboard_enter_surface =
                self.popup_surface_label(surface).to_string();
            self.write_xdg_popup_status();
        }
    }

    fn leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _surface: &wl_surface::WlSurface,
        _serial: u32,
    ) {
    }

    fn press_key(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        serial: u32,
        event: KeyEvent,
    ) {
        if self.xdg_popup_grab_probe && event.keysym == Keysym::Escape {
            self.xdg_popup_status.escape_pressed =
                self.xdg_popup_status.escape_pressed.saturating_add(1);
            self.destroy_topmost_xdg_popup();
        }
        let Some(seat) = self.keyboard_seat.as_ref() else {
            return;
        };
        self.request_spawn_activation(qh, serial, seat.clone(), self.window.wl_surface().clone());
    }

    fn repeat_key(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _serial: u32,
        _event: KeyEvent,
    ) {
    }

    fn release_key(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        serial: u32,
        _event: KeyEvent,
    ) {
        let Some(seat) = self.keyboard_seat.as_ref() else {
            return;
        };
        self.request_spawn_activation(qh, serial, seat.clone(), self.window.wl_surface().clone());
    }

    fn update_modifiers(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _serial: u32,
        _modifiers: Modifiers,
        _raw_modifiers: RawModifiers,
        _layout: u32,
    ) {
    }

    fn update_repeat_info(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _keyboard: &wl_keyboard::WlKeyboard,
        _info: RepeatInfo,
    ) {
    }
}

impl ShmHandler for TestClient {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl CompositorHandler for LayerPanelClient {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for LayerPanelClient {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl ShmHandler for LayerPanelClient {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl Dispatch<ZwlrLayerSurfaceV1, ()> for LayerPanelClient {
    fn event(
        state: &mut Self,
        proxy: &ZwlrLayerSurfaceV1,
        event: LayerSurfaceEvent,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        if let LayerSurfaceEvent::Configure {
            serial,
            width,
            height,
        } = event
        {
            proxy.ack_configure(serial);
            state.width = width.max(1);
            state.height = height.max(1);
            state.buffer = None;
            state.configured = true;
            state.draw();
        }
    }
}

impl SeatHandler for TestClient {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard && self.keyboard.is_none() {
            self.keyboard_seat = Some(seat.clone());
            let keyboard = self
                .seat_state
                .get_keyboard(qh, &seat, None)
                .expect("create keyboard");
            self.keyboard = Some(keyboard);
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            self.pointer_seat = Some(seat.clone());
            let pointer = self
                .seat_state
                .get_pointer(qh, &seat)
                .expect("create pointer");
            if let Some(manager) = self._xdg_toplevel_drag_data_device_manager.as_ref() {
                self._xdg_toplevel_drag_data_device = Some(manager.get_data_device(&seat, qh, ()));
            }
            self.relative_pointer = self
                .relative_pointer_state
                .get_relative_pointer(&pointer, qh)
                .ok();
            self.pointer = Some(pointer);
            self.ensure_game_pointer_state(qh);
            self.ensure_gesture_pointer_state(qh);
            self.ensure_cursor_shape_pointer_state(qh);
        }
        if capability == Capability::Touch && self.touch.is_none() {
            self.touch_seat = Some(seat.clone());
            let touch = self.seat_state.get_touch(qh, &seat).expect("create touch");
            self.touch = Some(touch);
            self.touch_status.device_ready = true;
            self.write_touch_status();
        }
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard {
            if let Some(keyboard) = self.keyboard.take() {
                keyboard.release();
            }
            self.keyboard_seat = None;
        }
        if capability == Capability::Pointer {
            if let Some(constraint) = self.pointer_constraint.take() {
                constraint.destroy();
            }
            if let Some(relative_pointer) = self.relative_pointer.take() {
                relative_pointer.destroy();
            }
            if let Some(gesture) = self.gesture_swipe.take() {
                gesture.destroy();
            }
            if let Some(gesture) = self.gesture_pinch.take() {
                gesture.destroy();
            }
            if let Some(gesture) = self.gesture_hold.take() {
                gesture.destroy();
            }
            if let Some(device) = self.cursor_shape_device.take() {
                device.destroy();
            }
            self.gesture_ready = false;
            self.gesture_ready_pending = false;
            if let Some(pointer) = self.pointer.take() {
                pointer.release();
            }
            if let Some(data_device) = self._xdg_toplevel_drag_data_device.take() {
                data_device.release();
            }
            self.constraint_locked = false;
            self.constraint_confined = false;
            self.pointer_seat = None;
        }
        if capability == Capability::Touch {
            if let Some(touch) = self.touch.take() {
                touch.release();
            }
            self.touch_seat = None;
            self.touch_status.device_ready = false;
            self.write_touch_status();
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
}

impl PointerHandler for TestClient {
    fn pointer_frame(
        &mut self,
        conn: &Connection,
        qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            let Some(seat) = self.pointer_seat.clone() else {
                continue;
            };
            match event.kind {
                PointerEventKind::Enter { serial, .. } => {
                    if self.xdg_popup_grab_probe {
                        self.xdg_popup_status.pointer_enters =
                            self.xdg_popup_status.pointer_enters.saturating_add(1);
                        self.xdg_popup_status.last_pointer_surface =
                            self.popup_surface_label(&event.surface).to_string();
                        self.write_xdg_popup_status();
                    }
                    self.gesture_status.pointer_enter =
                        self.gesture_status.pointer_enter.saturating_add(1);
                    self.write_gesture_status();
                    self.cursor_shape_pointer_enter =
                        self.cursor_shape_pointer_enter.saturating_add(1);
                    self.ensure_cursor_shape_pointer_state(qh);
                    if let Some(device) = self.cursor_shape_device.as_ref() {
                        device.set_shape(serial, CursorShape::Pointer);
                        self.cursor_shape_set = self.cursor_shape_set.saturating_add(1);
                    }
                    self.write_cursor_shape_status();
                    if self.request_token_on_pointer_enter {
                        self.request_spawn_activation(qh, serial, seat, event.surface.clone());
                    }
                }
                PointerEventKind::Press { serial, button, .. } => {
                    self.touch_status.pointer_press =
                        self.touch_status.pointer_press.saturating_add(1);
                    self.write_touch_status();
                    if self.xdg_popup_grab_probe && button == 0x110 {
                        let label = self.popup_surface_label(&event.surface);
                        self.xdg_popup_status.pointer_presses =
                            self.xdg_popup_status.pointer_presses.saturating_add(1);
                        self.xdg_popup_status.last_press_surface = label.to_string();
                        self.write_xdg_popup_status();
                        if let Some(seat) = self.pointer_seat.clone() {
                            if label == "toplevel" {
                                self.open_xdg_popup_parent(qh, &seat, serial);
                                let _ = conn.flush();
                            } else if label == "parent" {
                                self.open_xdg_popup_child(qh, &seat, serial);
                                let _ = conn.flush();
                            }
                        }
                    }
                    self.request_spawn_activation(qh, serial, seat.clone(), event.surface.clone());
                    if button == 0x110 {
                        self.maybe_start_xdg_toplevel_drag(qh, serial);
                    }
                    if self.move_on_header_press
                        && button == 0x110
                        && event.position.1 >= 0.0
                        && event.position.1 <= f64::from((self.height / 7).max(24))
                    {
                        self.window.move_(&seat, serial);
                    }
                }
                PointerEventKind::Release { serial, .. } => {
                    self.request_spawn_activation(qh, serial, seat, event.surface.clone());
                }
                _ => {}
            }
        }
    }
}

impl TouchHandler for TestClient {
    fn down(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _touch: &wl_touch::WlTouch,
        _serial: u32,
        _time: u32,
        surface: wl_surface::WlSurface,
        id: i32,
        position: (f64, f64),
    ) {
        self.touch_status.down = self.touch_status.down.saturating_add(1);
        self.touch_status.frame = self.touch_status.frame.saturating_add(1);
        self.touch_status.last_id = id;
        self.touch_status.last_surface = self.popup_surface_label(&surface).to_string();
        self.touch_status.last_x = position.0;
        self.touch_status.last_y = position.1;
        self.write_touch_status();
    }

    fn up(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _touch: &wl_touch::WlTouch,
        _serial: u32,
        _time: u32,
        id: i32,
    ) {
        self.touch_status.up = self.touch_status.up.saturating_add(1);
        self.touch_status.frame = self.touch_status.frame.saturating_add(1);
        self.touch_status.last_id = id;
        self.write_touch_status();
    }

    fn motion(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _touch: &wl_touch::WlTouch,
        _time: u32,
        id: i32,
        position: (f64, f64),
    ) {
        self.touch_status.motion = self.touch_status.motion.saturating_add(1);
        self.touch_status.frame = self.touch_status.frame.saturating_add(1);
        self.touch_status.last_id = id;
        self.touch_status.last_x = position.0;
        self.touch_status.last_y = position.1;
        self.write_touch_status();
    }

    fn shape(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _touch: &wl_touch::WlTouch,
        _id: i32,
        _major: f64,
        _minor: f64,
    ) {
    }

    fn orientation(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _touch: &wl_touch::WlTouch,
        _id: i32,
        _orientation: f64,
    ) {
    }

    fn cancel(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _touch: &wl_touch::WlTouch) {
        self.touch_status.cancel = self.touch_status.cancel.saturating_add(1);
        self.write_touch_status();
    }
}

impl PointerConstraintsHandler for TestClient {
    fn confined(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _confined_pointer: &zwp_confined_pointer_v1::ZwpConfinedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_confined = true;
        self.constraint_locked = false;
        self.update_status_title();
    }

    fn unconfined(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _confined_pointer: &zwp_confined_pointer_v1::ZwpConfinedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_confined = false;
        self.update_status_title();
    }

    fn locked(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _locked_pointer: &zwp_locked_pointer_v1::ZwpLockedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_locked = true;
        self.constraint_confined = false;
        self.update_status_title();
    }

    fn unlocked(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _locked_pointer: &zwp_locked_pointer_v1::ZwpLockedPointerV1,
        _surface: &wl_surface::WlSurface,
        _pointer: &wl_pointer::WlPointer,
    ) {
        self.constraint_locked = false;
        self.update_status_title();
    }
}

impl RelativePointerHandler for TestClient {
    fn relative_pointer_motion(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _relative_pointer: &zwp_relative_pointer_v1::ZwpRelativePointerV1,
        _pointer: &wl_pointer::WlPointer,
        event: RelativeMotionEvent,
    ) {
        self.last_relative = event.delta;
        self.total_relative.0 += event.delta.0;
        self.total_relative.1 += event.delta.1;
        self.update_status_title();
    }
}

impl Dispatch<zwp_pointer_gesture_swipe_v1::ZwpPointerGestureSwipeV1, ()> for TestClient {
    fn event(
        state: &mut Self,
        _proxy: &zwp_pointer_gesture_swipe_v1::ZwpPointerGestureSwipeV1,
        event: zwp_pointer_gesture_swipe_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            zwp_pointer_gesture_swipe_v1::Event::Begin { fingers, .. } => {
                state.gesture_status.swipe_begin =
                    state.gesture_status.swipe_begin.saturating_add(1);
                state.gesture_status.last_cancelled = false;
                let _ = fingers;
            }
            zwp_pointer_gesture_swipe_v1::Event::Update { dx, dy, .. } => {
                state.gesture_status.swipe_update =
                    state.gesture_status.swipe_update.saturating_add(1);
                state.gesture_status.last_swipe_delta = (dx, dy);
            }
            zwp_pointer_gesture_swipe_v1::Event::End { cancelled, .. } => {
                state.gesture_status.swipe_end = state.gesture_status.swipe_end.saturating_add(1);
                state.gesture_status.last_cancelled = cancelled != 0;
            }
            _ => {}
        }
        state.write_gesture_status();
    }
}

impl Dispatch<zwp_pointer_gesture_pinch_v1::ZwpPointerGesturePinchV1, ()> for TestClient {
    fn event(
        state: &mut Self,
        _proxy: &zwp_pointer_gesture_pinch_v1::ZwpPointerGesturePinchV1,
        event: zwp_pointer_gesture_pinch_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            zwp_pointer_gesture_pinch_v1::Event::Begin { fingers, .. } => {
                state.gesture_status.pinch_begin =
                    state.gesture_status.pinch_begin.saturating_add(1);
                state.gesture_status.last_cancelled = false;
                let _ = fingers;
            }
            zwp_pointer_gesture_pinch_v1::Event::Update {
                dx,
                dy,
                scale,
                rotation,
                ..
            } => {
                state.gesture_status.pinch_update =
                    state.gesture_status.pinch_update.saturating_add(1);
                state.gesture_status.last_pinch_delta = (dx, dy);
                state.gesture_status.last_pinch_scale = scale;
                state.gesture_status.last_pinch_rotation = rotation;
            }
            zwp_pointer_gesture_pinch_v1::Event::End { cancelled, .. } => {
                state.gesture_status.pinch_end = state.gesture_status.pinch_end.saturating_add(1);
                state.gesture_status.last_cancelled = cancelled != 0;
            }
            _ => {}
        }
        state.write_gesture_status();
    }
}

impl Dispatch<zwp_pointer_gesture_hold_v1::ZwpPointerGestureHoldV1, ()> for TestClient {
    fn event(
        state: &mut Self,
        _proxy: &zwp_pointer_gesture_hold_v1::ZwpPointerGestureHoldV1,
        event: zwp_pointer_gesture_hold_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            zwp_pointer_gesture_hold_v1::Event::Begin { fingers, .. } => {
                state.gesture_status.hold_begin = state.gesture_status.hold_begin.saturating_add(1);
                state.gesture_status.last_cancelled = false;
                let _ = fingers;
            }
            zwp_pointer_gesture_hold_v1::Event::End { cancelled, .. } => {
                state.gesture_status.hold_end = state.gesture_status.hold_end.saturating_add(1);
                state.gesture_status.last_cancelled = cancelled != 0;
            }
            _ => {}
        }
        state.write_gesture_status();
    }
}

impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, ()> for TestClient {
    fn event(
        state: &mut Self,
        _proxy: &wp_presentation_feedback::WpPresentationFeedback,
        event: wp_presentation_feedback::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            wp_presentation_feedback::Event::Presented { .. } => {
                state.presentation_presented = state.presentation_presented.saturating_add(1);
                state.update_status_title();
            }
            wp_presentation_feedback::Event::Discarded => {
                state.presentation_discarded = state.presentation_discarded.saturating_add(1);
                state.update_status_title();
            }
            _ => {}
        }
    }
}

delegate_compositor!(TestClient);
delegate_output!(TestClient);
delegate_shm!(TestClient);
delegate_pointer!(TestClient);
delegate_touch!(TestClient);
delegate_pointer_constraints!(TestClient);
delegate_relative_pointer!(TestClient);
delegate_xdg_shell!(TestClient);
delegate_xdg_window!(TestClient);
delegate_xdg_popup!(TestClient);
delegate_seat!(TestClient);
delegate_registry!(TestClient);
delegate_activation!(TestClient);
delegate_keyboard!(TestClient);
delegate_noop!(TestClient: ignore WpFifoManagerV1);
delegate_noop!(TestClient: ignore WpFifoV1);
delegate_noop!(TestClient: ignore WpCursorShapeManagerV1);
delegate_noop!(TestClient: ignore WpCursorShapeDeviceV1);
delegate_noop!(TestClient: ignore WpPresentation);
delegate_noop!(TestClient: ignore WpContentTypeManagerV1);
delegate_noop!(TestClient: ignore wp_content_type_v1::WpContentTypeV1);
delegate_noop!(TestClient: ignore WpTearingControlManagerV1);
delegate_noop!(TestClient: ignore wp_tearing_control_v1::WpTearingControlV1);
delegate_noop!(TestClient: ignore XdgToplevelIconManagerV1);
delegate_noop!(TestClient: ignore XdgToplevelIconV1);
delegate_noop!(TestClient: ignore XdgToplevelDragManagerV1);
delegate_noop!(TestClient: ignore XdgToplevelDragV1);
delegate_noop!(TestClient: ignore wl_data_device_manager::WlDataDeviceManager);
delegate_noop!(TestClient: ignore wl_data_device::WlDataDevice);
delegate_noop!(TestClient: ignore wl_data_source::WlDataSource);
delegate_noop!(TestClient: ignore ZwpPointerGesturesV1);
delegate_noop!(TestClient: ignore ZxdgDecorationManagerV1);
delegate_noop!(TestClient: ignore ZxdgToplevelDecorationV1);
delegate_noop!(TestClient: ignore OrgKdeKwinServerDecorationManager);
delegate_noop!(TestClient: ignore OrgKdeKwinServerDecoration);
delegate_compositor!(LayerPanelClient);
delegate_output!(LayerPanelClient);
delegate_shm!(LayerPanelClient);
delegate_registry!(LayerPanelClient);
delegate_noop!(LayerPanelClient: ignore ZwlrLayerShellV1);
delegate_noop!(LayerPanelClient: ignore wl_buffer::WlBuffer);
delegate_compositor!(ProtocolProbe);
delegate_output!(ProtocolProbe);
delegate_shm!(ProtocolProbe);
delegate_registry!(ProtocolProbe);
delegate_noop!(ProtocolProbe: ignore WpLinuxDrmSyncobjManagerV1);
delegate_noop!(ProtocolProbe: ignore WpLinuxDrmSyncobjSurfaceV1);
delegate_noop!(ProtocolProbe: ignore WpLinuxDrmSyncobjTimelineV1);
delegate_compositor!(ExplicitSyncDmabufClient);
delegate_output!(ExplicitSyncDmabufClient);
delegate_xdg_shell!(ExplicitSyncDmabufClient);
delegate_xdg_window!(ExplicitSyncDmabufClient);
delegate_registry!(ExplicitSyncDmabufClient);
delegate_noop!(ExplicitSyncDmabufClient: ignore ZwpLinuxDmabufV1);
delegate_noop!(ExplicitSyncDmabufClient: ignore zwp_linux_buffer_params_v1::ZwpLinuxBufferParamsV1);
delegate_noop!(ExplicitSyncDmabufClient: ignore WpLinuxDrmSyncobjManagerV1);
delegate_noop!(ExplicitSyncDmabufClient: ignore WpLinuxDrmSyncobjSurfaceV1);
delegate_noop!(ExplicitSyncDmabufClient: ignore WpLinuxDrmSyncobjTimelineV1);
delegate_noop!(ExplicitSyncDmabufClient: ignore wl_buffer::WlBuffer);
delegate_output!(ExtImageCopyClient);
delegate_shm!(ExtImageCopyClient);
delegate_registry!(ExtImageCopyClient);
delegate_noop!(ExtImageCopyClient: ignore wl_output::WlOutput);
delegate_noop!(ExtImageCopyClient: ignore wl_buffer::WlBuffer);
delegate_noop!(ExtImageCopyClient: ignore ExtOutputImageCaptureSourceManagerV1);
delegate_noop!(ExtImageCopyClient: ignore ExtImageCopyCaptureManagerV1);
delegate_noop!(ExtImageCopyClient: ignore ExtImageCaptureSourceV1);

impl ProvidesRegistryState for TestClient {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState, SeatState);
}

impl ProvidesRegistryState for LayerPanelClient {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers!(OutputState);
}
