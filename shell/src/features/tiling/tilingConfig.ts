import { DEFAULT_ASSIST_GRID_SHAPE, type AssistGridShape } from "./assistGrid";
import { listCustomLayoutZones, type CustomLayout } from "./customLayouts";
import {
  createLayout,
  type LayoutParams,
  type LayoutType,
  type TilingLayout,
} from "./layouts";
import type {
  WorkspaceMonitorLayoutState,
  WorkspaceMutation,
} from "@/features/workspace/workspaceProtocol";

const CUSTOM_SNAP_LAYOUT_PREFIX = "custom:";

export type MonitorSnapLayout =
  | { kind: "assist"; shape: AssistGridShape }
  | { kind: "custom"; layoutId: string };

export type MonitorTilingEntry = {
  layout: LayoutType;
  params?: LayoutParams;
  snapLayout?: string;
  customLayouts?: CustomLayout[];
};

export type TilingConfig = {
  monitors: Record<string, MonitorTilingEntry>;
};

let readWorkspaceLayouts:
  | (() => readonly WorkspaceMonitorLayoutState[])
  | null = null;
let sendWorkspaceMutation: ((mutation: WorkspaceMutation) => boolean) | null =
  null;

function defaultConfig(): TilingConfig {
  return { monitors: {} };
}

function isAssistGridShape(v: unknown): v is AssistGridShape {
  return v === "2x2" || v === "3x2" || v === "2x3" || v === "3x3";
}

export function assistMonitorSnapLayout(
  shape: AssistGridShape,
): MonitorSnapLayout {
  return { kind: "assist", shape };
}

export function customMonitorSnapLayout(layoutId: string): MonitorSnapLayout {
  return { kind: "custom", layoutId };
}

export function monitorSnapLayoutEquals(
  a: MonitorSnapLayout,
  b: MonitorSnapLayout,
): boolean {
  if (a.kind === "assist" && b.kind === "assist") {
    return a.shape === b.shape;
  }
  if (a.kind === "custom" && b.kind === "custom") {
    return a.layoutId === b.layoutId;
  }
  return false;
}

export function monitorSnapLayoutStorageKey(layout: MonitorSnapLayout): string {
  if (layout.kind === "assist") {
    return layout.shape;
  }
  return `${CUSTOM_SNAP_LAYOUT_PREFIX}${layout.layoutId}`;
}

function parseMonitorSnapLayout(
  value: unknown,
  customLayouts: readonly CustomLayout[],
): MonitorSnapLayout | null {
  if (isAssistGridShape(value)) {
    return assistMonitorSnapLayout(value);
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (isAssistGridShape(raw)) {
    return assistMonitorSnapLayout(raw);
  }
  if (!raw.startsWith(CUSTOM_SNAP_LAYOUT_PREFIX)) return null;
  const layoutId = raw.slice(CUSTOM_SNAP_LAYOUT_PREFIX.length).trim();
  if (!layoutId || !customLayouts.some((layout) => layout.id === layoutId))
    return null;
  return customMonitorSnapLayout(layoutId);
}

function sanitizeStoredSnapLayout(
  value: unknown,
  customLayouts: readonly CustomLayout[],
): string | undefined {
  const parsed = parseMonitorSnapLayout(value, customLayouts);
  return parsed ? monitorSnapLayoutStorageKey(parsed) : undefined;
}

function resolveMonitorSnapLayout(
  snapLayout: unknown,
  customLayouts: readonly CustomLayout[],
): MonitorSnapLayout {
  return (
    parseMonitorSnapLayout(snapLayout, customLayouts) ??
    assistMonitorSnapLayout(DEFAULT_ASSIST_GRID_SHAPE)
  );
}

export function customAutoLayoutParamsForMonitor(
  outputName: string,
): LayoutParams {
  const monitor = getMonitorLayout(outputName);
  const snapLayout = monitor.snapLayout;
  const selectedLayout =
    snapLayout.kind === "custom"
      ? monitor.customLayouts.find(
          (layout) => layout.id === snapLayout.layoutId,
        )
      : monitor.customLayouts[0];
  if (!selectedLayout) return {};
  const customSlots = listCustomLayoutZones(selectedLayout).map((zone) => ({
    slotId: zone.zoneId,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    ...(selectedLayout.slotRules?.[zone.zoneId]?.length
      ? { rules: selectedLayout.slotRules[zone.zoneId] }
      : {}),
  }));
  return {
    customLayoutId: selectedLayout.id,
    customSlots,
  };
}

export function configureWorkspaceTilingConfig(options: {
  readLayouts: () => readonly WorkspaceMonitorLayoutState[];
  sendMutation: (mutation: WorkspaceMutation) => boolean;
}): void {
  readWorkspaceLayouts = options.readLayouts;
  sendWorkspaceMutation = options.sendMutation;
}

function monitorKey(outputName: string, outputId?: string | null): string {
  return outputId ? `id:${outputId}` : `name:${outputName}`;
}

export function tilingConfigFromWorkspaceLayouts(
  layouts: readonly WorkspaceMonitorLayoutState[],
): TilingConfig {
  const cfg = defaultConfig();
  for (const layout of layouts) {
    const entry: MonitorTilingEntry = { layout: layout.layout };
    if (Object.keys(layout.params ?? {}).length > 0)
      entry.params = layout.params;
    if (layout.snapLayout) entry.snapLayout = layout.snapLayout;
    if (layout.customLayouts && layout.customLayouts.length > 0)
      entry.customLayouts = layout.customLayouts;
    cfg.monitors[monitorKey(layout.outputName, layout.outputId)] = entry;
    cfg.monitors[layout.outputName] = entry;
  }
  return cfg;
}

function currentTilingConfig(): TilingConfig {
  return tilingConfigFromWorkspaceLayouts(readWorkspaceLayouts?.() ?? []);
}

function persistMonitorEntry(
  outputName: string,
  entry: MonitorTilingEntry,
): void {
  sendWorkspaceMutation?.({
    type: "set_monitor_layout",
    outputName,
    layout: entry.layout,
    params: entry.params ?? {},
    ...(entry.snapLayout ? { snapLayout: entry.snapLayout } : {}),
    ...(entry.customLayouts && entry.customLayouts.length > 0
      ? { customLayouts: entry.customLayouts }
      : {}),
  });
}

export function getMonitorLayout(outputName: string): {
  layout: TilingLayout;
  params: LayoutParams;
  snapLayout: MonitorSnapLayout;
  customLayouts: CustomLayout[];
} {
  const cfg = currentTilingConfig();
  const entry = cfg.monitors[outputName];
  const layoutType: LayoutType = entry?.layout ?? "manual-snap";
  const params: LayoutParams = entry?.params ?? {};
  const customLayouts = entry?.customLayouts ?? [];
  return {
    layout: createLayout(layoutType),
    params,
    snapLayout: resolveMonitorSnapLayout(entry?.snapLayout, customLayouts),
    customLayouts,
  };
}

export function setMonitorLayout(
  outputName: string,
  layoutType: LayoutType,
  params?: LayoutParams,
): void {
  const cfg = currentTilingConfig();
  const prev = cfg.monitors[outputName];
  const nextParams = params !== undefined ? params : (prev?.params ?? {});
  const next: MonitorTilingEntry = { layout: layoutType };
  if (Object.keys(nextParams).length > 0) {
    next.params = nextParams;
  }
  const customLayouts = prev?.customLayouts ?? [];
  const snapLayout = sanitizeStoredSnapLayout(prev?.snapLayout, customLayouts);
  if (snapLayout) {
    next.snapLayout = snapLayout;
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts;
  }
  cfg.monitors[outputName] = next;
  persistMonitorEntry(outputName, next);
}

export function setMonitorSnapLayout(
  outputName: string,
  snapLayout: MonitorSnapLayout,
): void {
  const cfg = currentTilingConfig();
  const prev = cfg.monitors[outputName];
  const customLayouts = prev?.customLayouts ?? [];
  const next: MonitorTilingEntry = {
    layout: prev?.layout ?? "manual-snap",
    snapLayout: monitorSnapLayoutStorageKey(
      parseMonitorSnapLayout(
        monitorSnapLayoutStorageKey(snapLayout),
        customLayouts,
      ) ?? assistMonitorSnapLayout(DEFAULT_ASSIST_GRID_SHAPE),
    ),
  };
  if (prev?.params && Object.keys(prev.params).length > 0) {
    next.params = prev.params;
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts;
  }
  cfg.monitors[outputName] = next;
  persistMonitorEntry(outputName, next);
}

export function setMonitorCustomLayouts(
  outputName: string,
  customLayouts: CustomLayout[],
  snapLayout?: MonitorSnapLayout | null,
): void {
  const cfg = currentTilingConfig();
  const prev = cfg.monitors[outputName];
  const nextSnapLayout = snapLayout
    ? monitorSnapLayoutStorageKey(
        parseMonitorSnapLayout(
          monitorSnapLayoutStorageKey(snapLayout),
          customLayouts,
        ) ?? assistMonitorSnapLayout(DEFAULT_ASSIST_GRID_SHAPE),
      )
    : sanitizeStoredSnapLayout(prev?.snapLayout, customLayouts);
  const next: MonitorTilingEntry = {
    layout: prev?.layout ?? "manual-snap",
  };
  if (prev?.params && Object.keys(prev.params).length > 0) {
    next.params = prev.params;
  }
  if (nextSnapLayout) {
    next.snapLayout = nextSnapLayout;
  }
  if (customLayouts.length > 0) {
    next.customLayouts = customLayouts;
  }
  cfg.monitors[outputName] = next;
  persistMonitorEntry(outputName, next);
}

export function resetTilingConfig(): void {
  sendWorkspaceMutation?.({ type: "set_monitor_layouts", layouts: [] });
}
