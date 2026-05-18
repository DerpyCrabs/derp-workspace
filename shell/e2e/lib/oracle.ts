export {
  assert,
  assertRectMinSize,
  assertTaskbarRowOnMonitor,
  assertTopWindow,
  assertWindowTiled,
  captureFailureArtifacts,
  captureScreenshotRect,
  compositorFloatingLayerContainsPoint,
  compositorFloatingLayerCount,
  compositorFloatingLayerRect,
  compositorFloatingLayers,
  compositorWindowById,
  getJson,
  getShellHtml,
  getSnapshots,
  shellWindowById,
  syncTest,
  taskbarEntry,
  waitFor,
  waitForCompositorKeyboardWindow,
  waitForCompositorShellUiFocus,
  waitForDebugVisible,
  waitForNativeFocus,
  waitForNativeKeyboardFocus,
  waitForPowerMenuClosed,
  waitForPowerMenuOpen,
  waitForProgramsMenuClosed,
  waitForProgramsMenuOpen,
  waitForSettingsVisible,
  waitForShellUiFocus,
  waitForSpawnedWindow,
  waitForTaskbarEntry,
  waitForVolumeMenuClosed,
  waitForVolumeMenuOpen,
  waitForWindowGone,
  waitForWindowMinimized,
  waitForWindowRaised,
  topmostCompositorFloatingLayer,
  windowControls,
  writeJsonArtifact,
  writeStateDiffArtifact,
  writeTextArtifact,
} from './runtime.ts'

import { postJson } from './runtime.ts'

export async function captureTestScreenshot(
  base: string,
  rect: { x: number; y: number; width: number; height: number } | Record<string, never> = {},
): Promise<{ path?: string }> {
  return postJson<{ path?: string }>(base, '/test/screenshot', rect)
}

export type {
  CompositorSnapshot,
  CompositorFloatingLayerSnapshot,
  Rect,
  ShellSnapshot,
  TestContext,
  TestEntry,
  TestGroup,
  WindowSnapshot,
} from './runtime.ts'
