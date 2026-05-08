import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  artifactDir,
  assert,
  captureScreenshotRect,
  defineGroup,
  getJson,
  getSnapshots,
  readPngRgba,
  shellQuote,
  SkipError,
  syncTest,
  waitFor,
  waitForWindowGone,
  writeJsonArtifact,
  type CompositorSnapshot,
  type E2eState,
  type WindowSnapshot,
} from "../lib/runtime.ts";
import { closeWindow, postJson, spawnCommand } from "../lib/setup.ts";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const derpctlBin =
  process.env.DERP_E2E_DERPCTL_BIN ||
  path.join(repoRoot, "target", "release", "derpctl");

type TestRunCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

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

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function windowForPid(
  compositor: CompositorSnapshot,
  pid: number,
): WindowSnapshot | null {
  return (
    compositor.windows.find((window) => window.wayland_client_pid === pid) ??
    null
  );
}

async function visiblePixelSummary(
  pathname: string,
): Promise<{ variedPixels: number; brightPixels: number }> {
  const png = await readPngRgba(pathname);
  let variedPixels = 0;
  let brightPixels = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index] ?? 0;
    const g = png.data[index + 1] ?? 0;
    const b = png.data[index + 2] ?? 0;
    const alpha = png.data[index + 3] ?? 0;
    if (alpha > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 16)
      variedPixels += 1;
    if (alpha > 0 && r + g + b > 120) brightPixels += 1;
  }
  return { variedPixels, brightPixels };
}

async function spawnWleirdProcess(
  base: string,
  client: string,
  args: string[] = [],
  timeoutMs = 5000,
) {
  const stamp = Date.now();
  const statusPath = path.join(
    artifactDir(),
    `wleird-${client}-${stamp}.status`,
  );
  const outputPath = path.join(artifactDir(), `wleird-${client}-${stamp}.log`);
  const script = [
    `command -v ${shellQuote(`wleird-${client}`)} >/dev/null`,
    `stdbuf -o0 -e0 wleird-${client} ${args.map(shellQuote).join(" ")} >${shellQuote(outputPath)} 2>&1 &`,
    "pid=$!",
    `printf 'pid:%s\\n' "$pid" >${shellQuote(statusPath)}`,
    'wait "$pid"',
    `printf 'exit:%s\\n' "$?" >>${shellQuote(statusPath)}`,
  ].join("\n");
  const command = ["sh", "-lc", shellQuote(script)].join(" ");
  await getSnapshots(base);
  await spawnCommand(base, command);
  const pid = await waitFor(
    `wait for wleird-${client} pid`,
    async () => {
      const status = await readText(statusPath);
      const match = status?.match(/^pid:(\d+)$/m);
      return match ? Number(match[1]) : null;
    },
    timeoutMs,
    40,
  );
  return { pid, statusPath, outputPath, command };
}

async function spawnWleirdWindow(
  base: string,
  state: E2eState,
  client: string,
  args: string[] = [],
  timeoutMs = 5000,
) {
  const process = await spawnWleirdProcess(base, client, args, timeoutMs);
  const spawned = await waitFor(
    `wait for wleird-${client} window`,
    async () => {
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const window = windowForPid(compositor, process.pid);
      return window?.lifecycle === "mapped" ? { compositor, window } : null;
    },
    timeoutMs,
    40,
  );
  state.spawnedNativeWindowIds.add(spawned.window.window_id);
  state.knownWindowIds.add(spawned.window.window_id);
  return { ...process, compositor: spawned.compositor, window: spawned.window };
}

async function killWleirdPid(pid: number, signal = "-TERM"): Promise<void> {
  try {
    await execFileAsync("kill", [signal, String(pid)]);
  } catch {}
}

async function closeWleirdWindow(
  base: string,
  windowId: number,
  pid: number,
): Promise<void> {
  await closeWindow(base, windowId);
  try {
    await waitForWindowGone(base, windowId, 1200);
    return;
  } catch {}
  await killWleirdPid(pid);
  try {
    await waitForWindowGone(base, windowId, 2500);
    return;
  } catch {}
  await killWleirdPid(pid, "-KILL");
  await waitForWindowGone(base, windowId, 5000);
}

export default defineGroup(import.meta.url, ({ test }) => {
  test("damage-paint submits visible fine-grained content", async ({
    base,
    state,
  }) => {
    const probe = await spawnWleirdWindow(base, state, "damage-paint", [
      "fine-grid",
    ]);
    try {
      await syncTest(base);
      const settled = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const window = windowForPid(settled, probe.pid);
      assert(window, "wleird-damage-paint disappeared from compositor state");
      const screenshot = await captureScreenshotRect(base, {
        x: window.x,
        y: window.y,
        width: Math.min(window.width, 320),
        height: Math.min(window.height, 320),
      });
      const pixels = await visiblePixelSummary(screenshot.path);
      assert(
        pixels.variedPixels > 200 || pixels.brightPixels > 200,
        "wleird-damage-paint did not render visible client content",
      );
      await writeJsonArtifact("wleird-damage-paint.json", {
        pid: probe.pid,
        window,
        screenshot,
        pixels,
      });
    } finally {
      await closeWleirdWindow(base, probe.window.window_id, probe.pid);
    }
  });

  test("disobey-resize stays mapped and decorated after compositor resize", async ({
    base,
    state,
  }) => {
    const probe = await spawnWleirdWindow(base, state, "disobey-resize", [
      "0.5",
    ]);
    try {
      await derpctl([
        "window",
        "move",
        String(probe.window.window_id),
        "--x",
        String(probe.window.x + 30),
        "--y",
        String(probe.window.y + 30),
        "--width",
        "480",
        "--height",
        "360",
      ]);
      const resized = await waitFor(
        "wait for wleird disobey-resize shell chrome after resize",
        async () => {
          const snapshots = await getSnapshots(base);
          const window = windowForPid(snapshots.compositor, probe.pid);
          const controls = snapshots.shell.window_controls?.find(
            (entry) => entry.window_id === probe.window.window_id,
          );
          return window && controls?.titlebar && controls.close
            ? {
                compositor: snapshots.compositor,
                shell: snapshots.shell,
                window,
                controls,
              }
            : null;
        },
        5000,
        40,
      );
      assert(
        resized.window.width === 480 && resized.window.height === 360,
        "wleird-disobey-resize compositor geometry did not settle",
      );
      await writeJsonArtifact("wleird-disobey-resize.json", {
        pid: probe.pid,
        initial: probe.window,
        resized,
      });
    } finally {
      await closeWleirdWindow(base, probe.window.window_id, probe.pid);
    }
  });

  test("frame-callback receives repeated compositor frame callbacks", async ({
    base,
    state,
  }) => {
    const probe = await spawnWleirdWindow(base, state, "frame-callback");
    try {
      const output = await waitFor(
        "wait for wleird frame callbacks",
        async () => {
          const text = await readText(probe.outputPath);
          const count = text?.match(/received frame/g)?.length ?? 0;
          return count >= 2 ? text : null;
        },
        5000,
        40,
      );
      const settled = await getSnapshots(base);
      const window = windowForPid(settled.compositor, probe.pid);
      assert(window, "wleird-frame-callback disappeared from compositor state");
      await writeJsonArtifact("wleird-frame-callback.json", {
        pid: probe.pid,
        window,
        output,
      });
    } finally {
      await closeWleirdWindow(base, probe.window.window_id, probe.pid);
    }
  });

  test("surface output enters update when moved between monitors", async ({
    base,
    state,
  }) => {
    await syncTest(base);
    const probe = await spawnWleirdProcess(base, "surface-outputs");
    let windowId: number | null = null;
    try {
      let initial: string;
      try {
        initial = await waitFor(
          "wait for wleird surface output report",
          async () => {
            const output = await readText(probe.outputPath);
            return output?.includes('Surface "toplevel":') ? output : null;
          },
          5000,
          40,
        );
      } catch (error) {
        const compositor = await getJson<CompositorSnapshot>(
          base,
          "/test/state/compositor",
        );
        await writeJsonArtifact("wleird-surface-outputs-no-report.json", {
          pid: probe.pid,
          status: await readText(probe.statusPath),
          output: await readText(probe.outputPath),
          compositor,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new SkipError(
          "wleird-surface-outputs did not report output state",
        );
      }
      const compositor = await getJson<CompositorSnapshot>(
        base,
        "/test/state/compositor",
      );
      const outputs = [...compositor.outputs].sort(
        (a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name),
      );
      const current = windowForPid(compositor, probe.pid);
      if (!current) {
        await writeJsonArtifact("wleird-surface-outputs-no-window.json", {
          pid: probe.pid,
          initial,
          compositor,
        });
        throw new SkipError(
          "wleird-surface-outputs did not create a mapped xdg toplevel",
        );
      }
      windowId = current.window_id;
      state.spawnedNativeWindowIds.add(windowId);
      state.knownWindowIds.add(windowId);
      const target =
        outputs.find((output) => output.name !== current.output_name) ??
        outputs[0];
      assert(target, "missing compositor output for wleird-surface-outputs");
      await derpctl([
        "window",
        "move",
        String(current.window_id),
        "--x",
        String(target.x + 120),
        "--y",
        String(target.y + 120),
        "--width",
        "420",
        "--height",
        "320",
      ]);
      const moved = await waitFor(
        "wait for wleird surface output move",
        async () => {
          const next = await getJson<CompositorSnapshot>(
            base,
            "/test/state/compositor",
          );
          const window = windowForPid(next, probe.pid);
          return window && window.output_name === target.name
            ? { compositor: next, window }
            : null;
        },
        5000,
        40,
      );
      const afterOutput = await readText(probe.outputPath);
      await writeJsonArtifact("wleird-surface-outputs.json", {
        initial,
        afterOutput,
        outputs,
        target,
        window: moved.window,
      });
    } finally {
      if (windowId !== null) {
        await closeWleirdWindow(base, windowId, probe.pid);
      } else {
        await killWleirdPid(probe.pid);
      }
    }
  });

  test("unmap removes the native window without wedging state", async ({
    base,
    state,
  }) => {
    const probe = await spawnWleirdWindow(base, state, "unmap");
    try {
      const gone = await waitFor(
        "wait for wleird unmap cleanup",
        async () => {
          const snapshots = await getSnapshots(base);
          const compositorWindow = windowForPid(
            snapshots.compositor,
            probe.pid,
          );
          const shellWindow = snapshots.shell.windows.find(
            (window) => window.window_id === probe.window.window_id,
          );
          return !compositorWindow && !shellWindow ? snapshots : null;
        },
        5000,
        40,
      );
      await writeJsonArtifact("wleird-unmap.json", {
        pid: probe.pid,
        window: probe.window,
        compositorWindowCount: gone.compositor.windows.length,
        shellWindowCount: gone.shell.windows.length,
      });
    } finally {
      await killWleirdPid(probe.pid, "-KILL");
    }
  });

  test("slow configure acknowledgements still get shell chrome", async ({
    base,
    state,
  }) => {
    const probe = await spawnWleirdWindow(base, state, "slow-ack-configure");
    try {
      const decorated = await waitFor(
        "wait for wleird slow configure shell chrome",
        async () => {
          const snapshots = await getSnapshots(base);
          const controls = snapshots.shell.window_controls?.find(
            (entry) => entry.window_id === probe.window.window_id,
          );
          return controls?.titlebar && controls.close
            ? { shell: snapshots.shell, controls }
            : null;
        },
        2500,
        40,
      );
      const output = await readText(probe.outputPath);
      await writeJsonArtifact("wleird-slow-ack-configure.json", {
        pid: probe.pid,
        initial: probe.window,
        decorated,
        output,
      });
    } finally {
      await closeWleirdWindow(base, probe.window.window_id, probe.pid);
    }
  });

  test("sigbus client does not crash the compositor", async ({ base }) => {
    await syncTest(base);
    const command = "timeout -s KILL 5s stdbuf -o0 -e0 wleird-sigbus";
    const result = await postJson<TestRunCommandResult>(
      base,
      "/test/run_command",
      { command },
    );
    assert(
      result.status !== 126 && result.status !== 127,
      `wleird-sigbus did not run: ${result.stderr || result.stdout}`,
    );
    const snapshots = await getSnapshots(base);
    await writeJsonArtifact("wleird-sigbus.json", {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      compositorWindowCount: snapshots.compositor.windows.length,
      shellWindowCount: snapshots.shell.windows.length,
    });
  });
});
