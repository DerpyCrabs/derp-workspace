import { afterEach, describe, expect, it, vi } from 'vitest'
import { DERP_AUDIO_STATE_CHANGED_EVENT, dispatchAudioStateChanged } from './audioEvents'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dispatchAudioStateChanged', () => {
  it('emits the shared audio state change event', async () => {
    vi.stubGlobal('window', new EventTarget())
    const detail = await new Promise<unknown>((resolve) => {
      window.addEventListener(
        DERP_AUDIO_STATE_CHANGED_EVENT,
        (event) => resolve((event as CustomEvent).detail),
        { once: true },
      )
      dispatchAudioStateChanged({ reason: 'volume_overlay' })
    })

    expect(detail).toEqual({ reason: 'volume_overlay' })
  })
})
