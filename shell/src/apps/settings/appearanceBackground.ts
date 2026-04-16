export const SOLID_COLOR_PRESETS = ['#1a1a1a', '#242932', '#2e2746', '#372922', '#0f172a', '#111827']

export function hexToSolidRgba(hex: string): [number, number, number, number] {
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

export function normalizeHexColor(value: string): string | null {
  const s = value.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
  return `#${s.toLowerCase()}`
}

export function solidRgbaToHex(rgba: [number, number, number, number]): string {
  const toByte = (v: number) => {
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(255, Math.round(v * 255)))
  }
  return `#${[rgba[0], rgba[1], rgba[2]].map((v) => toByte(v).toString(16).padStart(2, '0')).join('')}`
}
