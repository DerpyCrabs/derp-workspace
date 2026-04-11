import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const tsxBin = process.platform === 'win32'
  ? path.join(repoRoot, 'shell', 'node_modules', '.bin', 'tsx.cmd')
  : path.join(repoRoot, 'shell', 'node_modules', '.bin', 'tsx')

const child = spawn(tsxBin, [path.join(here, 'run.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  throw error
})
