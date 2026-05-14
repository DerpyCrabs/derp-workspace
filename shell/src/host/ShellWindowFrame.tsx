import { type JSX, type Accessor, Show, createMemo } from "solid-js";
import {
  SHELL_RESIZE_BOTTOM,
  SHELL_RESIZE_LEFT,
  SHELL_RESIZE_RIGHT,
} from "@/lib/chromeConstants";
import {
  emptyShellWindowFrameLayout,
  shellWindowFrameLayout,
} from "./shellWindowFrameLayout";

export type ShellWindowModel = {
  window_id: number;
  surface_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  client_x?: number;
  client_y?: number;
  client_width?: number;
  client_height?: number;
  frame_x?: number;
  frame_y?: number;
  frame_width?: number;
  frame_height?: number;
  title: string;
  app_id: string;
  maximized: boolean;
  fullscreen: boolean;
  client_side_decoration?: boolean;
  snap_tiled?: boolean;
};

type MaybeAcc<T> = T | Accessor<T>;

function readAcc<T>(v: MaybeAcc<T>): T {
  return typeof v === "function" ? (v as Accessor<T>)() : v;
}

const titlebarLastClickByWindow = new Map<
  number,
  { t: number; x: number; y: number }
>();
const titlebarSuppressDblClickUntilByWindow = new Map<number, number>();

function titlebarInteractionTarget(
  target: EventTarget | null,
): HTMLElement | null {
  return target instanceof HTMLElement
    ? target.closest(
        "[data-shell-titlebar-controls], [data-workspace-tab], [data-workspace-tab-close]",
      )
    : null;
}

type ShellWindowFrameProps = {
  win: ShellWindowModel | Accessor<ShellWindowModel | undefined>;
  repaintKey?: MaybeAcc<number>;
  focused: MaybeAcc<boolean>;
  stackZ: MaybeAcc<number>;
  dragging?: MaybeAcc<boolean>;
  dragOpacity?: MaybeAcc<number>;
  hidden?: MaybeAcc<boolean>;
  frameVisible?: MaybeAcc<boolean>;
  contentPointerEvents?: MaybeAcc<"auto" | "none">;
  contentBackground?: MaybeAcc<string>;
  contentVisible?: MaybeAcc<boolean>;
  onFocusRequest?: () => void;
  onTitlebarPointerDown: (
    pointerId: number,
    clientX: number,
    clientY: number,
  ) => void;
  onTitlebarDoubleClick?: () => void;
  onSnapAssistOpen?: (anchorRect: DOMRect) => void;
  onResizeEdgeDown: (
    edges: number,
    pointerId: number,
    clientX: number,
    clientY: number,
  ) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  tabStrip?: JSX.Element;
  children?: JSX.Element;
};

export function ShellWindowFrame(props: ShellWindowFrameProps) {
  let pendingTitlebarDrag:
    | {
        pointerId: number;
        windowId: number;
        clientX: number;
        clientY: number;
        timer: number;
      }
    | null = null;
  const clearPendingTitlebarDrag = () => {
    const pending = pendingTitlebarDrag;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    window.removeEventListener("pointermove", onPendingTitlebarPointerMove, true);
    window.removeEventListener("pointerup", onPendingTitlebarPointerDone, true);
    window.removeEventListener("pointercancel", onPendingTitlebarPointerDone, true);
    pendingTitlebarDrag = null;
  };
  const startPendingTitlebarDrag = (
    pending: {
      pointerId: number;
      windowId: number;
      clientX: number;
      clientY: number;
      timer: number;
    },
    clientX: number,
    clientY: number,
  ) => {
    if (pendingTitlebarDrag !== pending) return;
    titlebarLastClickByWindow.delete(pending.windowId);
    clearPendingTitlebarDrag();
    props.onTitlebarPointerDown(pending.pointerId, clientX, clientY);
  };
  function onPendingTitlebarPointerMove(e: PointerEvent) {
    const pending = pendingTitlebarDrag;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (
      Math.abs(e.clientX - pending.clientX) < 1 &&
      Math.abs(e.clientY - pending.clientY) < 1
    )
      return;
    startPendingTitlebarDrag(pending, e.clientX, e.clientY);
  }
  function onPendingTitlebarPointerDone(e: PointerEvent) {
    if (pendingTitlebarDrag?.pointerId === e.pointerId) {
      clearPendingTitlebarDrag();
    }
  }
  const requestFocus = () => {
    props.onFocusRequest?.();
  };
  const model = createMemo((): ShellWindowModel | undefined => {
    const v = props.win;
    return typeof v === "function"
      ? (v as Accessor<ShellWindowModel | undefined>)()
      : v;
  });
  const layout = createMemo(() => {
    const w = model();
    return w ? shellWindowFrameLayout(w) : emptyShellWindowFrameLayout();
  });
  const chromeBg = createMemo(() =>
    readAcc(props.focused)
      ? "var(--shell-window-chrome-focused)"
      : "var(--shell-window-chrome-unfocused)",
  );
  const startResize = (
    edges: number,
    pointerId: number,
    clientX: number,
    clientY: number,
  ) => {
    props.onResizeEdgeDown(edges, pointerId, clientX, clientY);
  };
  const frameVisible = () =>
    props.frameVisible === undefined || readAcc(props.frameVisible);
  const dragging = () =>
    props.dragging !== undefined && readAcc(props.dragging);
  const chromeHidden = () =>
    (props.hidden !== undefined && readAcc(props.hidden)) || !frameVisible();
  const fireTitlebarDoubleClick = () => {
    const windowId = model()?.window_id ?? 0;
    titlebarSuppressDblClickUntilByWindow.set(
      windowId,
      performance.now() + 750,
    );
    titlebarLastClickByWindow.delete(windowId);
    requestFocus();
    props.onTitlebarDoubleClick?.();
  };

  return (
    <div
      data-shell-window-frame={model()?.window_id ?? 0}
      data-shell-window-hidden={chromeHidden() ? "true" : "false"}
      data-shell-window-dragging={dragging() ? "true" : "false"}
      data-shell-repaint={
        props.repaintKey !== undefined ? readAcc(props.repaintKey) : 0
      }
      class="pointer-events-none box-border"
      style={{
        position: "absolute",
        "z-index": 1000 + readAcc(props.stackZ),
        left: "0",
        top: "0",
        width: `${layout().ow}px`,
        height: `${layout().oh}px`,
        transform: `translate3d(${layout().ox}px, ${layout().oy}px, 0)`,
        "will-change": "transform",
        "box-sizing": "border-box",
        "pointer-events": "none",
        contain: "layout paint",
        background: "transparent",
        "--shell-chrome-bg": chromeBg(),
        visibility: chromeHidden() ? "hidden" : "visible",
        opacity: chromeHidden()
          ? "0"
          : props.dragOpacity !== undefined
            ? String(readAcc(props.dragOpacity))
            : dragging()
              ? "0.76"
              : "1",
      }}
    >
      <Show when={layout().showBorderChrome}>
        <div
          class="absolute z-2 box-border bg-(--shell-chrome-bg)"
          style={{
            left: "0",
            top: `${layout().insetTop + layout().th}px`,
            width: `${layout().inset}px`,
            bottom: "0",
          }}
        />
        <div
          class="absolute z-2 box-border bg-(--shell-chrome-bg)"
          style={{
            right: "0",
            top: `${layout().insetTop + layout().th}px`,
            width: `${layout().inset}px`,
            bottom: "0",
          }}
        />
        <div
          class="absolute z-2 box-border bg-(--shell-chrome-bg)"
          style={{
            left: `${layout().inset}px`,
            right: `${layout().inset}px`,
            bottom: "0",
            height: `${layout().inset}px`,
          }}
        />
      </Show>
      <Show
        when={
          props.contentVisible !== undefined
            ? readAcc(props.contentVisible)
            : props.children
        }
      >
        <div
          data-shell-window-content={model()?.window_id ?? 0}
          class="pointer-events-auto absolute z-5 box-border min-h-0 min-w-0 overflow-auto bg-(--shell-surface-inset) text-(--shell-text)"
          style={{
            left: `${layout().contentLeft}px`,
            top: `${layout().contentTop}px`,
            width: `${layout().contentW}px`,
            height: `${layout().contentH}px`,
            background:
              props.contentBackground !== undefined
                ? readAcc(props.contentBackground)
                : "var(--shell-surface-inset)",
            "pointer-events": dragging()
              ? "none"
              : props.contentPointerEvents !== undefined
                ? readAcc(props.contentPointerEvents)
                : "auto",
          }}
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            requestFocus();
          }}
          onTouchStart={() => {
            requestFocus();
          }}
        >
          {props.children}
        </div>
      </Show>
      <Show when={layout().th > 0}>
        <div
          data-shell-titlebar={model()?.window_id ?? 0}
          class="absolute right-0 left-0 top-0 box-border flex flex-col overflow-hidden py-0 select-none touch-none"
          style={{
            height: `${layout().insetTop + layout().th}px`,
            "box-sizing": "border-box",
            "z-index": 6,
            background: "var(--shell-chrome-bg)",
            "pointer-events": dragging() ? "none" : "auto",
          }}
          onPointerDown={(e) => {
            if (!e.isPrimary) return;
            if (e.button !== 0) return;
            if (titlebarInteractionTarget(e.target)) {
              requestFocus();
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            const now = performance.now();
            const windowId = model()?.window_id ?? 0;
            const lastTitlebarClick =
              titlebarLastClickByWindow.get(windowId) ?? null;
            if (
              lastTitlebarClick &&
              now - lastTitlebarClick.t <= 500 &&
              Math.abs(e.clientX - lastTitlebarClick.x) <= 8 &&
              Math.abs(e.clientY - lastTitlebarClick.y) <= 8
            ) {
              fireTitlebarDoubleClick();
              return;
            }
            titlebarLastClickByWindow.set(windowId, {
              t: now,
              x: e.clientX,
              y: e.clientY,
            });
            const pending = {
              pointerId: e.pointerId,
              windowId,
              clientX: e.clientX,
              clientY: e.clientY,
              timer: 0,
            };
            pending.timer = window.setTimeout(() => {
              startPendingTitlebarDrag(pending, pending.clientX, pending.clientY);
            }, 80);
            pendingTitlebarDrag = pending;
            window.addEventListener("pointermove", onPendingTitlebarPointerMove, true);
            window.addEventListener("pointerup", onPendingTitlebarPointerDone, true);
            window.addEventListener("pointercancel", onPendingTitlebarPointerDone, true);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {}
          }}
          onPointerMove={(e) => {
            const pending = pendingTitlebarDrag;
            if (!pending || pending.pointerId !== e.pointerId) return;
            if (
              Math.abs(e.clientX - pending.clientX) < 1 &&
              Math.abs(e.clientY - pending.clientY) < 1
            )
              return;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            startPendingTitlebarDrag(pending, e.clientX, e.clientY);
          }}
          onPointerUp={(e) => {
            if (pendingTitlebarDrag?.pointerId === e.pointerId) {
              clearPendingTitlebarDrag();
            }
          }}
          onPointerCancel={(e) => {
            if (pendingTitlebarDrag?.pointerId === e.pointerId) {
              clearPendingTitlebarDrag();
            }
          }}
          onDblClick={(e) => {
            if (e.button !== 0) return;
            if (titlebarInteractionTarget(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            const windowId = model()?.window_id ?? 0;
            if (
              performance.now() <=
              (titlebarSuppressDblClickUntilByWindow.get(windowId) ?? 0)
            )
              return;
            fireTitlebarDoubleClick();
          }}
          onTouchStart={(e) => {
            if (titlebarInteractionTarget(e.target)) {
              requestFocus();
              return;
            }
            const t = e.changedTouches[0];
            if (!t) return;
            e.preventDefault();
            e.stopPropagation();
            props.onTitlebarPointerDown(-1, t.clientX, t.clientY);
          }}
        >
          <Show when={layout().insetTop > 0}>
            <div class="shrink-0" style={{ height: `${layout().insetTop}px` }} />
          </Show>
          <div class="flex min-h-0 min-w-0 flex-1 flex-row items-stretch gap-1.5 overflow-hidden py-0 pr-1.5 pl-2.5">
          <Show
            when={props.tabStrip}
            fallback={
              <span
                class="flex min-h-0 min-w-0 flex-1 items-center overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap"
                classList={{
                  "text-(--shell-text-muted)": !readAcc(props.focused),
                  "text-(--shell-text)": readAcc(props.focused),
                }}
              >
                {model()?.title ||
                  model()?.app_id ||
                  `window ${model()?.window_id ?? 0}`}
              </span>
            }
          >
            <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {props.tabStrip}
            </div>
          </Show>
          <div
            class="flex shrink-0 items-center gap-1 self-stretch py-0"
            data-shell-titlebar-controls
          >
            <button
              type="button"
              data-shell-minimize-trigger={model()?.window_id ?? 0}
              class="m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-base leading-none font-bold text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)"
              title="Minimize window"
              onPointerDown={(e) => {
                requestFocus();
                e.stopPropagation();
                if (e.button !== 0) return;
                e.preventDefault();
                props.onMinimize();
              }}
              onClick={(e) => {
                if (e.detail !== 0) return;
                props.onMinimize();
              }}
            >
              −
            </button>
            <button
              type="button"
              data-shell-maximize-trigger={model()?.window_id ?? 0}
              class="m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-sm leading-none text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-bg) hover:text-(--shell-text)"
              title={model()?.maximized ? "Restore" : "Maximize"}
              onPointerDown={(e) => {
                requestFocus();
                e.stopPropagation();
                if (e.button === 0) {
                  e.preventDefault();
                  props.onMaximize();
                  return;
                }
                if (e.button === 2) {
                  e.preventDefault();
                  props.onSnapAssistOpen?.(
                    e.currentTarget.getBoundingClientRect(),
                  );
                }
              }}
              onClick={(e) => {
                if (e.detail !== 0) return;
                props.onMaximize();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onSnapAssistOpen?.(
                  e.currentTarget.getBoundingClientRect(),
                );
              }}
            >
              {model()?.maximized ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.35"
                    stroke-linejoin="miter"
                    d="M1.5 3.5h7v7h-7z M3.5 1.5h7v7h-7z"
                  />
                </svg>
              ) : (
                <svg
                  class="block shrink-0"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <rect
                    x="2"
                    y="2"
                    width="8"
                    height="8"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.35"
                  />
                </svg>
              )}
            </button>
            <button
              type="button"
              data-shell-close-trigger={model()?.window_id ?? 0}
              class="m-0 flex h-full min-h-[22px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-lg leading-none text-(--shell-control-muted-text) hover:bg-[color-mix(in_srgb,var(--shell-warning-bg)_70%,var(--shell-accent)_30%)] hover:text-(--shell-text)"
              title="Close window"
              onPointerDown={(e) => {
                requestFocus();
                e.stopPropagation();
                if (e.button !== 0) return;
                e.preventDefault();
                props.onClose();
              }}
              onClick={(e) => {
                if (e.detail !== 0) return;
                props.onClose();
              }}
            >
              ×
            </button>
          </div>
          </div>
        </div>
      </Show>
      <div
        data-shell-resize-bottom-left={model()?.window_id ?? 0}
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize"
        style={{
          position: "absolute",
          left: "0",
          bottom: "0",
          width: `${layout().rh}px`,
          height: `${layout().rh}px`,
          cursor: "nesw-resize",
          "pointer-events": dragging() ? "none" : "auto",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(
            SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT,
            e.pointerId,
            e.clientX,
            e.clientY,
          );
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(
            SHELL_RESIZE_BOTTOM | SHELL_RESIZE_LEFT,
            -1,
            t.clientX,
            t.clientY,
          );
        }}
      />
      <div
        data-shell-resize-bottom-right={model()?.window_id ?? 0}
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize"
        style={{
          position: "absolute",
          right: "0",
          bottom: "0",
          width: `${layout().rh}px`,
          height: `${layout().rh}px`,
          cursor: "nwse-resize",
          "pointer-events": dragging() ? "none" : "auto",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(
            SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT,
            e.pointerId,
            e.clientX,
            e.clientY,
          );
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(
            SHELL_RESIZE_BOTTOM | SHELL_RESIZE_RIGHT,
            -1,
            t.clientX,
            t.clientY,
          );
        }}
      />
      <div
        data-shell-resize-bottom={model()?.window_id ?? 0}
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize height"
        style={{
          position: "absolute",
          left: `${layout().rh}px`,
          bottom: "0",
          width: `${Math.max(0, layout().outerW - 2 * layout().rh)}px`,
          height: `${layout().rh}px`,
          cursor: "ns-resize",
          "pointer-events": dragging() ? "none" : "auto",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_BOTTOM, e.pointerId, e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_BOTTOM, -1, t.clientX, t.clientY);
        }}
      />
      <div
        data-shell-resize-left={model()?.window_id ?? 0}
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize width"
        style={{
          position: "absolute",
          left: "0",
          top: `${layout().insetTop + layout().th}px`,
          width: `${layout().rh}px`,
          bottom: `${layout().rh}px`,
          cursor: "ew-resize",
          "pointer-events": dragging() ? "none" : "auto",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_LEFT, e.pointerId, e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_LEFT, -1, t.clientX, t.clientY);
        }}
      />
      <div
        data-shell-resize-right={model()?.window_id ?? 0}
        class="pointer-events-auto touch-none z-3 box-border"
        classList={{ hidden: !layout().showBorderChrome }}
        title="Resize width"
        style={{
          position: "absolute",
          right: "0",
          top: `${layout().insetTop + layout().th}px`,
          width: `${layout().rh}px`,
          bottom: `${layout().rh}px`,
          cursor: "ew-resize",
          "pointer-events": dragging() ? "none" : "auto",
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_RIGHT, e.pointerId, e.clientX, e.clientY);
        }}
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          startResize(SHELL_RESIZE_RIGHT, -1, t.clientX, t.clientY);
        }}
      />
    </div>
  );
}
