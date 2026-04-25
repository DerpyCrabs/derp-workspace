import {
  KEY,
  NATIVE_APP_ID,
  assert,
  compositorWindowById,
  defineGroup,
  getSnapshots,
  shellWindowById,
  tapSuperShortcut,
  taskbarEntry,
  waitFor,
  writeJsonArtifact,
} from '../lib/runtime.ts'
import { spawnNativeWindow } from '../lib/setup.ts'

const EMPTY_SCRATCHPADS = { items: [] }

async function saveScratchpads(base: string, body: object): Promise<void> {
  const response = await fetch(`${base}/settings_scratchpads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`settings_scratchpads failed: ${response.status}`)
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('scratchpad rule hides native by default and hotkey toggles it', async ({ base, state }) => {
    const title = `Scratchpad Native ${Date.now()}`
    let windowId: number | null = null
    await saveScratchpads(base, {
      items: [
        {
          id: 'native-pad',
          name: 'Native pad',
          hotkey: 'Super+grave',
          default_visible: false,
          placement: {
            monitor: 'focused',
            width_percent: 70,
            height_percent: 60,
          },
          rules: [{ field: 'title', op: 'equals', value: title }],
        },
      ],
    })
    state.afterSuiteCleanup.push((cleanupBase) => saveScratchpads(cleanupBase, EMPTY_SCRATCHPADS))
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title,
      token: 'scratchpad-native',
      strip: 'green',
      width: 640,
      height: 420,
    })
    windowId = spawned.window.window_id
    state.spawnedNativeWindowIds.add(windowId)

    const hidden = await waitFor(
      'wait for scratchpad hidden native',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const shellWindow = shellWindowById(shell, windowId!)
        const compositorWindow = compositorWindowById(compositor, windowId!)
        if (!shellWindow?.scratchpad || !shellWindow.minimized || !compositorWindow?.minimized) return null
        if (taskbarEntry(shell, windowId!)) return null
        return { compositor, shell }
      },
      5000,
      50,
    )
    await writeJsonArtifact('scratchpad-hidden.json', hidden)

    await tapSuperShortcut(base, KEY.grave)
    const shown = await waitFor(
      'wait for scratchpad shown native',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const shellWindow = shellWindowById(shell, windowId!)
        const compositorWindow = compositorWindowById(compositor, windowId!)
        if (!shellWindow?.scratchpad || shellWindow.minimized || !compositorWindow || compositorWindow.minimized) return null
        if (taskbarEntry(shell, windowId!)) return null
        const output = compositor.outputs.find((entry) => entry.name === compositorWindow.output_name) ?? compositor.outputs[0]
        if (!output) return null
        const cx = compositorWindow.x + compositorWindow.width / 2
        const cy = compositorWindow.y + compositorWindow.height / 2
        assert(cx >= output.x && cx <= output.x + output.width, 'scratchpad center x should be on output')
        assert(cy >= output.y && cy <= output.y + output.height, 'scratchpad center y should be on output')
        return { compositor, shell }
      },
      5000,
      50,
    )
    await writeJsonArtifact('scratchpad-shown.json', shown)

    await tapSuperShortcut(base, KEY.grave)
    await waitFor(
      'wait for scratchpad hidden after toggle',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const shellWindow = shellWindowById(shell, windowId!)
        const compositorWindow = compositorWindowById(compositor, windowId!)
        return shellWindow?.scratchpad && shellWindow.minimized && compositorWindow?.minimized ? shell : null
      },
      5000,
      50,
    )
  })

  test('scratchpad settings can match app id and start visible', async ({ base, state }) => {
    const title = `Scratchpad Visible ${Date.now()}`
    let windowId: number | null = null
    await saveScratchpads(base, {
      items: [
        {
          id: 'visible-native-pad',
          name: 'Visible native pad',
          hotkey: 'Super+shift+grave',
          default_visible: true,
          placement: {
            monitor: 'focused',
            width_percent: 60,
            height_percent: 50,
          },
          rules: [{ field: 'app_id', op: 'equals', value: NATIVE_APP_ID }],
        },
      ],
    })
    state.afterSuiteCleanup.push((cleanupBase) => saveScratchpads(cleanupBase, EMPTY_SCRATCHPADS))
    const spawned = await spawnNativeWindow(base, state.knownWindowIds, {
      title,
      token: 'scratchpad-visible-native',
      strip: 'red',
      width: 520,
      height: 360,
    })
    windowId = spawned.window.window_id
    state.spawnedNativeWindowIds.add(windowId)
    await waitFor(
      'wait for visible scratchpad native',
      async () => {
        const { compositor, shell } = await getSnapshots(base)
        const shellWindow = shellWindowById(shell, windowId!)
        const compositorWindow = compositorWindowById(compositor, windowId!)
        if (!shellWindow?.scratchpad || shellWindow.minimized || !compositorWindow || compositorWindow.minimized) return null
        if (taskbarEntry(shell, windowId!)) return null
        return shell
      },
      5000,
      50,
    )
  })
})
