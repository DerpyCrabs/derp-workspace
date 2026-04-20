import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const specsDir = path.join(root, 'e2e', 'specs')
const legacySpecs = new Set([
  'artifacts.spec.ts',
  'compositor-snapshot.spec.ts',
  'file-browser.spec.ts',
  'launcher-multimonitor.spec.ts',
  'native-windows.spec.ts',
  'perf-smoke.spec.ts',
  'restart-input.spec.ts',
  'restart-persistence.spec.ts',
  'shell-chrome-session.spec.ts',
  'shell-chrome.spec.ts',
  'snap-assist.spec.ts',
  'tab-groups.spec.ts',
  'taskbar-close.spec.ts',
  'taskbar-minimize.spec.ts',
  'text-editor.spec.ts',
  'x11-windows.spec.ts',
])
const blocked = new Set([
  'postJson',
  'runKeybind',
  'closeWindow',
  'crashWindow',
  'openShellTestWindow',
  'spawnNativeWindow',
  'spawnXtermWindow',
  'spawnXtermCommandWindow',
  'prepareFileBrowserFixtures',
  'resetFileBrowserFixtures',
])
const rawInputEndpoint = /['"]\/test\/input\//
const rawFloatingLayers = /shell_floating_layers/

function files(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...files(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

function importedNames(source, from) {
  const names = new Set()
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(re)) {
    if (match[2] !== from) continue
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

const failures = []
for (const file of files(specsDir)) {
  const rel = path.relative(specsDir, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')
  const names = importedNames(source, '../lib/runtime.ts')
  const bad = [...names].filter((name) => blocked.has(name))
  if (legacySpecs.has(rel)) continue
  if (bad.length > 0) {
    failures.push(`${rel}: import ${bad.join(', ')} from ../lib/runtime.ts via ../lib/user.ts, ../lib/setup.ts, or ../lib/oracle.ts`)
  }
  if (rawInputEndpoint.test(source)) {
    failures.push(`${rel}: use ../lib/user.ts helpers instead of direct /test/input endpoints`)
  }
  if (rawFloatingLayers.test(source)) {
    failures.push(`${rel}: use floating layer helpers from ../lib/oracle.ts instead of reading shell_floating_layers directly`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}
