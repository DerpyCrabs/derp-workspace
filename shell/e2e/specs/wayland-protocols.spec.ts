import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  artifactDir,
  assert,
  defineGroup,
  nativeBin,
  shellQuote,
  spawnCommand,
  waitFor,
} from '../lib/runtime.ts'

export default defineGroup(import.meta.url, ({ test }) => {
  test('advertises linux-drm-syncobj-v1 to Wayland clients', async ({ base }) => {
    const outputPath = path.join(artifactDir(), `drm-syncobj-globals-${Date.now()}.txt`)
    const command = [
      shellQuote(nativeBin()),
      '--require-global',
      'wp_linux_drm_syncobj_manager_v1',
      '--list-globals',
      '>',
      shellQuote(outputPath),
      '2>&1;',
      'printf',
      shellQuote('\\nexit:%s\\n'),
      '$?',
      '>>',
      shellQuote(outputPath),
    ].join(' ')
    await spawnCommand(base, `sh -lc ${shellQuote(command)}`)
    const output = await waitFor(
      'wait for linux-drm-syncobj-v1 registry probe',
      async () => {
        try {
          const text = await readFile(outputPath, 'utf8')
          return text.includes('\nexit:') ? text : null
        } catch {
          return null
        }
      },
      5000,
      100,
    )
    assert(output.includes('wp_linux_drm_syncobj_manager_v1 1'), output)
    assert(output.includes('\nexit:0\n'), output)
  })
})
