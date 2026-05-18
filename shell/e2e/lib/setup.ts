export {
  cleanupNativeWindows,
  cleanupShellWindows,
  closeWindow,
  closeTaskbarWindow,
  crashWindow,
  disableSessionRestoreForE2e,
  ensureNativePair,
  ensureNativeWindow,
  ensureXtermWindow,
  openDebug,
  openPowerMenu,
  openProgramsMenu,
  openSettings,
  openShellTestWindow,
  openVolumeMenu,
  postJson,
  prepareFileBrowserFixtures,
  primeState,
  resetFileBrowserFixtures,
  spawnCommand,
  spawnNativeWindow,
  spawnXtermCommandWindow,
  spawnXtermWindow,
} from './runtime.ts'

import { postJson } from './runtime.ts'

export async function reloadSession(base: string, session: unknown): Promise<void> {
  await postJson(base, '/session_reload', session)
}

export async function resetTiling(base: string): Promise<void> {
  await postJson(base, '/test/tiling/reset', {})
}
