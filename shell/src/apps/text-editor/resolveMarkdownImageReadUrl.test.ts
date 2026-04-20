import { describe, expect, it } from 'vitest'
import { resolveMarkdownImageReadUrl } from '@/apps/text-editor/resolveMarkdownImageReadUrl'

describe('resolveMarkdownImageReadUrl', () => {
  const base = 'http://127.0.0.1:9'

  it('returns https URL unchanged', () => {
    expect(resolveMarkdownImageReadUrl('/a/b.md', 'https://ex/img.png', base)).toBe('https://ex/img.png')
  })

  it('resolves relative path to file_browser read URL', () => {
    const out = resolveMarkdownImageReadUrl('/fixture/notes/x.md', '../media/p.png', base)
    expect(out).toBe('http://127.0.0.1:9/file_browser/read?p=%2Ffixture%2Fmedia%2Fp.png')
  })

  it('returns null for absolute local path', () => {
    expect(resolveMarkdownImageReadUrl('/a/b.md', '/etc/passwd', base)).toBe(null)
  })

  it('returns null when path escapes roots', () => {
    expect(resolveMarkdownImageReadUrl('/a/b/c.md', '../../../etc/passwd', base)).toBe(null)
  })
})
