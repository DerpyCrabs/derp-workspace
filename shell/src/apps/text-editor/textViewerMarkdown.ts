import MarkdownIt from 'markdown-it'

const imageExtRe = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif)$/i

export function preprocessObsidianImages(content: string): string {
  return content.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
    const pipeIdx = inner.indexOf('|')
    const filename = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim()
    if (!imageExtRe.test(filename)) return _match
    const alt = (pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : filename) || filename
    return `![${alt}](<${filename}>)`
  })
}

function stripAngleSrc(src: string): string {
  return src.replace(/^<([\s\S]*)>$/, '$1').trim()
}

export function createMarkdownRenderer(
  resolveImageUrl: (src: string) => string | null,
): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true })
  const defaultImageRender =
    md.renderer.rules.image ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const raw = token.attrGet('src')
    if (!raw) return ''
    const stripped = stripAngleSrc(raw)
    const resolved = resolveImageUrl(stripped) ?? resolveImageUrl(raw)
    if (resolved === null) return ''
    token.attrSet('src', resolved)
    return defaultImageRender(tokens, idx, options, env, self)
  }

  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    function (t, i, o, _e, s) {
      return s.renderToken(t, i, o)
    }
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href')
    if (href?.startsWith('http://') || href?.startsWith('https://')) {
      tokens[idx].attrSet('target', '_blank')
      tokens[idx].attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  return md
}
