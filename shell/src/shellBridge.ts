export type DesktopAppEntry = {
  name: string
  exec: string
  executable?: string
  generic_name?: string
  full_name?: string
  keywords?: string[]
  terminal: boolean
  desktop_id: string
}

export class ShellHttpError extends Error {
  status: number
  body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ShellHttpError'
    this.status = status
    this.body = body
  }
}

function summarizeBody(body: string): string {
  return body.length > 200 ? `${body.slice(0, 200)}...` : body
}

export type PortalScreencastRequestState =
  | {
      pending: false
    }
  | {
      pending: true
      request_id: number
      types: number | null
    }

export type ShellSpawnRequest = {
  command: string
  desktop_id?: string
  app_name?: string
  session_restore?: boolean
}

function asDesktopAppEntry(value: unknown): DesktopAppEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.name !== 'string' || typeof row.exec !== 'string') return null
  const keywords =
    row.keywords === undefined
      ? []
      : Array.isArray(row.keywords) && row.keywords.every((value) => typeof value === 'string')
        ? row.keywords
        : null
  if (keywords === null) return null
  return {
    name: row.name,
    exec: row.exec,
    executable: typeof row.executable === 'string' ? row.executable : undefined,
    generic_name: typeof row.generic_name === 'string' ? row.generic_name : undefined,
    full_name: typeof row.full_name === 'string' ? row.full_name : undefined,
    keywords,
    terminal: row.terminal === true,
    desktop_id: typeof row.desktop_id === 'string' ? row.desktop_id : '',
  }
}

export async function postShellJson(path: string, body: object, base: string | null): Promise<void> {
  if (!base) {
    throw new Error('Shell HTTP bridge is unavailable.')
  }
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ShellHttpError(
      `Shell HTTP ${path} failed (${res.status}): ${summarizeBody(text) || 'empty response'}`,
      res.status,
      text,
    )
  }
}

export async function getShellJson(path: string, base: string | null): Promise<unknown> {
  if (!base) {
    throw new Error('Shell HTTP bridge is unavailable.')
  }
  const res = await fetch(`${base}${path}`)
  const text = await res.text()
  if (!res.ok) {
    throw new ShellHttpError(
      `Shell HTTP ${path} failed (${res.status}): ${summarizeBody(text) || 'empty response'}`,
      res.status,
      text,
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Shell HTTP ${path} returned invalid JSON: ${error}`)
  }
}

function asPortalScreencastRequestState(value: unknown): PortalScreencastRequestState {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid screencast picker response: expected an object.')
  }
  const row = value as Record<string, unknown>
  if (row.pending !== true) return { pending: false }
  const requestId = row.request_id
  if (typeof requestId !== 'number' || !Number.isInteger(requestId) || requestId < 1) {
    throw new Error('Invalid screencast picker response: bad request_id.')
  }
  const types =
    typeof row.types === 'number' && Number.isInteger(row.types) && row.types > 0 ? row.types : null
  return { pending: true, request_id: requestId, types }
}

export async function fetchPortalScreencastRequestState(
  base: string | null,
): Promise<PortalScreencastRequestState> {
  return asPortalScreencastRequestState(await getShellJson('/portal_screencast_request', base))
}

export async function respondPortalScreencastRequest(
  requestId: number,
  selection: string | null,
  base: string | null,
): Promise<void> {
  await postShellJson(
    '/portal_screencast_respond',
    {
      request_id: requestId,
      selection,
    },
    base,
  )
}

export async function beginScreenshotRegionMode(base: string | null): Promise<void> {
  await postShellJson('/screenshot_begin_region_mode', {}, base)
}

export async function cancelScreenshot(base: string | null): Promise<void> {
  await postShellJson('/screenshot_cancel', {}, base)
}

export async function spawnViaShellHttp(
  command: string,
  spawnUrl: string | undefined,
  extra?: Omit<ShellSpawnRequest, 'command'>,
): Promise<void> {
  if (!spawnUrl) {
    throw new Error('Shell spawn bridge is unavailable.')
  }
  const body: ShellSpawnRequest = { command }
  if (extra?.desktop_id) body.desktop_id = extra.desktop_id
  if (extra?.app_name) body.app_name = extra.app_name
  if (extra?.session_restore) body.session_restore = true
  const res = await fetch(spawnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ShellHttpError(
      `Spawn failed (${res.status}): ${summarizeBody(text) || 'empty response'}`,
      res.status,
      text,
    )
  }
}

export function parseDesktopApplicationsResponse(text: string): DesktopAppEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid applications response: ${error}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid applications response: expected an object.')
  }
  const appsValue = (parsed as { apps?: unknown }).apps
  if (appsValue === undefined) return []
  if (!Array.isArray(appsValue)) {
    throw new Error('Invalid applications response: apps must be an array.')
  }
  const items: DesktopAppEntry[] = []
  for (const row of appsValue) {
    const app = asDesktopAppEntry(row)
    if (!app) {
      throw new Error('Invalid applications response: bad application row.')
    }
    items.push(app)
  }
  return items
}
