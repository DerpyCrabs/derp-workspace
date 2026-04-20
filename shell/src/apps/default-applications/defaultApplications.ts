import { createSignal, type Accessor } from 'solid-js'
import { getShellJson, postShellJson, type DesktopAppEntry } from '@/features/bridge/shellBridge'
import { shellHttpBase, waitForShellHttpBase } from '@/features/bridge/shellHttp'
import { isImageFilePath } from '@/apps/image-viewer/imageViewerCore'
import { isPdfFilePath } from '@/apps/pdf-viewer/pdfViewerCore'
import { isTextEditorFilePath } from '@/apps/text-editor/textEditorCore'
import { isVideoFilePath } from '@/apps/video-viewer/videoViewerCore'

export type FileOpenCategory = 'image' | 'video' | 'text' | 'pdf' | 'other'

export type DefaultApplicationsSettings = Record<FileOpenCategory, string>

export type OpenWithOption =
  | {
      id: string
      kind: 'shell'
      label: string
      category: FileOpenCategory
      shellKind: 'image_viewer' | 'video_viewer' | 'text_editor' | 'pdf_viewer'
    }
  | {
      id: string
      kind: 'desktop'
      label: string
      category: FileOpenCategory
      app: DesktopAppEntry
    }
  | {
      id: string
      kind: 'xdg'
      label: string
      category: FileOpenCategory
    }

export type DefaultApplicationsController = {
  settings: Accessor<DefaultApplicationsSettings>
  loaded: Accessor<boolean>
  busy: Accessor<boolean>
  err: Accessor<string | null>
  refresh: () => Promise<void>
  warm: () => Promise<void>
  setDefault: (category: FileOpenCategory, appId: string) => Promise<void>
}

export const DEFAULT_APPLICATIONS_FALLBACK: DefaultApplicationsSettings = {
  image: 'shell:image_viewer',
  video: 'shell:video_viewer',
  text: 'shell:text_editor',
  pdf: 'shell:pdf_viewer',
  other: 'xdg-open',
}

export const FILE_OPEN_CATEGORIES: { id: FileOpenCategory; label: string }[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'text', label: 'Text files' },
  { id: 'pdf', label: 'PDF documents' },
  { id: 'other', label: 'Other files' },
]

const SHELL_OPTIONS: OpenWithOption[] = [
  {
    id: 'shell:image_viewer',
    kind: 'shell',
    label: 'Image Viewer',
    category: 'image',
    shellKind: 'image_viewer',
  },
  {
    id: 'shell:video_viewer',
    kind: 'shell',
    label: 'Video Viewer',
    category: 'video',
    shellKind: 'video_viewer',
  },
  {
    id: 'shell:text_editor',
    kind: 'shell',
    label: 'Text Editor',
    category: 'text',
    shellKind: 'text_editor',
  },
  {
    id: 'shell:pdf_viewer',
    kind: 'shell',
    label: 'PDF Viewer',
    category: 'pdf',
    shellKind: 'pdf_viewer',
  },
]

const XDG_OPTION: OpenWithOption = {
  id: 'xdg-open',
  kind: 'xdg',
  label: 'System default application',
  category: 'other',
}

const CATEGORY_MIME_PREFIX: Record<FileOpenCategory, string[]> = {
  image: ['image/'],
  video: ['video/'],
  text: ['text/', 'application/json', 'application/xml', 'application/x-yaml', 'application/yaml'],
  pdf: ['application/pdf'],
  other: [],
}

const [settings, setSettings] = createSignal<DefaultApplicationsSettings>(DEFAULT_APPLICATIONS_FALLBACK)
const [loaded, setLoaded] = createSignal(false)
const [busy, setBusy] = createSignal(false)
const [err, setErr] = createSignal<string | null>(null)
let refreshPromise: Promise<void> | null = null

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeSettings(value: unknown): DefaultApplicationsSettings {
  if (!isObject(value)) return DEFAULT_APPLICATIONS_FALLBACK
  return {
    image: typeof value.image === 'string' ? value.image : DEFAULT_APPLICATIONS_FALLBACK.image,
    video: typeof value.video === 'string' ? value.video : DEFAULT_APPLICATIONS_FALLBACK.video,
    text: typeof value.text === 'string' ? value.text : DEFAULT_APPLICATIONS_FALLBACK.text,
    pdf: typeof value.pdf === 'string' ? value.pdf : DEFAULT_APPLICATIONS_FALLBACK.pdf,
    other: typeof value.other === 'string' ? value.other : DEFAULT_APPLICATIONS_FALLBACK.other,
  }
}

function summarizeBody(body: string): string {
  return body.length > 200 ? `${body.slice(0, 200)}...` : body
}

export function fileOpenCategoryForPath(path: string): FileOpenCategory {
  if (isImageFilePath(path)) return 'image'
  if (isVideoFilePath(path)) return 'video'
  if (isTextEditorFilePath(path)) return 'text'
  if (isPdfFilePath(path)) return 'pdf'
  return 'other'
}

function desktopAppSupportsCategory(app: DesktopAppEntry, category: FileOpenCategory): boolean {
  const mimeTypes = app.mime_types ?? []
  if (mimeTypes.length === 0) return category === 'other'
  const prefixes = CATEGORY_MIME_PREFIX[category]
  if (prefixes.length === 0) return true
  return mimeTypes.some((mime) => prefixes.some((prefix) => mime === prefix || mime.startsWith(prefix)))
}

function desktopOption(category: FileOpenCategory, app: DesktopAppEntry): OpenWithOption {
  return {
    id: `desktop:${app.desktop_id}`,
    kind: 'desktop',
    label: app.name,
    category,
    app,
  }
}

export function openWithOptionsForCategory(
  category: FileOpenCategory,
  desktopApps: readonly DesktopAppEntry[],
): OpenWithOption[] {
  const out = SHELL_OPTIONS.filter((option) => option.category === category)
  out.push(XDG_OPTION)
  for (const app of desktopApps) {
    if (desktopAppSupportsCategory(app, category)) out.push(desktopOption(category, app))
  }
  return out
}

export function optionById(
  appId: string,
  category: FileOpenCategory,
  desktopApps: readonly DesktopAppEntry[],
): OpenWithOption {
  const match = openWithOptionsForCategory(category, desktopApps).find((option) => option.id === appId)
  return match ?? openWithOptionsForCategory(category, desktopApps)[0] ?? XDG_OPTION
}

async function refreshDefaultApplications(): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const base = shellHttpBase()
    setBusy(true)
    if (!base) {
      if (!loaded()) setErr('Default applications need cef_host (no shell HTTP).')
      setBusy(false)
      refreshPromise = null
      return
    }
    setErr(null)
    try {
      setSettings(sanitizeSettings(await getShellJson('/settings_default_applications', base)))
      setLoaded(true)
      setErr(null)
    } catch (error) {
      if (!loaded()) setErr(error instanceof Error ? summarizeBody(error.message) : String(error))
    } finally {
      setBusy(false)
      refreshPromise = null
    }
  })()
  return refreshPromise
}

async function warmDefaultApplications() {
  const base = await waitForShellHttpBase(4000)
  if (!base) return
  await refreshDefaultApplications()
}

async function setDefaultApplication(category: FileOpenCategory, appId: string): Promise<void> {
  const base = shellHttpBase()
  const next = { ...settings(), [category]: appId }
  setSettings(next)
  await postShellJson('/settings_default_applications', next, base)
}

const controller: DefaultApplicationsController = {
  settings,
  loaded,
  busy,
  err,
  refresh: refreshDefaultApplications,
  warm: warmDefaultApplications,
  setDefault: setDefaultApplication,
}

export function useDefaultApplicationsState(): DefaultApplicationsController {
  return controller
}
