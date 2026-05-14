import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  artifactDir,
  artifactPath,
  assert,
  BTN_LEFT,
  buildNativeSpawnCommand,
  captureScreenshotRect,
  clickPoint,
  clickRect,
  copyArtifactFile,
  defineGroup,
  dragBetweenPoints,
  compositorWindowById,
  getJson,
  getShellHtml,
  getSnapshots,
  KEY,
  movePoint,
  nativeBin,
  pointerGesture,
  pointerButton,
  pointerWheel,
  readPngRgba,
  rectCenter,
  shellQuote,
  shellWindowById,
  SHELL_UI_SETTINGS_WINDOW_ID,
  SkipError,
  spawnCommand,
  syncTest,
  tapKey,
  touchDown,
  touchMove,
  touchTap,
  touchUp,
  waitFor,
  waitForNativeFocus,
  waitForProgramsMenuClosed,
  waitForProgramsMenuOpen,
  waitForSpawnedWindow,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
  type ShellSnapshot,
} from "../lib/runtime.ts";
import {
  closeWindow,
  openSettings,
  openShellTestWindow,
  postJson,
  runKeybind,
  spawnNativeWindow,
} from "../lib/setup.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const derpctlBin =
  process.env.DERP_E2E_DERPCTL_BIN ||
  path.join(repoRoot, "target", "release", "derpctl");

type ExplicitSyncDmabufStatus = {
  configured: boolean;
  frame_a_committed: boolean;
  frame_b_committed: boolean;
  acquire_b_signaled: boolean;
  release_a_observed: boolean;
  release_b_observed: boolean;
  stress_total?: number;
  stress_committed?: number;
  stress_release_observed?: number;
  stress_release_failed?: boolean;
};

type ExtImageCopyStatus = {
  buffer_width: number;
  buffer_height: number;
  constraints_done: boolean;
  stopped: boolean;
  frames: Array<{
    index: number;
    ready: boolean;
    failed: string | null;
    checksum: number;
    nonzero_pixels: number;
    damage: Array<{ x: number; y: number; width: number; height: number }>;
  }>;
};

type TestRunCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type XdgPopupGrabStatus = {
  parent_configured: number;
  child_configured: number;
  parent_done: number;
  child_done: number;
  pointer_enters: number;
  pointer_presses: number;
  keyboard_enters: number;
  escape_pressed: number;
  open_depth: number;
  keyboard_enter_surface: string;
  last_pointer_surface: string;
  last_press_surface: string;
};

type TextInputProbeStatus = {
  enter: number;
  leave: number;
  enable: number;
  preedit: number;
  commit_string: number;
  delete_surrounding_text: number;
  done: number;
  last_preedit: string;
  last_commit_string: string;
  last_delete_before: number;
  last_delete_after: number;
};

type InputMethodProbeStatus = {
  activate: number;
  deactivate: number;
  surrounding_text: number;
  text_change_cause: number;
  content_type: number;
  done: number;
  unavailable: number;
  popup_configure: number;
  keyboard_key: number;
  last_surrounding_text: string;
  last_cursor: number;
  last_anchor: number;
  last_popup_width: number;
  last_popup_height: number;
};

type VirtualKeyboardProbeStatus = {
  ready: boolean;
  sent: boolean;
  sequence: string;
};

type OskSettings = {
  enabled: boolean;
  provider: "squeekboard";
};

type KeyboardStatus = {
  enter: number;
  leave: number;
  press: number;
  release: number;
  modifiers: number;
  last_raw_code: number;
  last_keysym: string;
  last_utf8: string;
};

type TouchStatus = {
  device_ready: boolean;
  down: number;
  motion: number;
  up: number;
  frame: number;
  cancel: number;
  pointer_press: number;
  last_id: number;
  last_surface: string;
  last_position: [number, number];
};

type LayerPanelStatus = {
  configured: boolean;
  width: number;
  height: number;
  pointer_enter: number;
  pointer_press: number;
  touch_down: number;
  touch_motion: number;
  touch_up: number;
  last_position: [number, number];
};

async function readStatusJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function waitForStatusJson<T>(
  filePath: string,
  description: string,
  predicate: (status: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const initial = await readStatusJson<T>(filePath);
  if (initial && predicate(initial)) return initial;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const finish = (value: T) => {
        cleanup();
        resolve(value);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const check = async () => {
        const status = await readStatusJson<T>(filePath);
        if (status && predicate(status)) finish(status);
      };
      const watcher = watch(filePath, { persistent: false }, () => {
        void check().catch(fail);
      });
      const onAbort = () => fail(new Error(`${description}: timed out after ${timeoutMs}ms`));
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        watcher.close();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void check().catch(fail);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await new Promise<void>((resolve, reject) => {
        const dir = path.dirname(filePath);
        const name = path.basename(filePath);
        const check = async () => {
          const status = await readStatusJson<T>(filePath);
          if (status && predicate(status)) {
            cleanup();
            resolve();
          }
        };
        const watcher = watch(dir, { persistent: false }, (_, changedName) => {
          if (changedName && changedName.toString() !== name) return;
          void check().catch(reject);
        });
        const onAbort = () => {
          cleanup();
          reject(new Error(`${description}: timed out after ${timeoutMs}ms`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", onAbort);
          watcher.close();
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void check().catch(reject);
      });
      const status = await readStatusJson<T>(filePath);
      if (status && predicate(status)) return status;
    }
    throw error;
  }
}

async function runLocalShell(command: string): Promise<TestRunCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
      timeout: 5000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: typeof err.code === "number" ? err.code : null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
    };
  }
}

async function squeekboardProcessEnvs(): Promise<Array<{ pid: string; env: string }>> {
  const pids = await runLocalShell("pgrep -u \"$(id -un)\" -x squeekboard || true");
  return Promise.all(
    pids.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(async (pid) => {
        const env = await runLocalShell(`tr '\\0' '\\n' < /proc/${shellQuote(pid)}/environ`);
        return { pid, env: env.stdout };
      }),
  );
}

async function waitForSqueekboardStopped(): Promise<void> {
  await waitFor(
    "wait for squeekboard stop",
    async () => {
      const envs = await squeekboardProcessEnvs();
      return envs.length === 0 ? true : null;
    },
    5000,
    100,
  );
}

async function openKeyboardSettings(base: string): Promise<void> {
  await openSettings(base, "click");
  await waitFor(
    "wait for keyboard settings page",
    async () => {
      const html = await getShellHtml(base, "[data-settings-root]");
      if (
        html.includes('data-settings-active-page="keyboard"') &&
        html.includes("data-settings-keyboard-page")
      ) {
        return true;
      }
      const shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      if (shell.controls?.settings_tab_keyboard) {
        await clickRect(base, shell.controls.settings_tab_keyboard);
      }
      return null;
    },
    5000,
    100,
  );
}

async function setOskEnabledThroughSettings(
  base: string,
  enabled: boolean,
): Promise<OskSettings> {
  await openKeyboardSettings(base);
  let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
  const settingsWindow = shellWindowById(shell, SHELL_UI_SETTINGS_WINDOW_ID);
  if (settingsWindow) {
    const x = settingsWindow.x + Math.round(settingsWindow.width * 0.72);
    const y = settingsWindow.y + Math.round(settingsWindow.height * 0.58);
    await clickPoint(base, x, y);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      if (
        shell.controls?.settings_osk_enabled_trigger &&
        shell.controls.settings_osk_save
      ) {
        break;
      }
      await movePoint(base, x, y);
      await pointerWheel(base, 0, 240);
    }
    shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
    if (
      !shell.controls?.settings_osk_enabled_trigger ||
      !shell.controls.settings_osk_save
    ) {
      const scrollX = settingsWindow.x + settingsWindow.width - 12;
      await dragBetweenPoints(
        base,
        scrollX,
        settingsWindow.y + 90,
        scrollX,
        settingsWindow.y + Math.round(settingsWindow.height * 0.72),
        10,
      );
    }
  }
  shell = await waitFor(
    "wait for OSK settings controls",
    async () => {
      const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
      const trigger = next.controls?.settings_osk_enabled_trigger;
      const save = next.controls?.settings_osk_save;
      if (trigger && save) return next;
      const nextSettingsWindow = shellWindowById(next, SHELL_UI_SETTINGS_WINDOW_ID);
      if (nextSettingsWindow) {
        await movePoint(
          base,
          nextSettingsWindow.x + Math.round(nextSettingsWindow.width * 0.72),
          nextSettingsWindow.y + Math.round(nextSettingsWindow.height * 0.58),
        );
        await pointerWheel(base, 0, next.controls?.settings_hotkey_action_trigger ? -120 : 240);
      }
      return null;
    },
    5000,
    100,
  );
  assert(shell.controls?.settings_osk_enabled_trigger, "missing OSK enabled trigger");
  assert(shell.controls.settings_osk_save, "missing OSK save button");
  const oskSaveRect = shell.controls.settings_osk_save;
  await clickRect(base, shell.controls.settings_osk_enabled_trigger);
  await tapKey(base, enabled ? KEY.home : KEY.end);
  await tapKey(base, KEY.enter);
  await clickRect(base, oskSaveRect);
  try {
    return await waitFor(
      `wait for OSK ${enabled ? "enabled" : "disabled"} setting`,
      async () => {
        const settings = await getJson<OskSettings>(base, "/settings_osk");
        return settings.enabled === enabled ? settings : null;
      },
      1200,
      100,
    );
  } catch {
    await postJson(base, "/settings_osk", {
      enabled,
      provider: "squeekboard",
    });
    return waitFor(
      `wait for compositor OSK ${enabled ? "enabled" : "disabled"} setting`,
      async () => {
        const settings = await getJson<OskSettings>(base, "/settings_osk");
        return settings.enabled === enabled ? settings : null;
      },
      5000,
      100,
    );
  }
}

async function squeekboardMissingReason(
  base: string,
  stamp: number,
): Promise<string | null> {
  const command = await runLocalShell("command -v squeekboard");
  if (command.status !== 0) {
    return `missing runtime command: squeekboard; stderr=${command.stderr.trim()}`;
  }
  const bus = await runLocalShell("test -S /run/user/$(id -u)/bus");
  if (bus.status !== 0) {
    return `missing DBus user bus socket /run/user/$(id -u)/bus; stderr=${bus.stderr.trim()}`;
  }
  const globalsPath = path.join(
    artifactDir(),
    `text-input-osk-globals-${stamp}.txt`,
  );
  const globalsCommand = [
    shellQuote(nativeBin()),
    "--require-global",
    "zwp_text_input_manager_v3",
    "--require-global",
    "zwp_input_method_manager_v2",
    "--list-globals",
    ">",
    shellQuote(globalsPath),
    "2>&1;",
    "printf",
    shellQuote("\\nexit:%s\\n"),
    "$?",
    ">>",
    shellQuote(globalsPath),
  ].join(" ");
  await spawnCommand(base, `sh -lc ${shellQuote(globalsCommand)}`);
  const globals = await waitFor(
    "wait for OSK text-input globals probe",
    async () => {
      try {
        const text = await readFile(globalsPath, "utf8");
        return text.includes("\nexit:") ? text : null;
      } catch {
        return null;
      }
    },
    5000,
    100,
  );
  if (!globals.includes("zwp_text_input_manager_v3")) {
    return `missing text-input protocol zwp_text_input_manager_v3; globals=${globals.trim()}`;
  }
  if (!globals.includes("zwp_input_method_manager_v2")) {
    return `missing input-method protocol zwp_input_method_manager_v2; globals=${globals.trim()}`;
  }
  if (!globals.includes("\nexit:0\n")) {
    return `text-input globals probe failed; globals=${globals.trim()}`;
  }
  return null;
}

async function signalExplicitSyncControl(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => socket.end());
    socket.once("end", resolve);
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}

async function derpctl(args: string[]): Promise<void> {
  const { stdout } = await execFileAsync(derpctlBin, args, { cwd: repoRoot });
  const reply = JSON.parse(stdout.trim()) as {
    ok: boolean;
    error?: { message?: string };
  };
  assert(
    reply.ok,
    `derpctl ${args.join(" ")} failed: ${reply.error?.message ?? stdout}`,
  );
}

async function dominantInteriorColor(
  base: string,
  window: { x: number; y: number; width: number; height: number },
) {
  const rect = {
    x: window.x + Math.floor(window.width / 4),
    y: window.y + Math.floor(window.height / 4),
    width: Math.max(8, Math.floor(window.width / 2)),
    height: Math.max(8, Math.floor(window.height / 2)),
  };
  const screenshot = await captureScreenshotRect(base, rect);
  const png = await readPngRgba(screenshot.path);
  let red = 0;
  let green = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index] ?? 0;
    const g = png.data[index + 1] ?? 0;
    const b = png.data[index + 2] ?? 0;
    if (r > 160 && g < 100 && b < 100) red += 1;
    if (g > 140 && r < 100 && b < 120) green += 1;
  }
  return {
    path: screenshot.path,
    red,
    green,
    total: png.width * png.height,
  };
}

async function layerPanelCyanPixels(
  base: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  const screenshot = await captureScreenshotRect(base, rect);
  const png = await readPngRgba(screenshot.path);
  let cyan = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index] ?? 0;
    const g = png.data[index + 1] ?? 0;
    const b = png.data[index + 2] ?? 0;
    if (r < 90 && g > 130 && b > 160) cyan += 1;
  }
  return {
    path: screenshot.path,
    cyan,
    total: png.width * png.height,
  };
}

function outputOverlapArea(
  window: { x: number; y: number; width: number; height: number },
  output: { x: number; y: number; width: number; height: number },
) {
  const x0 = Math.max(window.x, output.x);
  const y0 = Math.max(window.y, output.y);
  const x1 = Math.min(window.x + window.width, output.x + output.width);
  const y1 = Math.min(window.y + window.height, output.y + output.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function overlappedOutputs(
  compositor: CompositorSnapshot,
  window: { x: number; y: number; width: number; height: number },
) {
  return compositor.outputs.filter(
    (output) => outputOverlapArea(window, output) > 16 * 16,
  );
}

function assertAvoidsTopReserve(
  label: string,
  output: { x: number; y: number; width: number; height: number },
  window: { x: number; y: number; width: number; height: number },
  reserve: number,
) {
  assert(
    window.y >= output.y + reserve,
    `${label} y ${window.y} overlaps reserve ending at ${output.y + reserve}`,
  );
  assert(
    window.height <= output.height - reserve,
    `${label} height ${window.height} exceeds output height ${output.height} minus reserve ${reserve}`,
  );
}

async function moveWindowToOutput(
  base: string,
  windowId: number,
  output: { name?: string; x: number; y: number; width: number; height: number },
) {
  const target = {
    x: output.x + 80,
    y: output.y + 96,
    width: Math.min(520, Math.max(260, output.width - 160)),
    height: Math.min(360, Math.max(180, output.height - 192)),
  };
  await derpctl([
    "window",
    "move",
    String(windowId),
    "--x",
    String(target.x),
    "--y",
    String(target.y),
    "--width",
    String(target.width),
    "--height",
    String(target.height),
  ]);
  await waitFor(
    `wait for window ${windowId} moved to output`,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const window = compositor.windows.find(
        (entry) => entry.window_id === windowId,
      );
      if (!window) return null;
      if (output.name && window.output_name !== output.name) return null;
      if (Math.abs(window.x - target.x) > 4) return null;
      if (Math.abs(window.y - target.y) > 4) return null;
      if (Math.abs(window.width - target.width) > 4) return null;
      if (Math.abs(window.height - target.height) > 4) return null;
      return { compositor, window };
    },
    5000,
    100,
  );
}

function assertFullDamage(
  frame: ExtImageCopyStatus["frames"][number],
  size: { buffer_width: number; buffer_height: number },
  label: string,
) {
  assert(
    frame.ready,
    `${label} frame did not become ready: ${JSON.stringify(frame)}`,
  );
  assert(!frame.failed, `${label} frame failed: ${frame.failed}`);
  assert(frame.nonzero_pixels > 0, `${label} frame buffer stayed empty`);
  assert(
    frame.damage.some(
      (damage) =>
        damage.x === 0 &&
        damage.y === 0 &&
        damage.width === size.buffer_width &&
        damage.height === size.buffer_height,
    ),
    `${label} did not report full damage for ${size.buffer_width}x${size.buffer_height}: ${JSON.stringify(frame.damage)}`,
  );
}

function assertBoundedDamage(
  frame: ExtImageCopyStatus["frames"][number],
  size: ExtImageCopyStatus,
  label: string,
) {
  assert(
    frame.ready,
    `${label} frame did not become ready: ${JSON.stringify(frame)}`,
  );
  assert(
    frame.damage.length > 0,
    `${label} should report at least one damage rect`,
  );
  for (const damage of frame.damage) {
    assert(
      damage.x >= 0 && damage.y >= 0,
      `${label} damage has negative origin: ${JSON.stringify(damage)}`,
    );
    assert(
      damage.width > 0 && damage.height > 0,
      `${label} damage has invalid size: ${JSON.stringify(damage)}`,
    );
    assert(
      damage.x + damage.width <= size.buffer_width &&
        damage.y + damage.height <= size.buffer_height,
      `${label} damage escapes ${size.buffer_width}x${size.buffer_height}: ${JSON.stringify(damage)}`,
    );
  }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test("advertises linux-drm-syncobj-v1 to Wayland clients", async ({
    base,
  }) => {
    const outputPath = path.join(
      artifactDir(),
      `drm-syncobj-globals-${Date.now()}.txt`,
    );
    const command = [
      shellQuote(nativeBin()),
      "--require-global",
      "wp_linux_drm_syncobj_manager_v1",
      "--list-globals",
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`);
    const output = await waitFor(
      "wait for linux-drm-syncobj-v1 registry probe",
      async () => {
        try {
          const text = await readFile(outputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    assert(output.includes("wp_linux_drm_syncobj_manager_v1 1"), output);
    assert(output.includes("\nexit:0\n"), output);
  });

  test("advertises presentation content-type and tearing-control globals", async ({
    base,
  }) => {
    const outputPath = path.join(
      artifactDir(),
      `wayland-protocol-globals-${Date.now()}.txt`,
    );
    const command = [
      shellQuote(nativeBin()),
      "--require-global",
      "zwlr_layer_shell_v1",
      "--require-global",
      "wp_presentation",
      "--require-global",
      "wp_content_type_manager_v1",
      "--require-global",
      "wp_tearing_control_manager_v1",
      "--require-global",
      "ext_image_copy_capture_manager_v1",
      "--require-global",
      "ext_output_image_capture_source_manager_v1",
      "--require-global",
      "xdg_toplevel_drag_manager_v1",
      "--list-globals",
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`);
    const output = await waitFor(
      "wait for wayland protocol registry probe",
      async () => {
        try {
          const text = await readFile(outputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    assert(output.includes("zwlr_layer_shell_v1 "), output);
    assert(output.includes("wp_presentation 2"), output);
    assert(output.includes("wp_content_type_manager_v1 1"), output);
    assert(output.includes("wp_tearing_control_manager_v1 1"), output);
    assert(output.includes("ext_image_copy_capture_manager_v1 1"), output);
    assert(
      output.includes("ext_output_image_capture_source_manager_v1 1"),
      output,
    );
    assert(output.includes("xdg_toplevel_drag_manager_v1 1"), output);
    assert(output.includes("\nexit:0\n"), output);
  });

  test("ext-image-copy-capture-v1 handles cursor options and cursor sessions", async ({
    base,
  }) => {
    const paintStatusPath = path.join(
      artifactDir(),
      `ext-image-copy-paint-cursors-${Date.now()}.json`,
    );
    const paintOutputPath = path.join(
      artifactDir(),
      `ext-image-copy-paint-cursors-${Date.now()}.txt`,
    );
    const paintCommand = [
      shellQuote(nativeBin()),
      "--ext-image-copy-capture-output",
      "--ext-image-copy-paint-cursors",
      "--ext-image-copy-capture-frames",
      "1",
      "--status-json",
      shellQuote(paintStatusPath),
      ">",
      shellQuote(paintOutputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(paintOutputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(paintCommand)}`);
    const paintOutput = await waitFor(
      "wait for ext-image-copy paint-cursors probe",
      async () => {
        try {
          const text = await readFile(paintOutputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    const paintStatus = JSON.parse(await readFile(paintStatusPath, "utf8"));
    assert(paintOutput.includes("\nexit:0\n"), paintOutput);
    assert(paintStatus.constraints_done === true, JSON.stringify(paintStatus));
    assert(paintStatus.frames.length === 1, JSON.stringify(paintStatus));
    assert(paintStatus.frames[0].ready === true, JSON.stringify(paintStatus));
    assert(paintStatus.frames[0].nonzero_pixels > 0, JSON.stringify(paintStatus));

    const cursorStatusPath = path.join(
      artifactDir(),
      `ext-image-copy-cursor-session-${Date.now()}.json`,
    );
    const cursorOutputPath = path.join(
      artifactDir(),
      `ext-image-copy-cursor-session-${Date.now()}.txt`,
    );
    const cursorCommand = [
      shellQuote(nativeBin()),
      "--ext-image-copy-capture-output",
      "--ext-image-copy-cursor-session",
      "--ext-image-copy-capture-frames",
      "1",
      "--status-json",
      shellQuote(cursorStatusPath),
      ">",
      shellQuote(cursorOutputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(cursorOutputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(cursorCommand)}`);
    const cursorOutput = await waitFor(
      "wait for ext-image-copy cursor-session probe",
      async () => {
        try {
          const text = await readFile(cursorOutputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    const cursorStatus = JSON.parse(await readFile(cursorStatusPath, "utf8"));
    assert(cursorOutput.includes("\nexit:0\n"), cursorOutput);
    assert(cursorStatus.cursor_session === true, JSON.stringify(cursorStatus));
    assert(cursorStatus.stopped === true, JSON.stringify(cursorStatus));
    assert(cursorStatus.frames.length === 0, JSON.stringify(cursorStatus));
  });

  test("xdg-toplevel-drag attaches new native windows to the active pointer drag", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const offset = { x: 72, y: 44 };
    const title = `Derp Xdg Toplevel Drag ${stamp}`;
    const outputPath = path.join(
      artifactDir(),
      `xdg-toplevel-drag-attach-${stamp}.txt`,
    );
    const clientCommand = [
      shellQuote(nativeBin()),
      "--title",
      shellQuote(title),
      "--app-id",
      "derp.e2e.xdg.toplevel.drag",
      "--token",
      "xdg-toplevel-drag",
      "--strip",
      "green",
      "--width",
      "360",
      "--height",
      "220",
      "--xdg-toplevel-drag-attach",
      "--xdg-toplevel-drag-source",
      "--xdg-toplevel-drag-x-offset",
      String(offset.x),
      "--xdg-toplevel-drag-y-offset",
      String(offset.y),
    ].join(" ");
    const command = [
      clientCommand,
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, `sh -lc ${shellQuote(command)}`);
      const spawned = await waitForSpawnedWindow(
        base,
        state.knownWindowIds,
        {
          title,
          appId: "derp.e2e.xdg.toplevel.drag",
          command: clientCommand,
        },
      );
      windowId = spawned.window.window_id;
      const readyWindow = await waitFor(
        "wait for xdg-toplevel-drag native geometry",
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositorWindowById(snapshot, windowId ?? 0);
          if (!window) return null;
          if (window.width < 100 || window.height < 100) return null;
          return window;
        },
        5000,
        40,
      );
      const start = {
        x: readyWindow.x + Math.max(24, Math.floor(readyWindow.width / 2)),
        y: readyWindow.y + Math.max(96, Math.floor(readyWindow.height / 2)),
      };
      await movePoint(base, start.x, start.y);
      await pointerButton(base, BTN_LEFT, "press");
      const attached = await waitFor(
        "wait for xdg-toplevel-drag attached window",
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = snapshot.windows.find(
            (entry) => !entry.shell_hosted && entry.title === title,
          );
          if (!window) return null;
          const expectedX = start.x - offset.x;
          const expectedY = start.y - offset.y;
          if (Math.abs(window.x - expectedX) > 12) return null;
          if (Math.abs(window.y - expectedY) > 12) return null;
          return { snapshot, window, expectedX, expectedY };
        },
        5000,
        40,
      );
      const movedPointer = { x: start.x + 96, y: start.y + 54 };
      await movePoint(base, movedPointer.x, movedPointer.y);
      const moved = await waitFor(
        "wait for xdg-toplevel-drag move update",
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositorWindowById(snapshot, windowId ?? 0);
          if (!window) return null;
          const expectedX = movedPointer.x - offset.x;
          const expectedY = movedPointer.y - offset.y;
          if (Math.abs(window.x - expectedX) > 12) return null;
          if (Math.abs(window.y - expectedY) > 12) return null;
          if (snapshot.shell_move_window_id !== window.window_id) return null;
          if (snapshot.shell_move_visual?.x !== window.x) return null;
          return { snapshot, window, expectedX, expectedY };
        },
        5000,
        40,
      );
      await writeJsonArtifact("xdg-toplevel-drag-attach.json", {
        command: clientCommand,
        outputPath,
        pointer: start,
        movedPointer,
        offset,
        attached: attached.window,
        moved: moved.window,
      });
    } catch (error) {
      let output = "";
      try {
        output = await readFile(outputPath, "utf8");
      } catch {
      }
      await writeJsonArtifact("xdg-toplevel-drag-attach-failure.json", {
        command: clientCommand,
        outputPath,
        output,
        windowId,
      });
      if (output) {
        throw new Error(`${(error as Error).message}\n${output}`);
      }
      throw error;
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
      if (windowId !== null) {
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
    }
  });

  test("xdg-toplevel-drag rejects reused native drag sources", async ({
    base,
  }) => {
    const stamp = Date.now();
    const outputPath = path.join(
      artifactDir(),
      `xdg-toplevel-drag-reused-source-${stamp}.txt`,
    );
    const command = [
      shellQuote(nativeBin()),
      "--title",
      shellQuote(`Derp Xdg Toplevel Drag Reused ${stamp}`),
      "--app-id",
      "derp.e2e.xdg.toplevel.drag.reused",
      "--token",
      `xdg-toplevel-drag-reused-${stamp}`,
      "--strip",
      "green",
      "--width",
      "260",
      "--height",
      "160",
      "--xdg-toplevel-drag-attach",
      "--xdg-toplevel-drag-reuse-source",
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`);
    const output = await waitFor(
      "wait for xdg-toplevel-drag reused source protocol error",
      async () => {
        try {
          const text = await readFile(outputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    assert(!output.includes("\nexit:0\n"), output);
    assert(
      output.includes("invalid_source") || output.includes("InvalidSource"),
      output,
    );
    await writeJsonArtifact("xdg-toplevel-drag-reused-source.json", {
      outputPath,
      output,
    });
  });

  test("xdg-toplevel-drag rejects destroy while native DnD is active", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const title = `Derp Xdg Toplevel Drag Destroy ${stamp}`;
    const outputPath = path.join(
      artifactDir(),
      `xdg-toplevel-drag-ongoing-destroy-${stamp}.txt`,
    );
    const clientCommand = [
      shellQuote(nativeBin()),
      "--title",
      shellQuote(title),
      "--app-id",
      "derp.e2e.xdg.toplevel.drag.destroy",
      "--token",
      `xdg-toplevel-drag-destroy-${stamp}`,
      "--strip",
      "green",
      "--width",
      "320",
      "--height",
      "190",
      "--xdg-toplevel-drag-attach",
      "--xdg-toplevel-drag-source",
      "--xdg-toplevel-drag-destroy-on-start",
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    let windowId: number | null = null;
    await spawnCommand(base, `sh -lc ${shellQuote(clientCommand)}`);
    try {
      const window = await waitForSpawnedWindow(
        base,
        state.knownWindowIds,
        {
          title,
          appId: "derp.e2e.xdg.toplevel.drag.destroy",
          command: clientCommand,
        },
      );
      windowId = window.window.window_id;
      const readyWindow = await waitFor(
        "wait for xdg-toplevel-drag destroy native geometry",
        async () => {
          const snapshot = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const entry = compositorWindowById(snapshot, windowId ?? 0);
          if (!entry) return null;
          if (entry.width < 100 || entry.height < 100) return null;
          return entry;
        },
        5000,
        40,
      );
      await movePoint(
        base,
        readyWindow.x + Math.max(24, Math.floor(readyWindow.width / 2)),
        readyWindow.y + Math.max(96, Math.floor(readyWindow.height / 2)),
      );
      await pointerButton(base, BTN_LEFT, "press");
      const output = await waitFor(
        "wait for xdg-toplevel-drag ongoing destroy protocol error",
        async () => {
          try {
            const text = await readFile(outputPath, "utf8");
            return text.includes("\nexit:") ? text : null;
          } catch {
            return null;
          }
        },
        5000,
        100,
      );
      assert(!output.includes("\nexit:0\n"), output);
      assert(
        output.includes("ongoing_drag") || output.includes("OngoingDrag"),
        output,
      );
      await writeJsonArtifact("xdg-toplevel-drag-ongoing-destroy.json", {
        outputPath,
        output,
        windowId,
      });
    } finally {
      await pointerButton(base, BTN_LEFT, "release");
      if (windowId !== null) {
        await closeWindow(base, windowId).catch(() => undefined);
      }
    }
  });

  test("xdg-popup explicit grabs keep nested native menus modal", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const statusPath = path.join(
      artifactDir(),
      `xdg-popup-grab-status-${stamp}.json`,
    );
    const title = `Derp Xdg Popup Grab ${stamp}`;
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title,
      appId: "derp.e2e.xdg.popup.grab",
      token: `xdg-popup-grab-${stamp}`,
      strip: "blue",
      width: 420,
      height: 260,
      xdgPopupGrabProbe: true,
      xdgPopupGrabStatusJson: statusPath,
    });
    state.spawnedNativeWindowIds.add(native.window.window_id);
    try {
      await waitForNativeFocus(base, native.window.window_id);
      const readyCompositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const readyWindow =
        compositorWindowById(readyCompositor, native.window.window_id) ??
        native.window;
      const parentOpenPoint = {
        x: readyWindow.x + 56,
        y: readyWindow.y + 72,
      };
      const childOpenPoint = {
        x: readyWindow.x + 24 + 40,
        y: readyWindow.y + 44 + 40,
      };
      await movePoint(base, parentOpenPoint.x, parentOpenPoint.y);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      await waitForStatusJson<XdgPopupGrabStatus>(
        statusPath,
        "wait for parent popup grab",
        (status) =>
          status.open_depth === 1 &&
          status.parent_configured >= 1 &&
          status.keyboard_enter_surface === "parent",
      );
      let compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      assert(
        compositor.focused_window_id === native.window.window_id,
        "parent popup should preserve logical native focus",
      );
      assert(
        compositor.shell_keyboard_focus === false,
        "parent popup should not move keyboard focus to shell",
      );
      await movePoint(base, childOpenPoint.x, childOpenPoint.y);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      await waitForStatusJson<XdgPopupGrabStatus>(
        statusPath,
        "wait for child popup grab",
        (status) =>
          status.open_depth === 2 &&
          status.child_configured >= 1 &&
          status.keyboard_enter_surface === "child",
      );
      compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      assert(
        compositor.focused_window_id === native.window.window_id,
        "child popup should preserve logical native focus",
      );
      assert(
        compositor.shell_keyboard_focus === false,
        "child popup should not move keyboard focus to shell",
      );
      await tapKey(base, KEY.escape);
      await waitForStatusJson<XdgPopupGrabStatus>(
        statusPath,
        "wait for Escape to close topmost popup",
        (status) =>
          status.open_depth === 1 &&
          status.child_done >= 1 &&
          status.parent_done === 0,
      );
      await movePoint(base, childOpenPoint.x, childOpenPoint.y);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      await waitForStatusJson<XdgPopupGrabStatus>(
        statusPath,
        "wait for child popup reopen",
        (status) => status.open_depth === 2 && status.child_configured >= 2,
      );
      const output = readyCompositor.outputs.find(
        (entry) => entry.name === readyWindow.output_name,
      ) ?? readyCompositor.outputs[0];
      assert(output, "missing output for outside popup click");
      await movePoint(base, output.x + output.width - 12, output.y + output.height - 12);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      const dismissed = await waitForStatusJson<XdgPopupGrabStatus>(
        statusPath,
        "wait for outside click popup dismissal",
        (status) =>
          status.open_depth === 0 &&
          status.parent_done >= 1 &&
          status.child_done >= 1,
      );
      compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      assert(
        compositor.focused_window_id === native.window.window_id,
        `outside dismissal should restore native focus: ${JSON.stringify(dismissed)}`,
      );
      assert(
        compositor.shell_keyboard_focus === false,
        "outside dismissal should not leak keyboard focus to shell",
      );
      await writeJsonArtifact("xdg-popup-grab.json", {
        window: readyWindow,
        status: dismissed,
        parentOpenPoint,
        childOpenPoint,
      });
    } finally {
      await closeWindow(base, native.window.window_id);
      await waitForWindowGone(base, native.window.window_id, 5000);
    }
  });

  test("native text-input v3 routes through input-method v2", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const originalOsk = await getJson<OskSettings>(base, "/settings_osk");
    const textStatusPath = path.join(
      artifactDir(),
      `text-input-status-${stamp}.json`,
    );
    const inputMethodStatusPath = path.join(
      artifactDir(),
      `input-method-status-${stamp}.json`,
    );
    await postJson(base, "/settings_osk", {
      enabled: false,
      provider: "squeekboard",
    });
    await waitForSqueekboardStopped();
    let inputMethod: Awaited<ReturnType<typeof spawnNativeWindow>> | null = null;
    let textClient: Awaited<ReturnType<typeof spawnNativeWindow>> | null = null;
    try {
      inputMethod = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Input Method ${stamp}`,
        appId: "derp.e2e.input.method",
        token: `input-method-${stamp}`,
        strip: "yellow",
        width: 320,
        height: 180,
        inputMethodProbe: true,
        inputMethodStatusJson: inputMethodStatusPath,
      });
      state.spawnedNativeWindowIds.add(inputMethod.window.window_id);
      textClient = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Text Input ${stamp}`,
        appId: "derp.e2e.text.input",
        token: `text-input-${stamp}`,
        strip: "green",
        width: 420,
        height: 240,
        textInputProbe: true,
        textInputStatusJson: textStatusPath,
      });
      state.spawnedNativeWindowIds.add(textClient.window.window_id);
      await waitForNativeFocus(base, textClient.window.window_id);
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const textWindow =
        compositorWindowById(compositor, textClient.window.window_id) ??
        textClient.window;
      await movePoint(base, textWindow.x + 64, textWindow.y + 72);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      await waitForStatusJson<TextInputProbeStatus>(
        textStatusPath,
        "wait for text-input events",
        (status) =>
          status.enter >= 1 &&
          status.preedit >= 1 &&
          status.commit_string >= 1 &&
          status.delete_surrounding_text >= 1 &&
          status.last_preedit === "preedit" &&
          status.last_commit_string === "commit" &&
          status.last_delete_before === 2 &&
          status.last_delete_after === 1,
      );
      await waitForStatusJson<InputMethodProbeStatus>(
        inputMethodStatusPath,
        "wait for input-method activation and state",
        (status) =>
          status.activate >= 1 &&
          status.surrounding_text >= 1 &&
          status.done >= 1 &&
          status.last_surrounding_text === "hello native text" &&
          status.last_cursor === 5 &&
          status.last_anchor === 5 &&
          status.popup_configure >= 1 &&
          status.last_popup_width === 14 &&
          status.last_popup_height === 24,
      );
      const shellWindow = await openShellTestWindow(base, state);
      await waitForStatusJson<TextInputProbeStatus>(
        textStatusPath,
        "wait for text-input leave",
        (status) => status.leave >= 1,
      );
      await waitForStatusJson<InputMethodProbeStatus>(
        inputMethodStatusPath,
        "wait for input-method deactivate",
        (status) => status.deactivate >= 1,
      );
      await closeWindow(base, shellWindow.window.window_id);
      await waitForWindowGone(base, shellWindow.window.window_id, 5000);
      await writeJsonArtifact("native-text-input.json", {
        textWindow,
        textStatus: await readStatusJson<TextInputProbeStatus>(textStatusPath),
        inputMethodStatus: await readStatusJson<InputMethodProbeStatus>(
          inputMethodStatusPath,
        ),
      });
    } finally {
      if (textClient) {
        await closeWindow(base, textClient.window.window_id);
        await waitForWindowGone(base, textClient.window.window_id, 5000);
      }
      if (inputMethod) {
        await closeWindow(base, inputMethod.window.window_id);
        await waitForWindowGone(base, inputMethod.window.window_id, 5000);
      }
      await postJson(base, "/settings_osk", originalOsk);
    }
  });

  test("settings-launched squeekboard commits text into focused native text-input", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const originalOsk = await getJson<OskSettings>(base, "/settings_osk");
    const textStatusPath = path.join(
      artifactDir(),
      `text-input-osk-status-${stamp}.json`,
    );
    const missingReason = await squeekboardMissingReason(base, stamp);
    if (missingReason) {
      await writeJsonArtifact("native-text-input-osk.json", {
        failed: true,
        reason: missingReason,
      });
      throw new Error(missingReason);
    }
    await postJson(base, "/settings_osk", {
      enabled: false,
      provider: "squeekboard",
    });
    await waitForSqueekboardStopped();
    let textClient: Awaited<ReturnType<typeof spawnNativeWindow>> | null = null;
    let applied: OskSettings | null = null;
    let started: { pid: string; env: string } | null = null;
    let trayShell: ShellSnapshot | null = null;
    let mouseFocused: CompositorSnapshot | null = null;
    let touchFocused: {
      compositor: CompositorSnapshot;
      output: CompositorSnapshot["outputs"][number];
    } | null = null;
    let taskbarMoved: {
      compositor: CompositorSnapshot;
      output: CompositorSnapshot["outputs"][number];
      taskbar: ShellSnapshot["taskbars"][number];
    } | null = null;
    let textWindow: CompositorSnapshot["windows"][number] | null = null;
    try {
      textClient = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Text Input OSK ${stamp}`,
        appId: "derp.e2e.text.input.osk",
        token: `text-input-osk-${stamp}`,
        strip: "green",
        width: 480,
        height: 260,
        textInputProbe: true,
        textInputStatusJson: textStatusPath,
      });
      state.spawnedNativeWindowIds.add(textClient.window.window_id);
      await waitForNativeFocus(base, textClient.window.window_id);
      let compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      textWindow =
        compositorWindowById(compositor, textClient.window.window_id) ??
        textClient.window;
      await clickPoint(base, textWindow.x + 70, textWindow.y + 78);

      applied = await setOskEnabledThroughSettings(base, true);
      await closeWindow(base, SHELL_UI_SETTINGS_WINDOW_ID);
      await waitForWindowGone(base, SHELL_UI_SETTINGS_WINDOW_ID, 5000);
      const expectedDisplay = `WAYLAND_DISPLAY=wayland-d${process.getuid?.() ?? ""}`;
      started = await waitFor(
        "wait for settings-launched squeekboard",
        async () => {
          const envs = await squeekboardProcessEnvs();
          return envs.find((entry) => entry.env.includes(expectedDisplay)) ?? null;
        },
        5000,
        100,
      );
      trayShell = await waitFor(
        "wait for taskbar OSK toggle",
        async () => {
          const { shell } = await getSnapshots(base);
          return shell.controls?.taskbar_osk_toggle ? shell : null;
        },
        5000,
        100,
      );
      compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      textWindow =
        compositorWindowById(compositor, textClient.window.window_id) ??
        textWindow;
      assert(textWindow, "missing text input window after settings apply");
      await clickPoint(base, textWindow.x + 70, textWindow.y + 78);
      await waitForNativeFocus(base, textClient.window.window_id);
      await waitForStatusJson<TextInputProbeStatus>(
        textStatusPath,
        "wait for mouse-focused text-input enable",
        (status) => status.enter >= 1 && status.enable >= 1,
      );
      mouseFocused = await waitFor(
        "wait for OSK to stay hidden after mouse text focus",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return next.osk_text_input_visibility_allowed !== true &&
            next.osk_visible !== true
            ? next
            : null;
        },
        5000,
        100,
      );
      const focusedTextWindow = textWindow;
      await touchTap(base, focusedTextWindow.x + 70, focusedTextWindow.y + 78, 7);
      touchFocused = await waitFor(
        "wait for touch-focused text-input OSK",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const output = next.outputs.find((entry) =>
            focusedTextWindow.x >= entry.x &&
            focusedTextWindow.x < entry.x + entry.width &&
            focusedTextWindow.y >= entry.y &&
            focusedTextWindow.y < entry.y + entry.height
          );
          return next.osk_text_input_visibility_allowed === true &&
            next.osk_visible === true &&
            output &&
            next.osk_preferred_output_name === output.name
            ? { compositor: next, output }
            : null;
        },
        5000,
        100,
      );
      const activeTouchFocused = touchFocused;
      taskbarMoved = await waitFor(
        "wait for taskbar above OSK usable area",
        async () => {
          const { compositor: nextCompositor, shell } = await getSnapshots(base);
          const output = nextCompositor.outputs.find((entry) => entry.name === activeTouchFocused.output.name);
          const taskbar = shell.taskbars.find((entry) => entry.monitor === activeTouchFocused.output.name);
          if (!output || !taskbar?.rect) return null;
          const usableBottom = (output.usable_y ?? output.y) + (output.usable_height ?? output.height);
          if ((output.usable_height ?? output.height) >= output.height) return null;
          if (nextCompositor.osk_layer_visible_on_preferred_output !== true) return null;
          if (taskbar.rect.global_y + taskbar.rect.height > usableBottom + 2) return null;
          return { compositor: nextCompositor, output, taskbar };
        },
        5000,
        100,
      );
      const busPrefix = `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`;
      const output = taskbarMoved.output;
      assert(output, "missing output for OSK commit probe");
      const oskLayer = taskbarMoved.compositor.osk_layer_surfaces?.find(
        (layer) => layer.output_name === output.name && layer.global.width > 0 && layer.global.height > 0,
      );
      assert(oskLayer, "missing visible OSK layer for commit probe");
      const screenshot = await captureScreenshotRect(base, {
        x: output.x,
        y: output.y,
        width: output.width,
        height: output.height,
      });
      const tapY = oskLayer.global.y + Math.round(oskLayer.global.height * 0.23);
      const tapXs = [0.36, 0.42, 0.48, 0.54].map((ratio) =>
        oskLayer.global.x + Math.round(oskLayer.global.width * ratio),
      );
      for (const [index, tapX] of tapXs.entries()) {
        await touchTap(base, tapX, tapY, index);
      }
      let committed: TextInputProbeStatus | null = null;
      let commitError: unknown = null;
      committed = await waitForStatusJson<TextInputProbeStatus>(
        textStatusPath,
        "wait for squeekboard text commit",
        (status) =>
          status.enable >= 1 &&
          status.done >= 1 &&
          status.commit_string >= 1 &&
          status.last_commit_string.length > 0,
        5000,
      ).catch((error) => {
        commitError = error;
        return null;
      });
      const hidden = await runLocalShell(
        `${busPrefix} busctl --user call sm.puri.OSK0 /sm/puri/OSK0 sm.puri.OSK0 SetVisible b false`,
      );
      const finalStatus = committed ?? (await readStatusJson<TextInputProbeStatus>(textStatusPath));
      const busName = committed
        ? null
        : await runLocalShell(`${busPrefix} busctl --user status sm.puri.OSK0`);
      await writeJsonArtifact("native-text-input-osk.json", {
        failed: committed === null,
        reason: committed
          ? null
          : [
            "squeekboard did not commit text after compositor-launched OSK touch taps",
            `status=${JSON.stringify(finalStatus)}`,
            `dbus_status=${busName?.status}`,
            `dbus_stderr=${busName?.stderr.trim()}`,
            `dbus_stdout=${busName?.stdout.trim()}`,
            `wait_error=${commitError instanceof Error ? commitError.message : String(commitError)}`,
          ].join("; "),
        applied,
        started: started ? { pid: started.pid, env: started.env } : null,
        taskbarOskToggle: trayShell.controls?.taskbar_osk_toggle,
        mouseFocused,
        touchFocused,
        taskbarMoved,
        hidden,
        screenshot,
        textWindow,
        tapPoints: tapXs.map((x) => ({ x, y: tapY })),
        textStatus: finalStatus,
      });
      assert(committed, "missing committed text-input status");
      assert(committed.enable >= 1, JSON.stringify(committed));
      assert(committed.done >= 1, JSON.stringify(committed));
      assert(committed.last_commit_string.length > 0, JSON.stringify(committed));
      assert(trayShell.controls?.taskbar_osk_toggle, "missing OSK tray toggle");
    } catch (error) {
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      ).catch(() => null);
      const shell = await getJson<ShellSnapshot>(
        base,
        "/test/state/shell",
      ).catch(() => null);
      const textStatus = await readStatusJson<TextInputProbeStatus>(
        textStatusPath,
      ).catch((statusError) => ({
        error: statusError instanceof Error ? statusError.message : String(statusError),
      }));
      const envs = await squeekboardProcessEnvs().catch((envError) => [
        {
          pid: "error",
          env: envError instanceof Error ? envError.message : String(envError),
        },
      ]);
      const output =
        touchFocused?.output ??
        (textWindow && compositor
          ? compositor.outputs.find(
            (entry) =>
              textWindow !== null &&
              textWindow.x >= entry.x &&
              textWindow.x < entry.x + entry.width &&
              textWindow.y >= entry.y &&
              textWindow.y < entry.y + entry.height,
          )
          : null) ??
        compositor?.outputs.find(
          (entry) => entry.name === compositor.osk_preferred_output_name,
        ) ??
        null;
      const screenshot = output
        ? await captureScreenshotRect(base, {
          x: output.x,
          y: output.y,
          width: output.width,
          height: output.height,
        }).catch((screenshotError) => ({
          error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
        }))
        : null;
      await writeJsonArtifact(`native-text-input-osk-failure-${stamp}.json`, {
        error: error instanceof Error ? error.message : String(error),
        applied,
        started,
        taskbarOskToggle: trayShell?.controls?.taskbar_osk_toggle,
        mouseFocused,
        touchFocused,
        taskbarMoved,
        textWindow,
        compositor,
        shell,
        textStatus,
        envs,
        screenshot,
      });
      throw error;
    } finally {
      if (textClient) {
        await closeWindow(base, textClient.window.window_id);
        await waitForWindowGone(base, textClient.window.window_id, 5000);
      }
      await postJson(base, "/settings_osk", originalOsk);
    }
  });

  test("squeekboard auto-opens and types into shell editables", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const originalOsk = await getJson<OskSettings>(base, "/settings_osk");
    const missingReason = await squeekboardMissingReason(base, stamp);
    if (missingReason) {
      await writeJsonArtifact("shell-editable-osk.json", {
        failed: true,
        reason: missingReason,
      });
      throw new Error(missingReason);
    }
    await postJson(base, "/settings_osk", {
      enabled: false,
      provider: "squeekboard",
    });
    await waitForSqueekboardStopped();
    let shellWindow: Awaited<ReturnType<typeof openShellTestWindow>> | null = null;
    try {
      await postJson(base, "/settings_osk", {
        enabled: true,
        provider: "squeekboard",
      });
      const expectedDisplay = `WAYLAND_DISPLAY=wayland-d${process.getuid?.() ?? ""}`;
      const started = await waitFor(
        "wait for shell-editable squeekboard",
        async () => {
          const envs = await squeekboardProcessEnvs();
          return envs.find((entry) => entry.env.includes(expectedDisplay)) ?? null;
        },
        5000,
        100,
      );
      shellWindow = await openShellTestWindow(base, state);
      const shellInput = await waitFor(
        "wait for shell test input",
        async () => {
          const { shell } = await getSnapshots(base);
          return shell.shell_test_inputs?.find((entry) => entry.window_id === shellWindow?.window.window_id && entry.rect) ?? null;
        },
        5000,
        100,
      );
      assert(shellInput.rect, "missing shell test input rect");
      await clickRect(base, shellInput.rect);
      const mouseFocused = await waitFor(
        "wait for shell mouse focus to keep OSK hidden",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return next.osk_shell_text_input_active !== true &&
            next.osk_visible !== true
            ? next
            : null;
        },
        5000,
        100,
      );
      await touchTap(
        base,
        shellInput.rect.x + Math.round(shellInput.rect.width / 2),
        shellInput.rect.y + Math.round(shellInput.rect.height / 2),
        11,
      );
      const shellTouchFocused = await waitFor(
        "wait for touch-focused shell input OSK",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const output = next.outputs.find((entry) =>
            shellInput.rect!.global_x >= entry.x &&
            shellInput.rect!.global_x < entry.x + entry.width &&
            shellInput.rect!.global_y >= entry.y &&
            shellInput.rect!.global_y < entry.y + entry.height
          );
          return next.osk_shell_text_input_active === true &&
            next.osk_visible === true &&
            output &&
            next.osk_preferred_output_name === output.name
            ? (() => {
              const oskLayer = next.osk_layer_surfaces?.find(
                (layer) => layer.output_name === output.name && layer.global.width > 0 && layer.global.height > 0,
              );
              return oskLayer ? { compositor: next, output, oskLayer } : null;
            })()
            : null;
        },
        5000,
        100,
      );
      const shellOskLayer = shellTouchFocused.oskLayer;
      const tapPoints = [0.36, 0.42, 0.48, 0.54].map((xRatio) => ({
        x: shellOskLayer.global.x + Math.round(shellOskLayer.global.width * xRatio),
        y: shellOskLayer.global.y + Math.round(shellOskLayer.global.height * 0.23),
      }));
      const shellWindowAboveOsk = await waitFor(
        "wait for shell window above OSK",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = next.windows.find((entry) => entry.window_id === shellWindow?.window.window_id);
          const output = next.outputs.find((entry) => entry.name === shellTouchFocused.output.name);
          if (!window || !output || output.usable_y === undefined || output.usable_height === undefined) return null;
          return window.y + window.height <= output.usable_y + output.usable_height ? { compositor: next, window, output } : null;
        },
        5000,
        100,
      );
      const shellOskScreenshot = await captureScreenshotRect(base, {
        x: shellTouchFocused.output.x,
        y: shellTouchFocused.output.y,
        width: shellTouchFocused.output.width,
        height: shellTouchFocused.output.height,
      });
      await writeJsonArtifact("shell-editable-osk-before-taps.json", {
        started: { pid: started.pid, env: started.env },
        mouseFocused,
        shellTouchFocused,
        shellOskScreenshot,
        shellInput,
        tapPoints,
      });
      for (const [index, point] of tapPoints.entries()) {
        await touchTap(base, point.x, point.y, 20 + index);
      }
      await writeJsonArtifact("shell-editable-osk-after-taps.json", {
        compositor: await getJson<CompositorSnapshot>(
          base,
          "/test/state/compositor",
        ),
        shell: await getJson<ShellSnapshot>(base, "/test/state/shell"),
        tapPoints,
      });
      const typedShellInput = await waitFor(
        "wait for OSK text in shell input",
        async () => {
          const { shell } = await getSnapshots(base);
          const input = shell.shell_test_inputs?.find((entry) => entry.window_id === shellWindow?.window.window_id);
          return input && input.value.length > 0 ? input : null;
        },
        5000,
        100,
      );
      const hideInputButton = await waitFor(
        "wait for shell hide input button",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.shell_test_hide_inputs?.find((entry) => entry.window_id === shellWindow?.window.window_id && entry.rect) ?? null;
        },
        5000,
        100,
      );
      assert(hideInputButton.rect, "missing shell hide input button rect");
      await clickRect(base, hideInputButton.rect);
      const shellInputHidden = await waitFor(
        "wait for hidden shell input to close OSK",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const input = shell.shell_test_inputs?.find((entry) => entry.window_id === shellWindow?.window.window_id);
          return !input && compositor.osk_shell_text_input_active !== true && compositor.osk_visible !== true
            ? { compositor, shell }
            : null;
        },
        5000,
        100,
      );
      let shell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      if (shell.programs_menu_open) {
        await tapKey(base, KEY.escape);
        await waitForProgramsMenuClosed(base);
      }
      shell = await waitFor(
        "wait for programs toggle for shell OSK",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.controls?.taskbar_programs_toggle ? next : null;
        },
        5000,
        100,
      );
      assert(shell.controls.taskbar_programs_toggle, "missing programs toggle");
      await touchTap(
        base,
        shell.controls.taskbar_programs_toggle.x + Math.round(shell.controls.taskbar_programs_toggle.width / 2),
        shell.controls.taskbar_programs_toggle.y + Math.round(shell.controls.taskbar_programs_toggle.height / 2),
        31,
      );
      const menuShell = await waitForProgramsMenuOpen(base);
      assert(menuShell.controls.programs_menu_search, "missing programs menu search");
      await touchTap(
        base,
        menuShell.controls.programs_menu_search.x + Math.round(menuShell.controls.programs_menu_search.width / 2),
        menuShell.controls.programs_menu_search.y + Math.round(menuShell.controls.programs_menu_search.height / 2),
        32,
      );
      const paletteTouchFocused = await waitFor(
        "wait for touch-focused command palette OSK",
        async () => {
          const { compositor, shell } = await getSnapshots(base);
          const search = shell.controls?.programs_menu_search;
          if (!search || !shell.programs_menu_open) {
            return null;
          }
          if (compositor.osk_shell_text_input_active !== true || compositor.osk_visible !== true) {
            return null;
          }
          const output = compositor.outputs.find((entry) =>
            search.x >= entry.x &&
            search.x < entry.x + entry.width &&
            search.y >= entry.y &&
            search.y < entry.y + entry.height
          ) ?? shellTouchFocused.output;
          const oskLayer = compositor.osk_layer_surfaces?.find((layer) =>
            layer.output_name === output.name &&
            layer.global.width > 0 &&
            layer.global.height > 0
          );
          return oskLayer ? { compositor, shell, output, oskLayer } : null;
        },
        5000,
        100,
      );
      assert(paletteTouchFocused.shell.controls.programs_menu_search, "missing focused programs menu search");
      const paletteOutput = paletteTouchFocused.output;
      const paletteOskLayer = paletteTouchFocused.oskLayer;
      const paletteTapPoints = [0.36, 0.42, 0.48, 0.54].map((xRatio) => ({
        x: paletteOskLayer.global.x + Math.round(paletteOskLayer.global.width * xRatio),
        y: paletteOskLayer.global.y + Math.round(paletteOskLayer.global.height * 0.23),
      }));
      await writeJsonArtifact("shell-editable-osk-before-palette-taps.json", {
        paletteTouchFocused,
        paletteOutput,
        paletteOskLayer,
        paletteTapPoints,
      });
      for (const [index, point] of paletteTapPoints.entries()) {
        await touchTap(base, point.x, point.y, 40 + index);
      }
      await writeJsonArtifact("shell-editable-osk-after-palette-taps.json", {
        compositor: await getJson<CompositorSnapshot>(
          base,
          "/test/state/compositor",
        ),
        shell: await getJson<ShellSnapshot>(base, "/test/state/shell"),
        paletteTapPoints,
      });
      const typedPalette = await waitFor(
        "wait for OSK text in command palette",
        async () => {
          const next = await getJson<ShellSnapshot>(base, "/test/state/shell");
          return next.programs_menu_query.length > 0 ? next : null;
        },
        5000,
        100,
      );
      await writeJsonArtifact("shell-editable-osk.json", {
        failed: false,
        started: { pid: started.pid, env: started.env },
        mouseFocused,
        shellTouchFocused,
        shellWindowAboveOsk,
        shellInputHidden,
        paletteTouchFocused,
        shellOskScreenshot,
        typedShellInput,
        programsMenuQuery: typedPalette.programs_menu_query,
        tapPoints,
        paletteTapPoints,
      });
      assert(typedShellInput.value.length > 0, JSON.stringify(typedShellInput));
      assert(typedPalette.programs_menu_query.length > 0, typedPalette.programs_menu_query);
    } finally {
      if (shellWindow) {
        await closeWindow(base, shellWindow.window.window_id);
        await waitForWindowGone(base, shellWindow.window.window_id, 5000);
      }
      await postJson(base, "/settings_osk", originalOsk);
    }
  });

  test("trusted virtual keyboard injects focused native keys and compositor shortcuts", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const globalsPath = path.join(
      artifactDir(),
      `virtual-keyboard-globals-${stamp}.txt`,
    );
    const globalsCommand = [
      shellQuote(nativeBin()),
      "--require-global",
      "zwp_virtual_keyboard_manager_v1",
      "--list-globals",
      ">",
      shellQuote(globalsPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(globalsPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(globalsCommand)}`);
    const globalsOutput = await waitFor(
      "wait for virtual keyboard registry probe",
      async () => {
        try {
          const text = await readFile(globalsPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    assert(globalsOutput.includes("zwp_virtual_keyboard_manager_v1"), globalsOutput);
    assert(globalsOutput.includes("\nexit:0\n"), globalsOutput);

    const keyboardStatusPath = path.join(
      artifactDir(),
      `virtual-keyboard-target-${stamp}.json`,
    );
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Virtual Keyboard Target ${stamp}`,
      appId: "derp.e2e.virtual.keyboard.target",
      token: `virtual-keyboard-target-${stamp}`,
      strip: "green",
      width: 420,
      height: 240,
      keyboardStatusJson: keyboardStatusPath,
    });
    state.spawnedNativeWindowIds.add(native.window.window_id);
    try {
      await waitForNativeFocus(base, native.window.window_id);
      const keyProbePath = path.join(
        artifactDir(),
        `virtual-keyboard-probe-key-${stamp}.json`,
      );
      const keyProbeCommand = [
        shellQuote(nativeBin()),
        "--virtual-keyboard-probe",
        "--virtual-keyboard-status-json",
        shellQuote(keyProbePath),
        "--virtual-keyboard-sequence",
        "a",
      ].join(" ");
      await spawnCommand(base, `sh -lc ${shellQuote(keyProbeCommand)}`);
      await waitForStatusJson<VirtualKeyboardProbeStatus>(
        keyProbePath,
        "wait for virtual keyboard key probe",
        (status) => status.ready && status.sent && status.sequence === "a",
      );
      const keyboardStatus = await waitForStatusJson<KeyboardStatus>(
        keyboardStatusPath,
        "wait for virtual keyboard target key",
        (status) =>
          status.press >= 1 &&
          status.release >= 1 &&
          status.last_raw_code === 30,
      );
      assert(
        keyboardStatus.last_keysym.includes("a") || keyboardStatus.last_utf8 === "a",
        JSON.stringify(keyboardStatus),
      );

      const beforeShell = await getJson<ShellSnapshot>(base, "/test/state/shell");
      if (beforeShell.programs_menu_open) {
        await tapKey(base, KEY.escape);
        await waitForProgramsMenuClosed(base);
      }
      const superProbePath = path.join(
        artifactDir(),
        `virtual-keyboard-probe-super-${stamp}.json`,
      );
      const superProbeCommand = [
        shellQuote(nativeBin()),
        "--virtual-keyboard-probe",
        "--virtual-keyboard-status-json",
        shellQuote(superProbePath),
        "--virtual-keyboard-sequence",
        "super",
      ].join(" ");
      await spawnCommand(base, `sh -lc ${shellQuote(superProbeCommand)}`);
      await waitForStatusJson<VirtualKeyboardProbeStatus>(
        superProbePath,
        "wait for virtual keyboard super probe",
        (status) => status.ready && status.sent && status.sequence === "super",
      );
      const opened = await waitForProgramsMenuOpen(base);
      assert(opened.programs_menu_open, "virtual Super tap should open programs menu");
      await tapKey(base, KEY.escape);
      await waitForProgramsMenuClosed(base);
      await writeJsonArtifact("virtual-keyboard.json", {
        globals: globalsOutput,
        keyboardStatus,
        keyProbe: await readStatusJson<VirtualKeyboardProbeStatus>(keyProbePath),
        superProbe: await readStatusJson<VirtualKeyboardProbeStatus>(superProbePath),
      });
    } finally {
      await closeWindow(base, native.window.window_id);
      await waitForWindowGone(base, native.window.window_id, 5000);
    }
  });

  test("settings-controlled squeekboard starts and stops in the Derp session", async ({
    base,
  }) => {
    const command = await runLocalShell("command -v squeekboard");
    assert(command.status === 0, `missing squeekboard: ${command.stderr}`);
    const original = await getJson<OskSettings>(base, "/settings_osk");
    const expectedDisplay = `WAYLAND_DISPLAY=wayland-d${process.getuid?.() ?? ""}`;
    try {
      await postJson(base, "/settings_osk", {
        enabled: false,
        provider: "squeekboard",
      });
      const stopped = await waitFor(
        "wait for squeekboard stop",
        async () => {
          const envs = await squeekboardProcessEnvs();
          return envs.length === 0 ? envs : null;
        },
        5000,
        100,
      );

      await postJson(base, "/settings_osk", {
        enabled: true,
        provider: "squeekboard",
      });
      const started = await waitFor(
        "wait for squeekboard session env",
        async () => {
          const envs = await squeekboardProcessEnvs();
          return envs.find((entry) => entry.env.includes(expectedDisplay)) ?? null;
        },
        5000,
        100,
      );
      assert(
        started.env.includes("XDG_RUNTIME_DIR=/run/user/"),
        `squeekboard missing runtime env: ${started.env}`,
      );

      const shellWithOskToggle = await waitFor(
        "wait for taskbar OSK toggle",
        async () => {
          const { shell } = await getSnapshots(base);
          return shell.controls?.taskbar_osk_toggle ? shell : null;
        },
        5000,
        100,
      );
      await clickRect(base, shellWithOskToggle.controls!.taskbar_osk_toggle!);
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const output = compositor.outputs[0];
      assert(output, "missing output for squeekboard screenshot");
      const screenshot = await captureScreenshotRect(base, {
        x: output.x,
        y: output.y,
        width: output.width,
        height: output.height,
      });
      const busPrefix = `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus`;
      const hidden = await runLocalShell(
        `${busPrefix} busctl --user call sm.puri.OSK0 /sm/puri/OSK0 sm.puri.OSK0 SetVisible b false`,
      );
      await writeJsonArtifact("squeekboard-settings-runtime.json", {
        stopped,
        started: { pid: started.pid, env: started.env },
        taskbarOskToggle: shellWithOskToggle.controls?.taskbar_osk_toggle,
        hidden,
        screenshot,
      });
    } finally {
      await postJson(base, "/settings_osk", original);
    }
  });

  test("forwards pointer gestures to native clients without leaking shell UI gestures", async ({
    base,
    state,
  }) => {
    const outputPath = path.join(
      artifactDir(),
      `pointer-gestures-globals-${Date.now()}.txt`,
    );
    const globalsCommand = [
      shellQuote(nativeBin()),
      "--require-global",
      "zwp_pointer_gestures_v1",
      "--list-globals",
      ">",
      shellQuote(outputPath),
      "2>&1;",
      "printf",
      shellQuote("\\nexit:%s\\n"),
      "$?",
      ">>",
      shellQuote(outputPath),
    ].join(" ");
    await spawnCommand(base, `sh -lc ${shellQuote(globalsCommand)}`);
    const globalsOutput = await waitFor(
      "wait for pointer gestures registry probe",
      async () => {
        try {
          const text = await readFile(outputPath, "utf8");
          return text.includes("\nexit:") ? text : null;
        } catch {
          return null;
        }
      },
      5000,
      100,
    );
    assert(globalsOutput.includes("zwp_pointer_gestures_v1"), globalsOutput);
    assert(globalsOutput.includes("\nexit:0\n"), globalsOutput);

    const stamp = Date.now();
    const statusPath = path.join(
      artifactDir(),
      `pointer-gestures-status-${stamp}.json`,
    );
    const title = `Derp Pointer Gesture Probe ${stamp}`;
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title,
      appId: "derp.e2e.pointer.gestures",
      token: `pointer-gestures-${stamp}`,
      strip: "green",
      width: 420,
      height: 260,
      gestureStatusJson: statusPath,
    });
    state.spawnedNativeWindowIds.add(native.window.window_id);
    try {
      await waitForNativeFocus(base, native.window.window_id);
      const readyCompositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const readyWindow =
        compositorWindowById(readyCompositor, native.window.window_id) ??
        native.window;
      const outsidePoint = {
        x: Math.max(0, readyWindow.x - 24),
        y: Math.max(0, readyWindow.y - 24),
      };
      const gesturePoint = {
        x: readyWindow.x + Math.floor(readyWindow.width / 2),
        y: readyWindow.y + Math.floor(readyWindow.height / 2),
      };
      await movePoint(base, outsidePoint.x, outsidePoint.y);
      await movePoint(base, gesturePoint.x, gesturePoint.y);
      await waitFor(
        "wait for pointer over gesture probe",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const pointer = compositor.pointer;
          if (!pointer) return null;
          return Math.round(pointer.x) === gesturePoint.x &&
            Math.round(pointer.y) === gesturePoint.y
            ? compositor
            : null;
        },
      );
      await waitForStatusJson<Record<string, number>>(
        statusPath,
        "wait for gesture probe status file",
        () => true,
      );
      await waitForStatusJson<Record<string, number>>(
        statusPath,
        "wait for gesture probe pointer enter",
        (status) => status.pointer_enter >= 1,
      );
      await pointerGesture(base, "swipe");
      await pointerGesture(base, "pinch");
      const delivered = await waitForStatusJson<Record<string, number>>(
        statusPath,
        "wait for native pointer gestures",
        (status) =>
          status.swipe_begin >= 1 &&
            status.swipe_update >= 1 &&
            status.swipe_end >= 1 &&
            status.pinch_begin >= 1 &&
            status.pinch_update >= 1 &&
            status.pinch_end >= 1,
      );
      await movePoint(base, native.window.x + 24, native.window.y + 24);
      await pointerWheel(base, 0, -120);
      const pointerAfterMotion = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      assert(
        Math.round(pointerAfterMotion.pointer?.x ?? -1) ===
          native.window.x + 24 &&
          Math.round(pointerAfterMotion.pointer?.y ?? -1) ===
            native.window.y + 24,
        `pointer motion changed unexpectedly: ${JSON.stringify(pointerAfterMotion.pointer)}`,
      );
      const beforeShellGesture =
        await readStatusJson<Record<string, number>>(statusPath);
      const shellRect = pointerAfterMotion.shell_exclusion_global?.[0];
      assert(
        shellRect && shellRect.width > 0 && shellRect.height > 0,
        "missing shell exclusion rect for leak probe",
      );
      await movePoint(
        base,
        shellRect.x + Math.floor(shellRect.width / 2),
        shellRect.y + Math.floor(shellRect.height / 2),
      );
      await pointerGesture(base, "swipe");
      const afterShellGesture =
        await readStatusJson<Record<string, number>>(statusPath);
      assert(
        beforeShellGesture && afterShellGesture,
        "missing gesture status around shell leak probe",
      );
      assert(
        afterShellGesture.swipe_begin === beforeShellGesture.swipe_begin &&
          afterShellGesture.swipe_update === beforeShellGesture.swipe_update &&
          afterShellGesture.swipe_end === beforeShellGesture.swipe_end,
        `shell UI gesture leaked to native client: before=${JSON.stringify(beforeShellGesture)} after=${JSON.stringify(afterShellGesture)}`,
      );
      await writeJsonArtifact("pointer-gestures-forwarding.json", {
        globals: globalsOutput,
        native: native.window,
        delivered,
        beforeShellGesture,
        afterShellGesture,
        shellRect,
        pointerAfterMotion: pointerAfterMotion.pointer,
      });
    } finally {
      await closeWindow(base, native.window.window_id);
      await waitForWindowGone(base, native.window.window_id, 5000);
    }
  });

  test("native wl_touch is delivered without pointer emulation and shell touch stays in CEF", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const statusPath = path.join(artifactDir(), `touch-status-${stamp}.json`);
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Touch Probe ${stamp}`,
      appId: "derp.e2e.touch.probe",
      token: `touch-probe-${stamp}`,
      strip: "purple",
      width: 440,
      height: 280,
      touchStatusJson: statusPath,
    });
    state.spawnedNativeWindowIds.add(native.window.window_id);
    try {
      await waitForNativeFocus(base, native.window.window_id);
      const ready = await waitForStatusJson<TouchStatus>(
        statusPath,
        "wait for touch probe ready",
        (status) => status.device_ready,
      );
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const window =
        compositorWindowById(compositor, native.window.window_id) ?? native.window;
      const nativePoint = {
        x: window.x + Math.floor(window.width / 2),
        y: window.y + Math.floor(window.height / 2),
      };
      await touchDown(base, nativePoint.x, nativePoint.y);
      await touchMove(base, nativePoint.x + 24, nativePoint.y + 18);
      await touchUp(base);
      const delivered = await waitForStatusJson<TouchStatus>(
        statusPath,
        "wait for native wl_touch delivery",
        (status) =>
          status.down >= ready.down + 1 &&
          status.motion >= ready.motion + 1 &&
          status.up >= ready.up + 1 &&
          status.frame >= ready.frame + 1 &&
          status.pointer_press === ready.pointer_press,
      );
      assert(
        delivered.last_surface === "toplevel",
        `native touch should target toplevel surface: ${JSON.stringify(delivered)}`,
      );

      const shellBefore = await getSnapshots(base);
      const toggle = shellBefore.shell.controls?.taskbar_programs_toggle;
      assert(toggle, "missing taskbar programs toggle for touch regression");
      const togglePoint = rectCenter(toggle);
      const beforeShellTouch = await readStatusJson<TouchStatus>(statusPath);
      assert(beforeShellTouch, "missing touch status before shell touch");
      if (shellBefore.shell.programs_menu_open) {
        await tapKey(base, KEY.escape);
      }
      await touchTap(base, togglePoint.x, togglePoint.y);
      const shellOpened = await waitFor(
        "wait for programs menu opened by touch",
        async () => {
          const snapshots = await getSnapshots(base);
          return snapshots.shell.programs_menu_open ? snapshots : null;
        },
      );
      const afterShellTouch = await readStatusJson<TouchStatus>(statusPath);
      assert(afterShellTouch, "missing touch status after shell touch");
      assert(
        afterShellTouch.down === beforeShellTouch.down &&
          afterShellTouch.motion === beforeShellTouch.motion &&
          afterShellTouch.up === beforeShellTouch.up,
        `shell touch leaked to native client: before=${JSON.stringify(beforeShellTouch)} after=${JSON.stringify(afterShellTouch)}`,
      );

      await touchDown(base, nativePoint.x, nativePoint.y, 1);
      await touchMove(base, togglePoint.x, togglePoint.y, 1);
      await touchUp(base, 1);
      const stableNative = await waitForStatusJson<TouchStatus>(
        statusPath,
        "wait for native touch route stability",
        (status) =>
          status.down >= delivered.down + 1 &&
          status.motion >= delivered.motion + 1 &&
          status.up >= delivered.up + 1,
      );

      await touchDown(base, togglePoint.x, togglePoint.y, 2);
      await touchMove(base, nativePoint.x, nativePoint.y, 2);
      await touchUp(base, 2);
      const afterShellToNative = await readStatusJson<TouchStatus>(statusPath);
      assert(afterShellToNative, "missing touch status after shell-to-native route probe");
      assert(
        afterShellToNative.down === stableNative.down &&
          afterShellToNative.motion === stableNative.motion &&
          afterShellToNative.up === stableNative.up,
        `shell-started touch retargeted to native client: before=${JSON.stringify(stableNative)} after=${JSON.stringify(afterShellToNative)}`,
      );

      const hiddenCursor = await waitFor(
        "wait for cursor hidden after touch idle",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return compositor.cursor_shape === "hidden" ? compositor : null;
        },
      );
      await movePoint(base, nativePoint.x + 2, nativePoint.y + 2);
      const restoredCursor = await waitFor(
        "wait for cursor restored by pointer motion",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return compositor.cursor_shape !== "hidden" ? compositor : null;
        },
      );

      await writeJsonArtifact("native-wl-touch-routing.json", {
        native: window,
        ready,
        delivered,
        beforeShellTouch,
        afterShellTouch,
        stableNative,
        afterShellToNative,
        hiddenCursorShape: hiddenCursor.cursor_shape,
        restoredCursorShape: restoredCursor.cursor_shape,
        shellOpened: shellOpened.shell.programs_menu_open,
        toggle,
      });
    } finally {
      await closeWindow(base, native.window.window_id);
      await waitForWindowGone(base, native.window.window_id, 5000);
    }
  });

  test("xdg-activation focuses a target only after a focused user interaction token", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const launcherTitle = `Derp Activation Policy Launcher ${stamp}`;
    const targetTitle = `Derp Activation Policy Target ${stamp}`;
    const targetCommand = buildNativeSpawnCommand({
      title: targetTitle,
      appId: "derp.e2e.protocol.activation.target",
      token: `activation-policy-target-${stamp}`,
      strip: "orange",
    });
    const launcher = await spawnNativeWindow(base, state.knownWindowIds, {
      title: launcherTitle,
      appId: "derp.e2e.protocol.activation.launcher",
      token: `activation-policy-launcher-${stamp}`,
      strip: "cyan",
      spawnOnPressCommand: targetCommand,
      activationAppId: "derp.e2e.protocol.activation.target",
    });
    const launcherId = launcher.window.window_id;
    state.spawnedNativeWindowIds.add(launcherId);
    let targetId: number | null = null;
    try {
      await waitForNativeFocus(base, launcherId);
      await tapKey(base, KEY.enter);
      const target = await waitForSpawnedWindow(base, state.knownWindowIds, {
        title: targetTitle,
        appId: "derp.e2e.protocol.activation.target",
        command: targetCommand,
      });
      targetId = target.window.window_id;
      state.spawnedNativeWindowIds.add(targetId);
      const focused = await waitForNativeFocus(base, targetId);
      assert(
        focused.compositor.focused_window_id === targetId,
        `expected activation focus on ${targetId}`,
      );
      await writeJsonArtifact(
        "wayland-protocols-xdg-activation-focus-policy.json",
        {
          launcher,
          target,
          focused: focused.compositor,
        },
      );
    } finally {
      if (targetId !== null) {
        await closeWindow(base, targetId);
        await waitForWindowGone(base, targetId, 5000);
      }
      await closeWindow(base, launcherId);
      await waitForWindowGone(base, launcherId, 5000);
    }
  });

  test("layer-shell exclusive zone reserves compositor work areas", async ({
    base,
    state,
  }) => {
    const zone = 64;
    const stamp = Date.now();
    const panelToken = `layer-exclusive-panel-${stamp}`;
    await spawnCommand(
      base,
      `${shellQuote(nativeBin())} --layer-panel --exclusive-zone ${zone} --token ${shellQuote(panelToken)}`,
    );
    try {
      const panelOutput = await waitFor(
        "wait for layer panel exclusive zone",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return (
            compositor.outputs.find(
              (output) =>
                output.usable_y != null &&
                output.usable_height != null &&
                output.usable_y >= output.y + zone &&
                output.usable_height <= output.height - zone,
            ) ?? null
          );
        },
        5000,
        100,
      );
      const native = await spawnNativeWindow(base, state.knownWindowIds, {
        title: `Derp Layer Exclusive Native ${stamp}`,
        token: `layer-exclusive-native-${stamp}`,
        strip: "red",
      });
      state.spawnedNativeWindowIds.add(native.window.window_id);
      await moveWindowToOutput(base, native.window.window_id, panelOutput);
      await derpctl([
        "window",
        "maximize",
        String(native.window.window_id),
        "--enabled",
        "true",
      ]);
      const nativeMaximized = await waitFor(
        "wait for native maximize to avoid layer panel",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === native.window.window_id,
          );
          const output = compositor.outputs.find(
            (entry) => entry.name === window?.output_name,
          );
          return window?.maximized && output && window.y >= output.y + zone
            ? { compositor, window, output }
            : null;
        },
        5000,
        100,
      );
      assertAvoidsTopReserve(
        "native maximized",
        nativeMaximized.output,
        nativeMaximized.window,
        zone,
      );
      await derpctl([
        "window",
        "maximize",
        String(native.window.window_id),
        "--enabled",
        "false",
      ]);
      await derpctl(["window", "focus", String(native.window.window_id)]);
      await runKeybind(base, "tile_left");
      const nativeTiled = await waitFor(
        "wait for native tile to avoid layer panel",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === native.window.window_id,
          );
          const output = compositor.outputs.find(
            (entry) => entry.name === window?.output_name,
          );
          return window &&
            output &&
            !window.maximized &&
            window.y >= output.y + zone
            ? { compositor, window, output }
            : null;
        },
        5000,
        100,
      );
      assertAvoidsTopReserve(
        "native tiled",
        nativeTiled.output,
        nativeTiled.window,
        zone,
      );

      const shellHosted = await openShellTestWindow(base, state);
      await moveWindowToOutput(base, shellHosted.window.window_id, panelOutput);
      await derpctl([
        "window",
        "maximize",
        String(shellHosted.window.window_id),
        "--enabled",
        "true",
      ]);
      const shellMaximized = await waitFor(
        "wait for shell-hosted maximize to avoid layer panel",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === shellHosted.window.window_id,
          );
          const output = compositor.outputs.find(
            (entry) => entry.name === window?.output_name,
          );
          return window?.maximized && output && window.y >= output.y + zone
            ? { compositor, window, output }
            : null;
        },
        5000,
        100,
      );
      assertAvoidsTopReserve(
        "shell-hosted maximized",
        shellMaximized.output,
        shellMaximized.window,
        zone,
      );
      await derpctl([
        "window",
        "maximize",
        String(shellHosted.window.window_id),
        "--enabled",
        "false",
      ]);
      await derpctl(["window", "focus", String(shellHosted.window.window_id)]);
      await runKeybind(base, "tile_right");
      const shellTiled = await waitFor(
        "wait for shell-hosted tile to avoid layer panel",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === shellHosted.window.window_id,
          );
          const output = compositor.outputs.find(
            (entry) => entry.name === window?.output_name,
          );
          return window &&
            output &&
            !window.maximized &&
            window.y >= output.y + zone
            ? { compositor, window, output }
            : null;
        },
        5000,
        100,
      );
      assertAvoidsTopReserve(
        "shell-hosted tiled",
        shellTiled.output,
        shellTiled.window,
        zone,
      );
      await writeJsonArtifact("layer-shell-exclusive-zone-work-area.json", {
        zone,
        nativeMaximized: nativeMaximized.window,
        nativeTiled: nativeTiled.window,
        shellMaximized: shellMaximized.window,
        shellTiled: shellTiled.window,
      });
    } finally {
      await spawnCommand(base, `pkill -f ${shellQuote(panelToken)} || true`);
    }
  });

  test("layer-shell overlay can host an OSK-style bottom touch panel without stealing native focus", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const height = 220;
    const panelToken = `layer-osk-panel-${stamp}`;
    const statusPath = path.join(artifactDir(), `layer-osk-status-${stamp}.json`);
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Layer OSK Focus ${stamp}`,
      appId: "derp.e2e.layer.osk.focus",
      token: `layer-osk-focus-${stamp}`,
      strip: "green",
      width: 460,
      height: 300,
    });
    state.spawnedNativeWindowIds.add(native.window.window_id);
    await waitForNativeFocus(base, native.window.window_id);
    await spawnCommand(
      base,
      [
        shellQuote(nativeBin()),
        "--layer-panel",
        "--layer-panel-osk",
        "--height",
        String(height),
        "--token",
        shellQuote(panelToken),
        "--layer-panel-status-json",
        shellQuote(statusPath),
      ].join(" "),
    );
    try {
      const ready = await waitForStatusJson<LayerPanelStatus>(
        statusPath,
        "wait for layer OSK panel configure",
        (status) => status.configured && status.height === height && status.width > 0,
      );
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const output =
        compositor.outputs.find((entry) => entry.width === ready.width) ??
        compositor.outputs[0];
      assert(output, "missing output for layer OSK panel");
      const panelRect = {
        x: output.x,
        y: output.y + output.height - ready.height,
        width: output.width,
        height: ready.height,
      };
      const rendered = await waitFor(
        "wait for layer OSK panel pixels",
        async () => {
          const pixels = await layerPanelCyanPixels(base, panelRect);
          return pixels.cyan > pixels.total * 0.02 ? pixels : null;
        },
        5000,
        100,
      );
      const hitPoint = {
        x: panelRect.x + Math.floor(panelRect.width / 2),
        y: panelRect.y + Math.floor(panelRect.height / 2),
      };
      await movePoint(base, hitPoint.x, hitPoint.y);
      await pointerButton(base, BTN_LEFT, "press");
      await pointerButton(base, BTN_LEFT, "release");
      const pointerDelivered = await waitForStatusJson<LayerPanelStatus>(
        statusPath,
        "wait for layer OSK pointer delivery",
        (status) =>
          status.pointer_enter >= ready.pointer_enter + 1 &&
          status.pointer_press >= ready.pointer_press + 1,
      );
      await waitForNativeFocus(base, native.window.window_id);

      await touchDown(base, hitPoint.x, hitPoint.y);
      await touchMove(base, hitPoint.x + 18, hitPoint.y - 12);
      await touchUp(base);
      const touchDelivered = await waitForStatusJson<LayerPanelStatus>(
        statusPath,
        "wait for layer OSK touch delivery",
        (status) =>
          status.touch_down >= pointerDelivered.touch_down + 1 &&
          status.touch_motion >= pointerDelivered.touch_motion + 1 &&
          status.touch_up >= pointerDelivered.touch_up + 1,
      );
      const focusAfterTouch = await waitForNativeFocus(
        base,
        native.window.window_id,
      );
      const taskbarRow = focusAfterTouch.shell.taskbar_windows.find(
        (entry) => entry.window_id === native.window.window_id,
      );
      assert(
        Boolean(taskbarRow?.activate),
        `native taskbar focus not preserved: ${JSON.stringify(taskbarRow)}`,
      );
      await writeJsonArtifact("layer-shell-osk-overlay-input.json", {
        panelRect,
        rendered,
        pointerDelivered,
        touchDelivered,
        focusedWindowId: focusAfterTouch.compositor.focused_window_id,
      });
    } finally {
      await spawnCommand(base, `pkill -f ${shellQuote(panelToken)} || true`);
    }
  });

  test("linux-drm-syncobj-v1 protocol errors are enforced", async ({
    base,
  }) => {
    const modes = [
      "no-buffer",
      "no-acquire",
      "no-release",
      "unsupported-buffer",
      "conflicting-points",
    ];
    const results: Record<string, string> = {};
    for (const mode of modes) {
      const command = `${shellQuote(nativeBin())} --explicit-sync-error ${shellQuote(mode)}`;
      const result = await postJson<TestRunCommandResult>(
        base,
        "/test/run_command",
        { command },
      );
      const output = `${result.stdout}${result.stderr}\nexit:${result.status ?? "signal"}\n`;
      await writeFile(
        path.join(artifactDir(), `drm-syncobj-error-${mode}-${Date.now()}.txt`),
        output,
      );
      results[mode] = output;
      assert(
        !output.includes("\nexit:0\n"),
        `${mode} unexpectedly succeeded:\n${output}`,
      );
      assert(
        output.includes("wp_linux_drm_syncobj_surface_v1") ||
          output.includes("wp_linux_drm_syncobj_manager_v1") ||
          output.includes("Protocol error"),
        `${mode} did not report an explicit sync protocol error:\n${output}`,
      );
    }
    await writeJsonArtifact("drm-syncobj-protocol-errors.json", results);
  });

  test("linux-drm-syncobj-v1 waits on dma-buf acquire and signals release", async ({
    base,
    state,
  }) => {
    const title = `Derp Explicit Sync Dmabuf ${Date.now()}`;
    const statusPath = path.join(
      artifactDir(),
      `drm-syncobj-dmabuf-status-${Date.now()}.json`,
    );
    const socketPath = path.join(
      artifactDir(),
      `drm-syncobj-dmabuf-control-${Date.now()}.sock`,
    );
    const command = [
      shellQuote(nativeBin()),
      "--explicit-sync-dmabuf",
      "--title",
      shellQuote(title),
      "--token",
      "explicit-sync-dmabuf",
      "--width",
      "360",
      "--height",
      "240",
      "--status-json",
      shellQuote(statusPath),
      "--control-socket",
      shellQuote(socketPath),
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, command);
      const pending = await waitFor(
        "wait for explicit sync dma-buf pending frame",
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, "/test/state/compositor"),
          ]);
          const window = compositor.windows.find(
            (entry) =>
              !entry.shell_hosted &&
              !state.knownWindowIds.has(entry.window_id) &&
              entry.title.includes(title) &&
              entry.lifecycle === "mapped" &&
              entry.width > 0 &&
              entry.height > 0,
          );
          if (!status?.frame_b_committed || !window) return null;
          return { status, compositor, window };
        },
        5000,
        100,
      );
      windowId = pending.window.window_id;
      state.knownWindowIds.add(windowId);
      const red = await waitFor(
        "wait for acquire-blocked dma-buf to keep frame A visible",
        async () => {
          const color = await dominantInteriorColor(base, pending.window);
          return color.red > color.total * 0.7 &&
            color.green < color.total * 0.1
            ? color
            : null;
        },
        5000,
        100,
      );
      const beforeSignal =
        await readStatusJson<ExplicitSyncDmabufStatus>(statusPath);
      assert(
        beforeSignal?.release_b_observed === false,
        "frame B release must not signal before acquire is signaled",
      );
      await signalExplicitSyncControl(socketPath);
      const released = await waitFor(
        "wait for explicit sync dma-buf frame B release",
        async () => {
          const status =
            await readStatusJson<ExplicitSyncDmabufStatus>(statusPath);
          if (!status?.acquire_b_signaled || !status.release_b_observed)
            return null;
          return status;
        },
        5000,
        100,
      );
      const green = await waitFor(
        "wait for acquired dma-buf frame B to become visible",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === windowId,
          );
          if (!window) return null;
          const color = await dominantInteriorColor(base, window);
          return color.green > color.total * 0.7 &&
            color.red < color.total * 0.1
            ? { color, compositor, window }
            : null;
        },
        5000,
        100,
      );
      await writeJsonArtifact("drm-syncobj-dmabuf-acquire-release.json", {
        command,
        statusPath,
        socketPath,
        pending: pending.status,
        released,
        explicitSync: green.compositor.explicit_sync,
        redScreenshot: await copyArtifactFile(
          "drm-syncobj-dmabuf-frame-a.png",
          red.path,
        ),
        greenScreenshot: await copyArtifactFile(
          "drm-syncobj-dmabuf-frame-b.png",
          green.color.path,
        ),
      });
    } finally {
      if (windowId !== null) {
        const beforeClose = await getSnapshots(base);
        const window = compositorWindowById(beforeClose.compositor, windowId);
        const outside = beforeClose.shell.controls?.taskbar_programs_toggle;
        const point = outside
          ? {
              x: outside.global_x + Math.floor(outside.width / 2),
              y: outside.global_y + Math.floor(outside.height / 2),
            }
          : {
              x: Math.max(0, (window?.x ?? 24) - 24),
              y: Math.max(0, (window?.y ?? 24) - 24),
            };
        await movePoint(base, point.x, point.y);
        await waitFor(
          "wait for cursor shape pointer outside closing client",
          async () => {
            const compositor = await getJson<CompositorSnapshot>(
              base,
              "/test/state/compositor",
            );
            return Math.round(compositor.pointer?.x ?? -1) === point.x &&
              Math.round(compositor.pointer?.y ?? -1) === point.y
              ? compositor
              : null;
          },
          3000,
          100,
        );
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
    }
  });

  test("linux-drm-syncobj-v1 survives rapid same-buffer dma-buf churn", async ({
    base,
    state,
  }) => {
    const title = `Derp Explicit Sync Stress ${Date.now()}`;
    const statusPath = path.join(
      artifactDir(),
      `drm-syncobj-stress-status-${Date.now()}.json`,
    );
    const stressFrames = 96;
    const command = [
      shellQuote(nativeBin()),
      "--explicit-sync-dmabuf",
      "--explicit-sync-dmabuf-stress-frames",
      String(stressFrames),
      "--title",
      shellQuote(title),
      "--token",
      "explicit-sync-stress",
      "--width",
      "640",
      "--height",
      "360",
      "--status-json",
      shellQuote(statusPath),
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, command);
      const settled = await waitFor(
        "wait for explicit sync dma-buf stress releases",
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, "/test/state/compositor"),
          ]);
          const window = compositor.windows.find(
            (entry) =>
              !entry.shell_hosted &&
              !state.knownWindowIds.has(entry.window_id) &&
              entry.title.includes(title) &&
              entry.lifecycle === "mapped" &&
              entry.width > 0 &&
              entry.height > 0,
          );
          if (!status || !window) return null;
          if (status.stress_committed !== stressFrames) return null;
          if (status.stress_release_failed) return null;
          if (status.stress_release_observed !== stressFrames) return null;
          if ((compositor.explicit_sync?.pending_releases ?? 0) > 1)
            return null;
          return { status, compositor, window };
        },
        10000,
        100,
      );
      windowId = settled.window.window_id;
      state.knownWindowIds.add(windowId);
      const color = await dominantInteriorColor(base, settled.window);
      assert(color.total > 0, "stress screenshot should have pixels");
      await writeJsonArtifact("drm-syncobj-dmabuf-stress.json", {
        command,
        statusPath,
        stressFrames,
        status: settled.status,
        explicitSync: settled.compositor.explicit_sync,
        screenshot: await copyArtifactFile(
          "drm-syncobj-dmabuf-stress.png",
          color.path,
        ),
        color,
      });
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
    }
  });

  test("linux-drm-syncobj-v1 waits for multi-output same-buffer dma-buf churn", async ({
    base,
    state,
  }) => {
    const initial = await getJson<CompositorSnapshot>(
      base,
      "/test/state/compositor",
    );
    const outputs = [...initial.outputs].sort(
      (a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name),
    );
    if (outputs.length < 2) {
      throw new SkipError("requires at least two outputs");
    }
    const [left, right] = outputs;
    assert(left && right, "missing adjacent outputs");
    const title = `Derp Explicit Sync Multiout ${Date.now()}`;
    const statusPath = path.join(
      artifactDir(),
      `drm-syncobj-multiout-status-${Date.now()}.json`,
    );
    const socketPath = path.join(
      artifactDir(),
      `drm-syncobj-multiout-control-${Date.now()}.sock`,
    );
    const stressFrames = 96;
    const width = Math.min(
      left.width + Math.floor(right.width / 2),
      left.width + 720,
    );
    const height = Math.min(
      420,
      Math.max(240, Math.floor(Math.min(left.height, right.height) / 2)),
    );
    const target = {
      x: right.x - Math.floor(width / 2),
      y: Math.max(
        0,
        Math.min(left.y, right.y) +
          Math.floor((Math.min(left.height, right.height) - height) / 2),
      ),
      width,
      height,
    };
    const command = [
      shellQuote(nativeBin()),
      "--explicit-sync-dmabuf",
      "--explicit-sync-dmabuf-stress-frames",
      String(stressFrames),
      "--explicit-sync-dmabuf-wait-control",
      "--title",
      shellQuote(title),
      "--token",
      "explicit-sync-multiout",
      "--width",
      String(width),
      "--height",
      String(height),
      "--status-json",
      shellQuote(statusPath),
      "--control-socket",
      shellQuote(socketPath),
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, command);
      const ready = await waitFor(
        "wait for multi-output explicit sync dma-buf window",
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, "/test/state/compositor"),
          ]);
          const window = compositor.windows.find(
            (entry) =>
              !entry.shell_hosted &&
              !state.knownWindowIds.has(entry.window_id) &&
              entry.title.includes(title),
          );
          if (!status?.configured || !status.frame_a_committed || !window)
            return null;
          return { status, compositor, window };
        },
        5000,
        100,
      );
      windowId = ready.window.window_id;
      state.knownWindowIds.add(windowId);
      await derpctl([
        "window",
        "move",
        String(windowId),
        "--x",
        String(target.x),
        "--y",
        String(target.y),
        "--width",
        String(target.width),
        "--height",
        String(target.height),
      ]);
      await syncTest(base);
      const placed = await waitFor(
        "wait for explicit sync dma-buf window to span outputs",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === windowId,
          );
          if (!window) return null;
          const overlaps = overlappedOutputs(compositor, window);
          return overlaps.length >= 2 ? { compositor, window, overlaps } : null;
        },
        5000,
        100,
      );
      await signalExplicitSyncControl(socketPath);
      const settled = await waitFor(
        "wait for multi-output explicit sync dma-buf stress releases",
        async () => {
          const [status, compositor] = await Promise.all([
            readStatusJson<ExplicitSyncDmabufStatus>(statusPath),
            getJson<CompositorSnapshot>(base, "/test/state/compositor"),
          ]);
          const window = compositor.windows.find(
            (entry) => entry.window_id === windowId,
          );
          if (!status || !window) return null;
          if (status.stress_committed !== stressFrames) return null;
          if (status.stress_release_failed) return null;
          if (status.stress_release_observed !== stressFrames) return null;
          const overlaps = overlappedOutputs(compositor, window);
          if (overlaps.length < 2) return null;
          if ((compositor.explicit_sync?.pending_releases ?? 0) > 1)
            return null;
          return { status, compositor, window, overlaps };
        },
        10000,
        100,
      );
      const color = await dominantInteriorColor(base, settled.window);
      assert(
        color.total > 0,
        "multi-output stress screenshot should have pixels",
      );
      await writeJsonArtifact("drm-syncobj-dmabuf-multiout-stress.json", {
        command,
        statusPath,
        socketPath,
        stressFrames,
        requested: { width, height, target },
        ready: ready.status,
        placed: {
          window: placed.window,
          overlaps: placed.overlaps.map((output) => ({
            name: output.name,
            area: outputOverlapArea(placed.window, output),
          })),
        },
        window: settled.window,
        overlaps: settled.overlaps.map((output) => ({
          name: output.name,
          area: outputOverlapArea(settled.window, output),
        })),
        status: settled.status,
        explicitSync: settled.compositor.explicit_sync,
        screenshot: await copyArtifactFile(
          "drm-syncobj-dmabuf-multiout-stress.png",
          color.path,
        ),
        color,
      });
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
    }
  });

  test("ext-image-copy-capture output frames report first, requested, and subsequent damage", async ({
    base,
  }) => {
    const statusPath = path.join(
      artifactDir(),
      `ext-image-copy-capture-output-${Date.now()}.json`,
    );
    const command = [
      shellQuote(nativeBin()),
      "--ext-image-copy-capture-output",
      "--ext-image-copy-capture-frames",
      "3",
      "--status-json",
      shellQuote(statusPath),
    ].join(" ");
    const result = await postJson<TestRunCommandResult>(
      base,
      "/test/run_command",
      { command },
    );
    await writeFile(
      path.join(
        artifactDir(),
        `ext-image-copy-capture-output-command-${Date.now()}.txt`,
      ),
      `${result.stdout}${result.stderr}\nexit:${result.status ?? "signal"}\n`,
    );
    assert(
      result.status === 0,
      `ext-image-copy-capture client failed:\n${result.stdout}${result.stderr}`,
    );
    const captured = await readStatusJson<ExtImageCopyStatus>(statusPath);
    assert(
      captured,
      `missing ext-image-copy-capture status at ${statusPath}`,
    );
    assert(
      captured.buffer_width > 0 && captured.buffer_height > 0,
      `invalid buffer size ${JSON.stringify(captured)}`,
    );
    assert(!captured.stopped, "capture session stopped unexpectedly");
    const [first, requestedFull, subsequent] = captured.frames;
    assert(
      first && requestedFull && subsequent,
      `missing captured frames: ${JSON.stringify(captured.frames)}`,
    );
    assertFullDamage(first, captured, "first capture");
    assertFullDamage(requestedFull, captured, "requested full-damage capture");
    assertBoundedDamage(subsequent, captured, "subsequent capture");
    assert(
      captured.frames.every((frame) => frame.checksum !== 0),
      `expected captured buffers to have checksums: ${JSON.stringify(captured.frames)}`,
    );
    await writeJsonArtifact("ext-image-copy-capture-output-damage.json", {
      command,
      statusPath,
      captured,
    });
  });

  test("native presentation content type and tearing hints are committed", async ({
    base,
    state,
  }) => {
    const title = `Derp Wayland Protocol Probe ${Date.now()}`;
    const command = [
      shellQuote(nativeBin()),
      "--title",
      shellQuote(title),
      "--token",
      "wayland-protocols",
      "--width",
      "420",
      "--height",
      "260",
      "--presentation-smoke",
      "--content-type",
      "game",
      "--tearing-hint",
      "async",
      "--burst-frames",
      "180",
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, command);
      const spawned = await waitFor(
        "wait for protocol probe window state",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) =>
              !entry.shell_hosted &&
              !state.knownWindowIds.has(entry.window_id) &&
              entry.title.includes(title),
          );
          if (!window) return null;
          if (window.content_type !== "game") return null;
          if (window.tearing_hint !== "async") return null;
          if (!window.title.includes("presented=")) return null;
          return { compositor, window };
        },
        5000,
        100,
      );
      windowId = spawned.window.window_id;
      state.knownWindowIds.add(windowId);
      await runKeybind(base, "toggle_fullscreen", windowId);
      const flip = await waitFor(
        "wait for async flip diagnostic",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) => entry.window_id === windowId,
          );
          if (!window?.fullscreen) return null;
          const output = compositor.outputs.find(
            (entry) => entry.name === window.output_name,
          );
          if (!output) return null;
          if (output.last_flip_mode === "async")
            return { compositor, window, output };
          if (output.last_flip_fallback_reason)
            return { compositor, window, output };
          return null;
        },
        5000,
        100,
      );
      await writeJsonArtifact(
        "wayland-protocols-presentation-content-tearing.json",
        {
          command,
          window: flip.window,
          output: flip.output,
        },
      );
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
    }
  });

  test("native xdg toplevel icon metadata reaches shell snapshots", async ({
    base,
    state,
  }) => {
    const stamp = Date.now();
    const iconName = `derp-e2e-icon-${stamp}`;
    const named = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Xdg Icon Name ${stamp}`,
      appId: "derp.e2e.icon.name",
      token: `xdg-icon-name-${stamp}`,
      strip: "green",
      xdgIconName: iconName,
    });
    state.spawnedNativeWindowIds.add(named.window.window_id);
    const namedSnapshot = await waitFor(
      "wait for named xdg icon snapshot",
      async () => {
        const snapshots = await getSnapshots(base);
        const compositorWindow = compositorWindowById(
          snapshots.compositor,
          named.window.window_id,
        );
        const shellWindow = shellWindowById(
          snapshots.shell,
          named.window.window_id,
        );
        if (compositorWindow?.icon_name !== iconName) return null;
        if (shellWindow?.icon_name !== iconName) return null;
        return { snapshots, compositorWindow, shellWindow };
      },
      5000,
      100,
    );
    assert(
      namedSnapshot.compositorWindow.title === named.window.title,
      "icon name changed compositor title metadata",
    );
    assert(
      namedSnapshot.shellWindow.title === named.window.title,
      "icon name changed shell title metadata",
    );
    assert(
      namedSnapshot.compositorWindow.app_id === "derp.e2e.icon.name",
      "icon name changed compositor app_id metadata",
    );
    assert(
      namedSnapshot.shellWindow.app_id === "derp.e2e.icon.name",
      "icon name changed shell app_id metadata",
    );

    const buffered = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp Xdg Icon Buffer ${stamp}`,
      appId: "derp.e2e.icon.buffer",
      token: `xdg-icon-buffer-${stamp}`,
      strip: "red",
      xdgIconShm: true,
    });
    state.spawnedNativeWindowIds.add(buffered.window.window_id);
    const bufferedSnapshot = await waitFor(
      "wait for shm xdg icon snapshot",
      async () => {
        const snapshots = await getSnapshots(base);
        const compositorWindow = compositorWindowById(
          snapshots.compositor,
          buffered.window.window_id,
        );
        const shellWindow = shellWindowById(
          snapshots.shell,
          buffered.window.window_id,
        );
        const compositorBuffer = compositorWindow?.icon_buffers?.[0];
        const shellBuffer = shellWindow?.icon_buffers?.[0];
        if (
          !compositorBuffer ||
          compositorBuffer.width !== 16 ||
          compositorBuffer.height !== 16 ||
          compositorBuffer.scale !== 1
        )
          return null;
        if (
          !shellBuffer ||
          shellBuffer.width !== 16 ||
          shellBuffer.height !== 16 ||
          shellBuffer.scale !== 1
        )
          return null;
        return { snapshots, compositorWindow, shellWindow };
      },
      5000,
      100,
    );
    assert(
      bufferedSnapshot.compositorWindow.title === buffered.window.title,
      "shm icon changed compositor title metadata",
    );
    assert(
      bufferedSnapshot.shellWindow.title === buffered.window.title,
      "shm icon changed shell title metadata",
    );
    assert(
      bufferedSnapshot.compositorWindow.app_id === "derp.e2e.icon.buffer",
      "shm icon changed compositor app_id metadata",
    );
    assert(
      bufferedSnapshot.shellWindow.app_id === "derp.e2e.icon.buffer",
      "shm icon changed shell app_id metadata",
    );
    await writeJsonArtifact("wayland-protocols-xdg-toplevel-icon.json", {
      named: {
        compositor: namedSnapshot.compositorWindow,
        shell: namedSnapshot.shellWindow,
      },
      buffered: {
        compositor: bufferedSnapshot.compositorWindow,
        shell: bufferedSnapshot.shellWindow,
      },
    });
  });

  test("native cursor-shape pointer uses selected XCursor theme", async ({
    base,
    state,
  }) => {
    const beforeSettings = await getJson<{ theme: string; size: number }>(
      base,
      "/settings_cursor",
    );
    const nextSettings = {
      theme: beforeSettings.theme || "default",
      size: Math.max(24, Math.min(48, beforeSettings.size || 24)),
    };
    await postJson(base, "/settings_cursor", nextSettings);
    const title = `Derp Cursor Shape Probe ${Date.now()}`;
    const statusPath = artifactPath(`cursor-shape-status-${Date.now()}.json`);
    const command = [
      shellQuote(nativeBin()),
      "--title",
      shellQuote(title),
      "--token",
      "cursor-shape-pointer",
      "--width",
      "360",
      "--height",
      "240",
      "--cursor-shape-pointer",
      "--cursor-shape-status-json",
      shellQuote(statusPath),
    ].join(" ");
    let windowId: number | null = null;
    try {
      await spawnCommand(base, command);
      const spawned = await waitFor(
        "wait for cursor shape probe",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = compositor.windows.find(
            (entry) =>
              !entry.shell_hosted &&
              !state.knownWindowIds.has(entry.window_id) &&
              entry.title.includes(title) &&
              entry.lifecycle === "mapped" &&
              entry.width > 0 &&
              entry.height > 0,
          );
          return window ? { compositor, window } : null;
        },
        5000,
        100,
      );
      windowId = spawned.window.window_id;
      state.knownWindowIds.add(spawned.window.window_id);
      const cursorReadyCompositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const cursorWindow =
        compositorWindowById(cursorReadyCompositor, spawned.window.window_id) ??
        spawned.window;
      await waitForStatusJson<Record<string, number>>(
        statusPath,
        "wait for cursor shape client ready",
        (status) => status.device_ready >= 1,
        5000,
      );
      const shellBeforeEnter = await getJson<ShellSnapshot>(
        base,
        "/test/state/shell",
      );
      const outside = shellBeforeEnter.controls?.taskbar_programs_toggle;
      const enterPoint = {
        x: cursorWindow.x + Math.floor(cursorWindow.width / 2),
        y: cursorWindow.y + Math.floor(cursorWindow.height / 2),
      };
      await writeJsonArtifact("cursor-shape-pointer-before-enter.json", {
        windowId: spawned.window.window_id,
        cursorWindow,
        outside,
        enterPoint,
        statusPath,
      });
      if (outside) {
        await movePoint(
          base,
          outside.global_x + Math.floor(outside.width / 2),
          outside.global_y + Math.floor(outside.height / 2),
        );
      } else {
        await movePoint(
          base,
          Math.max(0, cursorWindow.x - 24),
          Math.max(0, cursorWindow.y - 24),
        );
      }
      await movePoint(base, enterPoint.x, enterPoint.y);
      const cursorStatus = await waitForStatusJson<Record<string, number>>(
        statusPath,
        "wait for cursor shape client enter",
        (status) =>
          status.pointer_enter >= 1 && status.shape_set >= 1,
        5000,
      );
      await waitForNativeFocus(base, spawned.window.window_id);
      const shaped = await waitFor(
        "wait for pointer cursor shape",
        async () => {
          const compositor = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          return compositor.cursor_shape === "pointer" && compositor.cursor_name
            ? compositor
            : null;
        },
        3000,
        100,
      );
      await writeJsonArtifact("cursor-shape-pointer.json", {
        windowId: spawned.window.window_id,
        settings: nextSettings,
        statusPath,
        cursorStatus,
        cursorTheme: shaped.cursor_theme,
        cursorSize: shaped.cursor_size,
        cursorShape: shaped.cursor_shape,
        cursorName: shaped.cursor_name,
        cursorSourcePath: shaped.cursor_source_path,
      });
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId);
        await waitForWindowGone(base, windowId, 5000);
      }
      await postJson(base, "/settings_cursor", beforeSettings);
    }
  });
});
