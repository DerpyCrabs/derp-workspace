import {
  assert,
  defineGroup,
  getJson,
  postJson,
  waitFor,
  writeJsonArtifact,
} from '../lib/runtime.ts'

type LockScreenSettings = {
  enabled: boolean
}

type LockScreenState = {
  enabled: boolean
  locked: boolean
  phase: string
  origin: string | null
  authenticating: boolean
  failed_attempts: number
  error: string
}

async function loadSettings(base: string): Promise<LockScreenSettings> {
  return getJson<LockScreenSettings>(base, '/settings_lock_screen')
}

async function saveSettings(base: string, settings: LockScreenSettings): Promise<void> {
  await postJson(base, '/settings_lock_screen', settings)
}

async function loadState(base: string): Promise<LockScreenState> {
  return getJson<LockScreenState>(base, '/lock_state')
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('lock screen is optional and authenticates through compositor state', async ({ base }) => {
    const original = await loadSettings(base)
    try {
      await saveSettings(base, { enabled: false })
      const disabled = await loadState(base)
      assert(disabled.enabled === false, 'lock screen should default to disabled in test setup')
      assert(disabled.locked === false, 'disabled lock screen should be unlocked')
      let rejected = false
      try {
        await postJson(base, '/lock', {})
      } catch (error) {
        void error
        rejected = true
      }
      assert(rejected, 'disabled built-in lock request should be rejected')

      await saveSettings(base, { enabled: true })
      await waitFor(
        'wait for enabled lock screen state',
        async () => ((await loadState(base)).enabled ? true : null),
        5000,
        100,
      )
      await postJson(base, '/lock', {})
      await waitFor(
        'wait for built-in lock',
        async () => {
          const state = await loadState(base)
          return state.locked && state.origin === 'builtin_shell' ? state : null
        },
        5000,
        100,
      )
      await postJson(base, '/unlock', { password: 'wrong-password' })
      const failed = await waitFor(
        'wait for failed unlock',
        async () => {
          const state = await loadState(base)
          return state.locked && state.failed_attempts >= 1 ? state : null
        },
        5000,
        100,
      )
      await postJson(base, '/unlock', { password: 'derp-e2e-lock' })
      const unlocked = await waitFor(
        'wait for successful unlock',
        async () => {
          const state = await loadState(base)
          return !state.locked && state.phase === 'unlocked' ? state : null
        },
        5000,
        100,
      )
      await writeJsonArtifact('lock-screen-state.json', { disabled, failed, unlocked })
    } finally {
      const state = await loadState(base)
      if (state.locked) {
        try {
          await postJson(base, '/unlock', { password: 'derp-e2e-lock' })
        } catch (error) {
          void error
          await postJson(base, '/unlock', { password: '' })
        }
      }
      await saveSettings(base, original)
    }
  })
})
