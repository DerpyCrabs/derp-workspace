import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from 'solid-js'
import type { LayoutScreen } from '@/host/types'
import type { ShellLockScreenState } from './lockScreenState'

export function LockScreenOverlay(props: {
  state: Accessor<ShellLockScreenState>
  screens: Accessor<LayoutScreen[]>
  canvasOrigin: Accessor<{ x: number; y: number } | null>
  submitPassword: (password: string) => Promise<void>
}) {
  const [password, setPassword] = createSignal('')
  const [localError, setLocalError] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(new Date())
  const visible = createMemo(() => props.state().locked || props.state().phase !== 'unlocked')
  const clock = createMemo(() => now().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const date = createMemo(() => now().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))
  const user = createMemo(() => {
    const raw = globalThis.window?.navigator?.userAgent ? '' : ''
    return raw || 'Derp session'
  })
  const timer = window.setInterval(() => setNow(new Date()), 30_000)
  onCleanup(() => window.clearInterval(timer))

  async function submit() {
    if (!password() || props.state().authenticating) return
    setLocalError(null)
    try {
      await props.submitPassword(password())
      setPassword('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Show when={visible()}>
      <div
        data-lock-screen-overlay
        class="fixed inset-0 z-[3000000] overflow-hidden bg-black text-white"
        tabIndex={-1}
        onContextMenu={(event) => event.preventDefault()}
      >
        <For each={props.screens()}>
          {(screen) => {
            const origin = props.canvasOrigin()
            const left = screen.x - (origin?.x ?? 0)
            const top = screen.y - (origin?.y ?? 0)
            return (
              <div
                data-lock-screen-output={screen.name}
                class="absolute flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden bg-neutral-950 px-8 py-10"
                style={{
                  left: `${left}px`,
                  top: `${top}px`,
                  width: `${screen.width}px`,
                  height: `${screen.height}px`,
                }}
              >
                <div class="mb-10 text-center">
                  <div class="text-6xl font-semibold leading-none text-white">{clock()}</div>
                  <div class="mt-3 text-base font-medium text-white/70">{date()}</div>
                </div>
                <form
                  class="flex w-full max-w-sm flex-col items-stretch gap-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submit()
                  }}
                >
                  <div class="text-center text-sm font-medium text-white/70">{user()}</div>
                  <input
                    data-lock-screen-password
                    class="h-11 rounded-md border border-white/15 bg-white/10 px-3 text-center text-base text-white outline-none placeholder:text-white/40 focus:border-white/45 focus:bg-white/15"
                    type="password"
                    autocomplete="current-password"
                    placeholder="Password"
                    value={password()}
                    disabled={props.state().authenticating || props.state().origin !== 'builtin_shell'}
                    autofocus
                    onInput={(event) => setPassword(event.currentTarget.value)}
                  />
                  <button
                    data-lock-screen-submit
                    class="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black outline-none hover:bg-white/90 disabled:cursor-default disabled:bg-white/35 disabled:text-black/55"
                    type="submit"
                    disabled={!password() || props.state().authenticating || props.state().origin !== 'builtin_shell'}
                  >
                    {props.state().authenticating ? 'Unlocking...' : 'Unlock'}
                  </button>
                  <Show when={props.state().origin === 'external_protocol'}>
                    <div class="text-center text-sm font-medium text-white/65">Locked by an external client</div>
                  </Show>
                  <Show when={props.state().error || localError()}>
                    <div class="min-h-5 text-center text-sm font-medium text-red-200">
                      {props.state().error || localError()}
                    </div>
                  </Show>
                </form>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
