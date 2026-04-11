export const DERP_AUDIO_STATE_CHANGED_EVENT = 'derp-audio-state-changed'

export type DerpAudioStateChangedReason = 'volume_overlay'

export type DerpAudioStateChangedDetail = {
  reason: DerpAudioStateChangedReason
}

export function dispatchAudioStateChanged(detail: DerpAudioStateChangedDetail) {
  window.dispatchEvent(new CustomEvent(DERP_AUDIO_STATE_CHANGED_EVENT, { detail }))
}
