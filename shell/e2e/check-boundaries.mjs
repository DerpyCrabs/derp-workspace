import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const repoRoot = path.resolve(root, '..')
const specsDir = path.join(root, 'e2e', 'specs')
const directRuntimeHelpers = new Set([
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
  'spawnCommand',
])
const userRuntimeHelpers = new Set(['runKeybind'])
const allowedRawInputEndpoint = new Set([
  'native-windows.spec.ts',
  'snap-assist.spec.ts',
])
const allowedRawFloatingLayers = new Set(['shell-chrome.spec.ts'])
const rawInputEndpoint = /['"]\/test\/input\//
const rawFloatingLayers = /shell_floating_layers/
const timingHacks = [
  [/setTimeout\s*\(/, 'move timer-based waits into shared e2e runtime helpers'],
  [/Date\.now\(\)\s*\+\s*\d+/, 'use event/file driven waits instead of Date.now deadline polling'],
  [/new\s+Promise\s*\([^)]*setTimeout/s, 'use shared e2e runtime waits instead of promise sleep loops'],
  [/\bsleep\s+0\./, 'remove subsecond shell sleeps from e2e specs'],
  [/for\s+_\s+in\s+\$\(seq/, 'replace shell retry loops with event-driven probes'],
]

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
  const re = /import\s*\{([^{}]*?)\}\s*from\s*['"]([^'"]+)['"]/g
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
try {
  execFileSync(process.execPath, [path.join(repoRoot, 'wire_schema', 'generate.mjs'), '--check'], {
    cwd: repoRoot,
    stdio: 'pipe',
  })
} catch (err) {
  const stderr = err?.stderr?.toString?.() ?? ''
  failures.push(stderr.trim() || 'wire schema: generated files are stale')
}
for (const file of files(specsDir)) {
  const rel = path.relative(specsDir, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')
  const names = importedNames(source, '../lib/runtime.ts')
  const bad = [...names].filter((name) => directRuntimeHelpers.has(name))
  if (bad.length > 0) {
    failures.push(`${rel}: import ${bad.join(', ')} from ../lib/runtime.ts via ../lib/user.ts, ../lib/setup.ts, or ../lib/oracle.ts`)
  }
  const setupNames = importedNames(source, '../lib/setup.ts')
  const setupUserActions = [...setupNames].filter((name) => userRuntimeHelpers.has(name))
  if (setupUserActions.length > 0) {
    failures.push(`${rel}: import ${setupUserActions.join(', ')} from ../lib/user.ts instead of ../lib/setup.ts`)
  }
  if (rawInputEndpoint.test(source) && !allowedRawInputEndpoint.has(rel)) {
    failures.push(`${rel}: use ../lib/user.ts helpers instead of direct /test/input endpoints`)
  }
  if (rawFloatingLayers.test(source) && !allowedRawFloatingLayers.has(rel)) {
    failures.push(`${rel}: use floating layer helpers from ../lib/oracle.ts instead of reading shell_floating_layers directly`)
  }
  for (const [pattern, message] of timingHacks) {
    if (pattern.test(source)) {
      failures.push(`${rel}: ${message}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`)
  process.exit(1)
}
