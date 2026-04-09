import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { shellHttpBase } from '../shellHttp'

export type GnomeDesktopBackgroundPayload = {
  schema: string
  picture_uri: string
  picture_uri_dark?: string | null
  picture_options: string
  primary_color: string
  secondary_color: string
  color_shading_type: string
}

export type DesktopBackgroundWire = {
  mode: string
  solid_rgba: [number, number, number, number]
  image_path: string
  fit: string
}

export type GnomeWallpaperChoice = {
  file_uri: string
  label: string
}

function fileUriToDisplay(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  const p = uri.slice(7)
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

function wallpaperThumbUrl(fileUri: string): string {
  const base = shellHttpBase()
  if (!base) return fileUri
  return `${base}/wallpaper_preview?p=${encodeURIComponent(fileUriToDisplay(fileUri))}`
}

function gnomePictureOptionsToFit(opts: string): string {
  const o = opts.replace(/^['"]|['"]$/g, '').toLowerCase()
  if (o === 'zoom') return 'fill'
  if (o === 'scaled') return 'fit'
  if (o === 'wallpaper') return 'tile'
  if (o === 'centered') return 'center'
  if (o === 'stretched') return 'stretch'
  if (o === 'spanned') return 'spanned'
  return 'fill'
}

function hexToSolidRgba(hex: string): [number, number, number, number] {
  const s = hex.replace(/^#/, '').replace(/^['"]|['"]$/g, '').trim()
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16)
    const g = parseInt(s.slice(2, 4), 16)
    const b = parseInt(s.slice(4, 6), 16)
    if ([r, g, b].every((x) => !Number.isNaN(x))) {
      return [r / 255, g / 255, b / 255, 1]
    }
  }
  return [0.1, 0.1, 0.1, 1]
}

function row(label: string, value: string) {
  return (
    <div class="grid grid-cols-[7.2rem_1fr] gap-x-2 gap-y-1 text-[0.8rem] leading-snug">
      <span class="text-neutral-500">{label}</span>
      <span class="min-w-0 break-all text-neutral-200">{value}</span>
    </div>
  )
}

export function SettingsAppearancePage(props: {
  setDesktopBackgroundJson: (json: string) => void
}) {
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [applyErr, setApplyErr] = createSignal<string | null>(null)
  const [payload, setPayload] = createSignal<GnomeDesktopBackgroundPayload | null>(null)
  const [wallBusy, setWallBusy] = createSignal(false)
  const [wallErr, setWallErr] = createSignal<string | null>(null)
  const [wallpapers, setWallpapers] = createSignal<GnomeWallpaperChoice[]>([])
  const [wallQuery, setWallQuery] = createSignal('')

  const filteredWallpapers = createMemo(() => {
    const q = wallQuery().trim().toLowerCase()
    const list = wallpapers()
    if (!q) return list
    return list.filter((w) => w.label.toLowerCase().includes(q) || w.file_uri.toLowerCase().includes(q))
  })

  async function loadWallpaperChoices() {
    const base = shellHttpBase()
    if (!base) {
      setWallErr('Needs cef_host control server to list wallpapers.')
      setWallpapers([])
      return
    }
    setWallBusy(true)
    setWallErr(null)
    try {
      const res = await fetch(`${base}/gnome_wallpaper_choices`)
      const text = await res.text()
      if (!res.ok) {
        setWallpapers([])
        setWallErr(
          `Wallpapers (${res.status}): ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`,
        )
        return
      }
      const data = JSON.parse(text) as { items?: GnomeWallpaperChoice[] }
      setWallpapers(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setWallpapers([])
      setWallErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWallBusy(false)
    }
  }

  async function load() {
    const base = shellHttpBase()
    if (!base) {
      setErr('Needs cef_host control server (shell HTTP) to read GNOME settings.')
      setPayload(null)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`${base}/gnome_desktop_background`)
      const text = await res.text()
      if (!res.ok) {
        setPayload(null)
        setErr(
          `Request failed (${res.status}): ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`,
        )
        return
      }
      const data = JSON.parse(text) as GnomeDesktopBackgroundPayload
      setPayload(data)
    } catch (e) {
      setPayload(null)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function wireFromGnome(p: GnomeDesktopBackgroundPayload): DesktopBackgroundWire {
    const uri = (p.picture_uri || '').trim().replace(/^['"]|['"]$/g, '')
    const hasPic = uri.length > 0 && uri !== "''"
    return {
      mode: hasPic ? 'image' : 'solid',
      solid_rgba: hexToSolidRgba(p.primary_color || '#1a1a1a'),
      image_path: hasPic ? uri : '',
      fit: gnomePictureOptionsToFit(p.picture_options || 'zoom'),
    }
  }

  function applyGnomeToCompositor() {
    const p = payload()
    if (!p) {
      setApplyErr('Load GNOME values first.')
      return
    }
    setApplyErr(null)
    const wire = wireFromGnome(p)
    props.setDesktopBackgroundJson(JSON.stringify(wire))
  }

  function applyWallpaperToCompositor(choice: GnomeWallpaperChoice) {
    const p = payload()
    setApplyErr(null)
    const fit = gnomePictureOptionsToFit(p?.picture_options ?? 'zoom')
    const solid = hexToSolidRgba(p?.primary_color ?? '#1a1a1a')
    const wire: DesktopBackgroundWire = {
      mode: 'image',
      solid_rgba: solid,
      image_path: choice.file_uri,
      fit,
    }
    props.setDesktopBackgroundJson(JSON.stringify(wire))
  }

  onMount(() => {
    void load()
    void loadWallpaperChoices()
  })

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-neutral-100">Appearance</h2>
        <button
          type="button"
          class="cursor-pointer rounded-lg border border-white/22 bg-black/35 px-2.5 py-1.5 text-[0.78rem] font-medium text-neutral-200 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
          disabled={busy() || !shellHttpBase()}
          onClick={() => void load()}
        >
          {busy() ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div class="rounded-lg border border-white/10 bg-black/20 px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-neutral-400">
          Desktop background (compositor)
        </p>
        <p class="mb-3 text-[0.78rem] leading-relaxed text-neutral-400">
          Wallpaper is drawn under the shell and clients. The shell desktop area is transparent so this layer
          shows through. Values below are read from GNOME (
          <span class="text-neutral-300">org.gnome.desktop.background</span>); use Apply to mirror them into
          derp and <span class="text-neutral-300">display.json</span> (persisted on the next DRM save).
        </p>
        <div class="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-emerald-500/40 bg-emerald-950/35 px-2.5 py-1.5 text-[0.78rem] font-medium text-emerald-100/95 hover:bg-emerald-900/40 disabled:cursor-default disabled:opacity-45"
            disabled={!payload() || typeof window.__derpShellWireSend !== 'function'}
            onClick={() => applyGnomeToCompositor()}
          >
            Apply GNOME wallpaper to compositor
          </button>
        </div>
        <Show when={applyErr()}>
          <p class="mb-2 text-[0.8rem] text-amber-200/95">{applyErr()}</p>
        </Show>
        <Show when={err()}>
          <p class="text-[0.8rem] text-amber-200/95">{err()}</p>
        </Show>
        <Show when={payload()}>
          {(p) => (
            <div class="space-y-2">
              {row('Picture', fileUriToDisplay(p().picture_uri || '(empty)'))}
              <Show when={p().picture_uri_dark}>
                {(u) => row('Picture (dark)', fileUriToDisplay(u()))}
              </Show>
              {row('Fit (GNOME)', p().picture_options)}
              {row('Primary color', p().primary_color)}
              {row('Secondary color', p().secondary_color)}
              {row('Shading', p().color_shading_type)}
            </div>
          )}
        </Show>
      </div>
      <div class="rounded-lg border border-white/10 bg-black/20 px-3 py-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-neutral-400">
            GNOME wallpapers
          </p>
          <button
            type="button"
            class="cursor-pointer rounded-lg border border-white/22 bg-black/35 px-2.5 py-1.5 text-[0.78rem] font-medium text-neutral-200 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
            disabled={wallBusy() || !shellHttpBase()}
            onClick={() => void loadWallpaperChoices()}
          >
            {wallBusy() ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <p class="mb-2 text-[0.78rem] leading-relaxed text-neutral-400">
          Images from <span class="text-neutral-300">/usr/share/gnome-background-properties</span> and{' '}
          <span class="text-neutral-300">/usr/share/backgrounds</span>. Click a tile to set the compositor
          backdrop (fit follows GNOME settings above when loaded).
        </p>
        <input
          type="search"
          placeholder="Filter by name or path…"
          class="mb-3 w-full max-w-md rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 text-[0.82rem] text-neutral-100 placeholder:text-neutral-500 focus:border-white/30 focus:outline-none"
          value={wallQuery()}
          onInput={(e) => setWallQuery(e.currentTarget.value)}
        />
        <Show when={wallErr()}>
          <p class="mb-2 text-[0.8rem] text-amber-200/95">{wallErr()}</p>
        </Show>
        <Show when={!wallBusy() && wallpapers().length === 0 && !wallErr()}>
          <p class="text-[0.78rem] text-neutral-500">No wallpapers found on this system.</p>
        </Show>
        <div class="max-h-[min(28rem,55vh)] overflow-auto rounded-md border border-white/8 bg-black/25 p-2">
          <div class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            <For each={filteredWallpapers()}>
              {(w) => (
                <button
                  type="button"
                  disabled={typeof window.__derpShellWireSend !== 'function'}
                  class="group flex cursor-pointer flex-col overflow-hidden rounded-md border border-white/12 bg-black/35 text-left transition-colors hover:border-emerald-500/45 hover:bg-emerald-950/25 disabled:cursor-default disabled:opacity-45"
                  onClick={() => applyWallpaperToCompositor(w)}
                >
                  <div class="aspect-[4/3] w-full overflow-hidden bg-neutral-900/80">
                    <img
                      src={wallpaperThumbUrl(w.file_uri)}
                      alt=""
                      class="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <span class="line-clamp-2 px-1 py-1 text-[0.65rem] leading-tight text-neutral-300">
                    {w.label}
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
