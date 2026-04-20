import { postShellJson } from '@/features/bridge/shellBridge'
import { waitForShellHttpBase } from '@/features/bridge/shellHttp'
import type { DesktopAppEntry } from '@/features/bridge/shellBridge'

export type DesktopAppUsageCounts = Record<string, number>

let desktopAppUsageCounts: DesktopAppUsageCounts = {}
let refreshPromise: Promise<DesktopAppUsageCounts> | null = null
let pendingLaunchKeys: string[] = []

function emptyUsageCounts(): DesktopAppUsageCounts {
  return {}
}

function sanitizeDesktopAppUsageCounts(value: unknown): DesktopAppUsageCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyUsageCounts()
  const counts: DesktopAppUsageCounts = {}
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
      continue
    }
    counts[key] = Math.floor(count)
  }
  return counts
}

export function parseDesktopAppUsageResponse(text: string): DesktopAppUsageCounts {
  try {
    return sanitizeDesktopAppUsageCounts(JSON.parse(text))
  } catch {
    return emptyUsageCounts()
  }
}

export function desktopAppUsageKey(app: DesktopAppEntry): string {
  const desktopId = app.desktop_id.trim()
  if (desktopId.length > 0) return desktopId
  const exec = app.exec.trim()
  if (exec.length > 0) return `exec:${exec}`
  return `name:${app.name.trim().toLocaleLowerCase()}`
}

async function readDesktopAppUsageViaShellHttp(base: string): Promise<DesktopAppUsageCounts> {
  const res = await fetch(`${base}/desktop_app_usage`)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Desktop app usage load failed (${res.status}): ${text || 'empty response'}`)
  }
  return parseDesktopAppUsageResponse(text)
}

async function persistDesktopAppUsageLaunch(key: string): Promise<void> {
  const base = await waitForShellHttpBase()
  if (!base) {
    pendingLaunchKeys = [...pendingLaunchKeys, key]
    return
  }
  await postShellJson('/desktop_app_usage_launch', { key }, base)
}

async function flushPendingDesktopAppUsageLaunches() {
  if (pendingLaunchKeys.length === 0) return
  const queued = pendingLaunchKeys
  pendingLaunchKeys = []
  for (const key of queued) {
    await persistDesktopAppUsageLaunch(key)
  }
}

export function getDesktopAppUsageCounts(): DesktopAppUsageCounts {
  return desktopAppUsageCounts
}

export async function refreshDesktopAppUsageFromRemote(): Promise<DesktopAppUsageCounts> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    try {
      const base = await waitForShellHttpBase()
      if (!base) return desktopAppUsageCounts
      const next = await readDesktopAppUsageViaShellHttp(base)
      desktopAppUsageCounts = next
      await flushPendingDesktopAppUsageLaunches()
      return desktopAppUsageCounts
    } catch (error) {
      console.warn('[derp-shell-desktop-app-usage] refresh failed', error)
      return desktopAppUsageCounts
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}

export function desktopAppLaunchCount(
  app: DesktopAppEntry,
  usageCounts: DesktopAppUsageCounts | undefined,
): number {
  if (!usageCounts) return 0
  return usageCounts[desktopAppUsageKey(app)] ?? 0
}

export function recordDesktopAppLaunch(app: DesktopAppEntry): DesktopAppUsageCounts {
  const key = desktopAppUsageKey(app)
  desktopAppUsageCounts = {
    ...desktopAppUsageCounts,
    [key]: (desktopAppUsageCounts[key] ?? 0) + 1,
  }
  void persistDesktopAppUsageLaunch(key).catch((error) => {
    console.warn('[derp-shell-desktop-app-usage] persist failed', error)
  })
  return desktopAppUsageCounts
}

export function __resetDesktopAppUsageForTests() {
  desktopAppUsageCounts = {}
  refreshPromise = null
  pendingLaunchKeys = []
}
