const TEXT_EDITOR_EXT = new Set([
  'bash',
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'css',
  'cxx',
  'env',
  'gitignore',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'less',
  'lock',
  'log',
  'mjs',
  'properties',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

export function isTextEditorFilePath(path: string): boolean {
  const base = path.split(/[/\\]/).filter(Boolean).pop() ?? ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile' || lower === 'cargo.lock' || lower === '.env') return true
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  const ext = lower.slice(dot + 1)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return true
  return TEXT_EDITOR_EXT.has(ext)
}

export function isMarkdownFilePath(path: string): boolean {
  const base = path.split(/[/\\]/).filter(Boolean).pop() ?? ''
  const lower = base.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')
}
