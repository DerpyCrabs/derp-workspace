#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const appId = process.argv[2]
if (!appId || !/^[a-z][a-z0-9-]*$/.test(appId)) {
  process.stderr.write(
    'Usage: node scripts/new-shell-app.mjs <id>\nExample: node scripts/new-shell-app.mjs notes\n',
  )
  process.exit(1)
}
const pascal = appId.replace(/(^|-)([a-z])/g, (_, __, c) => String(c).toUpperCase())
const dir = path.join(root, 'shell', 'src', 'apps', appId)
const cmp = `${pascal}Window.tsx`
fs.mkdirSync(dir, { recursive: true })
const windowPath = path.join(dir, cmp)
if (fs.existsSync(windowPath)) {
  process.stderr.write(`Refusing to overwrite existing ${windowPath}\n`)
  process.exit(1)
}
fs.writeFileSync(
  windowPath,
  `import type { Accessor } from 'solid-js'

type ${pascal}WindowProps = {
  windowId: number
  title: Accessor<string>
}

export function ${pascal}Window(props: ${pascal}WindowProps) {
  return (
    <div class="flex h-full min-h-0 flex-col bg-(--shell-surface-panel) p-4 text-left text-sm text-(--shell-text)">
      <p class="font-semibold">{props.title()}</p>
      <p class="mt-2 text-(--shell-text-dim)">Window {props.windowId}</p>
    </div>
  )
}
`,
)
process.stdout.write(
  `Created ${path.relative(root, windowPath)}\nNext: add a ${pascal} entry to shellHostedAppsRegistry (window id range, programsMenu if needed), wire open in backedShellWindowActions, render in shellHostedWindowContent, and SavedShellWindowKind in sessionSnapshot if sessions should restore it.\n`,
)
