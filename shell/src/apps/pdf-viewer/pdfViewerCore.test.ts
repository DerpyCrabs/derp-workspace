import { describe, expect, it } from 'vitest'
import { isPdfFilePath } from './pdfViewerCore'

describe('pdfViewerCore', () => {
  it('detects pdf paths case-insensitively', () => {
    expect(isPdfFilePath('/docs/report.pdf')).toBe(true)
    expect(isPdfFilePath('/docs/report.PDF')).toBe(true)
    expect(isPdfFilePath('/docs/report.pdf.txt')).toBe(false)
    expect(isPdfFilePath('/docs/report')).toBe(false)
  })
})
