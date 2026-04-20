import { fileBrowserReadUrl } from '@/apps/file-browser/fileBrowserBridge'

function parentDirPosix(filePath: string): string {
  const t = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  if (i < 0) return ''
  if (i === 0) return '/'
  return t.slice(0, i)
}

function posixResolveFromDir(fromDir: string, rel: string): string | null {
  const relNorm = rel.replace(/\\/g, '/')
  const baseParts =
    !fromDir || fromDir === '/'
      ? []
      : fromDir
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
  const stack = [...baseParts]
  for (const seg of relNorm.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else stack.push(seg)
  }
  if (stack.length === 0) return '/'
  return `/${stack.join('/')}`
}

export function resolveMarkdownImageReadUrl(
  viewingFilePath: string,
  rawSrc: string,
  base: string | null,
): string | null {
  let src = rawSrc
  try {
    src = decodeURIComponent(src)
  } catch {
    /* noop */
  }
  if (/^https?:\/\//i.test(src)) return src
  if (src.startsWith('data:')) return src
  if (src.startsWith('/')) return null
  const normView = viewingFilePath.replace(/\\/g, '/')
  const fromDir = parentDirPosix(normView)
  const resolved = posixResolveFromDir(fromDir, src)
  if (!resolved) return null
  const read = fileBrowserReadUrl(resolved, base)
  return read || null
}
