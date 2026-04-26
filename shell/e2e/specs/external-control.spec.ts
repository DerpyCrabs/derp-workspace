import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  assert,
  compositorWindowById,
  defineGroup,
  getSnapshots,
  syncTest,
  waitForNativeFocus,
} from '../lib/runtime.ts'
import { openShellTestWindow, spawnNativeWindow } from '../lib/setup.ts'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const derpctlBin = process.env.DERP_E2E_DERPCTL_BIN || path.join(repoRoot, 'target', 'release', 'derpctl')

type DerpctlReply = {
  id: number
  ok: boolean
  result?: any
  error?: { code?: string; message?: string }
}

type EventLine = {
  event: string
  revision: number
  domains?: string[]
  state?: any
}

class JsonLineReader {
  private buffer = ''
  private queued: string[] = []
  private waiters: Array<{ resolve(line: string): void; reject(error: Error): void }> = []

  push(chunk: Buffer | string) {
    this.buffer += chunk.toString()
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(line)
      else this.queued.push(line)
    }
  }

  fail(error: Error) {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }

  next(): Promise<string> {
    const queued = this.queued.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    const index = this.buffer.indexOf('\n')
    if (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      return Promise.resolve(line)
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }
}

async function nextEventLine(lines: JsonLineReader, label: string): Promise<string> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      lines.next(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function derpctl(args: string[]): Promise<DerpctlReply> {
  const { stdout } = await execFileAsync(derpctlBin, args, { cwd: repoRoot })
  const reply = JSON.parse(stdout.trim()) as DerpctlReply
  if (!reply.ok) {
    throw new Error(`derpctl ${args.join(' ')} failed: ${reply.error?.message ?? 'unknown error'}`)
  }
  return reply
}

async function derpctlTransaction(actions: Array<{ method: string; params: Record<string, unknown> }>) {
  return derpctl(['transaction', JSON.stringify(actions)])
}

function eventStream(args: string[]) {
  const child = spawn(derpctlBin, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = new JsonLineReader()
  let stderr = ''
  child.stdout.on('data', (chunk) => lines.push(chunk))
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.on('exit', (code) => {
    if (code) {
      lines.fail(new Error(`derpctl events exited ${code}: ${stderr}`))
    }
  })
  return { child, lines }
}

export default defineGroup(import.meta.url, ({ test }) => {
  test('derpctl reads and mutates compositor-owned window state', async ({ base, state }) => {
    const stamp = Date.now()
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp External Control Red ${stamp}`,
      token: `external-control-red-${stamp}`,
      strip: 'red',
    })
    const shellHosted = await openShellTestWindow(base, state)
    const nativeId = native.window.window_id
    const shellHostedId = shellHosted.window.window_id
    state.spawnedNativeWindowIds.add(nativeId)

    const schema = await derpctl(['schema'])
    assert(Array.isArray(schema.result?.methods), 'schema missing methods')
    const commands = await derpctl(['commands'])
    assert(commands.result?.commands?.includes('window move'), 'commands missing window move')
    assert(commands.result?.commands?.includes('transaction'), 'commands missing transaction')

    const stateReply = await derpctl(['state', '--domains', 'outputs,windows,workspace,settings'])
    assert(Array.isArray(stateReply.result?.outputs), 'state outputs missing')
    assert(Array.isArray(stateReply.result?.windows), 'state windows missing')
    assert(stateReply.result?.workspace, 'state workspace missing')
    assert(stateReply.result?.settings, 'state settings missing')
    assert(
      stateReply.result.windows.some((window: any) => window.window_id === nativeId && window.shell_hosted === false),
      'state missing native window',
    )
    assert(
      stateReply.result.windows.some((window: any) => window.window_id === shellHostedId && window.shell_hosted === true),
      'state missing shell-hosted window',
    )

    await derpctlTransaction([
      { method: 'window.set_maximized', params: { window_id: nativeId, enabled: false } },
      { method: 'window.set_fullscreen', params: { window_id: nativeId, enabled: false } },
      { method: 'window.focus', params: { window_id: nativeId } },
    ])
    const focused = await waitForNativeFocus(base, nativeId)
    assert(focused.compositor.focused_window_id === nativeId, `expected focus ${nativeId}`)

    const before = compositorWindowById(focused.compositor, nativeId)
    assert(before, 'missing native window before move')
    const target = {
      x: before.x + 31,
      y: before.y + 27,
      width: Math.max(360, before.width),
      height: Math.max(260, before.height),
    }
    await derpctl([
      'window',
      'move',
      String(nativeId),
      '--x',
      String(target.x),
      '--y',
      String(target.y),
      '--width',
      String(target.width),
      '--height',
      String(target.height),
    ])
    await syncTest(base)
    const moved = await getSnapshots(base)
    const movedWindow = compositorWindowById(moved.compositor, nativeId)
    assert(movedWindow, 'missing native window after move')
    assert(movedWindow.x === target.x, `expected moved x ${target.x}, got ${movedWindow.x}`)
    assert(movedWindow.y === target.y, `expected moved y ${target.y}, got ${movedWindow.y}`)

    await derpctl(['window', 'maximize', String(nativeId), '--enabled', 'true'])
    await syncTest(base)
    const maximized = await getSnapshots(base)
    assert(compositorWindowById(maximized.compositor, nativeId)?.maximized === true, 'maximize did not apply')
    await derpctl(['window', 'maximize', String(nativeId), '--enabled', 'false'])

    await derpctl(['window', 'minimize', String(nativeId)])
    await syncTest(base)
    const minimized = await getSnapshots(base)
    assert(compositorWindowById(minimized.compositor, nativeId)?.minimized === true, 'minimize did not apply')
  })

  test('derpctl events stream snapshot then ordered changes', async ({ base, state }) => {
    const stamp = Date.now()
    const native = await spawnNativeWindow(base, state.knownWindowIds, {
      title: `Derp External Control Green ${stamp}`,
      token: `external-control-green-${stamp}`,
      strip: 'green',
    })
    const nativeId = native.window.window_id
    state.spawnedNativeWindowIds.add(nativeId)
    await derpctl(['window', 'maximize', String(nativeId), '--enabled', 'false'])
    const before = native.window
    const target = {
      x: before.x + 29,
      y: before.y + 23,
      width: Math.max(360, before.width),
      height: Math.max(260, before.height),
    }

    const stream = eventStream(['events', '--domains', 'windows,workspace'])
    try {
      const snapshot = JSON.parse(await nextEventLine(stream.lines, 'external-control snapshot')) as EventLine
      assert(snapshot.event === 'snapshot', `expected snapshot, got ${snapshot.event}`)
      assert(snapshot.domains?.includes('windows'), 'snapshot missing windows domain')
      assert(Array.isArray(snapshot.state?.windows), 'snapshot missing windows')

      await derpctlTransaction([
        {
          method: 'window.set_geometry',
          params: {
            window_id: nativeId,
            x: target.x,
            y: target.y,
            width: target.width,
            height: target.height,
          },
        },
        { method: 'window.focus', params: { window_id: nativeId } },
      ])
      const changed = JSON.parse(await nextEventLine(stream.lines, 'external-control changed event')) as EventLine
      assert(changed.event === 'changed', `expected changed, got ${changed.event}`)
      assert(changed.revision >= snapshot.revision, 'changed revision moved backwards')
      assert(changed.domains?.includes('windows'), 'changed event missing windows domain')
      const changedWindow = changed.state?.windows?.find((window: any) => window.window_id === nativeId)
      assert(changedWindow?.x === target.x, `changed event missing moved x ${target.x}`)
      assert(changedWindow?.y === target.y, `changed event missing moved y ${target.y}`)
    } finally {
      stream.child.kill('SIGTERM')
      await derpctl(['window', 'maximize', String(nativeId), '--enabled', 'false'])
      await getSnapshots(base)
    }
  })
})
