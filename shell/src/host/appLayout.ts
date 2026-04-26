import { canvasOriginXY, rectGlobalToCanvasLocal, type CanvasOrigin } from '@/lib/shellCoords'
import type { LayoutScreen } from './types'

export function screensListForLayout(
  rows: LayoutScreen[],
  canvas: { w: number; h: number } | null,
  origin: { x: number; y: number } | null,
): LayoutScreen[] {
  if (rows.length > 0) return rows
  if (canvas && canvas.w > 0 && canvas.h > 0) {
    const { ox, oy } = canvasOriginXY(origin)
    return [
      {
        name: '',
        x: ox,
        y: oy,
        refresh_milli_hz: 0,
        width: canvas.w,
        height: canvas.h,
        transform: 0,
        vrr_supported: false,
        vrr_enabled: false,
      },
    ]
  }
  return []
}

export function layoutScreenCssRect(s: LayoutScreen, origin: CanvasOrigin): LayoutScreen {
  const loc = rectGlobalToCanvasLocal(s.x, s.y, s.width, s.height, origin)
  return {
    name: s.name,
    identity: s.identity,
    x: loc.x,
    y: loc.y,
    width: loc.w,
    height: loc.h,
    transform: s.transform,
    refresh_milli_hz: s.refresh_milli_hz,
    vrr_supported: s.vrr_supported,
    vrr_enabled: s.vrr_enabled,
  }
}

export function monitorRefreshLabel(milli: number): string {
  if (!milli || milli <= 0) return '—'
  const hz = milli / 1000
  const t = hz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${t} Hz`
}

export function formatMonitorPixels(width: number, height: number): string {
  return `${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`
}

export function physicalPixelsForScreen(
  screen: Pick<LayoutScreen, 'width' | 'height'>,
  outputGeom: { w: number; h: number } | null,
  outputPhysical: { w: number; h: number } | null,
) {
  if (!outputGeom || !outputPhysical) return { width: screen.width, height: screen.height }
  const sx = outputPhysical.w / Math.max(1, outputGeom.w)
  const sy = outputPhysical.h / Math.max(1, outputGeom.h)
  return {
    width: Math.max(1, Math.round(screen.width * sx)),
    height: Math.max(1, Math.round(screen.height * sy)),
  }
}

export function shellBuildLabelText(): string {
  const m = import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  const mode = m.env?.MODE
  const ver = m.env?.VITE_APP_VERSION
  const parts = [mode, ver].filter((x): x is string => typeof x === 'string' && x.length > 0)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

export function unionBBoxFromScreens(rows: LayoutScreen[]): { x: number; y: number; w: number; h: number } | null {
  if (rows.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxR = -Infinity
  let maxB = -Infinity
  for (const r of rows) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxR = Math.max(maxR, r.x + r.width)
    maxB = Math.max(maxB, r.y + r.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return {
    x: minX,
    y: minY,
    w: Math.max(1, Math.round(maxR - minX)),
    h: Math.max(1, Math.round(maxB - minY)),
  }
}
