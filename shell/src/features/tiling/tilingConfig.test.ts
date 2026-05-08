import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureWorkspaceTilingConfig,
  customMonitorSnapLayout,
  customAutoLayoutParamsForMonitor,
  getMonitorLayout,
  resetTilingConfig,
  setMonitorCustomLayouts,
  setMonitorLayout,
  setMonitorSnapLayout,
  tilingConfigFromWorkspaceLayouts,
} from "./tilingConfig";
import { createCustomLayout, setCustomLayoutSlotRules } from "./customLayouts";
import type {
  WorkspaceMonitorLayoutState,
  WorkspaceMutation,
} from "@/features/workspace/workspaceProtocol";

let layouts: WorkspaceMonitorLayoutState[] = [];
let mutations: WorkspaceMutation[] = [];

function applyLastMutation() {
  const mutation = mutations.at(-1);
  if (!mutation) return;
  if (mutation.type === "set_monitor_layout") {
    layouts = layouts.filter(
      (layout) => layout.outputName !== mutation.outputName,
    );
    layouts.push({
      outputId: mutation.outputId ?? undefined,
      outputName: mutation.outputName,
      layout: mutation.layout,
      params: mutation.params,
      snapLayout: mutation.snapLayout,
      customLayouts: mutation.customLayouts,
    });
  }
  if (mutation.type === "set_monitor_layouts") layouts = mutation.layouts;
}

function wireWorkspaceLayouts(initial: WorkspaceMonitorLayoutState[] = []) {
  layouts = initial;
  mutations = [];
  configureWorkspaceTilingConfig({
    readLayouts: () => layouts,
    sendMutation: (mutation) => {
      mutations.push(mutation);
      applyLastMutation();
      return true;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  wireWorkspaceLayouts();
});

describe("tilingConfig", () => {
  it("reads monitor layouts from compositor workspace state", () => {
    wireWorkspaceLayouts([
      {
        outputId: "make:model:serial-a",
        outputName: "DP-1",
        layout: "grid",
        params: { maxColumns: 3 },
        snapLayout: "2x2",
      },
    ]);

    expect(getMonitorLayout("DP-1").layout.type).toBe("grid");
    expect(getMonitorLayout("DP-1").params).toEqual({ maxColumns: 3 });
    expect(getMonitorLayout("DP-1").snapLayout).toEqual({
      kind: "assist",
      shape: "2x2",
    });
  });

  it("sends monitor layout mutations instead of writing localStorage", () => {
    const localStorage = {
      setItem: vi.fn(),
      getItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", localStorage);
    wireWorkspaceLayouts();

    setMonitorLayout("DP-1", "columns", { maxColumns: 2 });

    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(mutations).toEqual([
      {
        type: "set_monitor_layout",
        outputName: "DP-1",
        layout: "columns",
        params: { maxColumns: 2 },
      },
    ]);
  });

  it("preserves snap layout when changing monitor layout mode", () => {
    wireWorkspaceLayouts();

    setMonitorSnapLayout("DP-1", { kind: "assist", shape: "2x2" });
    setMonitorLayout("DP-1", "columns", { maxColumns: 2 });

    expect(getMonitorLayout("DP-1").snapLayout).toEqual({
      kind: "assist",
      shape: "2x2",
    });
    expect(mutations.at(-1)).toMatchObject({
      type: "set_monitor_layout",
      snapLayout: "2x2",
    });
  });

  it("defaults snap layout to 3x2 and persists explicit built-in override", () => {
    wireWorkspaceLayouts();

    expect(getMonitorLayout("DP-1").snapLayout).toEqual({
      kind: "assist",
      shape: "3x2",
    });
    setMonitorSnapLayout("DP-1", { kind: "assist", shape: "3x3" });

    expect(getMonitorLayout("DP-1").snapLayout).toEqual({
      kind: "assist",
      shape: "3x3",
    });
  });

  it("persists custom snap layout selections while layout exists", () => {
    wireWorkspaceLayouts();

    const customLayout = createCustomLayout("Zones");
    setMonitorCustomLayouts("DP-1", [customLayout]);
    setMonitorSnapLayout("DP-1", customMonitorSnapLayout(customLayout.id));

    expect(getMonitorLayout("DP-1").snapLayout).toEqual(
      customMonitorSnapLayout(customLayout.id),
    );
  });

  it("persists custom layouts and selected custom snap in one monitor mutation", () => {
    wireWorkspaceLayouts();

    const customLayout = createCustomLayout("Zones");
    setMonitorCustomLayouts(
      "DP-1",
      [customLayout],
      customMonitorSnapLayout(customLayout.id),
    );

    expect(mutations.at(-1)).toMatchObject({
      type: "set_monitor_layout",
      outputName: "DP-1",
      snapLayout: `custom:${customLayout.id}`,
      customLayouts: [customLayout],
    });
  });

  it("builds custom auto params from selected layout zones and rules", () => {
    wireWorkspaceLayouts();

    const customLayout = setCustomLayoutSlotRules(
      createCustomLayout("Zones"),
      "zone-missing",
      [],
    );
    const layout = {
      ...customLayout,
      root: {
        kind: "split" as const,
        axis: "vertical" as const,
        ratio: 0.5,
        first: { kind: "leaf" as const, zoneId: "slot-1" },
        second: { kind: "leaf" as const, zoneId: "slot-2" },
      },
      slotRules: {
        "slot-2": [
          {
            field: "app_id" as const,
            op: "equals" as const,
            value: "org.desktop.telegram",
          },
        ],
      },
    };
    setMonitorCustomLayouts("DP-1", [layout]);
    setMonitorSnapLayout("DP-1", customMonitorSnapLayout(layout.id));

    expect(customAutoLayoutParamsForMonitor("DP-1")).toEqual({
      customLayoutId: layout.id,
      customSlots: [
        { slotId: "slot-1", x: 0, y: 0, width: 0.5, height: 1 },
        {
          slotId: "slot-2",
          x: 0.5,
          y: 0,
          width: 0.5,
          height: 1,
          rules: [
            { field: "app_id", op: "equals", value: "org.desktop.telegram" },
          ],
        },
      ],
    });
  });

  it("falls back to default assist layout when selected custom layout disappears", () => {
    wireWorkspaceLayouts();

    const customLayout = createCustomLayout("Zones");
    setMonitorCustomLayouts("DP-1", [customLayout]);
    setMonitorSnapLayout("DP-1", customMonitorSnapLayout(customLayout.id));
    setMonitorCustomLayouts("DP-1", []);

    expect(getMonitorLayout("DP-1").snapLayout).toEqual({
      kind: "assist",
      shape: "3x2",
    });
  });

  it("clears compositor-owned tiling config", () => {
    wireWorkspaceLayouts();

    setMonitorLayout("DP-1", "grid", { maxColumns: 2 });
    resetTilingConfig();

    expect(mutations.at(-1)).toEqual({
      type: "set_monitor_layouts",
      layouts: [],
    });
    expect(getMonitorLayout("DP-1").layout.type).toBe("manual-snap");
  });

  it("keys workspace layouts by monitor identity and name", () => {
    expect(
      tilingConfigFromWorkspaceLayouts([
        {
          outputId: "make:model:serial-a",
          outputName: "DP-1",
          layout: "grid",
          params: { maxColumns: 2 },
        },
      ]).monitors,
    ).toMatchObject({
      "id:make:model:serial-a": { layout: "grid", params: { maxColumns: 2 } },
      "DP-1": { layout: "grid", params: { maxColumns: 2 } },
    });
  });
});
