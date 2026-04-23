import { describe, expect, it } from 'vitest'
import { FILE_BROWSER_FAVORITES_PATH } from './fileBrowserFilesSettings'
import type { FileBrowserEntry, FileBrowserRoot } from './fileBrowserBridge'
import {
  buildBreadcrumbs,
  customIconNameForPath,
  fileBrowserEntryCanOpenInShell,
  fileBrowserTitleForPath,
  formatEntryModified,
  formatEntrySize,
  normalizeDisplayName,
  normalizeFilesSettingsPath,
  pathWithinRoot,
  posixBasename,
  posixDirname,
  rootLabelForPath,
} from './fileBrowserPresentation'

function entry(path: string, kind = 'file', name = ''): FileBrowserEntry {
  return {
    path,
    name,
    kind,
    hidden: false,
    symlink: false,
    writable: true,
    size: null,
    modified_ms: null,
  }
}

const roots: FileBrowserRoot[] = [
  { path: '/', label: 'Computer', kind: 'root' },
  { path: '/home/crab', label: 'Home', kind: 'home' },
  { path: '/home/crab/projects', label: 'Projects', kind: 'folder' },
]

describe('fileBrowserPresentation', () => {
  it('matches paths only inside root boundaries', () => {
    expect(pathWithinRoot('/home/crab/docs', '/home/crab')).toBe(true)
    expect(pathWithinRoot('/home/crab2/docs', '/home/crab')).toBe(false)
    expect(pathWithinRoot('/tmp/a', '/')).toBe(true)
    expect(pathWithinRoot(null, '/')).toBe(false)
  })

  it('uses deepest root for labels and breadcrumbs', () => {
    expect(rootLabelForPath('/home/crab/projects/derp', roots)).toBe('Projects')
    expect(buildBreadcrumbs('/home/crab/projects/derp/shell', roots)).toEqual([
      { path: '/home/crab/projects', label: 'Projects' },
      { path: '/home/crab/projects/derp', label: 'derp' },
      { path: '/home/crab/projects/derp/shell', label: 'shell' },
    ])
  })

  it('builds fallback breadcrumbs without known roots', () => {
    expect(buildBreadcrumbs('/opt/derp/bin', [])).toEqual([
      { path: '/', label: 'Computer' },
      { path: '/opt', label: 'opt' },
      { path: '/opt/derp', label: 'derp' },
      { path: '/opt/derp/bin', label: 'bin' },
    ])
  })

  it('normalizes file settings paths and names', () => {
    expect(normalizeFilesSettingsPath('C:\\Users\\crab\\Desktop')).toBe('C:/Users/crab/Desktop')
    expect(normalizeDisplayName(entry('/tmp/readme.md', 'file', ''))).toBe('/tmp/readme.md')
    expect(normalizeDisplayName(entry('/tmp/readme.md', 'file', 'readme.md'))).toBe('readme.md')
  })

  it('formats sizes and missing modified dates', () => {
    expect(formatEntrySize(null)).toBe('—')
    expect(formatEntrySize(512)).toBe('512 B')
    expect(formatEntrySize(1536)).toBe('1.5 KB')
    expect(formatEntrySize(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatEntryModified(null)).toBe('—')
  })

  it('handles posix path names and window titles', () => {
    expect(posixDirname('/home/crab/docs/readme.md')).toBe('/home/crab/docs')
    expect(posixDirname('/home/crab/docs/')).toBe('/home/crab')
    expect(posixDirname('/')).toBe('/')
    expect(posixBasename('/home/crab/docs/readme.md')).toBe('readme.md')
    expect(posixBasename('/')).toBe('/')
    expect(fileBrowserTitleForPath(null)).toBe('Files')
    expect(fileBrowserTitleForPath('/')).toBe('Files')
    expect(fileBrowserTitleForPath(FILE_BROWSER_FAVORITES_PATH)).toBe('Favorites')
    expect(fileBrowserTitleForPath('/home/crab/docs')).toBe('docs')
  })

  it('classifies shell-openable entries', () => {
    expect(fileBrowserEntryCanOpenInShell(entry('/tmp/docs', 'directory'))).toBe(true)
    expect(fileBrowserEntryCanOpenInShell(entry('/tmp/photo.PNG'))).toBe(true)
    expect(fileBrowserEntryCanOpenInShell(entry('/tmp/movie.webm'))).toBe(true)
    expect(fileBrowserEntryCanOpenInShell(entry('/tmp/readme.md'))).toBe(true)
    expect(fileBrowserEntryCanOpenInShell(entry('/tmp/archive.zip'))).toBe(false)
  })

  it('resolves custom icon paths after slash normalization', () => {
    expect(customIconNameForPath('C:\\Users\\crab\\Desktop', { 'C:/Users/crab/Desktop': 'folder-star' })).toBe('folder-star')
    expect(customIconNameForPath('/tmp/none', {})).toBe(null)
  })
})
