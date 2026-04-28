import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const specsDir = path.join(root, 'e2e', 'specs')
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
const allowedRuntimeImports = new Map([
  ['artifacts.spec.ts', new Set(['crashWindow', 'postJson'])],
  ['compositor-snapshot.spec.ts', new Set(['spawnNativeWindow'])],
  ['custom-hotkeys.spec.ts', new Set(['postJson'])],
  ['file-browser.spec.ts', new Set(['prepareFileBrowserFixtures', 'postJson', 'resetFileBrowserFixtures'])],
  ['launcher-multimonitor.spec.ts', new Set(['closeWindow'])],
  ['native-windows.spec.ts', new Set(['closeWindow', 'postJson', 'runKeybind', 'spawnNativeWindow'])],
  ['restart-persistence.spec.ts', new Set(['openShellTestWindow', 'prepareFileBrowserFixtures', 'runKeybind', 'spawnNativeWindow'])],
  ['shell-chrome-session.spec.ts', new Set(['openShellTestWindow', 'postJson'])],
  ['shell-chrome.spec.ts', new Set(['openShellTestWindow', 'spawnNativeWindow'])],
  ['snap-assist.spec.ts', new Set(['postJson', 'runKeybind', 'spawnNativeWindow'])],
  ['tab-groups.spec.ts', new Set(['closeWindow', 'openShellTestWindow', 'postJson', 'runKeybind'])],
  ['taskbar-close.spec.ts', new Set(['openShellTestWindow', 'prepareFileBrowserFixtures'])],
  ['text-editor.spec.ts', new Set(['prepareFileBrowserFixtures'])],
  ['wayland-protocols.spec.ts', new Set(['spawnCommand'])],
  ['x11-windows.spec.ts', new Set(['runKeybind'])],
])
const allowedRawInputEndpoint = new Set([
  'native-windows.spec.ts',
  'snap-assist.spec.ts',
])
const allowedRawFloatingLayers = new Set(['shell-chrome.spec.ts'])
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
  const allowed = allowedRuntimeImports.get(rel) ?? new Set()
  const bad = [...names].filter((name) => blocked.has(name) && !allowed.has(name))
  if (bad.length > 0) {
    failures.push(`${rel}: import ${bad.join(', ')} from ../lib/runtime.ts via ../lib/user.ts, ../lib/setup.ts, or ../lib/oracle.ts`)
  }
  if (rawInputEndpoint.test(source) && !allowedRawInputEndpoint.has(rel)) {
    failures.push(`${rel}: use ../lib/user.ts helpers instead of direct /test/input endpoints`)
  }
  if (rawFloatingLayers.test(source) && !allowedRawFloatingLayers.has(rel)) {
    failures.push(`${rel}: use floating layer helpers from ../lib/oracle.ts instead of reading shell_floating_layers directly`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}
