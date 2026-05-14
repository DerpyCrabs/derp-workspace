import {
  assert,
  getJson,
  type CompositorSnapshot,
  waitFor,
  waitForWindowGone,
} from "../lib/oracle.ts";
import { defineGroup } from "../lib/runtime.ts";
import { closeWindow, ensureXtermWindow, postJson } from "../lib/setup.ts";

type ThemeSettings = {
  palette: string;
  mode: string;
};

type OskSettings = {
  enabled: boolean;
  provider: string;
};

async function expectOskGtkTheme(base: string, expected: string): Promise<void> {
  const snapshot = await getJson<CompositorSnapshot>(base, "/test/state/compositor");
  assert(
    snapshot.osk_gtk_theme === expected,
    `expected squeekboard GTK theme ${expected}, got ${snapshot.osk_gtk_theme ?? "null"}`,
  );
}

async function expectHiddenSqueekboard(base: string, label: string): Promise<CompositorSnapshot> {
  return waitFor(
    `wait for hidden squeekboard ${label}`,
    async () => {
      const snapshot = await getJson<CompositorSnapshot>(base, "/test/state/compositor");
      if (snapshot.osk_visible === true) return null;
      if (snapshot.osk_layer_visible_on_preferred_output === true) return null;
      return snapshot;
    },
    3000,
    40,
  );
}

export default defineGroup(import.meta.url, ({ test }) => {
  test("squeekboard follows shell dark and light theme choices", async ({ base }) => {
    const originalTheme = await getJson<ThemeSettings>(base, "/settings_theme");
    const originalOsk = await getJson<OskSettings>(base, "/settings_osk");
    await postJson(base, "/settings_osk", { enabled: true, provider: "squeekboard" });
    try {
      await postJson(base, "/settings_theme", { palette: originalTheme.palette, mode: "dark" });
      await expectOskGtkTheme(base, "Adwaita:dark");

      await postJson(base, "/settings_theme", { palette: originalTheme.palette, mode: "light" });
      await expectOskGtkTheme(base, "Adwaita");
    } finally {
      await postJson(base, "/settings_theme", originalTheme);
      await postJson(base, "/settings_osk", originalOsk);
    }
  });

  test("hidden squeekboard stays hidden across xterm window open and close", async ({ base, state }) => {
    const originalOsk = await getJson<OskSettings>(base, "/settings_osk");
    let windowId: number | null = null;
    await postJson(base, "/settings_osk", { enabled: true, provider: "squeekboard" });
    try {
      await expectHiddenSqueekboard(base, "before window open");
      const opened = await ensureXtermWindow(base, state, "osk-hidden-xterm");
      windowId = opened.window.window_id;
      await expectHiddenSqueekboard(base, "after window open");
      await closeWindow(base, windowId);
      await waitForWindowGone(base, windowId);
      windowId = null;
      await expectHiddenSqueekboard(base, "after window close");
    } finally {
      if (windowId !== null) {
        await closeWindow(base, windowId).catch(() => undefined);
      }
      await postJson(base, "/settings_osk", originalOsk);
    }
  });
});
