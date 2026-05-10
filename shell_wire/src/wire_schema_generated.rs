#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameDmabufPlane {
    pub plane_idx: u32,
    pub stride: u32,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputLayoutScreen {
    pub name: String,
    pub identity: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub usable_x: i32,
    pub usable_y: i32,
    pub usable_w: u32,
    pub usable_h: u32,
    pub physical_w: u32,
    pub physical_h: u32,
    pub transform: u32,
    pub refresh_milli_hz: u32,
    pub vrr_supported: bool,
    pub vrr_enabled: bool,
    pub taskbar_side: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellWindowIconBufferSnapshot {
    pub width: i32,
    pub height: i32,
    pub scale: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellWindowSnapshot {
    pub window_id: u32,
    pub surface_id: u32,
    pub stack_z: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub client_x: i32,
    pub client_y: i32,
    pub client_w: i32,
    pub client_h: i32,
    pub frame_x: i32,
    pub frame_y: i32,
    pub frame_w: i32,
    pub frame_h: i32,
    pub minimized: u32,
    pub maximized: u32,
    pub fullscreen: u32,
    pub client_side_decoration: u32,
    pub workspace_visible: u32,
    pub shell_flags: u32,
    pub title: String,
    pub app_id: String,
    pub output_id: String,
    pub output_name: String,
    pub capture_identifier: String,
    pub kind: String,
    pub x11_class: String,
    pub x11_instance: String,
    pub icon_name: String,
    pub icon_buffers: Vec<ShellWindowIconBufferSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellWindowOrderEntry {
    pub window_id: u32,
    pub stack_z: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellSharedStateHeader {
    pub magic: u32,
    pub abi_version: u32,
    pub payload_len: u32,
    pub flags: u32,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellUiWindowWireRow {
    pub id: u32,
    pub gx: i32,
    pub gy: i32,
    pub gw: u32,
    pub gh: u32,
    pub z: u32,
    pub flags: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellSharedStateExclusionRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub window_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellSharedStateTrayStrip {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositorInteractionVisual {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraySniItemWire {
    pub id: String,
    pub title: String,
    pub icon_png: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraySniMenuEntryWire {
    pub dbusmenu_id: i32,
    pub label: String,
    pub separator: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraySniMenuWire {
    pub request_serial: u32,
    pub notifier_id: String,
    pub menu_path: String,
    pub entries: Vec<TraySniMenuEntryWire>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SniTrayLoopMsg {
    Items(Vec<TraySniItemWire>),
    Menu(TraySniMenuWire),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedMessage {
    FrameDmabufCommit {
        width: u32,
        height: u32,
        drm_format: u32,
        modifier: u64,
        flags: u32,
        generation: u32,
        planes: Vec<FrameDmabufPlane>,
    },
    SpawnWaylandClient {
        command: String,
    },
    ShellMoveBegin {
        window_id: u32,
    },
    ShellMoveDelta {
        dx: i32,
        dy: i32,
    },
    ShellMoveEnd {
        window_id: u32,
    },
    ShellResizeBegin {
        window_id: u32,
        edges: u32,
    },
    ShellResizeDelta {
        dx: i32,
        dy: i32,
    },
    ShellResizeEnd {
        window_id: u32,
    },
    ShellListWindows,
    ShellSetGeometry {
        window_id: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        layout_state: u32,
    },
    ShellClose {
        window_id: u32,
    },
    ShellSetFullscreen {
        window_id: u32,
        enabled: bool,
    },
    ShellSetMaximized {
        window_id: u32,
        enabled: bool,
    },
    ShellSetPresentationFullscreen {
        enabled: bool,
    },
    ShellTaskbarActivate {
        window_id: u32,
    },
    ShellMinimize {
        window_id: u32,
    },
    ShellQuitCompositor,
    ShellSetOutputLayout {
        layout_json: String,
    },
    ShellContextMenu {
        visible: bool,
        bx: i32,
        by: i32,
        bw: u32,
        bh: u32,
        gx: i32,
        gy: i32,
        gw: u32,
        gh: u32,
    },
    ShellTilePreview {
        visible: bool,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    ShellChromeMetrics {
        titlebar_h: i32,
        border_w: i32,
    },
    ShellWindowsSync {
        generation: u32,
        windows: Vec<ShellUiWindowWireRow>,
    },
    ShellWorkspaceMutation {
        mutation_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedCompositorToShellMessage {
    PointerMove {
        x: i32,
        y: i32,
        modifiers: u32,
    },
    PointerButton {
        x: i32,
        y: i32,
        button: u32,
        mouse_up: bool,
        titlebar_drag_window_id: u32,
        modifiers: u32,
    },
    Touch {
        touch_id: i32,
        phase: u32,
        x: i32,
        y: i32,
    },
    PointerAxis {
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
        modifiers: u32,
    },
    Key {
        cef_key_type: u32,
        modifiers: u32,
        windows_key_code: i32,
        native_key_code: i32,
        character: u32,
        unmodified_character: u32,
    },
    OutputGeometry {
        logical_w: u32,
        logical_h: u32,
        physical_w: u32,
        physical_h: u32,
    },
    OutputLayout {
        revision: u64,
        canvas_logical_w: u32,
        canvas_logical_h: u32,
        canvas_physical_w: u32,
        canvas_physical_h: u32,
        screens: Vec<OutputLayoutScreen>,
        shell_chrome_primary: Option<String>,
        taskbar_auto_hide: bool,
    },
    WindowMapped {
        window_id: u32,
        surface_id: u32,
        stack_z: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        minimized: bool,
        maximized: bool,
        fullscreen: bool,
        title: String,
        app_id: String,
        client_side_decoration: bool,
        shell_flags: u32,
        output_id: String,
        output_name: String,
        capture_identifier: String,
        kind: String,
        x11_class: String,
        x11_instance: String,
    },
    WindowUnmapped {
        window_id: u32,
    },
    WindowGeometry {
        window_id: u32,
        surface_id: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        client_x: i32,
        client_y: i32,
        client_w: i32,
        client_h: i32,
        frame_x: i32,
        frame_y: i32,
        frame_w: i32,
        frame_h: i32,
        maximized: bool,
        fullscreen: bool,
        client_side_decoration: bool,
        output_id: String,
        output_name: String,
    },
    WindowMetadata {
        window_id: u32,
        surface_id: u32,
        title: String,
        app_id: String,
        icon_name: String,
        icon_buffers: Vec<ShellWindowIconBufferSnapshot>,
    },
    FocusChanged {
        surface_id: Option<u32>,
        window_id: Option<u32>,
    },
    WindowList {
        revision: u64,
        windows: Vec<ShellWindowSnapshot>,
    },
    WindowOrder {
        revision: u64,
        windows: Vec<ShellWindowOrderEntry>,
    },
    WindowState {
        window_id: u32,
        minimized: bool,
    },
    ContextMenuDismiss,
    ProgramsMenuToggle,
    Keybind {
        action: String,
        target_window_id: u32,
        output_name: Option<String>,
    },
    KeyboardLayout {
        label: String,
    },
    VolumeOverlay {
        volume_linear_percent_x100: u16,
        muted: bool,
        state_known: bool,
    },
    WorkspaceState {
        revision: u64,
        state_json: String,
    },
    WorkspaceStateBinary {
        revision: u64,
        state: Vec<u8>,
    },
    ShellHostedAppState {
        revision: u64,
        state_json: String,
    },
    CommandPaletteState {
        revision: u64,
        state_json: String,
    },
    InteractionState {
        revision: u64,
        interaction_serial: u64,
        pointer_x: i32,
        pointer_y: i32,
        move_window_id: u32,
        resize_window_id: u32,
        move_proxy_window_id: u32,
        move_capture_window_id: u32,
        move_visual: Option<CompositorInteractionVisual>,
        resize_visual: Option<CompositorInteractionVisual>,
        window_switcher_selected_window_id: u32,
        super_held: bool,
    },
    NativeDragPreview {
        window_id: u32,
        generation: u32,
        image_path: String,
    },
    MutationAck {
        domain: String,
        client_mutation_id: u64,
        status: String,
        snapshot_epoch: u64,
    },
    NotificationsState {
        state_json: String,
    },
    NotificationEvent {
        notification_id: u32,
        event_type: String,
        action_key: Option<String>,
        close_reason: Option<u32>,
        source: String,
    },
    TrayHints {
        slot_count: u32,
        slot_w: i32,
        reserved_w: u32,
    },
    TraySni {
        items: Vec<TraySniItemWire>,
    },
    TraySniMenu {
        menu: TraySniMenuWire,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ShellWireMessage {
    SpawnWaylandClient = 2,
    CompositorPointerMove = 3,
    CompositorPointerButton = 4,
    OutputGeometry = 5,
    WindowMapped = 6,
    WindowUnmapped = 7,
    WindowGeometry = 8,
    WindowMetadata = 9,
    FocusChanged = 10,
    WindowList = 11,
    ShellMoveBegin = 20,
    ShellMoveDelta = 21,
    ShellMoveEnd = 22,
    ShellListWindows = 23,
    ShellSetGeometry = 24,
    ShellClose = 25,
    ShellSetFullscreen = 26,
    ShellQuitCompositor = 27,
    CompositorTouch = 31,
    FrameDmabufCommit = 33,
    CompositorPointerAxis = 34,
    CompositorKey = 35,
    ShellTaskbarActivate = 36,
    WindowState = 37,
    ShellMinimize = 38,
    ShellResizeBegin = 39,
    ShellResizeDelta = 40,
    ShellResizeEnd = 41,
    ShellSetMaximized = 42,
    ShellSetPresentationFullscreen = 43,
    OutputLayout = 44,
    ShellSetOutputLayout = 45,
    ShellContextMenu = 46,
    CompositorContextMenuDismiss = 47,
    ShellTilePreview = 48,
    ShellChromeMetrics = 49,
    CompositorProgramsMenuToggle = 50,
    CompositorKeybind = 51,
    CompositorKeyboardLayout = 52,
    CompositorVolumeOverlay = 53,
    ShellWindowsSync = 54,
    CompositorTrayHints = 55,
    CompositorTraySni = 56,
    CompositorWorkspaceState = 57,
    ShellWorkspaceMutation = 58,
    CompositorShellHostedAppState = 59,
    CompositorInteractionState = 60,
    CompositorNativeDragPreview = 61,
    CompositorWorkspaceStateBinary = 62,
    WindowOrder = 63,
    CompositorCommandPaletteState = 64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ShellSnapshotDomain {
    Outputs = 1,
    Windows = 2,
    Focus = 4,
    Keyboard = 8,
    Workspace = 16,
    ShellHostedApps = 32,
    Interaction = 64,
    NativeDragPreview = 128,
    Tray = 256,
    WindowOrder = 512,
    WindowGeometry = 1024,
    WindowMetadata = 2048,
    WindowState = 4096,
    CommandPalette = 8192,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum HotBatchTag {
    WindowGeometry = 1,
    WindowState = 2,
    WindowUnmapped = 3,
    FocusChanged = 4,
    WindowOrder = 5,
    InteractionState = 6,
}

pub const MSG_SPAWN_WAYLAND_CLIENT: u32 = 2;
pub const MSG_COMPOSITOR_POINTER_MOVE: u32 = 3;
pub const MSG_COMPOSITOR_POINTER_BUTTON: u32 = 4;
pub const MSG_OUTPUT_GEOMETRY: u32 = 5;
pub const MSG_WINDOW_MAPPED: u32 = 6;
pub const MSG_WINDOW_UNMAPPED: u32 = 7;
pub const MSG_WINDOW_GEOMETRY: u32 = 8;
pub const MSG_WINDOW_METADATA: u32 = 9;
pub const MSG_FOCUS_CHANGED: u32 = 10;
pub const MSG_WINDOW_LIST: u32 = 11;
pub const MSG_SHELL_MOVE_BEGIN: u32 = 20;
pub const MSG_SHELL_MOVE_DELTA: u32 = 21;
pub const MSG_SHELL_MOVE_END: u32 = 22;
pub const MSG_SHELL_LIST_WINDOWS: u32 = 23;
pub const MSG_SHELL_SET_GEOMETRY: u32 = 24;
pub const MSG_SHELL_CLOSE: u32 = 25;
pub const MSG_SHELL_SET_FULLSCREEN: u32 = 26;
pub const MSG_SHELL_QUIT_COMPOSITOR: u32 = 27;
pub const MSG_COMPOSITOR_TOUCH: u32 = 31;
pub const MSG_FRAME_DMABUF_COMMIT: u32 = 33;
pub const MSG_COMPOSITOR_POINTER_AXIS: u32 = 34;
pub const MSG_COMPOSITOR_KEY: u32 = 35;
pub const MSG_SHELL_TASKBAR_ACTIVATE: u32 = 36;
pub const MSG_WINDOW_STATE: u32 = 37;
pub const MSG_SHELL_MINIMIZE: u32 = 38;
pub const MSG_SHELL_RESIZE_BEGIN: u32 = 39;
pub const MSG_SHELL_RESIZE_DELTA: u32 = 40;
pub const MSG_SHELL_RESIZE_END: u32 = 41;
pub const MSG_SHELL_SET_MAXIMIZED: u32 = 42;
pub const MSG_SHELL_SET_PRESENTATION_FULLSCREEN: u32 = 43;
pub const MSG_OUTPUT_LAYOUT: u32 = 44;
pub const MSG_SHELL_SET_OUTPUT_LAYOUT: u32 = 45;
pub const MSG_SHELL_CONTEXT_MENU: u32 = 46;
pub const MSG_COMPOSITOR_CONTEXT_MENU_DISMISS: u32 = 47;
pub const MSG_SHELL_TILE_PREVIEW: u32 = 48;
pub const MSG_SHELL_CHROME_METRICS: u32 = 49;
pub const MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE: u32 = 50;
pub const MSG_COMPOSITOR_KEYBIND: u32 = 51;
pub const MSG_COMPOSITOR_KEYBOARD_LAYOUT: u32 = 52;
pub const MSG_COMPOSITOR_VOLUME_OVERLAY: u32 = 53;
pub const MSG_SHELL_WINDOWS_SYNC: u32 = 54;
pub const MSG_COMPOSITOR_TRAY_HINTS: u32 = 55;
pub const MSG_COMPOSITOR_TRAY_SNI: u32 = 56;
pub const MSG_COMPOSITOR_WORKSPACE_STATE: u32 = 57;
pub const MSG_SHELL_WORKSPACE_MUTATION: u32 = 58;
pub const MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE: u32 = 59;
pub const MSG_COMPOSITOR_INTERACTION_STATE: u32 = 60;
pub const MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW: u32 = 61;
pub const MSG_COMPOSITOR_WORKSPACE_STATE_BINARY: u32 = 62;
pub const MSG_WINDOW_ORDER: u32 = 63;
pub const MSG_COMPOSITOR_COMMAND_PALETTE_STATE: u32 = 64;

pub const SHELL_SNAPSHOT_DOMAIN_OUTPUTS: u32 = 1;
pub const SHELL_SNAPSHOT_DOMAIN_WINDOWS: u32 = 2;
pub const SHELL_SNAPSHOT_DOMAIN_FOCUS: u32 = 4;
pub const SHELL_SNAPSHOT_DOMAIN_KEYBOARD: u32 = 8;
pub const SHELL_SNAPSHOT_DOMAIN_WORKSPACE: u32 = 16;
pub const SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS: u32 = 32;
pub const SHELL_SNAPSHOT_DOMAIN_INTERACTION: u32 = 64;
pub const SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW: u32 = 128;
pub const SHELL_SNAPSHOT_DOMAIN_TRAY: u32 = 256;
pub const SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER: u32 = 512;
pub const SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY: u32 = 1024;
pub const SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA: u32 = 2048;
pub const SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE: u32 = 4096;
pub const SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE: u32 = 8192;
pub const SHELL_SHARED_SNAPSHOT_MAGIC: u32 = 1146245203;
pub const SHELL_SNAPSHOT_DOMAIN_CHUNKS_MAGIC: u32 = 1146242125;
pub const SHELL_SHARED_SNAPSHOT_HEADER_BYTES: u32 = 32;
pub const SHELL_SNAPSHOT_DOMAIN_COUNT: usize = 14;
pub const SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES: usize = 112;

pub const HOT_BATCH_MAGIC: [u8; 4] = [0x44, 0x48, 0x42, 0x31];
pub const HOT_DETAIL_WINDOW_GEOMETRY: u8 = 1;
pub const HOT_DETAIL_WINDOW_STATE: u8 = 2;
pub const HOT_DETAIL_WINDOW_UNMAPPED: u8 = 3;
pub const HOT_DETAIL_FOCUS_CHANGED: u8 = 4;
pub const HOT_DETAIL_WINDOW_ORDER: u8 = 5;
pub const HOT_DETAIL_INTERACTION_STATE: u8 = 6;
pub const HOT_DETAIL_WINDOW_GEOMETRY_BYTES: usize = 57;
pub const HOT_DETAIL_INTERACTION_STATE_BYTES: usize = 88;

pub const SHELL_SHARED_STATE_MAGIC: u32 = 1146245204;
pub const SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES: u32 = 1;
pub const SHELL_SHARED_STATE_KIND_UI_WINDOWS: u32 = 2;
pub const SHELL_SHARED_STATE_KIND_FLOATING_LAYERS: u32 = 3;
pub const SHELL_SHARED_STATE_ABI_VERSION: u32 = 2;
pub const SHELL_SHARED_STATE_HEADER_BYTES: usize = 32;
pub const SHELL_SHARED_STATE_CAPACITY_BYTES: usize = 524288;
pub const SHELL_SHARED_STATE_PREFIX_BYTES: usize = 16;
pub const SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES: usize = 8;
pub const SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES: usize = 28;
pub const SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES: usize = 8;
pub const SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES: usize = 20;
pub const SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES: usize = 16;
pub const SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES: usize = 8;

pub const TOUCH_PHASE_MOVED: u32 = 0;
pub const TOUCH_PHASE_PRESSED: u32 = 1;
pub const TOUCH_PHASE_RELEASED: u32 = 2;
pub const TOUCH_PHASE_CANCELLED: u32 = 3;
pub const RESIZE_EDGE_TOP: u32 = 1;
pub const RESIZE_EDGE_BOTTOM: u32 = 2;
pub const RESIZE_EDGE_LEFT: u32 = 4;
pub const RESIZE_EDGE_RIGHT: u32 = 8;
pub const CEF_KEYEVENT_RAWKEYDOWN: u32 = 0;
pub const CEF_KEYEVENT_KEYDOWN: u32 = 1;
pub const CEF_KEYEVENT_KEYUP: u32 = 2;
pub const CEF_KEYEVENT_CHAR: u32 = 3;
pub const TASKBAR_SIDE_BOTTOM: u32 = 0;
pub const TASKBAR_SIDE_TOP: u32 = 1;
pub const TASKBAR_SIDE_LEFT: u32 = 2;
pub const TASKBAR_SIDE_RIGHT: u32 = 3;
pub const DMABUF_FLAG_Y_INVERT: u32 = 1;
pub const SHELL_WINDOW_FLAG_SHELL_HOSTED: u32 = 1;
pub const SHELL_WINDOW_FLAG_SCRATCHPAD: u32 = 2;

pub const MAX_BODY_BYTES: u32 = 67108864;
pub const MAX_SPAWN_COMMAND_BYTES: u32 = 4096;
pub const MAX_WINDOW_STRING_BYTES: u32 = 4096;
pub const MAX_WINDOW_LIST_ENTRIES: u32 = 512;
pub const WINDOW_LIST_SCHEMA_VERSION: u32 = 1146246915;
pub const WINDOW_LIST_HEADER_BYTES_V1: usize = 16;
pub const WINDOW_LIST_HEADER_BYTES: usize = 24;
pub const WINDOW_LIST_ROW_BYTES_V1: usize = 60;
pub const WINDOW_LIST_ROW_BYTES: usize = 92;
pub const WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION: u32 = 1146242818;
pub const WINDOW_GEOMETRY_RECTS_BYTES: usize = 36;
pub const COMPOSITOR_INTERACTION_STATE_BYTES_V1: usize = 80;
pub const COMPOSITOR_INTERACTION_STATE_BYTES_V2: usize = 88;
pub const COMPOSITOR_INTERACTION_STATE_BYTES: usize = 92;
pub const MAX_OUTPUT_LAYOUT_SCREENS: u32 = 16;
pub const MAX_OUTPUT_LAYOUT_NAME_BYTES: u32 = 128;
pub const MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES: u32 = 4096;
pub const MAX_WINDOW_ICON_BUFFERS: u32 = 16;
pub const MAX_KEYBIND_ACTION_BYTES: u32 = 256;
pub const MAX_KEYBOARD_LAYOUT_LABEL_BYTES: u32 = 32;
pub const MAX_DMABUF_PLANES: u32 = 4;
pub const MAX_SHELL_UI_WINDOWS: u32 = 32;
pub const MAX_WORKSPACE_JSON_BYTES: u32 = 65536;
pub const MAX_WORKSPACE_BINARY_BYTES: u32 = 262144;
pub const MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES: u32 = 65536;
pub const MAX_COMMAND_PALETTE_STATE_JSON_BYTES: u32 = 65536;

pub const SHELL_WIRE_MESSAGE_VALUES: &[u32] = &[
    MSG_SPAWN_WAYLAND_CLIENT,
    MSG_COMPOSITOR_POINTER_MOVE,
    MSG_COMPOSITOR_POINTER_BUTTON,
    MSG_OUTPUT_GEOMETRY,
    MSG_WINDOW_MAPPED,
    MSG_WINDOW_UNMAPPED,
    MSG_WINDOW_GEOMETRY,
    MSG_WINDOW_METADATA,
    MSG_FOCUS_CHANGED,
    MSG_WINDOW_LIST,
    MSG_SHELL_MOVE_BEGIN,
    MSG_SHELL_MOVE_DELTA,
    MSG_SHELL_MOVE_END,
    MSG_SHELL_LIST_WINDOWS,
    MSG_SHELL_SET_GEOMETRY,
    MSG_SHELL_CLOSE,
    MSG_SHELL_SET_FULLSCREEN,
    MSG_SHELL_QUIT_COMPOSITOR,
    MSG_COMPOSITOR_TOUCH,
    MSG_FRAME_DMABUF_COMMIT,
    MSG_COMPOSITOR_POINTER_AXIS,
    MSG_COMPOSITOR_KEY,
    MSG_SHELL_TASKBAR_ACTIVATE,
    MSG_WINDOW_STATE,
    MSG_SHELL_MINIMIZE,
    MSG_SHELL_RESIZE_BEGIN,
    MSG_SHELL_RESIZE_DELTA,
    MSG_SHELL_RESIZE_END,
    MSG_SHELL_SET_MAXIMIZED,
    MSG_SHELL_SET_PRESENTATION_FULLSCREEN,
    MSG_OUTPUT_LAYOUT,
    MSG_SHELL_SET_OUTPUT_LAYOUT,
    MSG_SHELL_CONTEXT_MENU,
    MSG_COMPOSITOR_CONTEXT_MENU_DISMISS,
    MSG_SHELL_TILE_PREVIEW,
    MSG_SHELL_CHROME_METRICS,
    MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE,
    MSG_COMPOSITOR_KEYBIND,
    MSG_COMPOSITOR_KEYBOARD_LAYOUT,
    MSG_COMPOSITOR_VOLUME_OVERLAY,
    MSG_SHELL_WINDOWS_SYNC,
    MSG_COMPOSITOR_TRAY_HINTS,
    MSG_COMPOSITOR_TRAY_SNI,
    MSG_COMPOSITOR_WORKSPACE_STATE,
    MSG_SHELL_WORKSPACE_MUTATION,
    MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE,
    MSG_COMPOSITOR_INTERACTION_STATE,
    MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW,
    MSG_COMPOSITOR_WORKSPACE_STATE_BINARY,
    MSG_WINDOW_ORDER,
    MSG_COMPOSITOR_COMMAND_PALETTE_STATE,
];
pub const SHELL_SNAPSHOT_DOMAIN_VALUES: &[u32] = &[
    SHELL_SNAPSHOT_DOMAIN_OUTPUTS,
    SHELL_SNAPSHOT_DOMAIN_WINDOWS,
    SHELL_SNAPSHOT_DOMAIN_FOCUS,
    SHELL_SNAPSHOT_DOMAIN_KEYBOARD,
    SHELL_SNAPSHOT_DOMAIN_WORKSPACE,
    SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS,
    SHELL_SNAPSHOT_DOMAIN_INTERACTION,
    SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW,
    SHELL_SNAPSHOT_DOMAIN_TRAY,
    SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER,
    SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY,
    SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA,
    SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE,
    SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE,
];
pub const HOT_BATCH_TAG_VALUES: &[u8] = &[
    HOT_DETAIL_WINDOW_GEOMETRY,
    HOT_DETAIL_WINDOW_STATE,
    HOT_DETAIL_WINDOW_UNMAPPED,
    HOT_DETAIL_FOCUS_CHANGED,
    HOT_DETAIL_WINDOW_ORDER,
    HOT_DETAIL_INTERACTION_STATE,
];
pub const SHELL_SHARED_STATE_KIND_VALUES: &[u32] = &[
    SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
    SHELL_SHARED_STATE_KIND_UI_WINDOWS,
    SHELL_SHARED_STATE_KIND_FLOATING_LAYERS,
];
