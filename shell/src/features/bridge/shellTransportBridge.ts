import { createMemo, createSignal, onCleanup } from 'solid-js'
import { postShellJson } from './shellBridge'
import { shellHttpBase } from './shellHttp'

const SHELL_WIRE_DEGRADED_WITH_HTTP =
  'Shell wire is unavailable. Window controls stay limited until cef_host reconnects.'
const SHELL_WIRE_DEGRADED_NO_HTTP =
  'Shell bridge is unavailable. Window controls and session actions stay limited until cef_host reconnects.'
const DERP_SHELL_WIRE_READY_EVENT = 'derp-shell-wire-ready'

type ShellTransportBridgeOptions = {
  shellWireSend: (
    op: 'quit' | 'request_compositor_sync' | 'set_chrome_metrics',
    arg?: number | string,
    arg2?: number | string,
  ) => boolean
  chromeTitlebarPx: number
  chromeBorderPx: number
}

export function createShellTransportBridge(options: ShellTransportBridgeOptions) {
  const [shellWireIssue, setShellWireIssue] = createSignal<string | null>(null)
  const [shellActionIssue, setShellActionIssue] = createSignal<string | null>(null)
  const [shellWireReadyRev, setShellWireReadyRev] = createSignal(0)
  const shellBridgeIssue = createMemo(() => shellActionIssue() ?? shellWireIssue())
  let compositorSyncAttempts = 0
  let compositorSyncRaf = 0
  let nativeWireHadBeenReady = false

  function shellWireIssueMessage(): string {
    return shellHttpBase() !== null ? SHELL_WIRE_DEGRADED_WITH_HTTP : SHELL_WIRE_DEGRADED_NO_HTTP
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function reportShellWireIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellWireIssue((current) => (current === message ? current : message))
  }

  function clearShellWireIssue() {
    setShellWireIssue(null)
  }

  function reportShellActionIssue(message: string) {
    console.warn(`[derp-shell-bridge] ${message}`)
    setShellActionIssue((current) => (current === message ? current : message))
  }

  function clearShellActionIssue() {
    setShellActionIssue(null)
  }

  async function postShell(path: string, body: object): Promise<void> {
    await postShellJson(path, body, shellHttpBase())
  }

  async function postSessionPower(action: string): Promise<void> {
    try {
      await postShell('/session_power', { action })
      clearShellActionIssue()
    } catch (error) {
      reportShellActionIssue(`Power action failed: ${describeError(error)}`)
      throw error
    }
  }

  function canSessionControl(): boolean {
    return typeof window.__derpShellWireSend === 'function' || shellHttpBase() !== null
  }

  function requestCompositorSync() {
    if (options.shellWireSend('request_compositor_sync')) {
      compositorSyncAttempts = 0
      if (!nativeWireHadBeenReady) setShellWireReadyRev((value) => value + 1)
      nativeWireHadBeenReady = true
      clearShellWireIssue()
      options.shellWireSend('set_chrome_metrics', options.chromeTitlebarPx, options.chromeBorderPx)
      return
    }
    compositorSyncAttempts += 1
    reportShellWireIssue(shellWireIssueMessage())
    if (compositorSyncAttempts >= 120) return
    compositorSyncRaf = requestAnimationFrame(() => {
      compositorSyncRaf = 0
      requestCompositorSync()
    })
  }

  function handleShellWireReady() {
    compositorSyncAttempts = 0
    requestCompositorSync()
  }

  function start() {
    window.addEventListener(DERP_SHELL_WIRE_READY_EVENT, handleShellWireReady)
    queueMicrotask(requestCompositorSync)
    queueMicrotask(() => {
      options.shellWireSend('set_chrome_metrics', options.chromeTitlebarPx, options.chromeBorderPx)
    })
    onCleanup(() => {
      window.removeEventListener(DERP_SHELL_WIRE_READY_EVENT, handleShellWireReady)
      if (compositorSyncRaf !== 0) cancelAnimationFrame(compositorSyncRaf)
    })
  }

  return {
    canSessionControl,
    clearShellActionIssue,
    clearShellWireIssue,
    describeError,
    postSessionPower,
    postShell,
    reportShellActionIssue,
    reportShellWireIssue,
    requestCompositorSync,
    shellBridgeIssue,
    shellWireReadyRev,
    start,
  }
}
