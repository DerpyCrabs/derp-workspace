import type { ExternalCommandPaletteState } from '@/features/command-palette/commandPalette'
import type { WorkspaceSnapshot } from '@/features/workspace/workspaceSnapshot'

export const MSG_SPAWN_WAYLAND_CLIENT = 2 as const
export const MSG_COMPOSITOR_POINTER_MOVE = 3 as const
export const MSG_COMPOSITOR_POINTER_BUTTON = 4 as const
export const MSG_OUTPUT_GEOMETRY = 5 as const
export const MSG_WINDOW_MAPPED = 6 as const
export const MSG_WINDOW_UNMAPPED = 7 as const
export const MSG_WINDOW_GEOMETRY = 8 as const
export const MSG_WINDOW_METADATA = 9 as const
export const MSG_FOCUS_CHANGED = 10 as const
export const MSG_WINDOW_LIST = 11 as const
export const MSG_SHELL_MOVE_BEGIN = 20 as const
export const MSG_SHELL_MOVE_DELTA = 21 as const
export const MSG_SHELL_MOVE_END = 22 as const
export const MSG_SHELL_LIST_WINDOWS = 23 as const
export const MSG_SHELL_SET_GEOMETRY = 24 as const
export const MSG_SHELL_CLOSE = 25 as const
export const MSG_SHELL_SET_FULLSCREEN = 26 as const
export const MSG_SHELL_QUIT_COMPOSITOR = 27 as const
export const MSG_COMPOSITOR_TOUCH = 31 as const
export const MSG_FRAME_DMABUF_COMMIT = 33 as const
export const MSG_COMPOSITOR_POINTER_AXIS = 34 as const
export const MSG_COMPOSITOR_KEY = 35 as const
export const MSG_SHELL_TASKBAR_ACTIVATE = 36 as const
export const MSG_WINDOW_STATE = 37 as const
export const MSG_SHELL_MINIMIZE = 38 as const
export const MSG_SHELL_RESIZE_BEGIN = 39 as const
export const MSG_SHELL_RESIZE_DELTA = 40 as const
export const MSG_SHELL_RESIZE_END = 41 as const
export const MSG_SHELL_SET_MAXIMIZED = 42 as const
export const MSG_SHELL_SET_PRESENTATION_FULLSCREEN = 43 as const
export const MSG_OUTPUT_LAYOUT = 44 as const
export const MSG_SHELL_SET_OUTPUT_LAYOUT = 45 as const
export const MSG_SHELL_CONTEXT_MENU = 46 as const
export const MSG_COMPOSITOR_CONTEXT_MENU_DISMISS = 47 as const
export const MSG_SHELL_TILE_PREVIEW = 48 as const
export const MSG_SHELL_CHROME_METRICS = 49 as const
export const MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE = 50 as const
export const MSG_COMPOSITOR_KEYBIND = 51 as const
export const MSG_COMPOSITOR_KEYBOARD_LAYOUT = 52 as const
export const MSG_COMPOSITOR_VOLUME_OVERLAY = 53 as const
export const MSG_SHELL_WINDOWS_SYNC = 54 as const
export const MSG_COMPOSITOR_TRAY_HINTS = 55 as const
export const MSG_COMPOSITOR_TRAY_SNI = 56 as const
export const MSG_COMPOSITOR_WORKSPACE_STATE = 57 as const
export const MSG_SHELL_WORKSPACE_MUTATION = 58 as const
export const MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE = 59 as const
export const MSG_COMPOSITOR_INTERACTION_STATE = 60 as const
export const MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW = 61 as const
export const MSG_COMPOSITOR_WORKSPACE_STATE_BINARY = 62 as const
export const MSG_WINDOW_ORDER = 63 as const
export const MSG_COMPOSITOR_COMMAND_PALETTE_STATE = 64 as const
export const SHELL_SHARED_SNAPSHOT_MAGIC = 1146245203 as const
export const SHELL_SNAPSHOT_DOMAIN_CHUNKS_MAGIC = 1146242125 as const
export const SHELL_SNAPSHOT_DOMAIN_OUTPUTS = 1 as const
export const SHELL_SNAPSHOT_DOMAIN_WINDOWS = 2 as const
export const SHELL_SNAPSHOT_DOMAIN_FOCUS = 4 as const
export const SHELL_SNAPSHOT_DOMAIN_KEYBOARD = 8 as const
export const SHELL_SNAPSHOT_DOMAIN_WORKSPACE = 16 as const
export const SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS = 32 as const
export const SHELL_SNAPSHOT_DOMAIN_INTERACTION = 64 as const
export const SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW = 128 as const
export const SHELL_SNAPSHOT_DOMAIN_TRAY = 256 as const
export const SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER = 512 as const
export const SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY = 1024 as const
export const SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA = 2048 as const
export const SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE = 4096 as const
export const SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE = 8192 as const
export const SHELL_SHARED_SNAPSHOT_HEADER_BYTES = 32 as const
export const SHELL_SNAPSHOT_DOMAIN_COUNT = 14 as const
export const SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES = 112 as const
export const TOUCH_PHASE_MOVED = 0 as const
export const TOUCH_PHASE_PRESSED = 1 as const
export const TOUCH_PHASE_RELEASED = 2 as const
export const TOUCH_PHASE_CANCELLED = 3 as const
export const RESIZE_EDGE_TOP = 1 as const
export const RESIZE_EDGE_BOTTOM = 2 as const
export const RESIZE_EDGE_LEFT = 4 as const
export const RESIZE_EDGE_RIGHT = 8 as const
export const CEF_KEYEVENT_RAWKEYDOWN = 0 as const
export const CEF_KEYEVENT_KEYDOWN = 1 as const
export const CEF_KEYEVENT_KEYUP = 2 as const
export const CEF_KEYEVENT_CHAR = 3 as const
export const TASKBAR_SIDE_BOTTOM = 0 as const
export const TASKBAR_SIDE_TOP = 1 as const
export const TASKBAR_SIDE_LEFT = 2 as const
export const TASKBAR_SIDE_RIGHT = 3 as const
export const DMABUF_FLAG_Y_INVERT = 1 as const
export const SHELL_WINDOW_FLAG_SHELL_HOSTED = 1 as const
export const SHELL_WINDOW_FLAG_SCRATCHPAD = 2 as const
export const MAX_BODY_BYTES = 67108864 as const
export const MAX_SPAWN_COMMAND_BYTES = 4096 as const
export const MAX_WINDOW_STRING_BYTES = 4096 as const
export const MAX_WINDOW_LIST_ENTRIES = 512 as const
export const WINDOW_LIST_SCHEMA_VERSION = 1146246915 as const
export const WINDOW_LIST_HEADER_BYTES_V1 = 16 as const
export const WINDOW_LIST_HEADER_BYTES = 24 as const
export const WINDOW_LIST_ROW_BYTES_V1 = 60 as const
export const WINDOW_LIST_ROW_BYTES = 92 as const
export const WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION = 1146242818 as const
export const WINDOW_GEOMETRY_RECTS_BYTES = 36 as const
export const COMPOSITOR_INTERACTION_STATE_BYTES_V1 = 80 as const
export const COMPOSITOR_INTERACTION_STATE_BYTES = 88 as const
export const MAX_OUTPUT_LAYOUT_SCREENS = 16 as const
export const MAX_OUTPUT_LAYOUT_NAME_BYTES = 128 as const
export const MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES = 4096 as const
export const MAX_WINDOW_ICON_BUFFERS = 16 as const
export const MAX_KEYBIND_ACTION_BYTES = 256 as const
export const MAX_KEYBOARD_LAYOUT_LABEL_BYTES = 32 as const
export const MAX_DMABUF_PLANES = 4 as const
export const MAX_SHELL_UI_WINDOWS = 32 as const
export const MAX_WORKSPACE_JSON_BYTES = 65536 as const
export const MAX_WORKSPACE_BINARY_BYTES = 262144 as const
export const MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES = 65536 as const
export const MAX_COMMAND_PALETTE_STATE_JSON_BYTES = 65536 as const
export const HOT_DETAIL_WINDOW_GEOMETRY = 1 as const
export const HOT_DETAIL_WINDOW_STATE = 2 as const
export const HOT_DETAIL_WINDOW_UNMAPPED = 3 as const
export const HOT_DETAIL_FOCUS_CHANGED = 4 as const
export const HOT_DETAIL_WINDOW_ORDER = 5 as const
export const HOT_DETAIL_INTERACTION_STATE = 6 as const
export const HOT_DETAIL_WINDOW_GEOMETRY_BYTES = 57 as const
export const HOT_DETAIL_INTERACTION_STATE_BYTES = 84 as const
export const SHELL_SHARED_STATE_MAGIC = 1146245204 as const
export const SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES = 1 as const
export const SHELL_SHARED_STATE_KIND_UI_WINDOWS = 2 as const
export const SHELL_SHARED_STATE_KIND_FLOATING_LAYERS = 3 as const
export const SHELL_SHARED_STATE_ABI_VERSION = 2 as const
export const SHELL_SHARED_STATE_HEADER_BYTES = 32 as const
export const SHELL_SHARED_STATE_CAPACITY_BYTES = 524288 as const
export const SHELL_SHARED_STATE_PREFIX_BYTES = 16 as const
export const SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES = 8 as const
export const SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES = 28 as const
export const SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES = 8 as const
export const SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES = 20 as const
export const SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES = 16 as const
export const SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES = 8 as const
export const HOT_BATCH_MAGIC = [0x44, 0x48, 0x42, 0x31] as const

export const SHELL_WIRE_MESSAGES = {
  MSG_SPAWN_WAYLAND_CLIENT: MSG_SPAWN_WAYLAND_CLIENT,
  MSG_COMPOSITOR_POINTER_MOVE: MSG_COMPOSITOR_POINTER_MOVE,
  MSG_COMPOSITOR_POINTER_BUTTON: MSG_COMPOSITOR_POINTER_BUTTON,
  MSG_OUTPUT_GEOMETRY: MSG_OUTPUT_GEOMETRY,
  MSG_WINDOW_MAPPED: MSG_WINDOW_MAPPED,
  MSG_WINDOW_UNMAPPED: MSG_WINDOW_UNMAPPED,
  MSG_WINDOW_GEOMETRY: MSG_WINDOW_GEOMETRY,
  MSG_WINDOW_METADATA: MSG_WINDOW_METADATA,
  MSG_FOCUS_CHANGED: MSG_FOCUS_CHANGED,
  MSG_WINDOW_LIST: MSG_WINDOW_LIST,
  MSG_SHELL_MOVE_BEGIN: MSG_SHELL_MOVE_BEGIN,
  MSG_SHELL_MOVE_DELTA: MSG_SHELL_MOVE_DELTA,
  MSG_SHELL_MOVE_END: MSG_SHELL_MOVE_END,
  MSG_SHELL_LIST_WINDOWS: MSG_SHELL_LIST_WINDOWS,
  MSG_SHELL_SET_GEOMETRY: MSG_SHELL_SET_GEOMETRY,
  MSG_SHELL_CLOSE: MSG_SHELL_CLOSE,
  MSG_SHELL_SET_FULLSCREEN: MSG_SHELL_SET_FULLSCREEN,
  MSG_SHELL_QUIT_COMPOSITOR: MSG_SHELL_QUIT_COMPOSITOR,
  MSG_COMPOSITOR_TOUCH: MSG_COMPOSITOR_TOUCH,
  MSG_FRAME_DMABUF_COMMIT: MSG_FRAME_DMABUF_COMMIT,
  MSG_COMPOSITOR_POINTER_AXIS: MSG_COMPOSITOR_POINTER_AXIS,
  MSG_COMPOSITOR_KEY: MSG_COMPOSITOR_KEY,
  MSG_SHELL_TASKBAR_ACTIVATE: MSG_SHELL_TASKBAR_ACTIVATE,
  MSG_WINDOW_STATE: MSG_WINDOW_STATE,
  MSG_SHELL_MINIMIZE: MSG_SHELL_MINIMIZE,
  MSG_SHELL_RESIZE_BEGIN: MSG_SHELL_RESIZE_BEGIN,
  MSG_SHELL_RESIZE_DELTA: MSG_SHELL_RESIZE_DELTA,
  MSG_SHELL_RESIZE_END: MSG_SHELL_RESIZE_END,
  MSG_SHELL_SET_MAXIMIZED: MSG_SHELL_SET_MAXIMIZED,
  MSG_SHELL_SET_PRESENTATION_FULLSCREEN: MSG_SHELL_SET_PRESENTATION_FULLSCREEN,
  MSG_OUTPUT_LAYOUT: MSG_OUTPUT_LAYOUT,
  MSG_SHELL_SET_OUTPUT_LAYOUT: MSG_SHELL_SET_OUTPUT_LAYOUT,
  MSG_SHELL_CONTEXT_MENU: MSG_SHELL_CONTEXT_MENU,
  MSG_COMPOSITOR_CONTEXT_MENU_DISMISS: MSG_COMPOSITOR_CONTEXT_MENU_DISMISS,
  MSG_SHELL_TILE_PREVIEW: MSG_SHELL_TILE_PREVIEW,
  MSG_SHELL_CHROME_METRICS: MSG_SHELL_CHROME_METRICS,
  MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE: MSG_COMPOSITOR_PROGRAMS_MENU_TOGGLE,
  MSG_COMPOSITOR_KEYBIND: MSG_COMPOSITOR_KEYBIND,
  MSG_COMPOSITOR_KEYBOARD_LAYOUT: MSG_COMPOSITOR_KEYBOARD_LAYOUT,
  MSG_COMPOSITOR_VOLUME_OVERLAY: MSG_COMPOSITOR_VOLUME_OVERLAY,
  MSG_SHELL_WINDOWS_SYNC: MSG_SHELL_WINDOWS_SYNC,
  MSG_COMPOSITOR_TRAY_HINTS: MSG_COMPOSITOR_TRAY_HINTS,
  MSG_COMPOSITOR_TRAY_SNI: MSG_COMPOSITOR_TRAY_SNI,
  MSG_COMPOSITOR_WORKSPACE_STATE: MSG_COMPOSITOR_WORKSPACE_STATE,
  MSG_SHELL_WORKSPACE_MUTATION: MSG_SHELL_WORKSPACE_MUTATION,
  MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE: MSG_COMPOSITOR_SHELL_HOSTED_APP_STATE,
  MSG_COMPOSITOR_INTERACTION_STATE: MSG_COMPOSITOR_INTERACTION_STATE,
  MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW: MSG_COMPOSITOR_NATIVE_DRAG_PREVIEW,
  MSG_COMPOSITOR_WORKSPACE_STATE_BINARY: MSG_COMPOSITOR_WORKSPACE_STATE_BINARY,
  MSG_WINDOW_ORDER: MSG_WINDOW_ORDER,
  MSG_COMPOSITOR_COMMAND_PALETTE_STATE: MSG_COMPOSITOR_COMMAND_PALETTE_STATE,
} as const
export type ShellWireMessage = (typeof SHELL_WIRE_MESSAGES)[keyof typeof SHELL_WIRE_MESSAGES]

export const SHELL_SNAPSHOT_DOMAINS = {
  SHELL_SNAPSHOT_DOMAIN_OUTPUTS: SHELL_SNAPSHOT_DOMAIN_OUTPUTS,
  SHELL_SNAPSHOT_DOMAIN_WINDOWS: SHELL_SNAPSHOT_DOMAIN_WINDOWS,
  SHELL_SNAPSHOT_DOMAIN_FOCUS: SHELL_SNAPSHOT_DOMAIN_FOCUS,
  SHELL_SNAPSHOT_DOMAIN_KEYBOARD: SHELL_SNAPSHOT_DOMAIN_KEYBOARD,
  SHELL_SNAPSHOT_DOMAIN_WORKSPACE: SHELL_SNAPSHOT_DOMAIN_WORKSPACE,
  SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS: SHELL_SNAPSHOT_DOMAIN_SHELL_HOSTED_APPS,
  SHELL_SNAPSHOT_DOMAIN_INTERACTION: SHELL_SNAPSHOT_DOMAIN_INTERACTION,
  SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW: SHELL_SNAPSHOT_DOMAIN_NATIVE_DRAG_PREVIEW,
  SHELL_SNAPSHOT_DOMAIN_TRAY: SHELL_SNAPSHOT_DOMAIN_TRAY,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER: SHELL_SNAPSHOT_DOMAIN_WINDOW_ORDER,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY: SHELL_SNAPSHOT_DOMAIN_WINDOW_GEOMETRY,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA: SHELL_SNAPSHOT_DOMAIN_WINDOW_METADATA,
  SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE: SHELL_SNAPSHOT_DOMAIN_WINDOW_STATE,
  SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE: SHELL_SNAPSHOT_DOMAIN_COMMAND_PALETTE,
} as const
export type ShellSnapshotDomain = (typeof SHELL_SNAPSHOT_DOMAINS)[keyof typeof SHELL_SNAPSHOT_DOMAINS]

export const HOT_BATCH_TAGS = {
  HOT_DETAIL_WINDOW_GEOMETRY: HOT_DETAIL_WINDOW_GEOMETRY,
  HOT_DETAIL_WINDOW_STATE: HOT_DETAIL_WINDOW_STATE,
  HOT_DETAIL_WINDOW_UNMAPPED: HOT_DETAIL_WINDOW_UNMAPPED,
  HOT_DETAIL_FOCUS_CHANGED: HOT_DETAIL_FOCUS_CHANGED,
  HOT_DETAIL_WINDOW_ORDER: HOT_DETAIL_WINDOW_ORDER,
  HOT_DETAIL_INTERACTION_STATE: HOT_DETAIL_INTERACTION_STATE,
} as const
export type HotBatchTag = (typeof HOT_BATCH_TAGS)[keyof typeof HOT_BATCH_TAGS]

export const SHELL_SHARED_STATE_KINDS = {
  SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES: SHELL_SHARED_STATE_KIND_EXCLUSION_ZONES,
  SHELL_SHARED_STATE_KIND_UI_WINDOWS: SHELL_SHARED_STATE_KIND_UI_WINDOWS,
  SHELL_SHARED_STATE_KIND_FLOATING_LAYERS: SHELL_SHARED_STATE_KIND_FLOATING_LAYERS,
} as const
export type ShellSharedStateKind = (typeof SHELL_SHARED_STATE_KINDS)[keyof typeof SHELL_SHARED_STATE_KINDS]

export const WIRE_BYTE_SIZES = {
  SHELL_SHARED_SNAPSHOT_HEADER_BYTES: SHELL_SHARED_SNAPSHOT_HEADER_BYTES,
  SHELL_SNAPSHOT_DOMAIN_COUNT: SHELL_SNAPSHOT_DOMAIN_COUNT,
  SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES: SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES,
  HOT_DETAIL_WINDOW_GEOMETRY_BYTES: HOT_DETAIL_WINDOW_GEOMETRY_BYTES,
  HOT_DETAIL_INTERACTION_STATE_BYTES: HOT_DETAIL_INTERACTION_STATE_BYTES,
  SHELL_SHARED_STATE_ABI_VERSION: SHELL_SHARED_STATE_ABI_VERSION,
  SHELL_SHARED_STATE_HEADER_BYTES: SHELL_SHARED_STATE_HEADER_BYTES,
  SHELL_SHARED_STATE_CAPACITY_BYTES: SHELL_SHARED_STATE_CAPACITY_BYTES,
  SHELL_SHARED_STATE_PREFIX_BYTES: SHELL_SHARED_STATE_PREFIX_BYTES,
  SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES: SHELL_SHARED_STATE_UI_WINDOWS_HEADER_BYTES,
  SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES: SHELL_SHARED_STATE_UI_WINDOWS_ROW_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES: SHELL_SHARED_STATE_EXCLUSION_HEADER_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES: SHELL_SHARED_STATE_EXCLUSION_RECT_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES: SHELL_SHARED_STATE_EXCLUSION_TRAY_STRIP_BYTES,
  SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES: SHELL_SHARED_STATE_EXCLUSION_FLOATING_HEADER_BYTES,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  MAX_SPAWN_COMMAND_BYTES: MAX_SPAWN_COMMAND_BYTES,
  MAX_WINDOW_STRING_BYTES: MAX_WINDOW_STRING_BYTES,
  MAX_WINDOW_LIST_ENTRIES: MAX_WINDOW_LIST_ENTRIES,
  WINDOW_LIST_SCHEMA_VERSION: WINDOW_LIST_SCHEMA_VERSION,
  WINDOW_LIST_HEADER_BYTES_V1: WINDOW_LIST_HEADER_BYTES_V1,
  WINDOW_LIST_HEADER_BYTES: WINDOW_LIST_HEADER_BYTES,
  WINDOW_LIST_ROW_BYTES_V1: WINDOW_LIST_ROW_BYTES_V1,
  WINDOW_LIST_ROW_BYTES: WINDOW_LIST_ROW_BYTES,
  WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION: WINDOW_GEOMETRY_RECTS_SCHEMA_VERSION,
  WINDOW_GEOMETRY_RECTS_BYTES: WINDOW_GEOMETRY_RECTS_BYTES,
  COMPOSITOR_INTERACTION_STATE_BYTES_V1: COMPOSITOR_INTERACTION_STATE_BYTES_V1,
  COMPOSITOR_INTERACTION_STATE_BYTES: COMPOSITOR_INTERACTION_STATE_BYTES,
  MAX_OUTPUT_LAYOUT_SCREENS: MAX_OUTPUT_LAYOUT_SCREENS,
  MAX_OUTPUT_LAYOUT_NAME_BYTES: MAX_OUTPUT_LAYOUT_NAME_BYTES,
  MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES: MAX_SHELL_OUTPUT_LAYOUT_JSON_BYTES,
  MAX_WINDOW_ICON_BUFFERS: MAX_WINDOW_ICON_BUFFERS,
  MAX_KEYBIND_ACTION_BYTES: MAX_KEYBIND_ACTION_BYTES,
  MAX_KEYBOARD_LAYOUT_LABEL_BYTES: MAX_KEYBOARD_LAYOUT_LABEL_BYTES,
  MAX_DMABUF_PLANES: MAX_DMABUF_PLANES,
  MAX_SHELL_UI_WINDOWS: MAX_SHELL_UI_WINDOWS,
  MAX_WORKSPACE_JSON_BYTES: MAX_WORKSPACE_JSON_BYTES,
  MAX_WORKSPACE_BINARY_BYTES: MAX_WORKSPACE_BINARY_BYTES,
  MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES: MAX_SHELL_HOSTED_APP_STATE_JSON_BYTES,
  MAX_COMMAND_PALETTE_STATE_JSON_BYTES: MAX_COMMAND_PALETTE_STATE_JSON_BYTES,
} as const
export type WireByteSize = (typeof WIRE_BYTE_SIZES)[keyof typeof WIRE_BYTE_SIZES]

export const TOUCH_PHASES = {
  TOUCH_PHASE_MOVED: TOUCH_PHASE_MOVED,
  TOUCH_PHASE_PRESSED: TOUCH_PHASE_PRESSED,
  TOUCH_PHASE_RELEASED: TOUCH_PHASE_RELEASED,
  TOUCH_PHASE_CANCELLED: TOUCH_PHASE_CANCELLED,
} as const
export type TouchPhase = (typeof TOUCH_PHASES)[keyof typeof TOUCH_PHASES]

export const RESIZE_EDGES = {
  RESIZE_EDGE_TOP: RESIZE_EDGE_TOP,
  RESIZE_EDGE_BOTTOM: RESIZE_EDGE_BOTTOM,
  RESIZE_EDGE_LEFT: RESIZE_EDGE_LEFT,
  RESIZE_EDGE_RIGHT: RESIZE_EDGE_RIGHT,
} as const
export type ResizeEdge = (typeof RESIZE_EDGES)[keyof typeof RESIZE_EDGES]

export const CEF_KEY_EVENTS = {
  CEF_KEYEVENT_RAWKEYDOWN: CEF_KEYEVENT_RAWKEYDOWN,
  CEF_KEYEVENT_KEYDOWN: CEF_KEYEVENT_KEYDOWN,
  CEF_KEYEVENT_KEYUP: CEF_KEYEVENT_KEYUP,
  CEF_KEYEVENT_CHAR: CEF_KEYEVENT_CHAR,
} as const
export type CefKeyEventType = (typeof CEF_KEY_EVENTS)[keyof typeof CEF_KEY_EVENTS]

export const TASKBAR_SIDES = {
  TASKBAR_SIDE_BOTTOM: TASKBAR_SIDE_BOTTOM,
  TASKBAR_SIDE_TOP: TASKBAR_SIDE_TOP,
  TASKBAR_SIDE_LEFT: TASKBAR_SIDE_LEFT,
  TASKBAR_SIDE_RIGHT: TASKBAR_SIDE_RIGHT,
} as const
export type TaskbarSide = (typeof TASKBAR_SIDES)[keyof typeof TASKBAR_SIDES]

export type ShellWindowIconBufferSnapshot = { width: number; height: number; scale: number }

export type ShellWindowSnapshot = { window_id: number; surface_id: number; stack_z: number; x: number; y: number; width: number; height: number; client_x: number; client_y: number; client_width: number; client_height: number; frame_x: number; frame_y: number; frame_width: number; frame_height: number; minimized: boolean; maximized: boolean; fullscreen: boolean; client_side_decoration: boolean; workspace_visible: boolean; shell_flags: number; title: string; app_id: string; output_id: string; output_name: string; capture_identifier: string; kind: string; x11_class: string; x11_instance: string; icon_name: string; icon_buffers: ShellWindowIconBufferSnapshot[] }

export type DerpWindow = Omit<ShellWindowSnapshot, 'client_x' | 'client_y' | 'client_width' | 'client_height' | 'frame_x' | 'frame_y' | 'frame_width' | 'frame_height' | 'client_side_decoration'> & { client_x?: number; client_y?: number; client_width?: number; client_height?: number; frame_x?: number; frame_y?: number; frame_width?: number; frame_height?: number; client_side_decoration?: boolean }

export type ShellWindowListRow = Partial<DerpWindow> & { window_id: number; surface_id: number }

export type ShellWindowOrderEntry = { window_id: number; stack_z: number }

export type SharedShellUiWindow = { id: number; z: number; gx: number; gy: number; gw: number; gh: number }

export type SharedShellExclusionRect = { x: number; y: number; w: number; h: number; window_id?: number }

export type SharedShellExclusionTrayStrip = { x: number; y: number; w: number; h: number }

export type CompositorInteractionVisual = { x: number; y: number; width: number; height: number; maximized: boolean; fullscreen: boolean }

export type OutputLayoutScreenDetail = { name: string; identity?: string; x: number; y: number; width: number; height: number; usable_x?: number; usable_y?: number; usable_width?: number; usable_height?: number; physical_width?: number; physical_height?: number; transform: number; refresh_milli_hz?: number; vrr_supported?: boolean; vrr_enabled?: boolean; taskbar_side?: 'bottom' | 'top' | 'left' | 'right' }

export type TraySniMenuEntryDetail = { dbusmenu_id: number; label: string; separator: boolean; enabled: boolean }

export type DerpShellDetail = { snapshot_epoch?: number } & (
  | { type: 'output_geometry'; logical_width: number; logical_height: number }
  | { type: 'output_layout'; revision?: number; canvas_logical_width: number; canvas_logical_height: number; canvas_logical_origin_x?: number; canvas_logical_origin_y?: number; canvas_physical_width: number; canvas_physical_height: number; screens: OutputLayoutScreenDetail[]; shell_chrome_primary?: string | null; taskbar_auto_hide?: boolean }
  | { type: 'window_mapped'; window_id: number; surface_id: number; x: number; y: number; width: number; height: number; client_x?: number; client_y?: number; client_width?: number; client_height?: number; frame_x?: number; frame_y?: number; frame_width?: number; frame_height?: number; title: string; app_id: string; icon_name?: string; icon_buffers?: ShellWindowIconBufferSnapshot[]; output_id?: string; output_name?: string; stack_z?: number; minimized?: boolean; maximized?: boolean; fullscreen?: boolean; client_side_decoration?: boolean; shell_flags?: number; capture_identifier?: string; kind?: string; x11_class?: string; x11_instance?: string; workspace_visible?: boolean }
  | { type: 'window_unmapped'; window_id: number }
  | { type: 'window_geometry'; window_id: number; surface_id: number; x: number; y: number; width: number; height: number; client_x?: number; client_y?: number; client_width?: number; client_height?: number; frame_x?: number; frame_y?: number; frame_width?: number; frame_height?: number; output_id?: string; output_name?: string; maximized?: boolean; fullscreen?: boolean; client_side_decoration?: boolean }
  | { type: 'window_metadata'; window_id: number; surface_id: number; title: string; app_id: string; icon_name?: string; icon_buffers?: ShellWindowIconBufferSnapshot[] }
  | { type: 'focus_changed'; surface_id: number | null; window_id: number | null }
  | { type: 'window_state'; window_id: number; minimized: boolean }
  | { type: 'window_list'; revision?: number; windows: ShellWindowListRow[] }
  | { type: 'window_order'; revision?: number; windows: ShellWindowOrderEntry[] }
  | { type: 'workspace_state'; revision?: number; state: WorkspaceSnapshot }
  | { type: 'shell_hosted_app_state'; revision?: number; state: { byWindowId?: Record<string, unknown> } }
  | { type: 'command_palette_state'; revision?: number; state: ExternalCommandPaletteState }
  | { type: 'interaction_state'; revision?: number; interaction_serial?: number; pointer_x: number; pointer_y: number; move_window_id: number | null; resize_window_id: number | null; move_proxy_window_id: number | null; move_capture_window_id: number | null; move_rect: CompositorInteractionVisual | null; resize_rect: CompositorInteractionVisual | null; window_switcher_selected_window_id?: number | null }
  | { type: 'native_drag_preview'; window_id: number; generation: number; image_path: string }
  | { type: 'context_menu_dismiss' }
  | { type: 'programs_menu_toggle'; output_name?: string }
  | { type: 'keybind'; action: string; target_window_id?: number; output_name?: string }
  | { type: 'keyboard_layout'; label: string }
  | { type: 'volume_overlay'; volume_linear_percent_x100: number; muted: boolean; state_known: boolean }
  | { type: 'tray_hints'; slot_count: number; slot_w: number; reserved_w: number }
  | { type: 'tray_sni'; items: { id: string; title: string; icon_base64: string }[] }
  | { type: 'tray_sni_menu'; request_serial: number; notifier_id: string; menu_path: string; entries: TraySniMenuEntryDetail[] }
  | { type: 'notifications_state'; state: unknown }
  | { type: 'notification_event'; notification_id: number; event_type: string; action_key?: string | null; close_reason?: number | null; source: string }
  | { type: 'mutation_ack'; domain: string; client_mutation_id: number; status: string; snapshot_epoch?: number }
)
