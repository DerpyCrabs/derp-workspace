import { For, Show, createMemo, createSignal, onMount, onCleanup } from 'solid-js'
import { shellHttpBase } from '../shellHttp'
import {
  getThemeSettings,
  prefersDarkTheme,
  resolveThemeMode,
  setTheme,
  subscribeThemeStore,
  type ThemeMode,
  type ThemePalette,
  type ThemeSettings,
} from '../themeStore'
import {
  SOLID_COLOR_PRESETS,
  hexToSolidRgba,
  normalizeHexColor,
} from './appearanceBackground'

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

const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

const THEME_PALETTES: {
  value: ThemePalette
  label: string
  swatches: [string, string, string]
}[] = [
  { value: 'default', label: 'Default', swatches: ['#7f99b9', '#242932', '#c9d2de'] },
  { value: 'caffeine', label: 'Caffeine', swatches: ['#9b7656', '#372922', '#d8c1ad'] },
  { value: 'cosmic-night', label: 'Cosmic Night', swatches: ['#916ee2', '#2e2746', '#d6c9f8'] },
]

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

function row(label: string, value: string) {
  return (
    <div class="grid grid-cols-[7.2rem_1fr] gap-x-2 gap-y-1 text-[0.8rem] leading-snug">
      <span class="text-(--shell-text-dim)">{label}</span>
      <span class="min-w-0 break-all text-(--shell-text-muted)">{value}</span>
    </div>
  )
}

export function SettingsAppearancePage(props: {
  setDesktopBackgroundJson: (json: string) => void
}) {
  const [themeSettings, setThemeSettings] = createSignal<ThemeSettings>(getThemeSettings())
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal<string | null>(null)
  const [applyErr, setApplyErr] = createSignal<string | null>(null)
  const [payload, setPayload] = createSignal<GnomeDesktopBackgroundPayload | null>(null)
  const [wallBusy, setWallBusy] = createSignal(false)
  const [wallErr, setWallErr] = createSignal<string | null>(null)
  const [wallpapers, setWallpapers] = createSignal<GnomeWallpaperChoice[]>([])
  const [wallQuery, setWallQuery] = createSignal('')
  const [solidColorHex, setSolidColorHex] = createSignal('#1a1a1a')

  const filteredWallpapers = createMemo(() => {
    const q = wallQuery().trim().toLowerCase()
    const list = wallpapers()
    if (!q) return list
    return list.filter((w) => w.label.toLowerCase().includes(q) || w.file_uri.toLowerCase().includes(q))
  })

  const resolvedMode = createMemo(() => resolveThemeMode(themeSettings().mode, prefersDarkTheme()))

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
      const nextSolid = normalizeHexColor(data.primary_color || '')
      if (nextSolid) setSolidColorHex(nextSolid)
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

  function applySolidColorToCompositor() {
    const color = normalizeHexColor(solidColorHex())
    if (!color) {
      setApplyErr('Solid color must be a 6-digit hex value like #334455.')
      return
    }
    setApplyErr(null)
    setSolidColorHex(color)
    const wire: DesktopBackgroundWire = {
      mode: 'solid',
      solid_rgba: hexToSolidRgba(color),
      image_path: '',
      fit: 'fill',
    }
    props.setDesktopBackgroundJson(JSON.stringify(wire))
  }

  onMount(() => {
    const unsubscribe = subscribeThemeStore((next) => setThemeSettings(next))
    onCleanup(unsubscribe)
    void load()
    void loadWallpaperChoices()
  })

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold tracking-wide text-(--shell-text)">Appearance</h2>
        <button
          type="button"
          class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
          disabled={busy() || !shellHttpBase()}
          onClick={() => void load()}
        >
          {busy() ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Theme
          </p>
          <span class="text-[0.78rem] text-(--shell-text-muted)">
            {themeSettings().mode === 'system'
              ? `Following system (${resolvedMode()})`
              : `${themeSettings().mode} mode`}
          </span>
        </div>
        <div class="mb-3 flex flex-wrap gap-2">
          <For each={THEME_MODES}>
            {(mode) => (
              <button
                type="button"
                class="cursor-pointer rounded-md px-3 py-1.5 text-[0.8rem] font-medium"
                classList={{
                  'border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover)':
                    themeSettings().mode === mode.value,
                  'border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover)':
                    themeSettings().mode !== mode.value,
                }}
                onClick={() => setTheme(themeSettings().palette, mode.value)}
              >
                {mode.label}
              </button>
            )}
          </For>
        </div>
        <div class="grid gap-2 md:grid-cols-3">
          <For each={THEME_PALETTES}>
            {(palette) => (
              <button
                type="button"
                class="cursor-pointer rounded-lg border p-2 text-left transition-colors"
                classList={{
                  'border-(--shell-accent-border) bg-(--shell-accent-soft)':
                    themeSettings().palette === palette.value,
                  'border-(--shell-border) bg-(--shell-surface-elevated) hover:bg-(--shell-surface-hover)':
                    themeSettings().palette !== palette.value,
                }}
                onClick={() => setTheme(palette.value, themeSettings().mode)}
              >
                <div class="mb-2 flex gap-1.5">
                  <For each={palette.swatches}>
                    {(swatch) => (
                      <span
                        class="h-3.5 w-3.5 rounded-full border border-(--shell-border)"
                        style={{ background: swatch }}
                      />
                    )}
                  </For>
                </div>
                <div class="text-[0.84rem] font-semibold text-(--shell-text)">{palette.label}</div>
                <div class="text-[0.74rem] text-(--shell-text-dim)">
                  {palette.value === 'default'
                    ? 'Balanced shell palette'
                    : palette.value === 'caffeine'
                      ? 'Warm browns and amber accents'
                      : 'Purple-forward night palette'}
                </div>
              </button>
            )}
          </For>
        </div>
        <p class="mt-3 text-[0.75rem] text-(--shell-text-dim)">
          Theme choice is saved in <span class="text-(--shell-text-muted)">settings.json</span>.
        </p>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
          Desktop background (compositor)
        </p>
        <p class="mb-3 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
          Wallpaper is drawn under the shell and clients. The shell desktop area is transparent so this layer
          shows through. Values below are read from GNOME (
          <span class="text-(--shell-text-muted)">org.gnome.desktop.background</span>); use Apply to
          mirror them into derp and{' '}
          <span class="text-(--shell-text-muted)">display.json</span> (persisted on the next DRM save).
        </p>
        <div class="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
            disabled={!payload() || typeof window.__derpShellWireSend !== 'function'}
            onClick={() => applyGnomeToCompositor()}
          >
            Apply GNOME wallpaper to compositor
          </button>
        </div>
        <Show when={applyErr()}>
          <p class="text-(--shell-warning-text) mb-2 text-[0.8rem]">{applyErr()}</p>
        </Show>
        <Show when={err()}>
          <p class="text-(--shell-warning-text) text-[0.8rem]">{err()}</p>
        </Show>
        <Show when={payload()} keyed>
          {(p) => (
            <div class="space-y-2">
              {row('Picture', fileUriToDisplay(p.picture_uri || '(empty)'))}
              {p.picture_uri_dark ? row('Picture (dark)', fileUriToDisplay(p.picture_uri_dark)) : null}
              {row('Fit (GNOME)', p.picture_options)}
              {row('Primary color', p.primary_color)}
              {row('Secondary color', p.secondary_color)}
              {row('Shading', p.color_shading_type)}
            </div>
          )}
        </Show>
        <div class="mt-4 rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) p-3">
          <p class="mb-2 text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            Solid color
          </p>
          <p class="mb-3 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
            Set the compositor backdrop to a flat color and persist it with the next display config save.
          </p>
          <div class="mb-3 flex flex-wrap items-center gap-3">
            <div
              class="h-10 w-14 rounded border border-(--shell-border)"
              style={{ background: normalizeHexColor(solidColorHex()) ?? '#1a1a1a' }}
            />
            <input
              type="text"
              inputMode="text"
              spellcheck={false}
              placeholder="#1a1a1a"
              class="border border-(--shell-input-border) bg-(--shell-input-bg) text-(--shell-text) placeholder:text-(--shell-text-dim) focus:border-(--shell-input-focus) focus:outline-none focus-visible:border-(--shell-input-focus) focus-visible:outline-none w-full max-w-44 rounded-md px-2.5 py-1.5 text-[0.82rem]"
              value={solidColorHex()}
              onInput={(e) => setSolidColorHex(e.currentTarget.value)}
            />
            <button
              type="button"
              class="border border-(--shell-accent-border) bg-(--shell-accent) text-(--shell-accent-foreground) hover:bg-(--shell-accent-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
              disabled={typeof window.__derpShellWireSend !== 'function'}
              onClick={() => applySolidColorToCompositor()}
            >
              Apply solid color
            </button>
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={SOLID_COLOR_PRESETS}>
              {(color) => (
                <button
                  type="button"
                  class="h-8 w-8 cursor-pointer rounded-full border-2 border-(--shell-border) transition-transform hover:scale-105"
                  style={{ background: color }}
                  title={color}
                  onClick={() => setSolidColorHex(color)}
                />
              )}
            </For>
          </div>
        </div>
      </div>
      <div class="border border-(--shell-border) bg-(--shell-surface) text-(--shell-text) rounded-lg px-3 py-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p class="text-[0.72rem] font-semibold uppercase tracking-wide text-(--shell-text-dim)">
            GNOME wallpapers
          </p>
          <button
            type="button"
            class="border border-(--shell-border-strong) bg-(--shell-control-muted-bg) text-(--shell-control-muted-text) hover:bg-(--shell-control-muted-hover) cursor-pointer rounded-lg px-2.5 py-1.5 text-[0.78rem] font-medium disabled:cursor-default"
            disabled={wallBusy() || !shellHttpBase()}
            onClick={() => void loadWallpaperChoices()}
          >
            {wallBusy() ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <p class="mb-2 text-[0.78rem] leading-relaxed text-(--shell-text-dim)">
          Images from{' '}
          <span class="text-(--shell-text-muted)">/usr/share/gnome-background-properties</span> and{' '}
          <span class="text-(--shell-text-muted)">/usr/share/backgrounds</span>. Click a tile to set the
          compositor backdrop (fit follows GNOME settings above when loaded).
        </p>
        <input
          type="search"
          placeholder="Filter by name or path…"
          class="border border-(--shell-input-border) bg-(--shell-input-bg) text-(--shell-text) placeholder:text-(--shell-text-dim) focus:border-(--shell-input-focus) focus:outline-none focus-visible:border-(--shell-input-focus) focus-visible:outline-none mb-3 w-full max-w-md rounded-md px-2.5 py-1.5 text-[0.82rem]"
          value={wallQuery()}
          onInput={(e) => setWallQuery(e.currentTarget.value)}
        />
        <Show when={wallErr()}>
          <p class="text-(--shell-warning-text) mb-2 text-[0.8rem]">{wallErr()}</p>
        </Show>
        <Show when={!wallBusy() && wallpapers().length === 0 && !wallErr()}>
          <p class="text-[0.78rem] text-(--shell-text-dim)">No wallpapers found on this system.</p>
        </Show>
        <div class="border border-(--shell-border) bg-(--shell-surface) max-h-[min(28rem,55vh)] overflow-auto rounded-md p-2">
          <div class="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            <For each={filteredWallpapers()}>
              {(w) => (
                <button
                  type="button"
                  disabled={typeof window.__derpShellWireSend !== 'function'}
                  class="group flex cursor-pointer flex-col overflow-hidden rounded-md border border-(--shell-border) bg-(--shell-surface-elevated) text-left transition-colors hover:border-(--shell-accent-border) hover:bg-(--shell-surface-hover) disabled:cursor-default"
                  onClick={() => applyWallpaperToCompositor(w)}
                >
                  <div class="aspect-4/3 w-full overflow-hidden bg-(--shell-surface-inset)">
                    <img
                      src={wallpaperThumbUrl(w.file_uri)}
                      alt=""
                      class="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <span class="line-clamp-2 px-1 py-1 text-[0.65rem] leading-tight text-(--shell-text-muted)">
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
