import type { DerpWindow } from '@/host/appWindowState'

type ShellUiGeometryKey =
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'client_x'
  | 'client_y'
  | 'client_width'
  | 'client_height'
  | 'frame_x'
  | 'frame_y'
  | 'frame_width'
  | 'frame_height'
  | 'restore_x'
  | 'restore_y'
  | 'restore_width'
  | 'restore_height'

export type ShellUiWindowView = Omit<DerpWindow, ShellUiGeometryKey>

function iconBuffersEqual(left: DerpWindow['icon_buffers'], right: DerpWindow['icon_buffers']): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((buffer, index) => {
    const other = right[index]
    return !!other && buffer.width === other.width && buffer.height === other.height && buffer.scale === other.scale
  })
}

export function shellUiWindowView(window: DerpWindow, previous?: ShellUiWindowView): ShellUiWindowView {
  const {
    x,
    y,
    width,
    height,
    client_x,
    client_y,
    client_width,
    client_height,
    frame_x,
    frame_y,
    frame_width,
    frame_height,
    restore_x,
    restore_y,
    restore_width,
    restore_height,
    ...next
  } = window
  void x
  void y
  void width
  void height
  void client_x
  void client_y
  void client_width
  void client_height
  void frame_x
  void frame_y
  void frame_width
  void frame_height
  void restore_x
  void restore_y
  void restore_width
  void restore_height
  return previous && shellUiWindowViewEqual(previous, next) ? previous : next
}

export function shellUiWindowViewEqual(left: ShellUiWindowView, right: ShellUiWindowView): boolean {
  return (
    left.window_id === right.window_id &&
    left.surface_id === right.surface_id &&
    left.stack_z === right.stack_z &&
    left.minimized === right.minimized &&
    left.maximized === right.maximized &&
    left.fullscreen === right.fullscreen &&
    left.client_side_decoration === right.client_side_decoration &&
    left.workspace_visible === right.workspace_visible &&
    left.shell_flags === right.shell_flags &&
    left.title === right.title &&
    left.app_id === right.app_id &&
    left.output_id === right.output_id &&
    left.output_name === right.output_name &&
    left.capture_identifier === right.capture_identifier &&
    left.kind === right.kind &&
    left.x11_class === right.x11_class &&
    left.x11_instance === right.x11_instance &&
    left.icon_name === right.icon_name &&
    iconBuffersEqual(left.icon_buffers, right.icon_buffers)
  )
}
