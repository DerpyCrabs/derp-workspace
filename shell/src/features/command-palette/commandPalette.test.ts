import { describe, expect, it } from 'vitest'
import {
  filterCommandPaletteItems,
  scoreCommandPaletteItem,
  type CommandPaletteItem,
} from './commandPalette'

function item(input: Partial<CommandPaletteItem> & Pick<CommandPaletteItem, 'id' | 'category' | 'label'>): CommandPaletteItem {
  return {
    categoryLabel:
      input.category === 'apps'
        ? 'Apps'
        : input.category === 'windows'
          ? 'Windows'
          : input.category === 'settings'
            ? 'Settings'
            : 'Workspace',
    action: () => {},
    ...input,
  }
}

describe('command palette search', () => {
  it('matches labels, subtitles, categories, and keywords', () => {
    const notifications = item({
      id: 'settings:notifications',
      category: 'settings',
      label: 'Notifications',
      subtitle: 'Open Settings',
      keywords: ['banners', 'history'],
    })
    expect(scoreCommandPaletteItem(notifications, 'banner')).toBeGreaterThan(0)
    expect(scoreCommandPaletteItem(notifications, 'open settings')).toBeGreaterThan(0)
    expect(scoreCommandPaletteItem(notifications, 'missing')).toBeNull()
  })

  it('keeps category grouping stable while ranking matches inside each group', () => {
    const results = filterCommandPaletteItems(
      [
        item({ id: 'window:1', category: 'windows', label: 'Settings window', score: 50 }),
        item({ id: 'app:settings', category: 'apps', label: 'Settings', score: 10 }),
        item({ id: 'settings:appearance', category: 'settings', label: 'Appearance', keywords: ['theme'] }),
        item({ id: 'settings:notifications', category: 'settings', label: 'Notifications', keywords: ['theme'], score: 20 }),
      ],
      'settings',
    )
    expect(results.map((result) => result.id)).toEqual([
      'app:settings',
      'window:1',
      'settings:notifications',
      'settings:appearance',
    ])
  })

  it('uses default ranks for empty query and hides opt-out commands', () => {
    const results = filterCommandPaletteItems(
      [
        item({ id: 'app:low', category: 'apps', label: 'Low', defaultRank: 1 }),
        item({ id: 'app:high', category: 'apps', label: 'High', defaultRank: 9 }),
        item({ id: 'workspace:hidden', category: 'workspace', label: 'Hidden', showOnEmpty: false }),
      ],
      '',
    )
    expect(results.map((result) => result.id)).toEqual(['app:high', 'app:low'])
  })

  it('lets providers break otherwise equal matches without searching badges', () => {
    const results = filterCommandPaletteItems(
      [
        item({ id: 'app:desktop-shell', category: 'apps', label: 'Terminal', keywords: ['shell'], score: 64000 }),
        item({ id: 'app:files', category: 'apps', label: 'Files', keywords: ['shell'], score: 100000 }),
        item({ id: 'settings:display', category: 'settings', label: 'Displays', badge: 'shell' }),
      ],
      'shell',
    )
    expect(results.map((result) => result.id)).toEqual(['app:files', 'app:desktop-shell'])
  })
})
