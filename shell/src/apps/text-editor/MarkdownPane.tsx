import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js'
import { createMarkdownRenderer, preprocessObsidianImages } from '@/apps/text-editor/textViewerMarkdown'

type Props = {
  content: string
  resolveImageUrl: (src: string) => string | null
}

export function MarkdownPane(props: Props): JSX.Element {
  const [expandedSrc, setExpandedSrc] = createSignal<string | null>(null)

  const html = createMemo(() => {
    const md = createMarkdownRenderer(props.resolveImageUrl)
    return md.render(preprocessObsidianImages(props.content))
  })

  const onMarkdownImageActivate = (e: PointerEvent | MouseEvent) => {
    const mount = e.currentTarget
    if (!(mount instanceof HTMLDivElement)) return
    if (expandedSrc()) return
    if (e.button !== 0) return
    if (e instanceof PointerEvent && !e.isPrimary) return
    let node: EventTarget | null = e.target
    if (node instanceof Text) node = node.parentElement
    if (!(node instanceof Element) || !mount.contains(node)) return
    const img = node instanceof HTMLImageElement ? node : node.closest('img')
    if (!(img instanceof HTMLImageElement) || !mount.contains(img)) return
    e.preventDefault()
    e.stopPropagation()
    setExpandedSrc(img.currentSrc || img.src)
  }

  createEffect(() => {
    if (!expandedSrc()) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpandedSrc(null)
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  return (
    <div class="relative h-full min-h-full min-w-0 overflow-auto">
      <Show when={expandedSrc()}>
        {(src) => (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="View image fullscreen"
            data-text-editor-markdown-image-dialog="1"
            tabindex={0}
            class="absolute inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/90 p-4"
            onClick={(e) => e.target === e.currentTarget && setExpandedSrc(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setExpandedSrc(null)
              }
            }}
          >
            <button
              type="button"
              class="absolute top-4 right-4 z-10 rounded-md p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              onClick={() => setExpandedSrc(null)}
              aria-label="Close"
            >
              ×
            </button>
            <img
              src={src()}
              alt=""
              class="max-h-full max-w-full cursor-default object-contain"
              draggable={false}
              loading="eager"
            />
          </div>
        )}
      </Show>
      <div
        class="markdown-pane-content min-h-full w-full max-w-none px-3 py-2 text-(--shell-text) [&_a]:text-(--shell-accent) [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-(--shell-border) [&_blockquote]:pl-3 [&_blockquote]:text-(--shell-text-dim) [&_code]:rounded [&_code]:bg-(--shell-surface-inset) [&_code]:px-1 [&_code]:text-sm [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:max-h-48 [&_img]:max-w-sm [&_img]:cursor-zoom-in [&_img]:object-contain [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-(--shell-surface-inset) [&_pre]:p-2 [&_pre]:text-sm [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
        innerHTML={html()}
        onPointerDown={onMarkdownImageActivate}
        onMouseDown={onMarkdownImageActivate}
        onClick={onMarkdownImageActivate}
      />
    </div>
  )
}
