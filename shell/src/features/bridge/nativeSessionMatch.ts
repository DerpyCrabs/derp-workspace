import type { SavedNativeWindow } from './sessionSnapshot'

export type NativeMatchWindow = {
  title: string
  appId: string
  outputId: string
  outputName: string
  maximized: boolean
  fullscreen: boolean
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function scoreNativeSessionMatch(
  window: NativeMatchWindow,
  saved: SavedNativeWindow,
): number {
  const liveAppId = normalize(window.appId)
  const savedAppId = normalize(saved.appId)
  const liveTitle = normalize(window.title)
  const savedTitle = normalize(saved.title)
  const liveOutputId = normalize(window.outputId)
  const savedOutputId = normalize(saved.outputId)
  const liveOutput = normalize(window.outputName)
  const savedOutput = normalize(saved.outputName)
  let score = 0
  if (liveAppId && savedAppId) {
    if (liveAppId === savedAppId) score += 70
    else if (liveAppId.includes(savedAppId) || savedAppId.includes(liveAppId)) score += 24
  }
  if (liveTitle && savedTitle) {
    if (liveTitle === savedTitle) score += 28
    else if (liveTitle.includes(savedTitle) || savedTitle.includes(liveTitle)) score += 12
  }
  if (liveOutputId && savedOutputId) {
    if (liveOutputId === savedOutputId) score += 10
    else score -= 8
  }
  if (liveOutput && savedOutput && liveOutput === savedOutput) score += 6
  if (window.maximized === saved.maximized) score += 2
  if (window.fullscreen === saved.fullscreen) score += 2
  if (saved.launch?.appName) {
    const appName = normalize(saved.launch.appName)
    if (appName && (liveTitle === appName || savedTitle === appName)) score += 4
  }
  return score
}

export function matchNativeSessionWindow(
  window: NativeMatchWindow,
  saved: readonly SavedNativeWindow[],
  assignedWindowRefs: ReadonlySet<string> = new Set(),
): SavedNativeWindow | null {
  let best: SavedNativeWindow | null = null
  let bestScore = 0
  let secondBestScore = 0
  for (const candidate of saved) {
    if (assignedWindowRefs.has(candidate.windowRef)) continue
    const score = scoreNativeSessionMatch(window, candidate)
    if (score > bestScore) {
      secondBestScore = bestScore
      best = candidate
      bestScore = score
      continue
    }
    if (score > secondBestScore) {
      secondBestScore = score
    }
  }
  if (!best) return null
  if (bestScore < 36) return null
  if (bestScore - secondBestScore < 8) return null
  return best
}
