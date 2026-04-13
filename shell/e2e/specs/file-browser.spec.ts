import { access, readFile, stat, writeFile } from 'node:fs/promises'

import {
  assert,
  defineGroup,
  getJson,
  prepareFileBrowserFixtures,
  resetFileBrowserFixtures,
  writeJsonArtifact,
  type ShellSnapshot,
} from '../lib/runtime.ts'

const WRITABLE_TEXT = 'Phase 1 writable fixture\nThis file should reset between runs.\n'
const READ_ONLY_TEXT = 'Phase 1 read-only fixture\nThis file should refuse direct writes.\n'

export default defineGroup(import.meta.url, ({ test }) => {
  test('file browser fixtures prepare deterministically and expose snapshot contract', async ({ base }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    for (const path of [
      fixtures.root_path,
      fixtures.empty_dir,
      fixtures.hidden_dir,
      fixtures.hidden_file,
      fixtures.hidden_dir_file,
      fixtures.writable_text,
      fixtures.read_only_text,
      fixtures.nested_text,
      fixtures.image_file,
      fixtures.pdf_file,
      fixtures.video_file,
      fixtures.unsupported_file,
    ]) {
      await access(path)
    }
    assert((await readFile(fixtures.writable_text, 'utf8')) === WRITABLE_TEXT, 'unexpected writable fixture contents')
    assert((await readFile(fixtures.read_only_text, 'utf8')) === READ_ONLY_TEXT, 'unexpected read-only fixture contents')
    const [imageStats, pdfStats, videoStats, unsupportedStats] = await Promise.all([
      stat(fixtures.image_file),
      stat(fixtures.pdf_file),
      stat(fixtures.video_file),
      stat(fixtures.unsupported_file),
    ])
    assert(imageStats.size > 0, 'expected image fixture bytes')
    assert(pdfStats.size > 0, 'expected pdf fixture bytes')
    assert(videoStats.size > 0, 'expected video fixture bytes')
    assert(unsupportedStats.size > 0, 'expected unsupported fixture bytes')
    const shell = await getJson<ShellSnapshot>(base, '/test/state/shell')
    assert(shell.file_browser && typeof shell.file_browser === 'object', 'missing file_browser snapshot section')
    assert(Array.isArray(shell.file_browser.rows), 'file_browser rows should be an array')
    assert(Array.isArray(shell.file_browser.breadcrumbs), 'file_browser breadcrumbs should be an array')
    assert(Array.isArray(shell.file_browser.primary_actions), 'file_browser primary_actions should be an array')
    assert(shell.file_browser.active_path === null, 'expected empty active_path before browser UI exists')
    assert(shell.file_browser.viewer_editor_title === null, 'expected empty viewer/editor title before UI exists')
    await writeJsonArtifact('file-browser-phase1-prepare.json', {
      fixtures,
      file_browser_snapshot: shell.file_browser,
    })
  })

  test('file browser fixtures reset writable changes and preserve read-only guardrails', async ({ base }) => {
    const fixtures = await prepareFileBrowserFixtures(base)
    const mutated = `${WRITABLE_TEXT}mutated during test\n`
    await writeFile(fixtures.writable_text, mutated, 'utf8')
    assert((await readFile(fixtures.writable_text, 'utf8')) === mutated, 'expected writable fixture mutation to stick before reset')
    let readOnlyWriteFailed = false
    try {
      await writeFile(fixtures.read_only_text, 'should fail\n', 'utf8')
    } catch {
      readOnlyWriteFailed = true
    }
    assert(readOnlyWriteFailed, 'expected read-only fixture write to fail')
    const reset = await resetFileBrowserFixtures(base)
    assert(reset.root_path === fixtures.root_path, 'fixture root path changed across reset')
    assert((await readFile(reset.writable_text, 'utf8')) === WRITABLE_TEXT, 'writable fixture did not reset')
    assert((await readFile(reset.read_only_text, 'utf8')) === READ_ONLY_TEXT, 'read-only fixture did not reset')
    await writeJsonArtifact('file-browser-phase1-reset.json', {
      prepared: fixtures,
      reset,
    })
  })
})
