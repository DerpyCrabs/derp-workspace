import { describe, expect, it } from 'vitest'
import { isVideoFilePath, orderedVideoPathsFromDirectoryEntries } from '@/apps/video-viewer/videoViewerCore'
import type { FileBrowserEntry } from '@/apps/file-browser/fileBrowserBridge'

describe('videoViewerCore', () => {
  it('detects video extensions', () => {
    expect(isVideoFilePath('/a/b/x.MP4')).toBe(true)
    expect(isVideoFilePath('/x/y.webm')).toBe(true)
    expect(isVideoFilePath('/x/readme.md')).toBe(false)
    expect(isVideoFilePath('/noext')).toBe(false)
  })

  it('orders video paths from directory entries', () => {
    const entries: FileBrowserEntry[] = [
      {
        path: '/m/b.webm',
        name: 'b.webm',
        kind: 'file',
        hidden: false,
        symlink: false,
        writable: true,
        size: 1,
        modified_ms: 0,
      },
      {
        path: '/m/a.mp4',
        name: 'a.mp4',
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
    expect(orderedVideoPathsFromDirectoryEntries(entries)).toEqual(['/m/a.mp4', '/m/b.webm'])
  })
})
