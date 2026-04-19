import { describe, expect, it } from 'vitest'
import type { FileBrowserEntry } from '@/apps/file-browser/fileBrowserBridge'
import { isImageFilePath, orderedImagePathsFromDirectoryEntries } from '@/apps/image-viewer/imageViewerCore'

describe('imageViewerCore', () => {
  it('detects common image extensions case-insensitively', () => {
    expect(isImageFilePath('/a/b/Photo.JPG')).toBe(true)
    expect(isImageFilePath('/x/y.PNG')).toBe(true)
    expect(isImageFilePath('/readme.md')).toBe(false)
    expect(isImageFilePath('/noext')).toBe(false)
  })

  it('orders image paths from directory entries', () => {
    const entries: FileBrowserEntry[] = [
      {
        path: '/m/a.png',
        name: 'a.png',
        kind: 'file',
        hidden: false,
        symlink: false,
        writable: true,
        size: 1,
        modified_ms: 0,
      },
      {
        path: '/m/sub',
        name: 'sub',
        kind: 'directory',
        hidden: false,
        symlink: false,
        writable: true,
        size: null,
        modified_ms: null,
      },
      {
        path: '/m/b.jpg',
        name: 'b.jpg',
        kind: 'file',
        hidden: false,
        symlink: false,
        writable: true,
        size: 1,
        modified_ms: 0,
      },
      {
        path: '/m/readme.txt',
        name: 'readme.txt',
        kind: 'file',
        hidden: false,
        symlink: false,
        writable: true,
        size: 1,
        modified_ms: 0,
      },
    ]
    expect(orderedImagePathsFromDirectoryEntries(entries)).toEqual(['/m/a.png', '/m/b.jpg'])
  })
})
