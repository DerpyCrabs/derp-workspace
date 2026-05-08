import type {
  ShellCompositorWireOp,
  ShellCompositorWireSend,
} from "@/features/shell-ui/shellWireSendType";

export function shellMoveLog(msg: string, detail?: Record<string, unknown>) {
  const now =
    typeof performance !== "undefined"
      ? Math.round(performance.now())
      : Date.now();
  const current =
    typeof window.__DERP_MOVE_DEBUG === "object" &&
    window.__DERP_MOVE_DEBUG !== null
      ? window.__DERP_MOVE_DEBUG
      : {
          events: [] as Array<{
            msg: string;
            at: number;
            detail: Record<string, unknown> | null;
          }>,
        };
  const events = Array.isArray(current.events) ? current.events.slice(-31) : [];
  events.push({ msg, at: now, detail: detail ?? null });
  window.__DERP_MOVE_DEBUG = { events };
}

export const shellWireSend: ShellCompositorWireSend = function shellWireSend(
  op: ShellCompositorWireOp,
  arg?: number | string,
  arg2?: number | string,
  arg3?: number,
  arg4?: number,
  arg5?: number,
  arg6?: number,
): boolean {
  const fn = window.__derpShellWireSend;
  const hasWire = typeof fn === "function";
  if (!hasWire) {
    if (
      op === "move_begin" ||
      op === "move_end" ||
      op === "resize_begin" ||
      op === "resize_delta" ||
      op === "resize_end" ||
      op === "resize_shell_grab_begin" ||
      op === "resize_shell_grab_end"
    ) {
      shellMoveLog("wire_missing", { op, arg, arg2 });
    }
    return false;
  }
  if (op === "resize_delta" && arg2 !== undefined) {
    fn(op, arg as number, arg2);
  } else if (op === "resize_begin" && arg2 !== undefined) {
    fn(op, arg as number, arg2);
  } else if (
    op === "set_geometry" &&
    typeof arg === "number" &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined &&
    arg6 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5, arg6);
  } else if (
    (op === "set_fullscreen" || op === "set_maximized") &&
    arg !== undefined &&
    arg2 !== undefined
  ) {
    fn(op, arg as number, arg2);
  } else if (
    op === "quit" ||
    op === "request_compositor_sync" ||
    op === "invalidate_view" ||
    op === "resize_shell_grab_end"
  ) {
    fn(op);
  } else if (
    (op === "hosted_window_open" || op === "backed_window_open") &&
    typeof arg === "string"
  ) {
    fn(op, arg);
  } else if (op === "set_output_layout" && typeof arg === "string") {
    fn(op, arg);
  } else if (op === "set_desktop_background" && typeof arg === "string") {
    fn(op, arg);
  } else if (
    (op === "workspace_mutation" ||
      op === "taskbar_pin_add" ||
      op === "taskbar_pin_remove" ||
      op === "taskbar_pin_launch" ||
      op === "command_palette_activate") &&
    typeof arg === "string"
  ) {
    fn(op, arg);
  } else if (op === "window_intent" && typeof arg === "string") {
    fn(op, arg);
  } else if (
    (op === "shell_hosted_window_state" ||
      op === "shell_hosted_window_title") &&
    typeof arg === "string"
  ) {
    fn(op, arg);
  } else if (op === "set_shell_primary" && typeof arg === "string") {
    fn(op, arg);
  } else if (op === "set_ui_scale" && typeof arg === "number") {
    fn(op, arg);
  } else if (
    op === "set_output_vrr" &&
    typeof arg === "string" &&
    typeof arg2 === "number"
  ) {
    fn(op, arg, arg2);
  } else if (op === "set_taskbar_auto_hide" && typeof arg === "number") {
    fn(op, arg);
  } else if (
    op === "set_taskbar_side" &&
    typeof arg === "string" &&
    typeof arg2 === "string"
  ) {
    fn(op, arg, arg2);
  } else if (
    op === "native_drag_preview_ready" &&
    typeof arg === "number" &&
    typeof arg2 === "number"
  ) {
    fn(op, arg, arg2);
  } else if (
    op === "set_tile_preview" &&
    typeof arg === "number" &&
    arg2 !== undefined &&
    arg3 !== undefined &&
    arg4 !== undefined &&
    arg5 !== undefined
  ) {
    fn(op, arg, arg2, arg3, arg4, arg5);
  } else if (
    op === "set_chrome_metrics" &&
    typeof arg === "number" &&
    arg2 !== undefined
  ) {
    fn(op, arg, arg2);
  } else if (op === "sni_tray_activate" && typeof arg === "string") {
    fn(op, arg);
  } else if (
    op === "sni_tray_open_menu" &&
    typeof arg === "string" &&
    typeof arg2 === "number"
  ) {
    fn(op, arg, arg2);
  } else if (
    op === "sni_tray_menu_event" &&
    typeof arg === "string" &&
    typeof arg2 === "string" &&
    arg3 !== undefined
  ) {
    fn(op, arg, arg2, arg3);
  } else if (
    op === "shell_blur_ui_window" ||
    op === "programs_menu_closed" ||
    op === "shell_ui_grab_end"
  ) {
    fn(op);
  } else {
    fn(op, arg);
  }
  return true;
};
