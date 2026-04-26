import type { ShellContextMenuItem } from '@/host/contextMenu'

export type CommandPaletteCategoryId = 'apps' | 'windows' | 'settings' | 'workspace'

export type CommandPaletteItem = ShellContextMenuItem & {
  id: string
  category: CommandPaletteCategoryId
  categoryLabel: string
  subtitle?: string
  keywords?: string[]
  score?: number
  defaultRank?: number
  showOnEmpty?: boolean
}

export const COMMAND_PALETTE_CATEGORY_ORDER: CommandPaletteCategoryId[] = [
  'apps',
  'windows',
  'settings',
  'workspace',
]

const categoryOrder = new Map(COMMAND_PALETTE_CATEGORY_ORDER.map((category, index) => [category, index]))

export function normalizeCommandText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
}

export function tokenizeCommandQuery(query: string): string[] {
  const normalized = normalizeCommandText(query).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return normalized === '' ? [] : normalized.split(/\s+/)
}

function itemSearchFields(item: CommandPaletteItem): string[] {
  return [
    item.label,
    item.subtitle ?? '',
    item.categoryLabel,
    item.title ?? '',
    ...(item.keywords ?? []),
  ].filter((value) => value.trim().length > 0)
}

function tokenScore(field: string, token: string): number {
  const normalized = normalizeCommandText(field)
  if (normalized === token) return 120
  const words = tokenizeCommandQuery(field)
  if (words.some((word) => word === token)) return 105
  if (words.some((word) => word.startsWith(token))) return 82
  if (normalized.startsWith(token)) return 76
  if (normalized.includes(token)) return 48
  return 0
}

export function scoreCommandPaletteItem(item: CommandPaletteItem, query: string): number | null {
  const tokens = tokenizeCommandQuery(query)
  if (tokens.length === 0) return item.showOnEmpty === false ? null : item.defaultRank ?? item.score ?? 0
  const fields = itemSearchFields(item)
  let total = item.score ?? 0
  for (const token of tokens) {
    let best = 0
    for (const field of fields) {
      best = Math.max(best, tokenScore(field, token))
    }
    if (best === 0) return null
    total += best
  }
  return total
}

export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  return items
    .map((item, index) => {
      const score = scoreCommandPaletteItem(item, query)
      return score === null ? null : { item, index, score }
    })
    .filter((entry): entry is { item: CommandPaletteItem; index: number; score: number } => entry !== null)
    .sort((left, right) => {
      const categoryDelta =
        (categoryOrder.get(left.item.category) ?? 99) - (categoryOrder.get(right.item.category) ?? 99)
      if (categoryDelta !== 0) return categoryDelta
      if (left.score !== right.score) return right.score - left.score
      const defaultDelta = (right.item.defaultRank ?? 0) - (left.item.defaultRank ?? 0)
      if (defaultDelta !== 0) return defaultDelta
      return left.index - right.index
    })
    .map((entry) => entry.item)
}
