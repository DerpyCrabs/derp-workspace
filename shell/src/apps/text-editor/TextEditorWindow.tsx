import type { Accessor } from 'solid-js'
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import Save from 'lucide-solid/icons/save'
import {
  fileBrowserReadUrl,
  statFileBrowserPath,
  writeFileBrowserFile,
} from '@/apps/file-browser/fileBrowserBridge'
import { MarkdownPane } from '@/apps/text-editor/MarkdownPane'
import { isMarkdownFilePath } from '@/apps/text-editor/textEditorCore'
import { resolveMarkdownImageReadUrl } from '@/apps/text-editor/resolveMarkdownImageReadUrl'
import {
  sanitizeTextEditorWindowMemento,
  snapshotTextEditorWindowMemento,
  type TextEditorWindowMemento,
} from '@/apps/text-editor/textEditorState'
import { shellHttpBase } from '@/features/bridge/shellHttp'
import {
  peekShellWindowState,
  primedShellWindowStateVersion,
  subscribeShellWindowState,
} from '@/features/shell-ui/shellWindowState'
import type { ShellCompositorWireSend } from '@/features/shell-ui/shellWireSendType'
import type { DerpWindow } from '@/host/appWindowState'

type TextEditorWindowProps = {
  windowId: number
  compositorAppState: Accessor<unknown | null>
  shellWireSend: ShellCompositorWireSend
  allWindowsMap: () => Map<number, DerpWindow>
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

type EditorStore = TextEditorWindowMemento & {
  loadStatus: LoadStatus
  errorMessage: string | null
  fileText: string
  draftText: string
  writable: boolean | null
}

function initialStore(m: TextEditorWindowMemento): EditorStore {
  return {
    ...m,
    loadStatus: 'idle',
    errorMessage: null,
    fileText: '',
    draftText: '',
    writable: null,
  }
}

export function TextEditorWindow(props: TextEditorWindowProps) {
  const primed = sanitizeTextEditorWindowMemento(peekShellWindowState(props.windowId))
  const [state, setState] = createStore<EditorStore>(
    initialStore(
      primed ?? {
        viewingPath: '',
        directory: '',
        showHidden: false,
      },
    ),
  )

  const [editing, setEditing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  let applyingFromCompositor = false
  let lastCompositorMementoJson = ''
  let lastAppliedRestoredStateVersion = 0
  let rootRef: HTMLDivElement | undefined
  let loadSeq = 0

  function pushTextEditorStateToCompositor() {
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    props.shellWireSend(
      'shell_hosted_window_state',
      JSON.stringify({
        window_id: props.windowId,
        kind: 'text_editor',
        state: snapshotTextEditorWindowMemento(state),
      }),
    )
  }

  function applyRestoredState(value: unknown) {
    const next = sanitizeTextEditorWindowMemento(value)
    if (!next) return
    setEditing(false)
    setState('viewingPath', next.viewingPath)
    setState('directory', next.directory)
    setState('showHidden', next.showHidden)
    loadSeq += 1
    void runLoad(next.viewingPath, loadSeq)
  }

  function applyPrimedRestoredState() {
    const version = primedShellWindowStateVersion(props.windowId)
    if (!version || version === lastAppliedRestoredStateVersion) return
    lastAppliedRestoredStateVersion = version
    applyRestoredState(peekShellWindowState(props.windowId))
  }

  async function runLoad(path: string, runId: number) {
    if (!path) {
      setState('loadStatus', 'ready')
      setState('errorMessage', null)
      setState('fileText', '')
      setState('draftText', '')
      setState('writable', null)
      return
    }
    setState('loadStatus', 'loading')
    setState('errorMessage', null)
    const base = shellHttpBase()
    try {
      const [statRes, textRes] = await Promise.all([
        statFileBrowserPath(path, base),
        fetch(fileBrowserReadUrl(path, base)),
      ])
      if (runId !== loadSeq) return
      if (!textRes.ok) {
        setState('loadStatus', 'error')
        setState('errorMessage', `HTTP ${textRes.status}`)
        setState('fileText', '')
        setState('draftText', '')
        setState('writable', statRes.entry.writable === true ? true : statRes.entry.writable === false ? false : null)
        return
      }
      const text = await textRes.text()
      if (runId !== loadSeq) return
      const w = statRes.entry.writable
      setState('writable', w === true ? true : w === false ? false : null)
      setState('fileText', text)
      setState('draftText', text)
      setState('loadStatus', 'ready')
      setEditing(false)
    } catch (error) {
      if (runId !== loadSeq) return
      setState('loadStatus', 'error')
      setState('errorMessage', error instanceof Error ? error.message : String(error))
      setState('fileText', '')
      setState('draftText', '')
    }
  }

  const isMd = createMemo(() => isMarkdownFilePath(state.viewingPath))

  const dirty = createMemo(() => state.draftText !== state.fileText)

  const resolveImg = (src: string) => resolveMarkdownImageReadUrl(state.viewingPath, src, shellHttpBase())

  async function onSave() {
    if (!state.viewingPath || state.writable !== true || saving()) return
    setSaving(true)
    const base = shellHttpBase()
    try {
      await writeFileBrowserFile(state.viewingPath, state.draftText, base)
      setState('fileText', state.draftText)
      setEditing(false)
    } catch {
      setState('loadStatus', 'error')
      setState('errorMessage', 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function onEdit() {
    if (state.writable !== true) return
    setState('draftText', state.fileText)
    setEditing(true)
  }

  function onReadOnly() {
    setState('draftText', state.fileText)
    setEditing(false)
  }

  const unsubscribeShellWindowState = subscribeShellWindowState(() => {
    applyPrimedRestoredState()
  })
  onCleanup(unsubscribeShellWindowState)

  onMount(() => {
    queueMicrotask(() => rootRef?.focus())
    if (state.viewingPath) {
      loadSeq += 1
      void runLoad(state.viewingPath, loadSeq)
    }
  })

  createEffect(() => {
    const raw = props.compositorAppState()
    void state.viewingPath
    void state.directory
    void state.showHidden
    if (raw == null || typeof raw !== 'object') return
    const next = sanitizeTextEditorWindowMemento(raw)
    if (!next) return
    const j = JSON.stringify(next)
    const local = JSON.stringify(snapshotTextEditorWindowMemento(state))
    if (j === local) {
      lastCompositorMementoJson = j
      return
    }
    if (j === lastCompositorMementoJson) return
    lastCompositorMementoJson = j
    applyingFromCompositor = true
    applyRestoredState(next)
    queueMicrotask(() => {
      applyingFromCompositor = false
    })
  })

  createEffect(() => {
    void state.viewingPath
    void state.directory
    void state.showHidden
    if (applyingFromCompositor) return
    if (!state.viewingPath || !state.directory) return
    pushTextEditorStateToCompositor()
  })

  return (
    <div
      ref={(el) => {
        rootRef = el
      }}
      class="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--shell-surface-inset)"
      tabIndex={0}
      data-text-editor-root
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-(--shell-border) bg-(--shell-surface) px-2 py-1.5">
        <Show when={state.writable === true && !editing()}>
          <button
            type="button"
            data-text-editor-edit
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover)"
            onClick={() => onEdit()}
          >
            Edit
          </button>
        </Show>
        <Show when={state.writable === true && editing()}>
          <button
            type="button"
            class="rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover)"
            onClick={() => onReadOnly()}
          >
            Read only
          </button>
        </Show>
        <Show when={state.writable === true && editing() && dirty()}>
          <button
            type="button"
            data-text-editor-save
            class="inline-flex items-center gap-1 rounded border border-(--shell-border) px-2 py-1 text-xs hover:bg-(--shell-control-muted-hover) disabled:opacity-50"
            disabled={saving()}
            onClick={() => void onSave()}
          >
            <Save class="size-3.5 shrink-0" />
            Save
          </button>
        </Show>
      </div>
      <Show when={state.loadStatus === 'loading'}>
        <div class="flex flex-1 items-center justify-center text-sm text-(--shell-text-dim)">Loading…</div>
      </Show>
      <Show when={state.loadStatus === 'error'}>
        <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <div class="text-sm text-(--shell-text)">Failed to load file.</div>
          <div class="max-w-md text-sm text-(--shell-text-dim)">{state.errorMessage ?? 'Unknown error'}</div>
        </div>
      </Show>
      <Show when={state.loadStatus === 'ready' && state.viewingPath}>
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Show when={editing()}>
            <textarea
              data-text-editor-textarea
              class="min-h-0 flex-1 resize-none bg-(--shell-surface-inset) p-3 font-mono text-sm text-(--shell-text) outline-none"
              value={state.draftText}
              onInput={(e) => setState('draftText', e.currentTarget.value)}
              spellcheck={false}
            />
          </Show>
          <Show when={!editing() && isMd()}>
            <div class="min-h-0 flex-1 overflow-auto" data-text-editor-markdown>
              <MarkdownPane content={state.fileText} resolveImageUrl={resolveImg} />
            </div>
          </Show>
          <Show when={!editing() && !isMd()}>
            <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-sm text-(--shell-text)">
              {state.fileText}
            </pre>
          </Show>
        </div>
      </Show>
    </div>
  )
}
