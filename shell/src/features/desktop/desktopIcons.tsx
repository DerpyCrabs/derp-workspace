import AppWindow from 'lucide-solid/icons/app-window'
import { createMemo, createSignal, type JSX } from 'solid-js'
import type { DesktopAppEntry } from '@/features/bridge/shellBridge'
import { shellHttpBase } from '@/features/bridge/shellHttp'

const DESKTOP_ICON_PRELOAD_ATTR = 'data-desktop-icon-preload'

function desktopIconKey(icon: string): string {
  return encodeURIComponent(icon)
}

export function desktopIconUrl(base: string | null, icon: string | null | undefined): string | null {
  const name = icon?.trim()
  if (!base || !name) return null
  return `${base}/desktop_icon?name=${desktopIconKey(name)}`
}

export function preloadDesktopAppIcons(apps: readonly DesktopAppEntry[], base: string | null): void {
  if (!base || typeof document === 'undefined') return
  const head = document.head
  const existing = new Set(
    [...head.getElementsByTagName('link')]
      .map((link) => link.getAttribute(DESKTOP_ICON_PRELOAD_ATTR))
      .filter((icon): icon is string => typeof icon === 'string' && icon.length > 0),
  )
  for (const app of apps) {
    const icon = app.icon?.trim()
    const href = desktopIconUrl(base, icon)
    if (!icon || !href) continue
    if (existing.has(icon)) continue
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'image'
    link.href = href
    link.fetchPriority = 'high'
    link.setAttribute(DESKTOP_ICON_PRELOAD_ATTR, icon)
    head.appendChild(link)
    existing.add(icon)
  }
}

export function DesktopAppIcon(props: {
  icon: string | null | undefined
  label: string
  class?: string
  imageClass?: string
}): JSX.Element {
  const [failedIcon, setFailedIcon] = createSignal<string | null>(null)
  const src = createMemo(() => {
    const icon = props.icon?.trim()
    if (!icon || failedIcon() === icon) return null
    return desktopIconUrl(shellHttpBase(), icon)
  })
  return (
    <span
      class={props.class ?? 'bg-(--shell-surface-elevated) flex h-7 w-7 shrink-0 items-center justify-center rounded'}
      aria-hidden="true"
      data-desktop-app-icon={props.icon?.trim() ? 'image' : 'fallback'}
    >
      {src() ? (
        <img
          src={src()!}
          alt=""
          class={props.imageClass ?? 'h-full w-full object-contain'}
          draggable={false}
          decoding="async"
          fetchpriority="high"
          onError={() => {
            const icon = props.icon?.trim()
            if (icon) setFailedIcon(icon)
          }}
        />
      ) : (
        <AppWindow class="h-4 w-4 text-(--shell-text-dim)" stroke-width={2} />
      )}
    </span>
  )
}
