import {
  BTN_LEFT,
  BTN_RIGHT,
  KEY,
  SHELL_UI_PORTAL_PICKER_WINDOW_ID,
  SHELL_UI_SETTINGS_WINDOW_ID,
  activateTaskbarWindow,
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  assertTopWindow,
  captureScreenshotRect,
  clickRect,
  clickPoint,
  closeTaskbarWindow,
  compositorWindowById,
  copyArtifactFile,
  createTimingMarks,
  defineGroup,
  discoverReadyBase,
  dragBetweenPoints,
  ensureNativePair,
  getJson,
  getShellHtml,
  getSnapshots,
  keyAction,
  movePoint,
  openSettings,
  pickMonitorMove,
  pointerButton,
  pointerWheel,
  postJson,
  readPngRgba,
  runKeybind,
  spawnNativeWindow,
  tapKey,
  taskbarForMonitor,
  waitFor,
  waitForNativeFocus,
  waitForShellUiFocus,
  waitForWindowGone,
  windowControls,
  writeJsonArtifact,
  type CompositorSnapshot,
  type Rect,
  type ShellSnapshot,
  type WindowSnapshot,
} from "../lib/runtime.ts";

const TITLEBAR_PX = 26;
const SHIFT_KEYCODE = 42;
const SUPER_KEYCODE = 125;

function monitorFrameRect(
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
): { x: number; y: number; width: number; height: number } {
  const output =
    compositor.outputs.find((entry) => entry.name === outputName) ?? null;
  const taskbar = taskbarForMonitor(shell, outputName);
  assert(output, `missing output ${outputName}`);
  assert(taskbar?.rect, `missing taskbar for ${outputName}`);
  return {
    x: output.x,
    y: output.y,
    width: output.width,
    height: taskbar.rect.global_y - output.y,
  };
}

function tiledClientRectFromFrame(frame: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: frame.x,
    y: frame.y + TITLEBAR_PX,
    width: frame.width,
    height: frame.height - TITLEBAR_PX,
  };
}

function resolveWindowOutputName(
  compositor: CompositorSnapshot,
  window: WindowSnapshot,
): string | null {
  if (window.output_name) return window.output_name;
  const centerX = window.x + window.width / 2;
  const centerY = window.y + window.height / 2;
  const output = compositor.outputs.find(
    (entry) =>
      centerX >= entry.x &&
      centerX < entry.x + entry.width &&
      centerY >= entry.y &&
      centerY < entry.y + entry.height,
  );
  return output?.name ?? null;
}

function assertTopThirdWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  column: "left" | "center" | "right",
) {
  const work = monitorFrameRect(outputName, compositor, shell);
  const thirdWidth = Math.round(work.width / 3);
  const twoThirdWidth = Math.round((work.width * 2) / 3);
  const halfHeight = Math.round(work.height / 2);
  const frame = {
    x:
      column === "left"
        ? work.x
        : column === "center"
          ? work.x + thirdWidth
          : work.x + twoThirdWidth,
    y: work.y,
    width:
      column === "left"
        ? thirdWidth
        : column === "center"
          ? twoThirdWidth - thirdWidth
          : work.width - twoThirdWidth,
    height: halfHeight,
  };
  assertWindowMatchesRect(
    window,
    tiledClientRectFromFrame(frame),
    `${column} top third`,
  );
}

function assertTopRightQuarterWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
) {
  const work = monitorFrameRect(outputName, compositor, shell);
  const halfWidth = Math.round(work.width / 2);
  const halfHeight = Math.round(work.height / 2);
  assertWindowMatchesRect(
    window,
    tiledClientRectFromFrame({
      x: work.x + halfWidth,
      y: work.y,
      width: work.width - halfWidth,
      height: halfHeight,
    }),
    "top-right quarter",
  );
}

function assertWindowMatchesRect(
  window: WindowSnapshot,
  expected: { x: number; y: number; width: number; height: number },
  label: string,
) {
  assert(
    Math.abs(window.x - expected.x) <= 28,
    `expected ${label} x near ${expected.x}, got ${window.x}`,
  );
  assert(
    Math.abs(window.y - expected.y) <= 28,
    `expected ${label} y near ${expected.y}, got ${window.y}`,
  );
  assert(
    Math.abs(window.width - expected.width) <= 36,
    `expected ${label} width near ${expected.width}, got ${window.width}`,
  );
  assert(
    Math.abs(window.height - expected.height) <= 36,
    `expected ${label} height near ${expected.height}, got ${window.height}`,
  );
}

function assertSnapshotRectMatchesRect(
  rect: { global_x: number; global_y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  label: string,
) {
  assert(
    Math.abs(rect.global_x - expected.x) <= 28,
    `expected ${label} x near ${expected.x}, got ${rect.global_x}`,
  );
  assert(
    Math.abs(rect.global_y - expected.y) <= 28,
    `expected ${label} y near ${expected.y}, got ${rect.global_y}`,
  );
  assert(
    Math.abs(rect.width - expected.width) <= 36,
    `expected ${label} width near ${expected.width}, got ${rect.width}`,
  );
  assert(
    Math.abs(rect.height - expected.height) <= 36,
    `expected ${label} height near ${expected.height}, got ${rect.height}`,
  );
}

function assertTopTwoThirdsThirdWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  column: "left" | "center" | "right",
) {
  const work = monitorFrameRect(outputName, compositor, shell);
  const thirdWidth = Math.round(work.width / 3);
  const twoThirdWidth = Math.round((work.width * 2) / 3);
  const twoThirdHeight = Math.round((work.height * 2) / 3);
  const frame = {
    x:
      column === "left"
        ? work.x
        : column === "center"
          ? work.x + thirdWidth
          : work.x + twoThirdWidth,
    y: work.y,
    width:
      column === "left"
        ? thirdWidth
        : column === "center"
          ? twoThirdWidth - thirdWidth
          : work.width - twoThirdWidth,
    height: twoThirdHeight,
  };
  assertWindowMatchesRect(
    window,
    tiledClientRectFromFrame(frame),
    `${column} top two-thirds`,
  );
}

function assertFullHeightTwoThirdsWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  side: "left" | "right",
) {
  const work = monitorFrameRect(outputName, compositor, shell);
  const thirdWidth = Math.round(work.width / 3);
  const frame = {
    x: side === "left" ? work.x : work.x + thirdWidth,
    y: work.y,
    width: Math.round((work.width * 2) / 3),
    height: work.height,
  };
  assertWindowMatchesRect(
    window,
    tiledClientRectFromFrame(frame),
    `${side} full-height two-thirds`,
  );
}

async function waitForPickerOpen(
  base: string,
  windowId: number,
): Promise<ShellSnapshot> {
  return waitFor(
    `wait for picker open ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return shell.snap_picker_open &&
        shell.snap_picker_window_id === windowId &&
        shell.controls?.snap_picker_root
        ? shell
        : null;
    },
    5000,
    100,
  );
}

async function waitForSnapStripTrigger(base: string) {
  const shell = await waitFor(
    "wait for snap strip trigger",
    async () => {
      const current = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return current.controls?.snap_strip_trigger ? current : null;
    },
    4000,
    100,
  );
  return assertRectMinSize(
    "snap strip trigger",
    shell.controls?.snap_strip_trigger,
    12,
  );
}

function nativeTitlebarDragPoint(shell: ShellSnapshot, windowId: number) {
  const controls = windowControls(shell, windowId);
  const titlebar = assertRectMinSize(
    `native titlebar ${windowId}`,
    controls?.titlebar,
    80,
    16,
  );
  const group =
    shell.tab_groups?.find((entry) =>
      entry.member_window_ids.includes(windowId),
    ) ?? null;
  const rightTabs = group?.tabs
    .filter((tab) => !tab.split_left && !!tab.rect)
    .map((tab) => tab.rect!);
  const tabsRight =
    rightTabs && rightTabs.length > 0
      ? Math.max(...rightTabs.map((rect) => rect.global_x + rect.width))
      : titlebar.global_x + 20;
  const controlsLeft =
    controls?.minimize?.global_x ?? titlebar.global_x + titlebar.width;
  if (controlsLeft - tabsRight >= 24) {
    const y =
      titlebar.global_y +
      Math.max(
        8,
        Math.min(titlebar.height - 8, Math.round(titlebar.height / 2)),
      );
    const minX = Math.round(tabsRight + 12);
    const maxX = Math.round(controlsLeft - 20);
    let x = maxX;
    const strip = shell.controls?.snap_strip_trigger;
    if (
      strip &&
      y >= strip.global_y &&
      y <= strip.global_y + strip.height &&
      x >= strip.global_x &&
      x <= strip.global_x + strip.width
    ) {
      const leftCandidate = Math.round(Math.max(minX, strip.global_x - 12));
      const rightCandidate = Math.round(
        Math.min(maxX, strip.global_x + strip.width + 12),
      );
      if (leftCandidate < strip.global_x) {
        x = leftCandidate;
      } else if (rightCandidate > strip.global_x + strip.width) {
        x = rightCandidate;
      }
    }
    return {
      x,
      y,
    };
  }
  return {
    x: Math.round(
      titlebar.global_x + Math.min(140, Math.max(40, titlebar.width * 0.35)),
    ),
    y: Math.round(titlebar.global_y + titlebar.height / 2),
  };
}

async function dragPointerToPoint(
  base: string,
  x: number,
  y: number,
  steps = 10,
): Promise<void> {
  const compositor = await getJson<CompositorSnapshot>(
    base,
    "/test/state/compositor",
  );
  assert(compositor.pointer, "missing compositor pointer position");
  const startX = compositor.pointer.x;
  const startY = compositor.pointer.y;
  const count = Math.max(1, steps);
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    await movePoint(
      base,
      Math.round(startX + (x - startX) * t),
      Math.round(startY + (y - startY) * t),
    );
  }
}

async function dragPointerToPointUntil<T>(
  base: string,
  x: number,
  y: number,
  steps: number,
  label: string,
  check: () => Promise<T | null>,
): Promise<T> {
  const compositor = await getJson<CompositorSnapshot>(
    base,
    "/test/state/compositor",
  );
  assert(compositor.pointer, "missing compositor pointer position");
  const startX = compositor.pointer.x;
  const startY = compositor.pointer.y;
  const count = Math.max(1, steps);
  let matched: T | null = null;
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    await movePoint(
      base,
      Math.round(startX + (x - startX) * t),
      Math.round(startY + (y - startY) * t),
    );
    if (matched === null) matched = await check();
  }
  if (matched) return matched;
  const result = await check();
  if (result) return result;
  throw new Error(`${label}: condition not met during drag`);
}

async function openPickerWhileDragging(
  base: string,
  windowId: number,
): Promise<ShellSnapshot> {
  const strip = await waitForSnapStripTrigger(base);
  const stripCenter = rectGlobalCenter(strip);
  const inset = Math.max(12, Math.min(28, Math.round(strip.width / 5)));
  const points = [
    stripCenter,
    {
      x: Math.max(strip.global_x + inset, stripCenter.x - inset),
      y: stripCenter.y,
    },
    {
      x: Math.min(strip.global_x + strip.width - inset, stripCenter.x + inset),
      y: stripCenter.y,
    },
    stripCenter,
  ];
  for (const point of points) {
    await dragPointerToPoint(base, point.x, point.y, 6);
    const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    if (
      shell.snap_picker_open &&
      shell.snap_picker_window_id === windowId &&
      shell.controls?.snap_picker_root
    ) {
      return shell;
    }
  }
  try {
    return await waitForPickerOpen(base, windowId);
  } catch (error) {
    const { compositor, shell } = await getSnapshots(base);
    await writeJsonArtifact(`snap-assist-open-picker-debug-${windowId}.json`, {
      error: error instanceof Error ? error.message : String(error),
      windowId,
      strip,
      points,
      compositor,
      shell,
    });
    throw error;
  }
}

async function waitForPickerClosed(
  base: string,
  windowId: number,
): Promise<ShellSnapshot> {
  return waitFor(
    `wait for picker closed ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return !shell.snap_picker_open && shell.snap_picker_window_id !== windowId
        ? shell
        : null;
    },
    4000,
    100,
  );
}

async function waitForPickerAboveWindow(
  base: string,
  shell: ShellSnapshot,
  windowId: number,
) {
  const root = assertRectMinSize(
    "picker root",
    shell.controls?.snap_picker_root,
    48,
  );
  return waitFor(
    "wait for snap picker above dragged window",
    async () => {
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const window = compositorWindowById(compositor, windowId);
      const placement = compositor.shell_ui_windows?.find(
        (entry) => entry.id === SHELL_UI_PORTAL_PICKER_WINDOW_ID,
      );
      if (!window || !placement) return null;
      if (placement.z <= (window.stack_z ?? 0)) return null;
      if (Math.abs(placement.global.x - root.global_x) > 3) return null;
      if (Math.abs(placement.global.y - root.global_y) > 3) return null;
      if (Math.abs(placement.global.width - root.width) > 3) return null;
      if (Math.abs(placement.global.height - root.height) > 3) return null;
      return { compositor, placement, window };
    },
    2000,
    16,
  );
}

async function hoverPickerCellWhileDragging(
  base: string,
  label: string,
  rect: { global_x: number; global_y: number; width: number; height: number },
): Promise<ShellSnapshot> {
  const center = rectGlobalCenter(rect);
  await movePoint(base, center.x, center.y);
  return waitFor(
    label,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return shell.snap_hover_span ? shell : null;
    },
    4000,
    100,
  );
}

async function dragToTopRightEdgePreview(
  base: string,
  output: { x: number; y: number; width: number; height: number },
  label: string,
  accept: (shell: ShellSnapshot) => boolean,
): Promise<ShellSnapshot> {
  const points = [
    { x: output.x + output.width - 24, y: output.y + 8 },
    { x: output.x + output.width - 8, y: output.y + 8 },
    { x: output.x + output.width - 40, y: output.y + 32 },
    { x: output.x + output.width - 16, y: output.y + 12 },
  ];
  for (const point of points) {
    await dragPointerToPoint(base, point.x, point.y, 8);
    const shell = await waitFor(
      label,
      async () => {
        const current = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return accept(current) ? current : null;
      },
      500,
      16,
    ).catch(() => null);
    if (shell) return shell;
  }
  return waitFor(
    label,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return accept(shell) ? shell : null;
    },
    2000,
    16,
  );
}

async function revealVisiblePickerControl(
  base: string,
  windowId: number,
  key:
    | "snap_picker_first_cell"
    | "snap_picker_top_center_cell"
    | "snap_picker_right_two_thirds"
    | "snap_picker_top_two_thirds_left",
  label: string,
) {
  let shell = await waitForPickerOpen(base, windowId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rect = shell.controls?.[key];
    if (rect) {
      return {
        shell,
        rect: assertRectMinSize(label, rect, 12),
      };
    }
    const root = assertRectMinSize(
      "picker root",
      shell.controls?.snap_picker_root,
      48,
    );
    const center = rectGlobalCenter(root);
    await movePoint(base, center.x, center.y);
    await pointerWheel(base, 0, 320);
    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    if (!shell.snap_picker_open || shell.snap_picker_window_id !== windowId) {
      shell = await waitForPickerOpen(base, windowId);
    }
  }
  const finalShell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  return {
    shell: finalShell,
    rect: assertRectMinSize(label, finalShell.controls?.[key], 12),
  };
}

function rectGlobalCenter(rect: {
  global_x: number;
  global_y: number;
  width: number;
  height: number;
}) {
  return {
    x: rect.global_x + rect.width / 2,
    y: rect.global_y + rect.height / 2,
  };
}

async function assertVisiblePixelsInRect(
  base: string,
  rect: { x: number; y: number; width: number; height: number },
  label: string,
) {
  const shot = await captureScreenshotRect(base, rect)
  const png = await readPngRgba(shot.path)
  let visible = 0
  let greenClient = 0
  let blendedGreenClient = 0
  let opaqueGreenClient = 0
  let greenSum = 0
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] > 16) visible += 1
    const r = png.data[i - 3]
    const g = png.data[i - 2]
    const b = png.data[i - 1]
    if (png.data[i] > 180 && g > 120 && g > r + 35 && g > b + 20) {
      greenClient += 1
      greenSum += g
      if (g >= 180) opaqueGreenClient += 1
      if (g >= 130 && g <= 175) blendedGreenClient += 1
    }
  }
  const total = png.width * png.height
  assert(
    visible >= Math.floor(total * 0.2),
    `${label} expected visible pixels in screenshot, got ${visible}/${total}`,
  )
  assert(
    greenClient >= Math.floor(total * 0.05),
    `${label} expected visible CSD client pixels in screenshot, got ${greenClient}/${total}`,
  )
  return {
    path: await copyArtifactFile(`${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, shot.path),
    width: png.width,
    height: png.height,
    visible,
    greenClient,
    blendedGreenClient,
    opaqueGreenClient,
    greenAverage: greenClient > 0 ? greenSum / greenClient : 0,
    total,
  }
}

function isTranslucentDragWindow(
  window: WindowSnapshot | null | undefined,
): window is WindowSnapshot {
  if (!window) return false
  const alpha = window.render_alpha ?? 1
  return alpha >= 0.7 && alpha <= 0.82
}

function assertTranslucentDragWindow(
  window: WindowSnapshot | null | undefined,
  label: string,
) {
  assert(window, `${label} missing window`)
  const alpha = window.render_alpha ?? 1
  assert(
    isTranslucentDragWindow(window),
    `${label} expected drag alpha around 0.76, got ${alpha}`,
  )
}

async function assertTranslucentCsdDragPixels(
  base: string,
  rect: { x: number; y: number; width: number; height: number },
  label: string,
) {
  const pixels = await assertVisiblePixelsInRect(base, rect, label)
  assert(
    pixels.blendedGreenClient >= Math.floor(pixels.greenClient * 0.35),
    `${label} expected blended translucent CSD client pixels, got ${pixels.blendedGreenClient}/${pixels.greenClient} with avg green ${pixels.greenAverage}`,
  )
  assert(
    pixels.opaqueGreenClient <= Math.ceil(pixels.greenClient * 0.65),
    `${label} expected CSD drag pixels not to be mostly opaque, got ${pixels.opaqueGreenClient}/${pixels.greenClient} with avg green ${pixels.greenAverage}`,
  )
  return pixels
}

function shellSessionWindowHasMonitorTile(shell: ShellSnapshot, windowId: number) {
  const session = shell.session_snapshot as {
    monitorTiles?: Array<{
      entries?: Array<{ windowId?: number; window_id?: number }>
    }>
  } | null
  return (
    session?.monitorTiles?.some((monitor) =>
      monitor.entries?.some(
        (entry) => (entry.windowId ?? entry.window_id) === windowId,
      ),
    ) ?? false
  )
}

type ScreenshotArtifact = {
  path: string
  rect: { x: number; y: number; width: number; height: number }
  width: number
  height: number
}

async function captureOutputArtifact(
  base: string,
  output: { x: number; y: number; width: number; height: number },
  label: string,
): Promise<ScreenshotArtifact> {
  const rect = {
    x: output.x,
    y: output.y,
    width: output.width,
    height: output.height,
  }
  const shot = await captureScreenshotRect(base, rect)
  const png = await readPngRgba(shot.path)
  return {
    path: await copyArtifactFile(`${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`, shot.path),
    rect,
    width: png.width,
    height: png.height,
  }
}

async function assertScreenshotRectChanged(
  beforeShot: ScreenshotArtifact,
  afterShot: ScreenshotArtifact,
  targetRect: { global_x: number; global_y: number; width: number; height: number },
  label: string,
) {
  const before = await readPngRgba(beforeShot.path)
  const after = await readPngRgba(afterShot.path)
  const x0 = Math.max(targetRect.global_x, beforeShot.rect.x, afterShot.rect.x)
  const y0 = Math.max(targetRect.global_y, beforeShot.rect.y, afterShot.rect.y)
  const x1 = Math.min(
    targetRect.global_x + targetRect.width,
    beforeShot.rect.x + beforeShot.rect.width,
    afterShot.rect.x + afterShot.rect.width,
  )
  const y1 = Math.min(
    targetRect.global_y + targetRect.height,
    beforeShot.rect.y + beforeShot.rect.height,
    afterShot.rect.y + afterShot.rect.height,
  )
  assert(x1 > x0 && y1 > y0, `${label} rect is outside screenshot bounds`)
  const beforeScaleX = before.width / beforeShot.rect.width
  const beforeScaleY = before.height / beforeShot.rect.height
  const afterScaleX = after.width / afterShot.rect.width
  const afterScaleY = after.height / afterShot.rect.height
  const beforeX0 = Math.max(0, Math.floor((x0 - beforeShot.rect.x) * beforeScaleX))
  const beforeY0 = Math.max(0, Math.floor((y0 - beforeShot.rect.y) * beforeScaleY))
  const beforeX1 = Math.min(before.width, Math.ceil((x1 - beforeShot.rect.x) * beforeScaleX))
  const beforeY1 = Math.min(before.height, Math.ceil((y1 - beforeShot.rect.y) * beforeScaleY))
  const afterX0 = Math.max(0, Math.floor((x0 - afterShot.rect.x) * afterScaleX))
  const afterY0 = Math.max(0, Math.floor((y0 - afterShot.rect.y) * afterScaleY))
  const afterX1 = Math.min(after.width, Math.ceil((x1 - afterShot.rect.x) * afterScaleX))
  const afterY1 = Math.min(after.height, Math.ceil((y1 - afterShot.rect.y) * afterScaleY))
  const compareWidth = Math.min(beforeX1 - beforeX0, afterX1 - afterX0)
  const compareHeight = Math.min(beforeY1 - beforeY0, afterY1 - afterY0)
  assert(compareWidth > 0 && compareHeight > 0, `${label} rect has no physical pixels`)
  let changed = 0
  let compared = 0
  for (let py = 0; py < compareHeight; py += 1) {
    const by = beforeY0 + py
    const ay = afterY0 + py
    for (let px = 0; px < compareWidth; px += 1) {
      const bi = (by * before.width + beforeX0 + px) * 4
      const ai = (ay * after.width + afterX0 + px) * 4
      const delta =
        Math.abs(before.data[bi] - after.data[ai]) +
        Math.abs(before.data[bi + 1] - after.data[ai + 1]) +
        Math.abs(before.data[bi + 2] - after.data[ai + 2]) +
        Math.abs(before.data[bi + 3] - after.data[ai + 3])
      if (delta > 24) changed += 1
      compared += 1
    }
  }
  const minChanged = Math.max(800, Math.floor(compared * 0.035))
  assert(
    changed >= minChanged,
    `${label} expected visible screenshot change, got ${changed}/${compared}`,
  )
  return { changed, compared, before: beforeShot.path, after: afterShot.path }
}

function usableSettingsSnapOption(rect: Rect | null | undefined): rect is Rect {
  return !!rect && rect.width >= 80 && rect.height >= 72;
}

async function clickSettingsSnapOption(
  base: string,
  rect: Rect | null | undefined,
  label: string,
) {
  const target = assertRectMinSize(label, rect, 12);
  await clickPoint(
    base,
    target.global_x + target.width / 2,
    target.global_y + Math.min(10, target.height / 2),
  );
}

async function scrollSettingsToCustomSnapOption(
  base: string,
): Promise<ShellSnapshot> {
  let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const custom = shell.controls?.settings_snap_layout_option_custom;
    if (usableSettingsSnapOption(custom)) return shell;
    const add = shell.controls?.settings_custom_layout_add;
    const settingsWindow = shell.windows.find(
      (window) => window.window_id === SHELL_UI_SETTINGS_WINDOW_ID,
    );
    const center = add
      ? rectGlobalCenter(add)
      : settingsWindow
        ? {
            x:
              settingsWindow.x +
              Math.min(
                settingsWindow.width - 24,
                Math.max(240, Math.round(settingsWindow.width * 0.55)),
              ),
            y:
              settingsWindow.y +
              Math.min(
                settingsWindow.height - 32,
                Math.max(88, Math.round(settingsWindow.height * 0.55)),
              ),
          }
        : shell.controls?.settings_tab_tiling
          ? rectGlobalCenter(shell.controls.settings_tab_tiling)
          : null;
    assert(center, "missing settings scroll anchor");
    await movePoint(base, center.x, center.y);
    await pointerWheel(base, 0, 120);
    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  }
  return shell;
}

async function scrollSettingsToSnapLayoutOption(
  base: string,
  layout: "2x2" | "3x2",
): Promise<ShellSnapshot> {
  let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const control =
      layout === "2x2"
        ? shell.controls?.settings_snap_layout_option_2x2
        : shell.controls?.settings_snap_layout_option_3x2;
    if (usableSettingsSnapOption(control)) return shell;
    const settingsWindow = shell.windows.find(
      (window) => window.window_id === SHELL_UI_SETTINGS_WINDOW_ID,
    );
    const center = settingsWindow
      ? {
          x:
            settingsWindow.x +
            Math.min(
              settingsWindow.width - 24,
              Math.max(240, Math.round(settingsWindow.width * 0.55)),
            ),
          y:
            settingsWindow.y +
            Math.min(
              settingsWindow.height - 32,
              Math.max(88, Math.round(settingsWindow.height * 0.55)),
            ),
        }
      : shell.controls?.settings_tab_tiling
        ? rectGlobalCenter(shell.controls.settings_tab_tiling)
        : null;
    assert(center, "missing settings scroll anchor");
    await movePoint(base, center.x, center.y);
    await pointerWheel(base, 0, 120);
    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  }
  return shell;
}

function shellHostedTitlebarPoint(window: WindowSnapshot) {
  return {
    x: window.x + window.width / 2,
    y: window.y - TITLEBAR_PX / 2,
  };
}

function assertRectCenteredOnOutput(
  rect: { global_x: number; width: number },
  output: { x: number; width: number; name: string },
  tolerance = 24,
) {
  const rectCenter = rect.global_x + rect.width / 2;
  const outputCenter = output.x + output.width / 2;
  assert(
    Math.abs(rectCenter - outputCenter) <= tolerance,
    `expected picker center near ${output.name} center ${outputCenter}, got ${rectCenter}`,
  );
}

function assertNoVerticalGapBetweenRects(
  label: string,
  anchor: { global_y: number; height: number },
  picker: { global_y: number; height: number },
) {
  const anchorBottom = anchor.global_y + anchor.height;
  const pickerBottom = picker.global_y + picker.height;
  const gap =
    picker.global_y >= anchorBottom
      ? picker.global_y - anchorBottom
      : anchor.global_y >= pickerBottom
        ? anchor.global_y - pickerBottom
        : 0;
  assert(
    gap <= 1,
    `${label} expected no vertical gap between trigger and picker, got ${gap}`,
  );
}

async function openPickerFromMaximizeButton(
  base: string,
  windowId: number,
): Promise<ShellSnapshot> {
  const { maximize } = await waitFor(
    `wait for maximize button ${windowId}`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      const controls = windowControls(shell, windowId);
      const maximize = controls?.maximize;
      if (!maximize || maximize.width < 12 || maximize.height < 12) return null;
      return { shell, maximize };
    },
    2000,
    40,
  );
  const center = rectGlobalCenter(maximize);
  await movePoint(base, center.x, center.y);
  await pointerButton(base, BTN_RIGHT, "press");
  await pointerButton(base, BTN_RIGHT, "release");
  return waitForPickerOpen(base, windowId);
}

async function focusNativeWindow(
  base: string,
  windowId: number,
): Promise<{ compositor: CompositorSnapshot; shell: ShellSnapshot }> {
  const { compositor, shell } = await getSnapshots(base);
  if (compositor.focused_window_id === windowId) {
    try {
      assertTopWindow(shell, windowId, `native focus ${windowId}`);
      return { compositor, shell };
    } catch {}
  }
  const window = compositorWindowById(compositor, windowId);
  assert(window, `missing compositor window ${windowId}`);
  try {
    await activateTaskbarWindow(base, shell, windowId);
    return await waitForNativeFocus(base, windowId, 2000);
  } catch {
    await clickPoint(
      base,
      window.x + window.width / 2,
      window.y + window.height / 2,
    );
    try {
      return await waitForNativeFocus(base, windowId, 2000);
    } catch {
      const nextShell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      await activateTaskbarWindow(base, nextShell, windowId);
      return waitForNativeFocus(base, windowId, 2000);
    }
  }
}

async function placeNativeWindowForPickerTest(
  base: string,
  windowId: number,
): Promise<void> {
  const focused = await focusNativeWindow(base, windowId);
  const window = compositorWindowById(focused.compositor, windowId);
  assert(window, `missing native window ${windowId}`);
  const output =
    focused.compositor.outputs.find(
      (entry) => entry.name === window.output_name,
    ) ?? focused.compositor.outputs[0];
  assert(output, "missing output for picker placement");
  const controls = windowControls(focused.shell, windowId);
  assert(controls?.titlebar, `missing native titlebar ${windowId}`);
  const from = nativeTitlebarDragPoint(focused.shell, windowId);
  const to = {
    x: output.x + Math.round(output.width * 0.45),
    y:
      output.y + Math.min(260, Math.max(160, Math.round(output.height * 0.22))),
  };
  await movePoint(base, from.x, from.y);
  await pointerButton(base, BTN_LEFT, "press");
  await postJson(base, "/test/input/pointer_move", to);
  await pointerButton(base, BTN_LEFT, "release");
  await waitFor(
    `wait for native picker placement ${windowId}`,
    async () => {
      const { compositor, shell } = await getSnapshots(base);
      if (
        compositor.shell_pointer_grab_window_id !== null ||
        compositor.shell_move_window_id !== null
      )
        return null;
      const next = compositorWindowById(compositor, windowId);
      if (!next) return null;
      const nextControls = windowControls(shell, windowId);
      if (!nextControls?.titlebar) return null;
      const nextOutput =
        compositor.outputs.find((entry) => entry.name === next.output_name) ??
        output;
      const insideOutput =
        next.x >= nextOutput.x + 24 &&
        next.x + next.width <= nextOutput.x + nextOutput.width - 24 &&
        next.y >= nextOutput.y + 80 &&
        next.y + next.height <= nextOutput.y + nextOutput.height - 80;
      return insideOutput ? { compositor, shell, window: next } : null;
    },
    2000,
    40,
  );
}

async function focusSettingsWindow(base: string) {
  const { compositor, shell } = await getSnapshots(base);
  if (compositor.focused_shell_ui_window_id === SHELL_UI_SETTINGS_WINDOW_ID) {
    try {
      assertTopWindow(
        shell,
        SHELL_UI_SETTINGS_WINDOW_ID,
        `shell focus ${SHELL_UI_SETTINGS_WINDOW_ID}`,
      );
      return { compositor, shell };
    } catch {}
  }
  const nextShell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  await activateTaskbarWindow(base, nextShell, SHELL_UI_SETTINGS_WINDOW_ID);
  return waitForShellUiFocus(base, SHELL_UI_SETTINGS_WINDOW_ID);
}

function settingsSnapLayout(shell: ShellSnapshot): string | null {
  const settingsWindow = shell.windows.find(
    (window) => window.window_id === SHELL_UI_SETTINGS_WINDOW_ID,
  );
  const monitorName = settingsWindow?.output_name;
  const sessionSnapshot = shell.session_snapshot as {
    monitorLayouts?: Array<{
      outputName?: string | null;
      snapLayout?: string | null;
    }> | null;
  } | null;
  if (!monitorName) return null;
  return (
    sessionSnapshot?.monitorLayouts?.find(
      (entry) => entry.outputName === monitorName,
    )?.snapLayout ?? "3x2"
  );
}

async function waitForSettingsSnapLayout(
  base: string,
  layout: "2x2" | "3x2" | "custom",
  requireTitlebar = false,
) {
  return waitFor(
    `wait for settings ${layout} snap layout selection`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      const controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID);
      const currentLayout = settingsSnapLayout(shell);
      if (layout === "custom") {
        if (!currentLayout?.startsWith("custom:")) return null;
      } else if (currentLayout !== layout) {
        return null;
      }
      return requireTitlebar && !controls?.titlebar ? null : shell;
    },
    2000,
    125,
  );
}

async function selectSettingsSnapLayout(base: string, layout: "2x2" | "3x2") {
  await openSettings(base, "click");
  await focusSettingsWindow(base);
  let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  assert(
    shell.controls?.settings_tab_tiling,
    "missing settings tiling tab rect",
  );
  await clickRect(base, shell.controls.settings_tab_tiling);
  shell = await scrollSettingsToSnapLayoutOption(base, layout);
  const control =
    layout === "2x2"
      ? shell.controls?.settings_snap_layout_option_2x2
      : shell.controls?.settings_snap_layout_option_3x2;
  await clickSettingsSnapOption(
    base,
    control,
    `settings ${layout} snap layout option`,
  );
  shell = await waitForSettingsSnapLayout(base, layout);
  await closeTaskbarWindow(base, shell, SHELL_UI_SETTINGS_WINDOW_ID);
  await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID);
}

async function selectSettingsLayoutType(
  base: string,
  layout: "manual-snap" | "custom-auto",
) {
  const opened = await openSettings(base, "click");
  await focusSettingsWindow(base);
  if (opened.shell.controls?.settings_tab_tiling) {
    await clickRect(base, opened.shell.controls.settings_tab_tiling);
  }
  let shell = await waitFor(
    `wait for ${layout} layout trigger`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.settings_tiling_layout_trigger ? next : null;
    },
    5000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "tiling layout trigger",
      shell.controls.settings_tiling_layout_trigger,
      12,
    ),
  );
  shell = await waitFor(
    `wait for ${layout} layout option`,
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      const option =
        layout === "custom-auto"
          ? next.controls?.settings_tiling_layout_option_custom_auto
          : next.controls?.settings_tiling_layout_option_manual_snap;
      return option ? next : null;
    },
    3000,
    100,
  );
  const option =
    layout === "custom-auto"
      ? shell.controls.settings_tiling_layout_option_custom_auto
      : shell.controls.settings_tiling_layout_option_manual_snap;
  await clickRect(
    base,
    assertRectMinSize(`${layout} layout option`, option, 12),
  );
}

async function configureCustomAutoRuleLayout(base: string): Promise<string> {
  await selectSettingsLayoutType(base, "manual-snap");
  let shell = await waitFor(
    "wait for custom layout add control for auto layout",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.settings_custom_layout_add ? next : null;
    },
    5000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout add",
      shell.controls.settings_custom_layout_add,
      12,
    ),
  );
  shell = await waitFor(
    "wait for custom layout overlay add",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.custom_layout_overlay_add ? next : null;
    },
    3000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout overlay add",
      shell.controls.custom_layout_overlay_add,
      12,
    ),
  );
  shell = await waitFor(
    "wait for custom layout editor zone for auto layout",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.settings_custom_layout_editor_zone ? next : null;
    },
    3000,
    100,
  );
  const firstZone = assertRectMinSize(
    "custom layout zone before split",
    shell.controls.settings_custom_layout_editor_zone,
    80,
  );
  await clickPoint(
    base,
    firstZone.global_x + firstZone.width * 0.5,
    firstZone.global_y + firstZone.height * 0.5,
  );
  shell = await waitFor(
    "wait for custom layout selected slot rule button",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.custom_layout_overlay_selected_zone_rules
        ? next
        : null;
    },
    3000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout selected zone rules",
      shell.controls.custom_layout_overlay_selected_zone_rules,
      12,
    ),
  );
  shell = await waitFor(
    "wait for custom layout add rule button",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.custom_layout_overlay_rule_add ? next : null;
    },
    3000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout add rule",
      shell.controls.custom_layout_overlay_rule_add,
      12,
    ),
  );
  shell = await waitFor(
    "wait for custom layout rule value input",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.custom_layout_overlay_rule_value ? next : null;
    },
    3000,
    100,
  );
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout rule value",
      shell.controls.custom_layout_overlay_rule_value,
      24,
    ),
  );
  await tapKey(base, KEY.backspace);
  for (const char of "derpautorule") {
    await tapKey(base, KEY[char as keyof typeof KEY]);
  }
  shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  await clickRect(
    base,
    assertRectMinSize(
      "custom layout overlay save",
      shell.controls.custom_layout_overlay_save,
      12,
    ),
  );
  shell = await waitFor(
    "wait for custom layout overlay close before custom auto",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      return next.controls?.custom_layout_overlay_root ? null : next;
    },
    3000,
    100,
  );
  await clickSettingsSnapOption(
    base,
    shell.controls.settings_snap_layout_option_custom,
    "custom snap layout option",
  );
  await selectSettingsLayoutType(base, "custom-auto");
  const configured = await getSnapshots(base);
  const settingsWindow = compositorWindowById(
    configured.compositor,
    SHELL_UI_SETTINGS_WINDOW_ID,
  );
  const outputName =
    settingsWindow?.output_name || configured.compositor.outputs[0]?.name || "";
  assert(outputName, "missing configured custom auto output");
  shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  await closeTaskbarWindow(base, shell, SHELL_UI_SETTINGS_WINDOW_ID);
  await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID);
  return outputName;
}

function assertAutoSlotWindow(
  window: WindowSnapshot,
  outputName: string,
  compositor: CompositorSnapshot,
  shell: ShellSnapshot,
  slot: "left-top" | "left-bottom" | "right",
) {
  const work = monitorFrameRect(outputName, compositor, shell);
  const halfWidth = Math.round(work.width / 2);
  const halfHeight = Math.round(work.height / 2);
  const frame =
    slot === "right"
      ? {
          x: work.x + halfWidth,
          y: work.y,
          width: work.width - halfWidth,
          height: work.height,
        }
      : {
          x: work.x,
          y: slot === "left-top" ? work.y : work.y + halfHeight,
          width: halfWidth,
          height: slot === "left-top" ? halfHeight : work.height - halfHeight,
        };
  assertWindowMatchesRect(
    window,
    tiledClientRectFromFrame(frame),
    `custom auto ${slot}`,
  );
}

export default defineGroup(import.meta.url, ({ test }) => {
  test(
    "custom auto layout rules softly reserve slots and overflow into tabs",
    async ({ base, state }) => {
      let currentBase = base;
      await postJson(currentBase, "/session_reload", { version: 1, shell: {} });
      await waitFor(
        "wait for custom auto clean shell restart",
        async () => {
          try {
            await getJson<CompositorSnapshot>(
              currentBase,
              "/test/state/compositor",
            );
            return null;
          } catch {
            return true;
          }
        },
        5000,
        100,
      );
      currentBase = await discoverReadyBase(45000);
      state.base = currentBase;
      state.knownWindowIds = new Set();
      state.spawnedNativeWindowIds.clear();
      state.nativeLaunchByWindowId.clear();
      const outputName = await configureCustomAutoRuleLayout(currentBase);
      let completed = false;
      try {
        const fillerA = await spawnNativeWindow(
          currentBase,
          state.knownWindowIds,
          {
            title: "Derp Auto Filler A",
            token: "auto-filler-a",
            strip: "#b91c1c",
          },
        );
        state.spawnedNativeWindowIds.add(fillerA.window.window_id);
        const fillerB = await spawnNativeWindow(
          currentBase,
          state.knownWindowIds,
          {
            title: "Derp Auto Filler B",
            token: "auto-filler-b",
            strip: "#15803d",
          },
        );
        state.spawnedNativeWindowIds.add(fillerB.window.window_id);
        const ruleWindow = await spawnNativeWindow(
          currentBase,
          state.knownWindowIds,
          {
            title: "derpautorule",
            appId: "derpautorule",
            token: "auto-rule",
            strip: "#1d4ed8",
          },
        );
        state.spawnedNativeWindowIds.add(ruleWindow.window.window_id);

        const reserved = await waitFor(
          "wait for custom auto reserved slot eviction",
          async () => {
            const { compositor, shell } = await getSnapshots(currentBase);
            const a = compositorWindowById(
              compositor,
              fillerA.window.window_id,
            );
            const b = compositorWindowById(
              compositor,
              fillerB.window.window_id,
            );
            const rule = compositorWindowById(
              compositor,
              ruleWindow.window.window_id,
            );
            if (!a || !b || !rule) return null;
            try {
              assertAutoSlotWindow(
                a,
                outputName,
                compositor,
                shell,
                "left-top",
              );
              assertAutoSlotWindow(
                rule,
                outputName,
                compositor,
                shell,
                "left-bottom",
              );
              assertAutoSlotWindow(b, outputName, compositor, shell, "right");
            } catch {
              return null;
            }
            return { compositor, shell, a, b, rule };
          },
          5000,
          100,
        );

        const overflow = await spawnNativeWindow(
          currentBase,
          state.knownWindowIds,
          {
            title: "Derp Auto Overflow",
            token: "auto-overflow",
            strip: "#a21caf",
          },
        );
        state.spawnedNativeWindowIds.add(overflow.window.window_id);
        const tabbed = await waitFor(
          "wait for custom auto overflow tab",
          async () => {
            const { compositor, shell } = await getSnapshots(currentBase);
            const group = shell.tab_groups?.find(
              (entry) =>
                entry.member_window_ids.includes(fillerB.window.window_id) &&
                entry.member_window_ids.includes(overflow.window.window_id),
            );
            const visible = compositorWindowById(
              compositor,
              group?.visible_window_id ?? 0,
            );
            if (!group || !visible) return null;
            try {
              assertAutoSlotWindow(
                visible,
                outputName,
                compositor,
                shell,
                "right",
              );
            } catch {
              return null;
            }
            return { compositor, shell, group, visible };
          },
          5000,
          100,
        );

        await writeJsonArtifact(
          "custom-auto-layout-reserved-slots.json",
          reserved,
        );
        await writeJsonArtifact("custom-auto-layout-overflow-tab.json", tabbed);
        completed = true;
      } finally {
        if (completed) {
          await postJson(currentBase, "/session_reload", {
            version: 1,
            shell: {},
          });
          await waitFor(
            "wait for custom auto cleanup shell restart",
            async () => {
              try {
                await getJson<CompositorSnapshot>(
                  currentBase,
                  "/test/state/compositor",
                );
                return null;
              } catch {
                return true;
              }
            },
            5000,
            100,
          );
          state.base = await discoverReadyBase(45000);
          state.knownWindowIds = new Set();
          state.spawnedNativeWindowIds.clear();
          state.nativeLaunchByWindowId.clear();
          return;
        }
      }
    },
    { shellRestart: true },
  );

  test("dragging a native titlebar into the strip opens the picker without Win", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    const focused = await focusNativeWindow(base, redId);
    const controls = windowControls(focused.shell, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    const titlebarPoint = nativeTitlebarDragPoint(focused.shell, redId);
    await movePoint(base, titlebarPoint.x, titlebarPoint.y);
    await pointerButton(base, BTN_LEFT, "press");
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId);
      assert(
        pickerOpen.snap_picker_source === "strip",
        "expected plain strip drag to open the picker",
      );
      await pointerButton(base, BTN_LEFT, "release");
      await waitForPickerClosed(base, redId);
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
    }
  });

  test("super-dragging a native titlebar into the strip opens the picker", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    const focused = await focusNativeWindow(base, redId);
    const focusedWindow = compositorWindowById(focused.compositor, redId);
    const output =
      focused.compositor.outputs.find(
        (entry) => entry.name === focusedWindow?.output_name,
      ) ?? null;
    const dragShell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    const controls = windowControls(dragShell, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    const titlebarPoint = nativeTitlebarDragPoint(dragShell, redId);
    await movePoint(base, titlebarPoint.x, titlebarPoint.y);
    await keyAction(base, SUPER_KEYCODE, "press");
    await pointerButton(base, 0x110, "press");
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId);
      assert(
        pickerOpen.snap_picker_source === "strip",
        "expected strip drag to open the picker",
      );
      assert(output, "missing focused output");
      const pickerRoot = assertRectMinSize(
        "picker root",
        pickerOpen.controls?.snap_picker_root,
        48,
      );
      assertRectCenteredOnOutput(pickerRoot, output);
      assertNoVerticalGapBetweenRects(
        "strip picker",
        assertRectMinSize(
          "snap strip trigger",
          pickerOpen.controls?.snap_strip_trigger,
          12,
        ),
        pickerRoot,
      );
      await pointerButton(base, 0x110, "release");
      await waitForPickerClosed(base, redId);
    } finally {
      await pointerButton(base, 0x110, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("super-dragging a CSD client header drives grid snap", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const csd = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp CSD Snap ${Date.now()}`,
      token: `snap-csd-${Date.now()}`,
      strip: "green",
      width: 520,
      height: 360,
      xdgDecorationClientSide: true,
      moveOnHeaderPress: true,
      solidClient: true,
    });
    const csdId = csd.window.window_id;
    state.spawnedNativeWindowIds.add(csdId);
    let pointerReleased = false;
    try {
      const ready = await waitFor(
        `wait for CSD snap source ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          const shellWindow = shell.windows.find(
            (entry) => entry.window_id === csdId,
          );
          const controls = windowControls(shell, csdId);
          if (!window || !shellWindow) return null;
          if (!window.client_side_decoration || !shellWindow.client_side_decoration) return null;
          if (controls?.titlebar) return null;
          const output =
            compositor.outputs.find((entry) => entry.name === window.output_name) ??
            compositor.outputs[0];
          if (!output) return null;
          return { compositor, shell, window, output };
        },
        3000,
        40,
      );
      const start = {
        x: Math.round(ready.window.x + ready.window.width / 2),
        y: Math.round(
          ready.window.y + Math.min(24, Math.max(8, ready.window.height / 7)),
        ),
      };
      await movePoint(base, start.x, start.y);
      await pointerButton(base, BTN_LEFT, "press");
      const armed = await waitFor(
        `wait for CSD compositor move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      assertTranslucentDragWindow(armed.window, "CSD armed drag");
      assert(
        armed.shell.compositor_interaction_state?.move_proxy_window_id === null,
        "CSD grid drag should not synthesize shell move proxy",
      );
      const dragTarget = {
        x: ready.output.x + Math.round(ready.output.width * 0.82),
        y: ready.output.y + Math.round(ready.output.height * 0.28),
      };
      await dragPointerToPoint(
        base,
        dragTarget.x,
        dragTarget.y,
        10,
      );
      const visibleDrag = await waitFor(
        `wait for visible CSD drag pixels ${csdId}`,
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, "/test/state/compositor");
          const window = compositorWindowById(compositor, csdId);
          if (!isTranslucentDragWindow(window)) return null;
          if (Math.abs(window.x - ready.window.x) < 20 && Math.abs(window.y - ready.window.y) < 20) return null;
          return assertTranslucentCsdDragPixels(
            base,
            {
              x: window.x + 12,
              y: window.y + 12,
              width: Math.min(180, window.width - 24),
              height: Math.min(120, window.height - 24),
            },
            `csd-drag-preview-${csdId}`,
          );
        },
        3000,
        16,
      );
      const beforeSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-drag-before-super-output-${csdId}`,
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      const previewShell = await waitFor(
        `wait for CSD super snap preview ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (shell.compositor_interaction_state?.super_held !== true) return null;
          if (shell.snap_drag_super_held !== true) return null;
          if (!shell.snap_preview_visible || !shell.snap_preview_rect) return null;
          return shell;
        },
        3000,
        16,
      ).catch(async (error) => {
        const snapshots = await getSnapshots(base);
        await writeJsonArtifact("snap-assist-csd-super-drag-timeout.json", {
          error: error instanceof Error ? error.message : String(error),
          start,
          pointerTarget: dragTarget,
          snapshots,
        });
        throw error;
      });
      const expected = assertRectMinSize(
        "CSD super snap preview",
        previewShell.snap_preview_rect,
        40,
      );
      const afterSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-drag-after-super-output-${csdId}`,
      );
      const visiblePreview = await assertScreenshotRectChanged(
        beforeSuperOutput,
        afterSuperOutput,
        expected,
        "CSD super snap preview output",
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      const snapped = await waitFor(
        `wait for CSD super snap commit ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (!window) return null;
          try {
            assertWindowMatchesRect(
              window,
              {
                x: expected.global_x,
                y: expected.global_y,
                width: expected.width,
                height: expected.height,
              },
              "CSD super snap",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window, expected };
        },
        2000,
        40,
      );
      await writeJsonArtifact("snap-assist-csd-super-drag.json", {
        ...snapped,
        visibleDrag,
        visiblePreview,
      });
    } finally {
      if (!pointerReleased) {
        try {
          await pointerButton(base, BTN_LEFT, "release");
        } catch {}
      }
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("dragging a snapped CSD client header restores its floating size", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const csd = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp CSD Untile ${Date.now()}`,
      token: `untile-csd-${Date.now()}`,
      strip: "green",
      width: 520,
      height: 360,
      xdgDecorationClientSide: true,
      moveOnHeaderPress: true,
      solidClient: true,
    });
    const csdId = csd.window.window_id;
    state.spawnedNativeWindowIds.add(csdId);
    let pointerReleased = true;
    try {
      const ready = await waitFor(
        `wait for CSD untile source ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          const shellWindow = shell.windows.find(
            (entry) => entry.window_id === csdId,
          );
          if (!window || !shellWindow) return null;
          if (!window.client_side_decoration || !shellWindow.client_side_decoration) return null;
          const output =
            compositor.outputs.find((entry) => entry.name === window.output_name) ??
            compositor.outputs[0];
          if (!output) return null;
          return { compositor, shell, window, output };
        },
        3000,
        40,
      );
      const floating = {
        x: ready.window.x,
        y: ready.window.y,
        width: ready.window.width,
        height: ready.window.height,
      };
      await movePoint(
        base,
        Math.round(ready.window.x + ready.window.width / 2),
        Math.round(ready.window.y + 18),
      );
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await waitFor(
        `wait for CSD snap compositor move ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return shell.compositor_interaction_state?.move_window_id === csdId
            ? shell
            : null;
        },
        2000,
        16,
      );
      const initialSnapTarget = {
        x: ready.output.x + Math.round(ready.output.width * 0.82),
        y: ready.output.y + Math.round(ready.output.height * 0.28),
      };
      await dragPointerToPoint(
        base,
        initialSnapTarget.x,
        initialSnapTarget.y,
        10,
      );
      const beforeInitialSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-untile-initial-before-super-output-${csdId}`,
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      const previewShell = await waitFor(
        `wait for CSD untile snap preview ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          if (!shell.snap_preview_visible || !shell.snap_preview_rect) return null;
          return shell;
        },
        3000,
        16,
      );
      const expected = assertRectMinSize(
        "CSD untile snap preview",
        previewShell.snap_preview_rect,
        40,
      );
      const afterInitialSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-untile-initial-after-super-output-${csdId}`,
      );
      const initialVisiblePreview = await assertScreenshotRectChanged(
        beforeInitialSuperOutput,
        afterInitialSuperOutput,
        expected,
        "CSD initial snap preview output",
      );
      const work = monitorFrameRect(
        ready.output.name,
        ready.compositor,
        ready.shell,
      );
      const twoThirdWidth = Math.round((work.width * 2) / 3);
      const halfHeight = Math.round(work.height / 2);
      const expectedSnap = {
        x: work.x + twoThirdWidth,
        y: work.y,
        width: work.width - twoThirdWidth,
        height: halfHeight,
      };
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      await keyAction(base, SUPER_KEYCODE, "release");
      const snapped = await waitFor(
        `wait for CSD untile snap commit ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (!window) return null;
          try {
            assertWindowMatchesRect(
              window,
              expectedSnap,
              "CSD untile snapped",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        40,
      );
      const start = {
        x: Math.round(snapped.window.x + snapped.window.width / 2),
        y: Math.round(snapped.window.y + 18),
      };
      const end = {
        x: Math.round(snapped.window.x + snapped.window.width / 2 + 90),
        y: Math.round(snapped.window.y + 90),
      };
      await movePoint(base, start.x, start.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await waitFor(
        `wait for CSD untile compositor move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      await dragPointerToPoint(base, end.x, end.y, 8);
      const liveUntile = await waitFor(
        `wait for CSD live untile restore ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          if (Math.abs(window.width - floating.width) > 2) return null;
          if (Math.abs(window.height - floating.height) > 2) return null;
          if (
            Math.abs(window.x - expectedSnap.x) <= 4 &&
            Math.abs(window.y - expectedSnap.y) <= 4
          )
            return null;
          return { compositor, shell, window };
        },
        3000,
        16,
      );
      const visibleUntileDrag = await assertTranslucentCsdDragPixels(
        base,
        {
          x: liveUntile.window.x + 12,
          y: liveUntile.window.y + 12,
          width: Math.min(180, liveUntile.window.width - 24),
          height: Math.min(120, liveUntile.window.height - 24),
        },
        `csd-live-untile-preview-${csdId}`,
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      const firstUntiled = await waitFor(
        `wait for CSD first untile release restore ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if ((shell.compositor_interaction_state?.move_window_id ?? null) !== null) return null;
          if (shell.snap_preview_visible) return null;
          if (shellSessionWindowHasMonitorTile(shell, csdId)) return null;
          if (!window) return null;
          if (Math.abs(window.width - floating.width) > 2) return null;
          if (Math.abs(window.height - floating.height) > 2) return null;
          if (
            Math.abs(window.x - expectedSnap.x) <= 4 &&
            Math.abs(window.y - expectedSnap.y) <= 4
          )
            return null;
          return { compositor, shell, window };
        },
        3000,
        40,
      );
      const secondDragStart = {
        x: Math.round(firstUntiled.window.x + firstUntiled.window.width / 2),
        y: Math.round(firstUntiled.window.y + 18),
      };
      await movePoint(base, secondDragStart.x, secondDragStart.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      const secondDragArmed = await waitFor(
        `wait for CSD second drag compositor move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      const secondDragSnapTarget = {
        x: ready.output.x + Math.round(ready.output.width * 0.18),
        y: ready.output.y + Math.round(ready.output.height * 0.28),
      };
      await dragPointerToPoint(
        base,
        secondDragSnapTarget.x,
        secondDragSnapTarget.y,
        10,
      );
      const beforeSecondDragSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-second-drag-before-super-output-${csdId}`,
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      const secondDragPreview = await waitFor(
        `wait for CSD second-drag snap preview ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (shell.compositor_interaction_state?.super_held !== true) return null;
          if (shell.snap_drag_super_held !== true) return null;
          if (!shell.snap_preview_visible || !shell.snap_preview_rect) return null;
          return shell;
        },
        3000,
        16,
      );
      const expectedSecondDragSnap = assertRectMinSize(
        "CSD second-drag snap preview",
        secondDragPreview.snap_preview_rect,
        40,
      );
      const afterSecondDragSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-second-drag-after-super-output-${csdId}`,
      );
      const secondDragVisiblePreview = await assertScreenshotRectChanged(
        beforeSecondDragSuperOutput,
        afterSecondDragSuperOutput,
        expectedSecondDragSnap,
        "CSD second-drag snap preview output",
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      await keyAction(base, SUPER_KEYCODE, "release");
      const secondDragSnapped = await waitFor(
        `wait for CSD second-drag snap commit ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if ((shell.compositor_interaction_state?.move_window_id ?? null) !== null) return null;
          if (!window) return null;
          try {
            assertWindowMatchesRect(
              window,
              {
                x: expectedSecondDragSnap.global_x,
                y: expectedSecondDragSnap.global_y,
                width: expectedSecondDragSnap.width,
                height: expectedSecondDragSnap.height,
              },
              "CSD second-drag snap",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        40,
      );
      const releaseRestoreStart = {
        x: Math.round(secondDragSnapped.window.x + secondDragSnapped.window.width / 2),
        y: Math.round(secondDragSnapped.window.y + 18),
      };
      const releaseRestoreEnd = {
        x: Math.round(secondDragSnapped.window.x + secondDragSnapped.window.width / 2 + 90),
        y: Math.round(secondDragSnapped.window.y + 90),
      };
      await movePoint(base, releaseRestoreStart.x, releaseRestoreStart.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await waitFor(
        `wait for CSD release-restore compositor move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      await dragPointerToPoint(base, releaseRestoreEnd.x, releaseRestoreEnd.y, 8);
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      const untiled = await waitFor(
        `wait for CSD untile restore ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if ((shell.compositor_interaction_state?.move_window_id ?? null) !== null) return null;
          if (shell.snap_preview_visible) return null;
          if (shellSessionWindowHasMonitorTile(shell, csdId)) return null;
          if (!window) return null;
          if (Math.abs(window.width - floating.width) > 2) return null;
          if (Math.abs(window.height - floating.height) > 2) return null;
          if (
            Math.abs(window.x - secondDragSnapped.window.x) <= 4 &&
            Math.abs(window.y - secondDragSnapped.window.y) <= 4
          )
            return null;
          return { compositor, shell, window, floating, expected, expectedSnap };
        },
        3000,
        40,
      );
      const postUntileSnapStart = {
        x: Math.round(untiled.window.x + untiled.window.width / 2),
        y: Math.round(untiled.window.y + 18),
      };
      await movePoint(base, postUntileSnapStart.x, postUntileSnapStart.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await waitFor(
        `wait for CSD post-untile compositor move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (!isTranslucentDragWindow(window)) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      await dragPointerToPoint(base, postUntileSnapStart.x + 72, postUntileSnapStart.y + 72, 6);
      const postUntileVisibleDrag = await waitFor(
        `wait for CSD post-untile visible drag ${csdId}`,
        async () => {
          const compositor = await getJson<CompositorSnapshot>(base, "/test/state/compositor");
          const window = compositorWindowById(compositor, csdId);
          if (!isTranslucentDragWindow(window)) return null;
          if (Math.abs(window.x - untiled.window.x) < 12 && Math.abs(window.y - untiled.window.y) < 12) return null;
          return assertTranslucentCsdDragPixels(
            base,
            {
              x: window.x + 12,
              y: window.y + 12,
              width: Math.min(180, window.width - 24),
              height: Math.min(120, window.height - 24),
            },
            `csd-post-untile-live-preview-${csdId}`,
          );
        },
        3000,
        16,
      );
      const postUntileSnapTarget = {
        x: ready.output.x + Math.round(ready.output.width * 0.82),
        y: ready.output.y + Math.round(ready.output.height * 0.28),
      };
      await dragPointerToPoint(
        base,
        postUntileSnapTarget.x,
        postUntileSnapTarget.y,
        10,
      );
      const beforePostUntileSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-post-untile-before-super-output-${csdId}`,
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      const postUntilePreview = await waitFor(
        `wait for CSD post-untile snap preview ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (shell.compositor_interaction_state?.super_held !== true) return null;
          if (shell.snap_drag_super_held !== true) return null;
          if (!shell.snap_preview_visible || !shell.snap_preview_rect) return null;
          return shell;
        },
        3000,
        16,
      );
      const postUntileExpectedSnap = assertRectMinSize(
        "CSD post-untile snap preview",
        postUntilePreview.snap_preview_rect,
        40,
      );
      const afterPostUntileSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-post-untile-after-super-output-${csdId}`,
      );
      const postUntileVisiblePreview = await assertScreenshotRectChanged(
        beforePostUntileSuperOutput,
        afterPostUntileSuperOutput,
        postUntileExpectedSnap,
        "CSD post-untile snap preview output",
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      await keyAction(base, SUPER_KEYCODE, "release");
      const postUntileSnapped = await waitFor(
        `wait for CSD post-untile snap commit ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (!window) return null;
          try {
            assertWindowMatchesRect(
              window,
              {
                x: postUntileExpectedSnap.global_x,
                y: postUntileExpectedSnap.global_y,
                width: postUntileExpectedSnap.width,
                height: postUntileExpectedSnap.height,
              },
              "CSD post-untile snap",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        40,
      );
      await writeJsonArtifact("snap-assist-csd-drag-untile-restore.json", {
        initialVisiblePreview,
        liveUntile,
        visibleUntileDrag,
        firstUntiled,
        secondDragArmed,
        secondDragPreview,
        secondDragVisiblePreview,
        expectedSecondDragSnap,
        secondDragSnapped,
        untiled,
        postUntileVisibleDrag,
        postUntilePreview,
        postUntileVisiblePreview,
        postUntileExpectedSnap,
        postUntileSnapped,
      });
    } finally {
      if (!pointerReleased) {
        try {
          await pointerButton(base, BTN_LEFT, "release");
        } catch {}
      }
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("CSD tiled from snap picker untiles on first drag and keeps the next grid drag alive", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const csd = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp CSD Picker Untile ${Date.now()}`,
      token: `picker-untile-csd-${Date.now()}`,
      strip: "green",
      width: 520,
      height: 360,
      xdgDecorationClientSide: true,
      moveOnHeaderPress: true,
      solidClient: true,
    });
    const csdId = csd.window.window_id;
    state.spawnedNativeWindowIds.add(csdId);
    let pointerReleased = true;
    try {
      const ready = await waitFor(
        `wait for picker CSD untile source ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          const shellWindow = shell.windows.find(
            (entry) => entry.window_id === csdId,
          );
          const controls = windowControls(shell, csdId);
          if (!window || !shellWindow) return null;
          if (!window.client_side_decoration || !shellWindow.client_side_decoration) return null;
          if (controls?.titlebar) return null;
          const outputName = resolveWindowOutputName(compositor, window);
          if (!outputName) return null;
          const output =
            compositor.outputs.find((entry) => entry.name === outputName) ??
            compositor.outputs[0];
          if (!output) return null;
          return { compositor, shell, window, outputName, output };
        },
        3000,
        40,
      );
      const floating = {
        width: ready.window.width,
        height: ready.window.height,
      };
      await movePoint(
        base,
        Math.round(ready.window.x + ready.window.width / 2),
        Math.round(ready.window.y + 18),
      );
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await openPickerWhileDragging(base, csdId);
      const { rect: firstCell } = await revealVisiblePickerControl(
        base,
        csdId,
        "snap_picker_top_two_thirds_left",
        "CSD picker top two-thirds left cell",
      );
      await hoverPickerCellWhileDragging(
        base,
        "hover CSD picker top two-thirds left cell",
        firstCell,
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      const snapped = await waitFor(
        `wait for picker CSD snap commit ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (!window) return null;
          try {
            assertTopTwoThirdsThirdWindow(
              window,
              ready.outputName,
              compositor,
              shell,
              "left",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        40,
      );
      const untileStart = {
        x: Math.round(snapped.window.x + snapped.window.width / 2),
        y: Math.round(snapped.window.y + 18),
      };
      const untileEnd = {
        x: untileStart.x + 96,
        y: untileStart.y + 88,
      };
      await movePoint(base, untileStart.x, untileStart.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      await waitFor(
        `wait for picker CSD first untile move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (
            shell.compositor_interaction_state?.move_window_id !== csdId &&
            compositor.shell_move_window_id !== csdId
          )
            return null;
          if (!window) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      const readFirstLiveUntile = async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(compositor, csdId);
        const moving = !(
          shell.compositor_interaction_state?.move_window_id !== csdId &&
          compositor.shell_move_window_id !== csdId
        );
        if (!moving && shellSessionWindowHasMonitorTile(shell, csdId))
          return null;
        if (!window) return null;
        if (moving && !isTranslucentDragWindow(window)) return null;
        if (Math.abs(window.width - floating.width) > 2) return null;
        if (Math.abs(window.height - floating.height) > 2) return null;
        return { compositor, shell, window };
      };
      const firstLiveUntile = await dragPointerToPointUntil(
        base,
        untileEnd.x,
        untileEnd.y,
        8,
        `picker CSD first drag live restore ${csdId}`,
        readFirstLiveUntile,
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      const firstUntiled = await waitFor(
        `wait for picker CSD first untile release ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (!window) return null;
          if (
            shell.compositor_interaction_state?.move_window_id === csdId ||
            compositor.shell_move_window_id === csdId
          )
            return null;
          if (shellSessionWindowHasMonitorTile(shell, csdId)) return null;
          if (Math.abs(window.width - floating.width) > 2) return null;
          if (Math.abs(window.height - floating.height) > 2) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      const secondStart = {
        x: Math.round(firstUntiled.window.x + firstUntiled.window.width / 2),
        y: Math.round(firstUntiled.window.y + 18),
      };
      await movePoint(base, secondStart.x, secondStart.y);
      pointerReleased = false;
      await pointerButton(base, BTN_LEFT, "press");
      const secondMove = await waitFor(
        `wait for picker CSD immediate second move ${csdId}`,
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, csdId);
          if (
            shell.compositor_interaction_state?.move_window_id !== csdId &&
            compositor.shell_move_window_id !== csdId
          )
            return null;
          if (!isTranslucentDragWindow(window)) return null;
          if (Math.abs(window.width - floating.width) > 2) return null;
          if (Math.abs(window.height - floating.height) > 2) return null;
          return { compositor, shell, window };
        },
        2000,
        16,
      );
      await dragPointerToPoint(base, secondStart.x + 96, secondStart.y + 88, 8);
      const beforeSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-picker-untile-second-before-super-output-${csdId}`,
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      const secondGrid = await waitFor(
        `wait for picker CSD immediate second grid ${csdId}`,
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          if (shell.compositor_interaction_state?.move_window_id !== csdId) return null;
          if (shell.compositor_interaction_state?.super_held !== true) return null;
          if (shell.snap_drag_super_held !== true) return null;
          if (!shell.snap_preview_visible || !shell.snap_preview_rect) return null;
          return shell;
        },
        3000,
        16,
      );
      const expectedSecondGrid = assertRectMinSize(
        "picker CSD immediate second grid",
        secondGrid.snap_preview_rect,
        40,
      );
      const afterSuperOutput = await captureOutputArtifact(
        base,
        ready.output,
        `csd-picker-untile-second-after-super-output-${csdId}`,
      );
      const secondGridVisible = await assertScreenshotRectChanged(
        beforeSuperOutput,
        afterSuperOutput,
        expectedSecondGrid,
        "picker CSD immediate second grid output",
      );
      await pointerButton(base, BTN_LEFT, "release");
      pointerReleased = true;
      await keyAction(base, SUPER_KEYCODE, "release");
      await writeJsonArtifact("snap-assist-csd-picker-untile-race.json", {
        snapped,
        firstLiveUntile,
        firstUntiled,
        secondMove,
        secondGrid,
        expectedSecondGrid,
        secondGridVisible,
      });
    } finally {
      if (!pointerReleased) {
        try {
          await pointerButton(base, BTN_LEFT, "release");
        } catch {}
      }
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("super-drag picker commits a native window layout", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const timing = createTimingMarks("snap native picker");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    await timing.step("place native window", () =>
      placeNativeWindowForPickerTest(base, redId),
    );
    await timing.step("focus native window", () =>
      focusNativeWindow(base, redId),
    );
    const shellFocused = await timing.step("read shell snapshot", () =>
      getJson<ShellSnapshot>(base, "/test/state/shell"),
    );
    const controls = windowControls(shellFocused, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    const titlebarPoint = nativeTitlebarDragPoint(shellFocused, redId);
    await movePoint(base, titlebarPoint.x, titlebarPoint.y);
    await keyAction(base, SUPER_KEYCODE, "press");
    await pointerButton(base, 0x110, "press");
    try {
      await timing.step("open drag picker", () =>
        openPickerWhileDragging(base, redId),
      );
      const { rect: firstCell } = await timing.step(
        "reveal picker first cell",
        () =>
          revealVisiblePickerControl(
            base,
            redId,
            "snap_picker_first_cell",
            "picker first cell",
          ),
      );
      await timing.step("hover first cell", () =>
        hoverPickerCellWhileDragging(
          base,
          "hover picker first cell",
          firstCell,
        ),
      );
      await timing.step("release drag on first cell", () =>
        pointerButton(base, 0x110, "release"),
      );
      const snapped = await timing.step("wait for native picker snap", () =>
        waitFor(
          "wait for native picker snap",
          async () => {
            const { compositor, shell } = await getSnapshots(base);
            const window = compositorWindowById(compositor, redId);
            if (!window) return null;
            try {
              assertTopThirdWindow(
                window,
                window.output_name,
                compositor,
                shell,
                "left",
              );
            } catch {
              return null;
            }
            return { compositor, shell, window };
          },
          2000,
          125,
        ),
      );
      await writeJsonArtifact("snap-assist-picker-native.json", snapped);
    } finally {
      await pointerButton(base, 0x110, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("super-drag picker stays above the dragged window and hovers non-custom divider spans", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    const focused = await focusNativeWindow(base, redId);
    const controls = windowControls(focused.shell, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    const titlebarPoint = nativeTitlebarDragPoint(focused.shell, redId);
    await movePoint(base, titlebarPoint.x, titlebarPoint.y);
    await keyAction(base, SUPER_KEYCODE, "press");
    await pointerButton(base, 0x110, "press");
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId);
      await waitForPickerAboveWindow(base, pickerOpen, redId);
      const draggingControls = windowControls(pickerOpen, redId);
      assert(
        (pickerOpen.snap_picker_z ?? 0) > (draggingControls?.frame_z ?? 0),
        `snap picker z ${pickerOpen.snap_picker_z ?? "missing"} must be above dragging frame z ${draggingControls?.frame_z ?? "missing"}`,
      );
      const { rect: topTwoThirds } = await revealVisiblePickerControl(
        base,
        redId,
        "snap_picker_top_two_thirds_left",
        "drag picker 3x3 top two-thirds left divider",
      );
      const point = {
        x: topTwoThirds.global_x + topTwoThirds.width / 2,
        y: topTwoThirds.global_y + topTwoThirds.height + 8,
      };
      await movePoint(base, point.x, point.y);
      const hovered = await waitFor(
        "wait for drag picker expanded non-custom hover",
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          const span = shell.snap_hover_span;
          return span?.gridCols === 3 &&
            span.gridRows === 3 &&
            span.gc0 === 0 &&
            span.gc1 === 0 &&
            span.gr0 === 0 &&
            span.gr1 === 1 &&
            shell.controls?.snap_picker_hover_overlay
            ? shell
            : null;
        },
        2000,
        16,
      );
      const hoverScreenshot = await postJson<{ path?: string }>(
        base,
        "/test/screenshot",
        {},
      );
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      await writeJsonArtifact(
        "snap-assist-super-drag-picker-hover-visual.json",
        {
          hoverScreenshot,
          shell: hovered,
          pickerPlacement:
            compositor.shell_ui_windows?.find(
              (entry) => entry.id === SHELL_UI_PORTAL_PICKER_WINDOW_ID,
            ) ?? null,
          draggedWindow: compositorWindowById(compositor, redId),
        },
      );
    } finally {
      await pointerButton(base, 0x110, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("super-drag picker closes when pointer leaves the strip and picker", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    const focused = await focusNativeWindow(base, redId);
    const controls = windowControls(focused.shell, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    const titlebarPoint = nativeTitlebarDragPoint(focused.shell, redId);
    await movePoint(base, titlebarPoint.x, titlebarPoint.y);
    await keyAction(base, SUPER_KEYCODE, "press");
    await pointerButton(base, 0x110, "press");
    try {
      const pickerOpen = await openPickerWhileDragging(base, redId);
      assert(pickerOpen.snap_picker_open, "expected drag picker to open");
      const window = compositorWindowById(focused.compositor, redId);
      assert(window, "missing focused native window");
      const output =
        focused.compositor.outputs.find(
          (entry) => entry.name === window.output_name,
        ) ?? null;
      assert(output, `missing output ${window.output_name}`);
      await movePoint(
        base,
        output.x + output.width / 2,
        output.y + output.height - 120,
      );
      try {
        await waitForPickerClosed(base, redId);
      } catch (error) {
        const { compositor, shell } = await getSnapshots(base);
        await writeJsonArtifact(
          `snap-assist-picker-close-timeout-${redId}.json`,
          {
            error: error instanceof Error ? error.message : String(error),
            windowId: redId,
            compositor,
            shell,
          },
        );
        throw error;
      }
    } finally {
      await pointerButton(base, 0x110, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("plain edge drag does not show pane overlay before snap preview", async ({
    base,
    state,
  }) => {
    await selectSettingsSnapLayout(base, "3x2");
    const { red } = await ensureNativePair(base, state);
    const redId = red.window.window_id;
    const focused = await focusNativeWindow(base, redId);
    const focusedWindow = compositorWindowById(focused.compositor, redId);
    const output =
      focused.compositor.outputs.find(
        (entry) => entry.name === focusedWindow?.output_name,
      ) ?? null;
    const controls = windowControls(focused.shell, redId);
    assert(controls?.titlebar, "missing red titlebar rect");
    assert(output, "missing output for plain edge drag overlay test");
    const titlebarCenter = rectGlobalCenter(controls.titlebar);
    await movePoint(base, titlebarCenter.x, titlebarCenter.y);
    await pointerButton(base, BTN_LEFT, "press");
    try {
      await movePoint(base, output.x + output.width / 2, output.y + 6);
      const noOverlay = await waitFor(
        "wait for no pane overlay during plain edge drag",
        async () => {
          const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
          const overlayHtml = await getShellHtml(
            base,
            "[data-shell-snap-overlay]",
          );
          if (shell.snap_picker_open) return null;
          if (overlayHtml.trim().length > 0) return null;
          return { shell };
        },
        4000,
        100,
      );
      await writeJsonArtifact("snap-assist-plain-edge-no-overlay.json", {
        redId,
        output: output.name,
        shell: noOverlay.shell,
      });
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
    }
  });

  test("maximize button picker snaps the settings window and keeps shell focus parity", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    const pickerOpen = await openPickerFromMaximizeButton(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(
      pickerOpen.snap_picker_source === "button",
      "expected maximize button to open picker",
    );
    const controls = windowControls(pickerOpen, SHELL_UI_SETTINGS_WINDOW_ID);
    assertNoVerticalGapBetweenRects(
      "maximize button picker",
      assertRectMinSize("settings maximize button", controls?.maximize, 12),
      assertRectMinSize(
        "settings picker root",
        pickerOpen.controls?.snap_picker_root,
        48,
      ),
    );
    const { rect: firstCell } = await revealVisiblePickerControl(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
      "snap_picker_first_cell",
      "settings picker first cell",
    );
    const firstCellCenter = rectGlobalCenter(firstCell);
    await clickPoint(base, firstCellCenter.x, firstCellCenter.y);
    const snapped = await waitFor(
      "wait for settings picker snap",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        try {
          assertTopThirdWindow(
            window,
            window.output_name,
            compositor,
            shell,
            "left",
          );
          assertTaskbarRowOnMonitor(
            shell,
            SHELL_UI_SETTINGS_WINDOW_ID,
            window.output_name,
          );
          assertTopWindow(
            shell,
            SHELL_UI_SETTINGS_WINDOW_ID,
            "settings should stay frontmost after picker snap",
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    await writeJsonArtifact("snap-assist-picker-settings.json", snapped);
  });

  test("maximize button right click opens picker and 3x3 top two-thirds keeps partial height", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    const pickerOpen = await openPickerFromMaximizeButton(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(
      pickerOpen.snap_picker_source === "button",
      "expected maximize button to open picker",
    );
    const { rect: topTwoThirds } = await revealVisiblePickerControl(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
      "snap_picker_top_two_thirds_left",
      "3x3 top two-thirds left cell",
    );
    const topTwoThirdsCenter = rectGlobalCenter(topTwoThirds);
    await clickPoint(base, topTwoThirdsCenter.x, topTwoThirdsCenter.y);
    const snapped = await waitFor(
      "wait for settings top two-thirds third snap",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        try {
          assertTopTwoThirdsThirdWindow(
            window,
            window.output_name,
            compositor,
            shell,
            "left",
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    await writeJsonArtifact(
      "snap-assist-picker-settings-top-two-thirds.json",
      snapped,
    );
  });

  test("maximize button picker snaps a 3x2 two-column span to two-thirds width", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    const pickerOpen = await openPickerFromMaximizeButton(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(
      pickerOpen.snap_picker_source === "button",
      "expected maximize button to open picker",
    );
    const { rect: rightTwoThirds } = await revealVisiblePickerControl(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
      "snap_picker_right_two_thirds",
      "3x2 right two-thirds cell",
    );
    const rightTwoThirdsCenter = rectGlobalCenter(rightTwoThirds);
    await clickPoint(base, rightTwoThirdsCenter.x, rightTwoThirdsCenter.y);
    const snapped = await waitFor(
      "wait for settings right two-thirds snap",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        try {
          assertFullHeightTwoThirdsWindow(
            window,
            window.output_name,
            compositor,
            shell,
            "right",
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    await writeJsonArtifact(
      "snap-assist-picker-settings-right-two-thirds.json",
      snapped,
    );
  });

  test("selected layout changes top-right edge tiling per monitor", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    assert(
      shell.controls?.settings_tab_tiling,
      "missing settings tiling tab rect",
    );
    await clickRect(base, shell.controls.settings_tab_tiling);
    shell = await waitFor(
      "wait for settings snap layout options",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_snap_layout_option_2x2 &&
          next.controls?.settings_snap_layout_option_3x2
          ? next
          : null;
      },
      2000,
      125,
    );
    await clickSettingsSnapOption(
      base,
      shell.controls?.settings_snap_layout_option_2x2,
      "settings 2x2 snap layout option",
    );
    shell = await waitForSettingsSnapLayout(base, "2x2", true);

    let controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID);
    const titlebar2x2 = assertRectMinSize(
      "settings titlebar after 2x2 snap",
      controls?.titlebar,
      12,
    );
    const titlebar2x2Center = rectGlobalCenter(titlebar2x2);
    const compositor2x2 = await getJson<CompositorSnapshot>(
      base,
      "/test/state/compositor",
    );
    const window2x2 = compositorWindowById(
      compositor2x2,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(window2x2, "missing settings compositor window after 2x2 snap");
    const output2x2 =
      compositor2x2.outputs.find(
        (entry) => entry.name === window2x2.output_name,
      ) ?? null;
    assert(output2x2, `missing output ${window2x2.output_name}`);
    await dragBetweenPoints(
      base,
      titlebar2x2Center.x,
      titlebar2x2Center.y,
      output2x2.x + Math.round(output2x2.width * 0.52),
      output2x2.y + Math.max(140, Math.round(output2x2.height * 0.18)),
      18,
    );
    const floated2x2 = await waitFor(
      "wait for settings float reposition after 2x2 snap",
      async () => {
        const { compositor } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_pointer_grab_window_id !== null
        )
          return null;
        return window.y >= output2x2.y + 48 ? { compositor, window } : null;
      },
      2000,
      125,
    );
    const floated2x2TitlebarPoint = shellHostedTitlebarPoint(floated2x2.window);
    await movePoint(base, floated2x2TitlebarPoint.x, floated2x2TitlebarPoint.y);
    await pointerButton(base, BTN_LEFT, "press");
    try {
      const preview2x2 = await dragToTopRightEdgePreview(
        base,
        output2x2,
        "wait for 2x2 top-right edge preview",
        (candidate) => {
          const rect = candidate.snap_preview_rect;
          if (!candidate.snap_preview_visible || !rect) return false;
          const work = monitorFrameRect(
            output2x2.name,
            compositor2x2,
            candidate,
          );
          const halfWidth = Math.round(work.width / 2);
          const halfHeight = Math.round(work.height / 2);
          return (
            Math.abs(rect.global_x - (work.x + halfWidth)) <= 28 &&
            Math.abs(rect.global_y - work.y) <= 28 &&
            Math.abs(rect.width - (work.width - halfWidth)) <= 36 &&
            Math.abs(rect.height - halfHeight) <= 36
          );
        },
      );
      const work2x2 = monitorFrameRect(
        output2x2.name,
        compositor2x2,
        preview2x2,
      );
      const halfWidth2x2 = Math.round(work2x2.width / 2);
      const halfHeight2x2 = Math.round(work2x2.height / 2);
      assertSnapshotRectMatchesRect(
        assertRectMinSize("2x2 snap preview", preview2x2.snap_preview_rect, 12),
        {
          x: work2x2.x + halfWidth2x2,
          y: work2x2.y,
          width: work2x2.width - halfWidth2x2,
          height: halfHeight2x2,
        },
        "2x2 top-right preview",
      );
      await pointerButton(base, BTN_LEFT, "release");
      const snapped2x2 = await waitFor(
        "wait for 2x2 top-right edge snap",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(
            compositor,
            SHELL_UI_SETTINGS_WINDOW_ID,
          );
          if (!window) return null;
          try {
            assertTopRightQuarterWindow(
              window,
              window.output_name,
              compositor,
              shell,
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        125,
      );
      await writeJsonArtifact("snap-assist-edge-layout-2x2.json", snapped2x2);
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
    }

    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID);
    const titlebarBefore3x2 = assertRectMinSize(
      "settings titlebar before 3x2 selection",
      controls?.titlebar,
      12,
    );
    const titlebarBefore3x2Center = rectGlobalCenter(titlebarBefore3x2);
    const compositorBefore3x2 = await getJson<CompositorSnapshot>(
      base,
      "/test/state/compositor",
    );
    const windowBefore3x2 = compositorWindowById(
      compositorBefore3x2,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(
      windowBefore3x2,
      "missing settings compositor window before 3x2 selection",
    );
    const outputBefore3x2 =
      compositorBefore3x2.outputs.find(
        (entry) => entry.name === windowBefore3x2.output_name,
      ) ?? null;
    assert(outputBefore3x2, `missing output ${windowBefore3x2.output_name}`);
    await dragBetweenPoints(
      base,
      titlebarBefore3x2Center.x,
      titlebarBefore3x2Center.y,
      outputBefore3x2.x + Math.round(outputBefore3x2.width * 0.55),
      outputBefore3x2.y +
        Math.max(260, Math.round(outputBefore3x2.height * 0.35)),
      18,
    );
    await waitFor(
      "wait for settings float before 3x2 selection",
      async () => {
        const { compositor } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_pointer_grab_window_id !== null
        )
          return null;
        return window.y >= outputBefore3x2.y + 48
          ? { compositor, window }
          : null;
      },
      2000,
      125,
    );

    shell = await scrollSettingsToSnapLayoutOption(base, "3x2");
    assert(
      shell.controls?.settings_snap_layout_option_3x2,
      "missing settings 3x2 snap layout option",
    );
    await clickSettingsSnapOption(
      base,
      shell.controls?.settings_snap_layout_option_3x2,
      "settings 3x2 snap layout option",
    );
    await waitForSettingsSnapLayout(base, "3x2", true);

    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    controls = windowControls(shell, SHELL_UI_SETTINGS_WINDOW_ID);
    const titlebar3x2 = assertRectMinSize(
      "settings titlebar after 3x2 snap",
      controls?.titlebar,
      12,
    );
    const titlebar3x2Center = rectGlobalCenter(titlebar3x2);
    const compositor3x2 = await getJson<CompositorSnapshot>(
      base,
      "/test/state/compositor",
    );
    const window3x2 = compositorWindowById(
      compositor3x2,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(window3x2, "missing settings compositor window after 3x2 snap");
    const output3x2 =
      compositor3x2.outputs.find(
        (entry) => entry.name === window3x2.output_name,
      ) ?? null;
    assert(output3x2, `missing output ${window3x2.output_name}`);
    await dragBetweenPoints(
      base,
      titlebar3x2Center.x,
      titlebar3x2Center.y,
      output3x2.x + Math.round(output3x2.width * 0.55),
      output3x2.y + Math.max(260, Math.round(output3x2.height * 0.35)),
      18,
    );
    const floated3x2 = await waitFor(
      "wait for settings float reposition after 3x2 snap",
      async () => {
        const { compositor } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        if (
          compositor.shell_move_window_id !== null ||
          compositor.shell_pointer_grab_window_id !== null
        )
          return null;
        return window.y >= output3x2.y + 48 ? { compositor, window } : null;
      },
      2000,
      125,
    );
    const floated3x2TitlebarPoint = shellHostedTitlebarPoint(floated3x2.window);
    await movePoint(base, floated3x2TitlebarPoint.x, floated3x2TitlebarPoint.y);
    await pointerButton(base, BTN_LEFT, "press");
    try {
      const preview3x2 = await dragToTopRightEdgePreview(
        base,
        output3x2,
        "wait for 3x2 top-right edge preview",
        (candidate) => {
          const rect = candidate.snap_preview_rect;
          if (!candidate.snap_preview_visible || !rect) return false;
          const work = monitorFrameRect(
            output3x2.name,
            compositor3x2,
            candidate,
          );
          const twoThirdWidth = Math.round((work.width * 2) / 3);
          const halfHeight = Math.round(work.height / 2);
          return (
            Math.abs(rect.global_x - (work.x + twoThirdWidth)) <= 28 &&
            Math.abs(rect.global_y - work.y) <= 28 &&
            Math.abs(rect.width - (work.width - twoThirdWidth)) <= 36 &&
            Math.abs(rect.height - halfHeight) <= 36
          );
        },
      );
      const work3x2 = monitorFrameRect(
        output3x2.name,
        compositor3x2,
        preview3x2,
      );
      const twoThirdWidth3x2 = Math.round((work3x2.width * 2) / 3);
      const halfHeight3x2 = Math.round(work3x2.height / 2);
      assertSnapshotRectMatchesRect(
        assertRectMinSize("3x2 snap preview", preview3x2.snap_preview_rect, 12),
        {
          x: work3x2.x + twoThirdWidth3x2,
          y: work3x2.y,
          width: work3x2.width - twoThirdWidth3x2,
          height: halfHeight3x2,
        },
        "3x2 top-right preview",
      );
      await pointerButton(base, BTN_LEFT, "release");
      const snapped3x2 = await waitFor(
        "wait for 3x2 top-right edge snap",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(
            compositor,
            SHELL_UI_SETTINGS_WINDOW_ID,
          );
          if (!window) return null;
          try {
            assertTopThirdWindow(
              window,
              window.output_name,
              compositor,
              shell,
              "right",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        125,
      );
      await writeJsonArtifact("snap-assist-edge-layout-3x2.json", snapped3x2);
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
    }
  });

  test("custom layouts created in tiling settings appear in snap picker and snap shell windows", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    assert(
      shell.controls?.settings_tab_tiling,
      "missing settings tiling tab rect",
    );
    await clickRect(base, shell.controls.settings_tab_tiling);
    shell = await waitFor(
      "wait for custom layout add control",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_add ? next : null;
      },
      5000,
      100,
    );
    assert(
      shell.controls?.settings_custom_layout_add,
      "missing add custom layout control",
    );
    await clickRect(base, shell.controls.settings_custom_layout_add);
    shell = await waitFor(
      "wait for custom layout overlay",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_root &&
          next.controls?.custom_layout_overlay_add &&
          next.controls?.custom_layout_overlay_save
          ? next
          : null;
      },
      3000,
      100,
    );
    assert(
      shell.controls?.custom_layout_overlay_add,
      "missing overlay add control",
    );
    const closeBeforeEdit = assertRectMinSize(
      "custom layout overlay close before edit",
      shell.controls?.custom_layout_overlay_close,
      12,
    );
    await movePoint(
      base,
      rectGlobalCenter(closeBeforeEdit).x,
      rectGlobalCenter(closeBeforeEdit).y,
    );
    shell = await waitFor(
      "wait for custom layout overlay to own pointer hit test",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.custom_layout_overlay_blocks_pointer &&
          next.custom_layout_overlay_hit_pointer
          ? next
          : null;
      },
      1000,
      16,
    );
    assert(
      shell.custom_layout_overlay_blocks_pointer,
      "custom layout overlay root must accept pointer events",
    );
    assert(
      shell.custom_layout_overlay_hit_pointer,
      "custom layout overlay root must be under the pointer over its controls",
    );
    await clickRect(
      base,
      assertRectMinSize(
        "custom layout overlay add after hit test",
        shell.controls?.custom_layout_overlay_add,
        12,
      ),
    );
    shell = await waitFor(
      "wait for overlay zone after add",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_editor_zone ? next : null;
      },
      3000,
      100,
    );
    const firstEditorZone = assertRectMinSize(
      "initial editor zone",
      shell.controls?.settings_custom_layout_editor_zone,
      80,
    );
    await clickPoint(
      base,
      firstEditorZone.global_x + firstEditorZone.width * 0.5,
      firstEditorZone.global_y + firstEditorZone.height * 0.7,
    );
    shell = await waitFor(
      "wait for off-center horizontal split",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const zone = next.controls?.settings_custom_layout_editor_zone;
        if (!zone) return null;
        return Math.abs(zone.global_x - firstEditorZone.global_x) > 12
          ? next
          : null;
      },
      3000,
      100,
    );
    const secondEditorZone = assertRectMinSize(
      "editor zone after first split",
      shell.controls?.settings_custom_layout_editor_zone,
      80,
    );
    await keyAction(base, SHIFT_KEYCODE, "press");
    try {
      await clickPoint(
        base,
        secondEditorZone.global_x + secondEditorZone.width * 0.88,
        secondEditorZone.global_y + secondEditorZone.height * 0.5,
      );
    } finally {
      await keyAction(base, SHIFT_KEYCODE, "release");
    }
    shell = await waitFor(
      "wait for off-center vertical split",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const zone = next.controls?.settings_custom_layout_editor_zone;
        if (!zone) return null;
        return zone.width < secondEditorZone.width - 12 ? next : null;
      },
      3000,
      100,
    );
    assert(
      shell.controls?.custom_layout_overlay_save,
      "missing overlay save control",
    );
    await clickRect(base, shell.controls.custom_layout_overlay_save);
    await waitFor(
      "wait for custom layout overlay close",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_root ? null : next;
      },
      3000,
      100,
    );

    await openPickerFromMaximizeButton(base, SHELL_UI_SETTINGS_WINDOW_ID);
    const pickerOpen = await waitFor(
      "wait for compositor-backed custom picker zone",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.snap_picker_custom_zone ? next : null;
      },
      3000,
      100,
    );
    const customZone = assertRectMinSize(
      "custom picker zone",
      pickerOpen.controls?.snap_picker_custom_zone,
      12,
    );
    await clickPoint(
      base,
      rectGlobalCenter(customZone).x,
      rectGlobalCenter(customZone).y,
    );
    const snapped = await waitFor(
      "wait for settings custom picker snap",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window) return null;
        try {
          const output = compositor.outputs.find(
            (entry) => entry.name === window.output_name,
          );
          const taskbar = taskbarForMonitor(shell, window.output_name);
          assert(output, `missing output ${window.output_name}`);
          assert(taskbar?.rect, `missing taskbar for ${window.output_name}`);
          const workTop = output.y + TITLEBAR_PX;
          const workBottom = taskbar.rect.global_y;
          const halfWidth = Math.floor(output.width / 2);
          const clickedRightHalf =
            secondEditorZone.global_x >= output.x + halfWidth - 24;
          const halfStart = clickedRightHalf ? output.x + halfWidth : output.x;
          const halfWidthPx = clickedRightHalf
            ? output.width - halfWidth
            : halfWidth;
          assertWindowMatchesRect(
            window,
            {
              x: halfStart,
              y: workTop,
              width: Math.round(halfWidthPx * 0.88),
              height: workBottom - workTop,
            },
            "custom layout largest zone",
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    await writeJsonArtifact("snap-assist-picker-custom-layout.json", snapped);
  });

  test("settings-selected custom snap layout snaps a shell window on super drag", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    assert(
      shell.controls?.settings_tab_tiling,
      "missing settings tiling tab rect",
    );
    await clickRect(base, shell.controls.settings_tab_tiling);
    shell = await waitFor(
      "wait for custom layout add control",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_add ? next : null;
      },
      5000,
      100,
    );
    assert(
      shell.controls?.settings_custom_layout_add,
      "missing add custom layout control",
    );
    await clickRect(base, shell.controls.settings_custom_layout_add);
    shell = await waitFor(
      "wait for custom layout overlay",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_root &&
          next.controls?.custom_layout_overlay_add &&
          next.controls?.custom_layout_overlay_save
          ? next
          : null;
      },
      3000,
      100,
    );
    assert(
      shell.controls?.custom_layout_overlay_add,
      "missing overlay add control",
    );
    await clickRect(base, shell.controls.custom_layout_overlay_add);
    shell = await waitFor(
      "wait for overlay zone after add",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_editor_zone ? next : null;
      },
      3000,
      100,
    );
    const firstEditorZone = assertRectMinSize(
      "initial editor zone",
      shell.controls?.settings_custom_layout_editor_zone,
      80,
    );
    await clickPoint(
      base,
      firstEditorZone.global_x + firstEditorZone.width * 0.5,
      firstEditorZone.global_y + firstEditorZone.height * 0.7,
    );
    shell = await waitFor(
      "wait for off-center horizontal split",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const zone = next.controls?.settings_custom_layout_editor_zone;
        if (!zone) return null;
        return Math.abs(zone.global_x - firstEditorZone.global_x) > 12
          ? next
          : null;
      },
      3000,
      100,
    );
    const secondEditorZone = assertRectMinSize(
      "editor zone after first split",
      shell.controls?.settings_custom_layout_editor_zone,
      80,
    );
    await keyAction(base, SHIFT_KEYCODE, "press");
    try {
      await clickPoint(
        base,
        secondEditorZone.global_x + secondEditorZone.width * 0.88,
        secondEditorZone.global_y + secondEditorZone.height * 0.5,
      );
    } finally {
      await keyAction(base, SHIFT_KEYCODE, "release");
    }
    shell = await waitFor(
      "wait for custom layout save after second split",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_save &&
          next.controls?.settings_custom_layout_editor_zone
          ? next
          : null;
      },
      3000,
      100,
    );
    assert(
      shell.controls?.custom_layout_overlay_save,
      "missing overlay save control",
    );
    await clickRect(base, shell.controls.custom_layout_overlay_save);
    shell = await waitFor(
      "wait for custom layout overlay close",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_root ? null : next;
      },
      3000,
      100,
    );
    shell = await scrollSettingsToCustomSnapOption(base);
    assert(
      shell.controls?.settings_snap_layout_option_custom,
      "missing custom snap layout option",
    );
    await clickSettingsSnapOption(
      base,
      shell.controls.settings_snap_layout_option_custom,
      "custom snap layout option",
    );
    await waitForSettingsSnapLayout(base, "custom", true);

    const focused = await focusSettingsWindow(base);
    const window = compositorWindowById(
      focused.compositor,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(window, "missing settings compositor window before super drag");
    const output = focused.compositor.outputs.find(
      (entry) => entry.name === window.output_name,
    );
    const taskbar = taskbarForMonitor(focused.shell, window.output_name);
    assert(output, `missing output ${window.output_name}`);
    assert(taskbar?.rect, `missing taskbar for ${window.output_name}`);
    const workTop = output.y + TITLEBAR_PX;
    const workBottom = taskbar.rect.global_y;
    const halfWidth = Math.floor(output.width / 2);
    const clickedRightHalf =
      secondEditorZone.global_x >= output.x + halfWidth - 24;
    const halfStart = clickedRightHalf ? output.x + halfWidth : output.x;
    const halfWidthPx = clickedRightHalf ? output.width - halfWidth : halfWidth;
    const target = {
      x: halfStart + Math.round(halfWidthPx * 0.44),
      y: workTop + Math.round((workBottom - workTop) * 0.5),
    };
    const controls = windowControls(focused.shell, SHELL_UI_SETTINGS_WINDOW_ID);
    const titlebar = assertRectMinSize(
      "settings titlebar before super drag",
      controls?.titlebar,
      12,
    );
    const titlebarCenter = rectGlobalCenter(titlebar);

    await movePoint(base, titlebarCenter.x, titlebarCenter.y);
    await pointerButton(base, BTN_LEFT, "press");
    await keyAction(base, SUPER_KEYCODE, "press");
    try {
      await movePoint(base, target.x, target.y);
      await waitFor(
        "wait for custom super drag preview",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.snap_preview_visible ? next : null;
        },
        2000,
        16,
      );
      await keyAction(base, SUPER_KEYCODE, "release");
      const afterSuperReleaseDuringDrag = await waitFor(
        "wait for programs menu stay closed after super keyup during drag",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.programs_menu_open ? null : next;
        },
        2000,
        16,
      );
      assert(
        !afterSuperReleaseDuringDrag.programs_menu_open,
        "programs menu should stay closed when super is released before mouseup",
      );
      await keyAction(base, SUPER_KEYCODE, "press");
      await movePoint(base, target.x, target.y);
      await waitFor(
        "wait for custom super drag preview after re-press",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.snap_preview_visible ? next : null;
        },
        2000,
        16,
      );
      await pointerButton(base, BTN_LEFT, "release");
      const snapped = await waitFor(
        "wait for custom super drag snap",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const current = compositorWindowById(
            compositor,
            SHELL_UI_SETTINGS_WINDOW_ID,
          );
          if (!current) return null;
          try {
            assertWindowMatchesRect(
              current,
              {
                x: halfStart,
                y: workTop,
                width: Math.round(halfWidthPx * 0.88),
                height: workBottom - workTop,
              },
              "custom layout super drag zone",
            );
          } catch {
            return null;
          }
          return { compositor, shell, window: current };
        },
        2000,
        125,
      );
      await keyAction(base, SUPER_KEYCODE, "release");
      const afterSuperRelease = await waitFor(
        "wait for programs menu stay closed after custom super drag",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.programs_menu_open ? null : next;
        },
        2000,
        16,
      );
      assert(
        !afterSuperRelease.programs_menu_open,
        "programs menu should stay closed after custom super drag snap",
      );
      await writeJsonArtifact(
        "snap-assist-super-drag-custom-layout.json",
        snapped,
      );
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }
  });

  test("custom layout preview follows cursor movement inside one zone and shift flips axis in place", async ({
    base,
  }) => {
    await openSettings(base, "click");
    await focusSettingsWindow(base);
    let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    assert(
      shell.controls?.settings_tab_tiling,
      "missing settings tiling tab rect",
    );
    await clickRect(base, shell.controls.settings_tab_tiling);
    shell = await waitFor(
      "wait for custom layout add control",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_add ? next : null;
      },
      5000,
      100,
    );
    assert(
      shell.controls?.settings_custom_layout_add,
      "missing add custom layout control",
    );
    await clickRect(base, shell.controls.settings_custom_layout_add);
    shell = await waitFor(
      "wait for custom layout overlay",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_add &&
          next.controls?.custom_layout_overlay_close
          ? next
          : null;
      },
      3000,
      100,
    );
    assert(
      shell.controls?.custom_layout_overlay_add,
      "missing overlay add control",
    );
    await clickRect(base, shell.controls.custom_layout_overlay_add);
    shell = await waitFor(
      "wait for previewable editor zone",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.settings_custom_layout_editor_zone ? next : null;
      },
      3000,
      100,
    );
    const overlayScreenshot = await postJson<{ path?: string }>(
      base,
      "/test/screenshot",
      {},
    );
    await writeJsonArtifact(
      "custom-layout-overlay-dialog-screenshot.json",
      overlayScreenshot,
    );
    const zone = assertRectMinSize(
      "preview editor zone",
      shell.controls?.settings_custom_layout_editor_zone,
      80,
    );

    await movePoint(
      base,
      zone.global_x + zone.width * 0.5,
      zone.global_y + zone.height * 0.2,
    );
    const horizontalTop = await waitFor(
      "wait for horizontal preview near top",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const first = next.controls?.settings_custom_layout_preview_first;
        const second = next.controls?.settings_custom_layout_preview_second;
        if (!first || !second) return null;
        if (first.height >= zone.height * 0.35) return null;
        if (Math.abs(first.width - zone.width) > 8) return null;
        return { next, first, second };
      },
      1000,
      16,
    );

    await movePoint(
      base,
      zone.global_x + zone.width * 0.5,
      zone.global_y + zone.height * 0.75,
    );
    const horizontalLower = await waitFor(
      "wait for horizontal preview lower in same zone",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const first = next.controls?.settings_custom_layout_preview_first;
        const second = next.controls?.settings_custom_layout_preview_second;
        if (!first || !second) return null;
        if (first.height <= horizontalTop.first.height + 40) return null;
        if (Math.abs(first.width - zone.width) > 8) return null;
        return { next, first, second };
      },
      1000,
      16,
    );

    await keyAction(base, SHIFT_KEYCODE, "press");
    const verticalAtSamePoint = await waitFor(
      "wait for shift vertical preview without moving zones",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const first = next.controls?.settings_custom_layout_preview_first;
        const second = next.controls?.settings_custom_layout_preview_second;
        if (!first || !second) return null;
        if (Math.abs(first.height - zone.height) > 8) return null;
        if (first.width >= zone.width * 0.7) return null;
        return { next, first, second };
      },
      1000,
      16,
    );

    await movePoint(
      base,
      zone.global_x + zone.width * 0.82,
      zone.global_y + zone.height * 0.75,
    );
    const verticalMoved = await waitFor(
      "wait for vertical preview moved within same zone",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        const first = next.controls?.settings_custom_layout_preview_first;
        const second = next.controls?.settings_custom_layout_preview_second;
        if (!first || !second) return null;
        if (Math.abs(first.height - zone.height) > 8) return null;
        if (first.width <= verticalAtSamePoint.first.width + 40) return null;
        return { next, first, second };
      },
      1000,
      16,
    );
    await keyAction(base, SHIFT_KEYCODE, "release");

    assert(
      horizontalLower.first.height > horizontalTop.first.height,
      "horizontal preview should move with pointer inside one zone",
    );
    assert(
      verticalAtSamePoint.first.width < horizontalLower.first.width - 40,
      "shift should flip preview axis in place",
    );
    assert(
      verticalMoved.first.width > verticalAtSamePoint.first.width,
      "vertical preview should move with pointer inside one zone",
    );

    assert(
      shell.controls?.custom_layout_overlay_close,
      "missing overlay close control",
    );
    await clickRect(base, shell.controls.custom_layout_overlay_close);
    await waitFor(
      "wait for custom layout overlay close after preview verification",
      async () => {
        const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
        return next.controls?.custom_layout_overlay_root ? null : next;
      },
      3000,
      100,
    );

    await writeJsonArtifact(
      "snap-assist-custom-layout-preview-horizontal-top.json",
      horizontalTop.next,
    );
    await writeJsonArtifact(
      "snap-assist-custom-layout-preview-horizontal-lower.json",
      horizontalLower.next,
    );
    await writeJsonArtifact(
      "snap-assist-custom-layout-preview-vertical-same-point.json",
      verticalAtSamePoint.next,
    );
    await writeJsonArtifact(
      "snap-assist-custom-layout-preview-vertical-moved.json",
      verticalMoved.next,
    );
  });

  test("picker stays monitor-local for native and shell windows on multi-monitor setups", async ({
    base,
    state,
  }) => {
    const { green } = await ensureNativePair(base, state);
    const redId = green.window.window_id;
    const initial = await getSnapshots(base);
    if (initial.compositor.outputs.length < 2) {
      return;
    }
    const nativeInitial = await waitFor(
      "wait for native output assignment before monitor move",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const redWindow = compositorWindowById(compositor, redId);
        if (!redWindow) return null;
        const outputName = resolveWindowOutputName(compositor, redWindow);
        if (!outputName) return null;
        const nativeMove = pickMonitorMove(compositor.outputs, outputName);
        if (!nativeMove) return null;
        return { compositor, shell, redWindow, nativeMove, outputName };
      },
      5000,
      100,
    );
    const nativeMove = nativeInitial.nativeMove;
    await focusNativeWindow(base, redId);
    await runKeybind(base, nativeMove.action, redId);
    const nativeMoved = await waitFor(
      "wait for native monitor move before picker",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(compositor, redId);
        if (!window || window.output_name !== nativeMove.target.name)
          return null;
        try {
          assertTaskbarRowOnMonitor(shell, redId, nativeMove.target.name);
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    const nativeControls = await waitFor(
      "wait for moved native titlebar geometry before picker drag",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(compositor, redId);
        const titlebar = windowControls(shell, redId)?.titlebar;
        if (!window || !titlebar) return null;
        if (Math.abs(titlebar.global_y + titlebar.height - window.y) > 1)
          return null;
        if (titlebar.global_x > window.x) return null;
        if (titlebar.global_x + titlebar.width < window.x + window.width)
          return null;
        return { titlebar };
      },
      5000,
      50,
    );
    const nativeTitlebarCenter = rectGlobalCenter(nativeControls.titlebar);
    await movePoint(base, nativeTitlebarCenter.x, nativeTitlebarCenter.y);
    await pointerButton(base, 0x110, "press");
    let nativeSnapped;
    try {
      await keyAction(base, SUPER_KEYCODE, "press");
      const nativePicker = await openPickerWhileDragging(base, redId);
      assert(
        nativePicker.snap_picker_monitor === nativeMove.target.name,
        "native picker should stay on moved monitor",
      );
      const nativeOutput =
        nativeMoved.compositor.outputs.find(
          (entry) => entry.name === nativeMove.target.name,
        ) ?? null;
      assert(
        nativeOutput,
        `missing moved native output ${nativeMove.target.name}`,
      );
      assertRectCenteredOnOutput(
        assertRectMinSize(
          "native picker root",
          nativePicker.controls?.snap_picker_root,
          48,
        ),
        nativeOutput,
      );
      const { rect: topCenter } = await revealVisiblePickerControl(
        base,
        redId,
        "snap_picker_top_center_cell",
        "native picker top-center cell",
      );
      await hoverPickerCellWhileDragging(
        base,
        "hover native picker top-center cell",
        topCenter,
      );
      await pointerButton(base, 0x110, "release");
      nativeSnapped = await waitFor(
        "wait for native monitor-local picker snap",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const window = compositorWindowById(compositor, redId);
          if (!window || window.output_name !== nativeMove.target.name)
            return null;
          try {
            assertTopThirdWindow(
              window,
              nativeMove.target.name,
              compositor,
              shell,
              "center",
            );
            assertTaskbarRowOnMonitor(shell, redId, nativeMove.target.name);
          } catch {
            return null;
          }
          return { compositor, shell, window };
        },
        2000,
        125,
      );
    } finally {
      await pointerButton(base, 0x110, "release");
      await keyAction(base, SUPER_KEYCODE, "release");
    }

    await openSettings(base, "click");
    const settingsFocused = await focusSettingsWindow(base);
    const settingsWindow = compositorWindowById(
      settingsFocused.compositor,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(settingsWindow, "missing settings compositor window");
    const settingsOutputName = resolveWindowOutputName(
      settingsFocused.compositor,
      settingsWindow,
    );
    assert(settingsOutputName, "missing settings output assignment");
    const shellMove = pickMonitorMove(
      settingsFocused.compositor.outputs,
      settingsOutputName,
    );
    assert(shellMove, `no adjacent monitor from ${settingsOutputName}`);
    await runKeybind(base, shellMove.action, SHELL_UI_SETTINGS_WINDOW_ID);
    const settingsMoved = await waitFor(
      "wait for settings monitor move before picker",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window || window.output_name !== shellMove.target.name)
          return null;
        try {
          assertTaskbarRowOnMonitor(
            shell,
            SHELL_UI_SETTINGS_WINDOW_ID,
            shellMove.target.name,
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );
    const settingsPicker = await openPickerFromMaximizeButton(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
    );
    assert(
      settingsPicker.snap_picker_monitor === shellMove.target.name,
      "settings picker should stay on moved monitor",
    );
    const settingsOutput =
      settingsMoved.compositor.outputs.find(
        (entry) => entry.name === shellMove.target.name,
      ) ?? null;
    assert(
      settingsOutput,
      `missing moved settings output ${shellMove.target.name}`,
    );
    const settingsPickerRoot = assertRectMinSize(
      "settings picker root",
      settingsPicker.controls?.snap_picker_root,
      48,
    );
    const settingsPickerCenter = rectGlobalCenter(settingsPickerRoot);
    assert(
      settingsPickerCenter.x >= settingsOutput.x &&
        settingsPickerCenter.x < settingsOutput.x + settingsOutput.width &&
        settingsPickerCenter.y >= settingsOutput.y &&
        settingsPickerCenter.y < settingsOutput.y + settingsOutput.height,
      `expected settings picker center to stay within ${settingsOutput.name}, got ${settingsPickerCenter.x},${settingsPickerCenter.y}`,
    );
    const { rect: firstCell } = await revealVisiblePickerControl(
      base,
      SHELL_UI_SETTINGS_WINDOW_ID,
      "snap_picker_first_cell",
      "settings picker first cell",
    );
    const firstCellCenter = rectGlobalCenter(firstCell);
    await clickPoint(base, firstCellCenter.x, firstCellCenter.y);
    const settingsSnapped = await waitFor(
      "wait for settings monitor-local picker snap",
      async () => {
        const { compositor, shell } = await getSnapshots(base);
        const window = compositorWindowById(
          compositor,
          SHELL_UI_SETTINGS_WINDOW_ID,
        );
        if (!window || window.output_name !== shellMove.target.name)
          return null;
        try {
          assertTaskbarRowOnMonitor(
            shell,
            SHELL_UI_SETTINGS_WINDOW_ID,
            shellMove.target.name,
          );
        } catch {
          return null;
        }
        return { compositor, shell, window };
      },
      2000,
      125,
    );

    state.multiMonitorNativeMove = {
      window_id: redId,
      target_output: nativeMove.target.name,
    };
    state.multiMonitorShellMove = {
      window_id: SHELL_UI_SETTINGS_WINDOW_ID,
      target_output: shellMove.target.name,
    };
    await writeJsonArtifact(
      "snap-assist-multimonitor-native.json",
      nativeSnapped,
    );
    await writeJsonArtifact(
      "snap-assist-multimonitor-settings.json",
      settingsSnapped,
    );
  });
});
