import { NATIVE_APP_ID, SHELL_TEST_APP_ID, defineGroup, type TestContext, type WindowSnapshot } from '../lib/runtime.ts'
import { clickRect, dragBetweenPoints } from '../lib/user.ts'
import {
  assert,
  assertRectMinSize,
  getJson,
  shellWindowById,
  waitFor,
  waitForWindowGone,
  waitForWindowRaised,
  windowControls,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/oracle.ts'
import { openShellTestWindow, spawnNativeWindow } from '../lib/setup.ts'

type ParityCase = {
  label: string
  open: (context: TestContext) => Promise<WindowSnapshot>
}

async function clickMaximize(base: string, windowId: number, label: string) {
  const maximize = await waitFor(
    `${label} maximize control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.maximize
      return rect && rect.width >= 12 && rect.height >= 12 ? rect : null
    },
    5000,
    100,
  )
  await clickRect(base, maximize)
}

async function clickClose(base: string, windowId: number, label: string) {
  const close = await waitFor(
    `${label} close control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.close
      return rect && rect.width >= 12 && rect.height >= 12 ? rect : null
    },
    5000,
    100,
  )
  await clickRect(base, close)
}

async function dragTitlebarDown(base: string, windowId: number, label: string) {
  const titlebar = await waitFor(
    `${label} titlebar control`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const rect = windowControls(shell, windowId)?.titlebar
      return rect && rect.width >= 80 && rect.height >= 16 ? rect : null
    },
    5000,
    100,
  )
  assertRectMinSize(`${label} titlebar`, titlebar, 80, 16)
  const start = {
    x: titlebar.x + Math.min(Math.max(titlebar.width * 0.35, 260), titlebar.width - 260),
    y: titlebar.y + titlebar.height / 2,
  }
  await dragBetweenPoints(base, start.x, start.y, start.x + 180, start.y + 120, 16)
}

async function waitForMaximized(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} maximized`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shellWindowById(shell, windowId)
      return window?.maximized ? { shell, window } : null
    },
    5000,
    100,
  )
}

async function waitForFloating(base: string, windowId: number, label: string) {
  return waitFor(
    `${label} floating`,
    async () => {
      const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
      const window = shellWindowById(shell, windowId)
      return window && !window.maximized && !window.fullscreen ? { shell, window } : null
    },
    5000,
    100,
  )
}

async function runChromeContract(context: TestContext, parity: ParityCase) {
  const { base } = context
  const opened = await parity.open(context)
  await waitForWindowRaised(base, opened.window_id)
  const focused = await getJson<ShellSnapshot>(base, '/test/state/shell')
  const visible = shellWindowById(focused, opened.window_id)
  assert(visible && !visible.minimized, `${parity.label} window visible after open`)

  await clickMaximize(base, opened.window_id, parity.label)
  const maximized = await waitForMaximized(base, opened.window_id, parity.label)
  assert(maximized.window.maximized, `${parity.label} should maximize through chrome click`)

  await dragTitlebarDown(base, opened.window_id, parity.label)
  const restored = await waitForFloating(base, opened.window_id, parity.label)
  assert(restored.window.width > 100 && restored.window.height > 100, `${parity.label} restore keeps usable size`)

  await clickClose(base, opened.window_id, parity.label)
  await waitForWindowGone(base, opened.window_id, 5000)
  await writeJsonArtifact(`window-parity-${parity.label}.json`, {
    windowId: opened.window_id,
    appId: opened.app_id,
    maximized: maximized.window,
    restored: restored.window,
  })
}

export default defineGroup(import.meta.url, ({ test }) => {
  const cases: ParityCase[] = [
    {
      label: 'shell-hosted',
      open: async ({ base, state }) => {
        const opened = await openShellTestWindow(base, state)
        assert(opened.window.app_id === SHELL_TEST_APP_ID, `expected ${SHELL_TEST_APP_ID}, got ${opened.window.app_id}`)
        return opened.window
      },
    },
    {
      label: 'native',
      open: async ({ base, state }) => {
        const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
          title: 'Derp Native Parity Probe',
          token: 'native-parity-probe',
          strip: 'red',
        })
        state.spawnedNativeWindowIds.add(spawned.window.window_id)
        assert(spawned.window.app_id === NATIVE_APP_ID, `expected ${NATIVE_APP_ID}, got ${spawned.window.app_id}`)
        return spawned.window
      },
    },
  ]

  for (const parity of cases) {
    test(`${parity.label} window chrome follows common contract`, async (context) => {
      await runChromeContract(context, parity)
    })
  }
})
