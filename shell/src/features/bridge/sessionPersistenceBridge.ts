import { createEffect, onCleanup, type Accessor } from 'solid-js'
import { saveTilingConfig } from '@/features/tiling/tilingConfig'
import {
  loadSessionSnapshot,
  saveSessionSnapshot,
  sanitizeSessionSnapshot,
  type NativeLaunchMetadata,
  type SavedShellWindow,
  type SessionSnapshot,
  type SessionWindowRef,
} from './sessionSnapshot'
import { setSessionAutoSaveEnabled as persistSessionAutoSaveEnabled } from './sessionPersistenceSettings'

type SessionPersistenceBridgeOptions = {
  sessionAutoSaveEnabled: Accessor<boolean>
  sessionPersistenceReady: Accessor<boolean>
  sessionRestoreSnapshot: Accessor<SessionSnapshot | null>
  savedSessionAvailable: Accessor<boolean>
  hasSeenCompositorWindowSync: Accessor<boolean>
  windows: Accessor<ReadonlyMap<number, unknown>>
  workspaceState: Accessor<unknown>
  nativeWindowRefs: Accessor<ReadonlyMap<number, SessionWindowRef>>
  tilingCfgRev: Accessor<number>
  shellWindowStateRev: Accessor<number>
  buildSessionSnapshot: () => SessionSnapshot
  sessionSnapshotHasData: (snapshot: SessionSnapshot) => boolean
  sessionRestoreSignature: (snapshot: SessionSnapshot) => string
  restoreWindowModes: (snapshot: SessionSnapshot) => void
  applyRestoredWorkspace: (snapshot: SessionSnapshot) => void
  sessionRestoreIsComplete: (snapshot: SessionSnapshot) => boolean
  restoreBackedShellWindow: (record: SavedShellWindow) => void
  spawnInCompositor: (
    cmd: string,
    launch?: NativeLaunchMetadata | null,
    sessionRestore?: boolean,
    forcedWindowRef?: SessionWindowRef | null,
  ) => Promise<void>
  nativeLaunchMetadataByRef: Map<SessionWindowRef, NativeLaunchMetadata>
  setSessionAutoSaveEnabled: (enabled: boolean) => void
  setSavedSessionAvailable: (value: boolean) => void
  setSessionPersistenceReady: (value: boolean) => void
  setSessionRestoreSnapshot: (snapshot: SessionSnapshot | null) => void
  setHasSeenCompositorWindowSync: (value: boolean) => void
  setNextNativeWindowSeq: (value: number | ((prev: number) => number)) => void
  bumpTilingCfgRev: () => void
  reportShellActionIssue: (message: string) => void
  clearShellActionIssue: () => void
  describeError: (error: unknown) => string
}

export function createSessionPersistenceBridge(options: SessionPersistenceBridgeOptions) {
  let sessionPersistTimer: ReturnType<typeof setTimeout> | undefined
  let sessionRestoreStopTimer: ReturnType<typeof setTimeout> | undefined
  let sessionPersistGeneration = 0
  let lastPersistedSessionJson = ''
  let lastAppliedRestoreSignature = ''

  function sessionAutoSaveReady() {
    return (
      options.sessionAutoSaveEnabled() &&
      options.sessionPersistenceReady() &&
      !options.sessionRestoreSnapshot()
    )
  }

  async function persistLiveSessionSnapshotSoon(
    mode: 'auto' | 'manual' = 'auto',
    generation = sessionPersistGeneration,
  ) {
    if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
    let snapshot: SessionSnapshot
    let json: string
    try {
      snapshot = sanitizeSessionSnapshot(options.buildSessionSnapshot())
      if (
        !options.sessionSnapshotHasData(snapshot) &&
        options.savedSessionAvailable() &&
        !options.hasSeenCompositorWindowSync()
      ) {
        return
      }
      json = JSON.stringify(snapshot)
    } catch (error) {
      console.warn('[derp-shell-session] build failed', error)
      return
    }
    if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
    if (json === lastPersistedSessionJson) return
    try {
      if (mode === 'auto' && (!sessionAutoSaveReady() || generation !== sessionPersistGeneration)) return
      await saveSessionSnapshot(snapshot)
      lastPersistedSessionJson = json
      options.setSavedSessionAvailable(options.sessionSnapshotHasData(snapshot))
    } catch (error) {
      console.warn('[derp-shell-session] persist failed', error)
    }
  }

  function stopSessionRestore() {
    if (sessionRestoreStopTimer !== undefined) {
      clearTimeout(sessionRestoreStopTimer)
      sessionRestoreStopTimer = undefined
    }
    lastAppliedRestoreSignature = ''
    options.setSessionRestoreSnapshot(null)
    options.setSessionPersistenceReady(true)
  }

  async function startSessionRestore(snapshot: SessionSnapshot) {
    if (sessionRestoreStopTimer !== undefined) {
      clearTimeout(sessionRestoreStopTimer)
    }
    options.setSessionPersistenceReady(false)
    options.setSessionRestoreSnapshot(snapshot)
    options.setHasSeenCompositorWindowSync(false)
    lastPersistedSessionJson = JSON.stringify(snapshot)
    lastAppliedRestoreSignature = ''
    options.setNextNativeWindowSeq(Math.max(1, snapshot.nextNativeWindowSeq))
    saveTilingConfig(snapshot.tilingConfig)
    options.bumpTilingCfgRev()
    for (const nativeWindow of snapshot.nativeWindows) {
      if (nativeWindow.launch) options.nativeLaunchMetadataByRef.set(nativeWindow.windowRef, nativeWindow.launch)
    }
    for (const shellWindow of [...snapshot.shellWindows].sort((a, b) => a.stackZ - b.stackZ)) {
      options.restoreBackedShellWindow(shellWindow)
    }
    for (const nativeWindow of snapshot.nativeWindows) {
      if (!nativeWindow.launch?.command) continue
      void options.spawnInCompositor(nativeWindow.launch.command, nativeWindow.launch, true, nativeWindow.windowRef)
    }
    sessionRestoreStopTimer = setTimeout(() => {
      stopSessionRestore()
    }, 15000)
  }

  function updateSessionAutoSavePreference(enabled: boolean) {
    persistSessionAutoSaveEnabled(enabled)
    options.setSessionAutoSaveEnabled(enabled)
  }

  async function saveCurrentSessionSnapshot() {
    try {
      const snapshot = sanitizeSessionSnapshot(options.buildSessionSnapshot())
      await saveSessionSnapshot(snapshot)
      lastPersistedSessionJson = JSON.stringify(snapshot)
      options.setSavedSessionAvailable(options.sessionSnapshotHasData(snapshot))
      options.clearShellActionIssue()
    } catch (error) {
      options.reportShellActionIssue(`Save workspace failed: ${options.describeError(error)}`)
    }
  }

  async function restoreSavedSessionSnapshot() {
    try {
      const snapshot = await loadSessionSnapshot()
      if (!options.sessionSnapshotHasData(snapshot)) {
        options.reportShellActionIssue('Restore workspace failed: no saved workspace snapshot is available.')
        return
      }
      options.setSavedSessionAvailable(true)
      await startSessionRestore(snapshot)
      options.clearShellActionIssue()
    } catch (error) {
      options.reportShellActionIssue(`Restore workspace failed: ${options.describeError(error)}`)
    }
  }

  async function bootstrapSessionState() {
    try {
      const snapshot = await loadSessionSnapshot()
      const hasSnapshotData = options.sessionSnapshotHasData(snapshot)
      options.setSavedSessionAvailable(hasSnapshotData)
      if (!hasSnapshotData) {
        lastPersistedSessionJson = JSON.stringify(snapshot)
        options.setNextNativeWindowSeq(snapshot.nextNativeWindowSeq)
        options.setSessionPersistenceReady(true)
        return
      }
      await startSessionRestore(snapshot)
    } catch (error) {
      console.warn('[derp-shell-session] load failed', error)
      options.setSessionPersistenceReady(true)
    }
  }

  createEffect(() => {
    const snapshot = options.sessionRestoreSnapshot()
    if (!snapshot) return
    const signature = options.sessionRestoreSignature(snapshot)
    if (signature === lastAppliedRestoreSignature) return
    lastAppliedRestoreSignature = signature
    options.restoreWindowModes(snapshot)
    options.applyRestoredWorkspace(snapshot)
  })

  createEffect(() => {
    const snapshot = options.sessionRestoreSnapshot()
    options.windows()
    options.nativeWindowRefs()
    if (!snapshot) return
    if (!options.sessionRestoreIsComplete(snapshot)) return
    stopSessionRestore()
  })

  createEffect(() => {
    options.sessionAutoSaveEnabled()
    options.sessionPersistenceReady()
    options.sessionRestoreSnapshot()
    options.windows()
    options.workspaceState()
    options.nativeWindowRefs()
    options.tilingCfgRev()
    options.shellWindowStateRev()
    if (!sessionAutoSaveReady()) {
      if (sessionPersistTimer !== undefined) {
        clearTimeout(sessionPersistTimer)
        sessionPersistTimer = undefined
      }
      sessionPersistGeneration += 1
      return
    }
    if (sessionPersistTimer !== undefined) clearTimeout(sessionPersistTimer)
    const generation = sessionPersistGeneration
    sessionPersistTimer = setTimeout(() => {
      void persistLiveSessionSnapshotSoon('auto', generation)
    }, 150)
  })

  onCleanup(() => {
    if (sessionPersistTimer !== undefined) clearTimeout(sessionPersistTimer)
    if (sessionRestoreStopTimer !== undefined) clearTimeout(sessionRestoreStopTimer)
  })

  return {
    bootstrapSessionState,
    restoreSavedSessionSnapshot,
    saveCurrentSessionSnapshot,
    sessionAutoSaveReady,
    startSessionRestore,
    stopSessionRestore,
    updateSessionAutoSavePreference,
  }
}
