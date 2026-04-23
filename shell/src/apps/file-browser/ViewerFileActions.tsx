import Clipboard from 'lucide-solid/icons/clipboard'
import ExternalLink from 'lucide-solid/icons/external-link'
import FolderOpen from 'lucide-solid/icons/folder-open'

type ViewerFileActionsProps = {
  path: string
  directory: string
  showHidden: boolean
  tone?: 'dark' | 'shell'
  onOpenContainingFolder?: (path: string) => void
  onOpenExternalFile?: (path: string, context: { directory: string; showHidden: boolean }) => void
}

function dirname(path: string): string {
  const norm = path.replace(/\/+$/, '') || '/'
  const i = norm.lastIndexOf('/')
  if (i <= 0) return '/'
  return norm.slice(0, i) || '/'
}

function canCopyPath(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
}

export function ViewerFileActions(props: ViewerFileActionsProps) {
  const directory = () => props.directory || dirname(props.path)
  return (
    <>
      <button
        type="button"
        title="Open containing folder"
        aria-label="Open containing folder"
        class={
          props.tone === 'shell'
            ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:opacity-50'
            : 'inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10 disabled:opacity-50'
        }
        disabled={!props.path || !props.onOpenContainingFolder}
        data-viewer-open-containing-folder
        onClick={() => {
          if (props.path) props.onOpenContainingFolder?.(directory())
        }}
      >
        <FolderOpen class="h-3.5 w-3.5" stroke-width={2} />
      </button>
      <button
        type="button"
        title="Open with default app"
        aria-label="Open with default app"
        class={
          props.tone === 'shell'
            ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:opacity-50'
            : 'inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10 disabled:opacity-50'
        }
        disabled={!props.path || !props.onOpenExternalFile}
        data-viewer-open-external
        onClick={() => {
          if (props.path) props.onOpenExternalFile?.(props.path, { directory: directory(), showHidden: props.showHidden })
        }}
      >
        <ExternalLink class="h-3.5 w-3.5" stroke-width={2} />
      </button>
      <button
        type="button"
        title="Copy path"
        aria-label="Copy path"
        class={
          props.tone === 'shell'
            ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-(--shell-text-dim) hover:bg-(--shell-control-muted-hover) hover:text-(--shell-text) disabled:opacity-50'
            : 'inline-flex h-7 w-7 items-center justify-center rounded-md text-white hover:bg-white/10 disabled:opacity-50'
        }
        disabled={!props.path || !canCopyPath()}
        data-viewer-copy-path
        onClick={() => {
          if (props.path && canCopyPath()) void navigator.clipboard.writeText(props.path).catch(() => {})
        }}
      >
        <Clipboard class="h-3.5 w-3.5" stroke-width={2} />
      </button>
    </>
  )
}
