import { ShellHttpError, getShellJson } from './shellBridge'

export type FileBrowserRoot = {
  label: string
  path: string
  kind: string
}

export type FileBrowserEntry = {
  path: string
  name: string
  kind: string
  hidden: boolean
  symlink: boolean
  writable: boolean | null
  size: number | null
  modified_ms: number | null
}

export type FileBrowserRootsResponse = {
  roots: FileBrowserRoot[]
}

export type FileBrowserListResponse = {
  path: string
  parent_path: string | null
  entries: FileBrowserEntry[]
}

export type FileBrowserStatResponse = {
  entry: FileBrowserEntry
}

export class FileBrowserBridgeError extends Error {
  status: number
  code: string
  path: string | null

  constructor(message: string, status = 500, code = 'io_error', path: string | null = null) {
    super(message)
    this.name = 'FileBrowserBridgeError'
    this.status = status
    this.code = code
    this.path = path
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asEntry(value: unknown): FileBrowserEntry | null {
  if (!isObject(value)) return null
  if (typeof value.path !== 'string' || typeof value.name !== 'string' || typeof value.kind !== 'string') return null
  return {
    path: value.path,
    name: value.name,
    kind: value.kind,
    hidden: value.hidden === true,
    symlink: value.symlink === true,
    writable:
      typeof value.writable === 'boolean'
        ? value.writable
        : value.writable === null || value.writable === undefined
          ? null
          : null,
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : null,
    modified_ms:
      typeof value.modified_ms === 'number' && Number.isFinite(value.modified_ms) ? value.modified_ms : null,
  }
}

function asRoot(value: unknown): FileBrowserRoot | null {
  if (!isObject(value)) return null
  if (typeof value.label !== 'string' || typeof value.path !== 'string' || typeof value.kind !== 'string') return null
  return {
    label: value.label,
    path: value.path,
    kind: value.kind,
  }
}

function parseBridgeError(error: unknown): FileBrowserBridgeError {
  if (error instanceof FileBrowserBridgeError) return error
  if (error instanceof ShellHttpError) {
    try {
      const parsed = JSON.parse(error.body) as unknown
      if (isObject(parsed) && isObject(parsed.error)) {
        const detail = parsed.error
        const message = typeof detail.message === 'string' ? detail.message : error.message
        const code = typeof detail.code === 'string' ? detail.code : 'io_error'
        const path = typeof detail.path === 'string' ? detail.path : null
        return new FileBrowserBridgeError(message, error.status, code, path)
      }
    } catch {}
    return new FileBrowserBridgeError(error.message, error.status, 'io_error', null)
  }
  if (error instanceof Error) return new FileBrowserBridgeError(error.message)
  return new FileBrowserBridgeError(String(error))
}

function parseRootsResponse(value: unknown): FileBrowserRootsResponse {
  if (!isObject(value) || !Array.isArray(value.roots)) {
    throw new FileBrowserBridgeError('Invalid file browser roots response.')
  }
  return {
    roots: value.roots.map(asRoot).filter((entry): entry is FileBrowserRoot => entry !== null),
  }
}

function parseListResponse(value: unknown): FileBrowserListResponse {
  if (!isObject(value) || typeof value.path !== 'string' || !Array.isArray(value.entries)) {
    throw new FileBrowserBridgeError('Invalid file browser list response.')
  }
  return {
    path: value.path,
    parent_path: typeof value.parent_path === 'string' ? value.parent_path : null,
    entries: value.entries.map(asEntry).filter((entry): entry is FileBrowserEntry => entry !== null),
  }
}

function parseStatResponse(value: unknown): FileBrowserStatResponse {
  if (!isObject(value)) {
    throw new FileBrowserBridgeError('Invalid file browser stat response.')
  }
  const entry = asEntry(value.entry)
  if (!entry) {
    throw new FileBrowserBridgeError('Invalid file browser stat response.')
  }
  return { entry }
}

export async function listFileBrowserRoots(base: string | null): Promise<FileBrowserRootsResponse> {
  try {
    return parseRootsResponse(await getShellJson('/file_browser/roots', base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function listFileBrowserDirectory(
  path: string,
  showHidden: boolean,
  base: string | null,
): Promise<FileBrowserListResponse> {
  try {
    return parseListResponse(
      await getShellJson(`/file_browser/list?p=${encodeURIComponent(path)}&hidden=${showHidden ? '1' : '0'}`, base),
    )
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function statFileBrowserPath(path: string, base: string | null): Promise<FileBrowserStatResponse> {
  try {
    return parseStatResponse(await getShellJson(`/file_browser/stat?p=${encodeURIComponent(path)}`, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}
