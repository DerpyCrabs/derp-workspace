import { describe, expect, it } from 'vitest'
import { sanitizeShellAudioState } from './audioState'

describe('sanitizeShellAudioState', () => {
  it('keeps valid devices and streams', () => {
    const state = sanitizeShellAudioState({
      backend: 'pipewire',
      sinks: [
        {
          id: 69,
          label: 'Intel HDMI',
          subtitle: 'alsa_output.pci-test.hdmi-stereo',
          name: 'alsa_output.pci-test.hdmi-stereo',
          volume_percent: 55,
          volume_known: true,
          muted: false,
          is_default: true,
        },
      ],
      sources: [],
      playback_streams: [
        {
          id: 77,
          label: 'YouTube',
          subtitle: 'Firefox | firefox.output',
          name: 'firefox.output',
          app_name: 'Firefox',
          volume_percent: 30,
          volume_known: true,
          muted: false,
        },
      ],
      capture_streams: [],
    })

    expect(state.sinks[0]).toMatchObject({
      id: 69,
      label: 'Intel HDMI',
      is_default: true,
    })
    expect(state.playback_streams[0]).toMatchObject({
      id: 77,
      app_name: 'Firefox',
    })
  })

  it('drops malformed rows and falls back to empty lists', () => {
    const state = sanitizeShellAudioState({
      sinks: [{ id: 'bad' }, { id: 0 }, { id: 1, label: 'OK', name: 'ok' }],
      sources: 'nope',
      playback_streams: [{ id: 4, label: 'App', name: 'app', app_name: 'App' }],
      capture_streams: [{ id: -5, label: 'bad' }],
    })

    expect(state.backend).toBe('pipewire')
    expect(state.sinks).toHaveLength(1)
    expect(state.sinks[0].id).toBe(1)
    expect(state.sources).toEqual([])
    expect(state.playback_streams).toHaveLength(1)
    expect(state.capture_streams).toEqual([])
  })

  it('clamps amplified volumes to 100 percent', () => {
    const state = sanitizeShellAudioState({
      sinks: [{ id: 1, label: 'Speakers', name: 'speakers', volume_percent: 102 }],
      sources: [{ id: 2, label: 'Mic', name: 'mic', volume_percent: 160 }],
      playback_streams: [{ id: 3, label: 'App', name: 'app', app_name: 'App', volume_percent: 140 }],
      capture_streams: [{ id: 4, label: 'Capture', name: 'capture', app_name: 'Capture', volume_percent: 101 }],
    })

    expect(state.sinks[0]?.volume_percent).toBe(100)
    expect(state.sources[0]?.volume_percent).toBe(100)
    expect(state.playback_streams[0]?.volume_percent).toBe(100)
    expect(state.capture_streams[0]?.volume_percent).toBe(100)
  })
})
