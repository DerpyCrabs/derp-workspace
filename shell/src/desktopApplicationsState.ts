import { createSignal, type Accessor } from 'solid-js'
import { shellHttpBase } from './shellHttp'
import { parseDesktopApplicationsResponse, type DesktopAppEntry } from './shellBridge'

export type DesktopApplicationsController = {
  items: Accessor<DesktopAppEntry[]>
  loaded: Accessor<boolean>
  busy: Accessor<boolean>
  err: Accessor<string | null>
  refresh: () => Promise<void>
  warm: () => Promise<void>
}

export type DesktopAppMatchCandidate = Pick<DesktopAppEntry, 'name' | 'exec' | 'desktop_id' | 'icon'> & {
  executable?: string
  generic_name?: string
  full_name?: string
  keywords?: string[]
}

export type DesktopAppWindowLike = {
  title: string
  app_id: string
}

type PreparedDesktopAppMatchCandidate = {
  app: DesktopAppMatchCandidate
  desktopId: string
  executable: string
  name: string
  generic: string
  full: string
  icon: string
  texts: Array<{ normalized: string; tokens: Set<string> }>
}

type PreparedDesktopAppCollection = {
  apps: PreparedDesktopAppMatchCandidate[]
  byDesktopId: Map<string, PreparedDesktopAppMatchCandidate[]>
  byExecutable: Map<string, PreparedDesktopAppMatchCandidate[]>
  byIcon: Map<string, PreparedDesktopAppMatchCandidate[]>
  matchCache: Map<string, DesktopAppMatchCandidate | null>
}

const [desktopAppItems, setDesktopAppItems] = createSignal<DesktopAppEntry[]>([])
const [desktopAppsLoaded, setDesktopAppsLoaded] = createSignal(false)
const [desktopAppsBusy, setDesktopAppsBusy] = createSignal(false)
const [desktopAppsErr, setDesktopAppsErr] = createSignal<string | null>(null)
let refreshPromise: Promise<void> | null = null
const preparedAppCache = new WeakMap<DesktopAppMatchCandidate, PreparedDesktopAppMatchCandidate>()
const preparedCollections = new WeakMap<readonly DesktopAppMatchCandidate[], PreparedDesktopAppCollection>()

function summarizeBody(body: string): string {
  return body.length > 200 ? `${body.slice(0, 200)}...` : body
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenSet(value: string | null | undefined): Set<string> {
  return new Set(
    normalizeToken(value)
      .split(' ')
      .map((part) => part.trim())
      .filter(Boolean),
  )
}

function candidateTextValues(app: DesktopAppMatchCandidate): string[] {
  return [
    app.desktop_id,
    app.executable,
    app.exec,
    app.name,
    app.generic_name,
    app.full_name,
    app.icon,
    ...(app.keywords ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function appendPreparedIndex(
  index: Map<string, PreparedDesktopAppMatchCandidate[]>,
  key: string,
  candidate: PreparedDesktopAppMatchCandidate,
) {
  if (!key) return
  const existing = index.get(key)
  if (existing) existing.push(candidate)
  else index.set(key, [candidate])
}

function prepareDesktopAppCandidate(app: DesktopAppMatchCandidate): PreparedDesktopAppMatchCandidate {
  const cached = preparedAppCache.get(app)
  if (cached) return cached
  const prepared = {
    app,
    desktopId: normalizeToken(app.desktop_id),
    executable: normalizeToken(app.executable ?? app.exec),
    name: normalizeToken(app.name),
    generic: normalizeToken(app.generic_name),
    full: normalizeToken(app.full_name),
    icon: normalizeToken(app.icon),
    texts: candidateTextValues(app).map((value) => ({
      normalized: normalizeToken(value),
      tokens: tokenSet(value),
    })),
  }
  preparedAppCache.set(app, prepared)
  return prepared
}

function prepareDesktopAppCollection(
  apps: readonly DesktopAppMatchCandidate[],
): PreparedDesktopAppCollection {
  const cached = preparedCollections.get(apps)
  if (cached) return cached
  const preparedApps = apps.map((app) => prepareDesktopAppCandidate(app))
  const collection: PreparedDesktopAppCollection = {
    apps: preparedApps,
    byDesktopId: new Map(),
    byExecutable: new Map(),
    byIcon: new Map(),
    matchCache: new Map(),
  }
  for (const prepared of preparedApps) {
    appendPreparedIndex(collection.byDesktopId, prepared.desktopId, prepared)
    appendPreparedIndex(collection.byExecutable, prepared.executable, prepared)
    appendPreparedIndex(collection.byIcon, prepared.icon, prepared)
  }
  preparedCollections.set(apps, collection)
  return collection
}

export function matchDesktopApplication(
  apps: readonly DesktopAppMatchCandidate[],
  window: DesktopAppWindowLike,
): DesktopAppMatchCandidate | null {
  const appId = normalizeToken(window.app_id)
  const title = normalizeToken(window.title)
  const signature = `${appId}\u0000${title}`
  const prepared = prepareDesktopAppCollection(apps)
  if (prepared.matchCache.has(signature)) {
    return prepared.matchCache.get(signature) ?? null
  }
  const appIdTokens = tokenSet(window.app_id)
  const titleTokens = tokenSet(window.title)
  let best: DesktopAppMatchCandidate | null = null
  let bestScore = -1
  const exactMatches = new Set<PreparedDesktopAppMatchCandidate>()
  for (const match of prepared.byDesktopId.get(appId) ?? []) exactMatches.add(match)
  for (const match of prepared.byExecutable.get(appId) ?? []) exactMatches.add(match)
  for (const match of prepared.byIcon.get(appId) ?? []) exactMatches.add(match)
  if (exactMatches.size === 1) {
    const result = [...exactMatches][0]!.app
    prepared.matchCache.set(signature, result)
    return result
  }
  const candidates = exactMatches.size > 1 ? [...exactMatches] : prepared.apps
  for (const candidate of candidates) {
    const { app, desktopId, executable, name, generic, full, icon } = candidate
    let score = 0
    if (appId) {
      if (desktopId === appId) score = Math.max(score, 1000)
      if (executable === appId) score = Math.max(score, 950)
      if (name === appId || generic === appId || full === appId) score = Math.max(score, 900)
      if (desktopId.includes(appId) || appId.includes(desktopId)) score = Math.max(score, 760)
      if (icon && (icon === appId || icon.includes(appId) || appId.includes(icon))) {
        score = Math.max(score, 720)
      }
    }
    if (title) {
      if (name === title || full === title) score = Math.max(score, 860)
      if (name && title.includes(name)) score = Math.max(score, 780)
      if (full && title.includes(full)) score = Math.max(score, 760)
      if (generic && title.includes(generic)) score = Math.max(score, 720)
    }
    for (const value of candidate.texts) {
      const normalized = value.normalized
      if (!normalized) continue
      let overlap = 0
      for (const token of appIdTokens) {
        if (value.tokens.has(token)) overlap += 1
      }
      for (const token of titleTokens) {
        if (value.tokens.has(token)) overlap += 1
      }
      if (overlap > 0) score = Math.max(score, 500 + overlap * 25)
      if (appId && normalized.includes(appId)) score = Math.max(score, 680)
      if (title && normalized && title.includes(normalized)) score = Math.max(score, 640)
    }
    if (score > bestScore) {
      best = app
      bestScore = score
    }
  }
  const result = bestScore >= 500 ? best : null
  prepared.matchCache.set(signature, result)
  return result
}

async function refreshDesktopApplications(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const base = shellHttpBase()
    setDesktopAppsBusy(true)
    if (!base) {
      if (!desktopAppsLoaded()) setDesktopAppsErr('Programs list needs cef_host (no shell HTTP).')
      setDesktopAppsBusy(false)
      refreshPromise = null
      return
    }
    setDesktopAppsErr(null)
    try {
      const res = await fetch(`${base}/desktop_applications`)
      const text = await res.text()
      if (!res.ok) {
        if (!desktopAppsLoaded()) {
          setDesktopAppsErr(`Failed to load (${res.status}): ${summarizeBody(text)}`)
        }
        return
      }
      const list = parseDesktopApplicationsResponse(text)
      setDesktopAppItems(list)
      setDesktopAppsLoaded(true)
      setDesktopAppsErr(null)
    } catch (error) {
      if (!desktopAppsLoaded()) setDesktopAppsErr(`Network error: ${error}`)
    } finally {
      setDesktopAppsBusy(false)
      refreshPromise = null
    }
  })()
  return refreshPromise
}

async function warmDesktopApplications() {
  const startedAt = Date.now()
  let base = shellHttpBase()
  while (!base && Date.now() - startedAt < 4000) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
    base = shellHttpBase()
  }
  if (!base) return
  await refreshDesktopApplications()
}

const controller: DesktopApplicationsController = {
  items: desktopAppItems,
  loaded: desktopAppsLoaded,
  busy: desktopAppsBusy,
  err: desktopAppsErr,
  refresh: refreshDesktopApplications,
  warm: warmDesktopApplications,
}

export function useDesktopApplicationsState(): DesktopApplicationsController {
  return controller
}
