import { ShellHttpError, getShellJson, postShellJson, postShellJsonReturnJson } from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'

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

export function fileBrowserReadUrl(path: string, base: string | null): string {
  const origin = (base ?? shellHttpBase() ?? '').replace(/\/$/, '')
  if (!origin) return ''
  return `${origin}/file_browser/read?p=${encodeURIComponent(path)}`
}

export function fileBrowserStreamUrl(path: string, base: string | null): string {
  const origin = (base ?? shellHttpBase() ?? '').replace(/\/$/, '')
  if (!origin) return ''
  return `${origin}/file_browser/stream?p=${encodeURIComponent(path)}`
}

export function fileBrowserWatchUrl(paths: readonly string[], base: string | null): string {
  const origin = (base ?? shellHttpBase() ?? '').replace(/\/$/, '')
  if (!origin) return ''
  const query = paths.map((path) => `p=${encodeURIComponent(path)}`).join('&')
  return query ? `${origin}/file_browser/watch?${query}` : ''
}

export async function writeFileBrowserFile(path: string, content: string, base: string | null): Promise<void> {
  try {
    await postShellJson('/file_browser/write', { path, content }, base)
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function writeFileBrowserBytes(
  parent: string,
  name: string,
  contentBase64: string,
  base: string | null,
): Promise<FileBrowserMutationOk> {
  try {
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/write_bytes', { parent, name, base64: contentBase64 }, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export type FileBrowserMutationOk = {
  ok: true
  path?: string
}

function parseMutationOk(value: unknown): FileBrowserMutationOk {
  if (!isObject(value) || value.ok !== true) {
    throw new FileBrowserBridgeError('Invalid file browser mutation response.')
  }
  return {
    ok: true,
    path: typeof value.path === 'string' ? value.path : undefined,
  }
}

export async function mkdirFileBrowserEntry(
  parent: string,
  name: string,
  base: string | null,
): Promise<FileBrowserMutationOk> {
  try {
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/mkdir', { parent, name }, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function touchFileBrowserFile(
  parent: string,
  name: string,
  base: string | null,
): Promise<FileBrowserMutationOk> {
  try {
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/touch', { parent, name }, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function removeFileBrowserPath(path: string, base: string | null): Promise<FileBrowserMutationOk> {
  try {
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/remove', { path }, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function renameFileBrowserPath(
  from: string,
  to: string,
  base: string | null,
): Promise<FileBrowserMutationOk> {
  try {
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/rename', { from, to }, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}

export async function copyFileBrowserFile(
  from: string,
  toDir: string,
  destName: string | null,
  base: string | null,
): Promise<FileBrowserMutationOk> {
  try {
    const body: { from: string; to_dir: string; dest_name?: string } = { from, to_dir: toDir }
    if (destName != null && destName.length > 0) body.dest_name = destName
    return parseMutationOk(await postShellJsonReturnJson('/file_browser/copy', body, base))
  } catch (error) {
    throw parseBridgeError(error)
  }
}
