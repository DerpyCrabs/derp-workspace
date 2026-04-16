import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { ExclusionHudZone } from '@/host/types'

type DebugHudRuntimeOptions = {
  debugHudFrameVisible: Accessor<boolean>
}

export function createDebugHudRuntime(options: DebugHudRuntimeOptions) {
  const [hudFps, setHudFps] = createSignal(0)
  const [rootPointerDowns, setRootPointerDowns] = createSignal(0)
  const [exclusionZonesHud, setExclusionZonesHud] = createSignal<ExclusionHudZone[]>([])

  createEffect(() => {
    if (!options.debugHudFrameVisible()) {
      setHudFps(0)
      return
    }
    let hudFpsFrames = 0
    let hudFpsLast = performance.now()
    let hudFpsRaf = 0
    const hudFpsStep = (now: number) => {
      hudFpsFrames += 1
      const dt = now - hudFpsLast
      if (dt >= 500) {
        setHudFps(Math.round((hudFpsFrames * 1000) / dt))
        hudFpsFrames = 0
        hudFpsLast = now
      }
      hudFpsRaf = requestAnimationFrame(hudFpsStep)
    }
    hudFpsRaf = requestAnimationFrame(hudFpsStep)
    onCleanup(() => cancelAnimationFrame(hudFpsRaf))
  })

  return {
    hudFps,
    rootPointerDowns,
    exclusionZonesHud,
    setExclusionZonesHud,
    bumpRootPointerDowns: () => setRootPointerDowns((n) => n + 1),
  }
}
