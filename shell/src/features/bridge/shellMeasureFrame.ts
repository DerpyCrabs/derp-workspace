import { noteShellDomMeasure } from './shellPerfCounters'

export type ShellMeasureEnv = {
  main: HTMLElement
  outputGeom: { w: number; h: number }
  origin: { x: number; y: number } | null
}

export type ShellMeasureFrame = ShellMeasureEnv & {
  mainRect: DOMRect
}
let activeFrame: ShellMeasureFrame | null = null

export function createShellMeasureFrame(env: ShellMeasureEnv | null): ShellMeasureFrame | null {
  if (!env) return null
  const start = performance.now()
  const mainRect = env.main.getBoundingClientRect()
  noteShellDomMeasure(1, performance.now() - start)
  return {
    ...env,
    mainRect,
  }
}

export function currentShellMeasureFrame(): ShellMeasureFrame | null {
  return activeFrame
}

export function withShellMeasureFrame<T>(getEnv: () => ShellMeasureEnv | null, fn: () => T): T {
  const previous = activeFrame
  activeFrame = createShellMeasureFrame(getEnv())
  try {
    return fn()
  } finally {
    activeFrame = previous
  }
}
