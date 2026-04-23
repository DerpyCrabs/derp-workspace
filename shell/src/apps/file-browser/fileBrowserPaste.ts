export type FileBrowserPasteData = {
  kind: 'text' | 'image' | 'file'
  contentBase64: string
  suggestedName: string
  previewText: string | null
  previewDataUrl: string | null
  size: number | null
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function textFileName(): string {
  return `pasted-${Date.now()}.txt`
}

function imageFileName(type: string): string {
  const ext = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  return `image-${Date.now()}.${ext}`
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  return /\.(txt|md|json|csv|log|yaml|yml|toml|ini|conf|sh|js|ts|tsx|css|html|rs|py)$/i.test(file.name)
}

async function pasteDataFromFile(file: File): Promise<FileBrowserPasteData> {
  if (file.type.startsWith('image/')) {
    const dataUrl = await readFileAsDataUrl(file)
    return {
      kind: 'image',
      contentBase64: dataUrl.split(',')[1] ?? '',
      suggestedName: file.name || imageFileName(file.type),
      previewText: null,
      previewDataUrl: dataUrl,
      size: file.size,
    }
  }
  if (isTextFile(file)) {
    const text = await readFileAsText(file)
    return {
      kind: 'text',
      contentBase64: bytesToBase64(new TextEncoder().encode(text)),
      suggestedName: file.name || textFileName(),
      previewText: text,
      previewDataUrl: null,
      size: file.size,
    }
  }
  const dataUrl = await readFileAsDataUrl(file)
  return {
    kind: 'file',
    contentBase64: dataUrl.split(',')[1] ?? '',
    suggestedName: file.name || `file-${Date.now()}`,
    previewText: null,
    previewDataUrl: null,
    size: file.size,
  }
}

export async function extractFileBrowserPasteData(data: DataTransfer | null): Promise<FileBrowserPasteData | null> {
  if (!data) return null
  if (data.files?.length) return pasteDataFromFile(data.files[0]!)
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return pasteDataFromFile(file)
  }
  const text = data.getData('text/plain')
  if (text.trim()) {
    return {
      kind: 'text',
      contentBase64: bytesToBase64(new TextEncoder().encode(text)),
      suggestedName: textFileName(),
      previewText: text,
      previewDataUrl: null,
      size: new Blob([text]).size,
    }
  }
  const html = data.getData('text/html')
  if (html.trim()) {
    const textFromHtml =
      new DOMParser().parseFromString(html, 'text/html').body?.textContent?.trim() || html.replace(/<[^>]+>/g, ' ').trim()
    if (!textFromHtml) return null
    return {
      kind: 'text',
      contentBase64: bytesToBase64(new TextEncoder().encode(textFromHtml)),
      suggestedName: textFileName(),
      previewText: textFromHtml,
      previewDataUrl: null,
      size: new Blob([textFromHtml]).size,
    }
  }
  return null
}

export function fileToBase64(file: File): Promise<string> {
  return readFileAsDataUrl(file).then((dataUrl) => dataUrl.split(',')[1] ?? '')
}
