export type ShellCompositorWireOp =
  | 'close'
  | 'quit'
  | 'request_compositor_sync'
  | 'shell_ipc_pong'
  | 'spawn'
  | 'move_begin'
  | 'move_delta'
  | 'move_end'
  | 'resize_begin'
  | 'resize_delta'
  | 'resize_end'
  | 'resize_shell_grab_begin'
  | 'resize_shell_grab_end'
  | 'taskbar_activate'
  | 'activate_window'
  | 'shell_focus_ui_window'
  | 'shell_blur_ui_window'
  | 'shell_ui_grab_begin'
  | 'shell_ui_grab_end'
  | 'minimize'
  | 'set_geometry'
  | 'set_fullscreen'
  | 'set_maximized'
  | 'presentation_fullscreen'
  | 'set_output_layout'
  | 'set_shell_primary'
  | 'set_ui_scale'
  | 'set_tile_preview'
  | 'set_chrome_metrics'
  | 'set_desktop_background'
  | 'workspace_mutation'
  | 'shell_hosted_window_state'
  | 'backed_window_open'
  | 'e2e_snapshot_response'
  | 'e2e_html_response'
  | 'sni_tray_activate'
  | 'sni_tray_open_menu'
  | 'sni_tray_menu_event'

export type ShellCompositorWireSend = (
  op: ShellCompositorWireOp,
  arg?: number | string,
  arg2?: number | string,
  arg3?: number,
  arg4?: number,
  arg5?: number,
  arg6?: number,
) => boolean
