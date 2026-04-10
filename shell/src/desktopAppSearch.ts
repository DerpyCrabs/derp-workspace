import type { DesktopAppEntry } from './shellBridge'

type SearchMatch = {
  category: number
  matchType: number
  tokenPos: number
}

const PREFIX_MATCH = 1
const SUBSTRING_MATCH = 2

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
}

function tokenizeForSearch(value: string): string[] {
  const normalized = normalizeForSearch(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return normalized === '' ? [] : normalized.split(/\s+/)
}

function bestTokenMatch(value: string | undefined, queryToken: string, category: number): SearchMatch | null {
  if (!value) return null
  const tokens = tokenizeForSearch(value)
  let best: SearchMatch | null = null
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith(queryToken)) {
      const match = { category, matchType: PREFIX_MATCH, tokenPos: index }
      if (
        !best ||
        match.matchType < best.matchType ||
        (match.matchType === best.matchType && match.category < best.category) ||
        (match.matchType === best.matchType &&
          match.category === best.category &&
          match.tokenPos < best.tokenPos)
      ) {
        best = match
      }
      continue
    }
    if (token.includes(queryToken)) {
      const match = { category, matchType: SUBSTRING_MATCH, tokenPos: index }
      if (
        !best ||
        match.matchType < best.matchType ||
        (match.matchType === best.matchType && match.category < best.category) ||
        (match.matchType === best.matchType &&
          match.category === best.category &&
          match.tokenPos < best.tokenPos)
      ) {
        best = match
      }
    }
  }
  return best
}

function bestFieldMatch(app: DesktopAppEntry, queryToken: string): SearchMatch | null {
  const matches = [
    bestTokenMatch(app.name, queryToken, 1),
    bestTokenMatch(app.executable, queryToken, 2),
    ...(app.keywords ?? []).map((keyword) => bestTokenMatch(keyword, queryToken, 3)),
    bestTokenMatch(app.generic_name, queryToken, 4),
    bestTokenMatch(app.full_name, queryToken, 5),
  ].filter((value): value is SearchMatch => value !== null)
  if (matches.length === 0) return null
  matches.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType - b.matchType
    if (a.category !== b.category) return a.category - b.category
    return a.tokenPos - b.tokenPos
  })
  return matches[0]
}

export function searchDesktopApplications(apps: DesktopAppEntry[], query: string): DesktopAppEntry[] {
  const queryTokens = tokenizeForSearch(query)
  if (queryTokens.length === 0) return apps
  return apps
    .map((app, index) => {
      let category = 0
      let matchType = 0
      let tokenPos = 0
      for (const queryToken of queryTokens) {
        const match = bestFieldMatch(app, queryToken)
        if (!match) return null
        category = Math.max(category, match.category)
        matchType = Math.max(matchType, match.matchType)
        tokenPos = Math.max(tokenPos, match.tokenPos)
      }
      return { app, index, category, matchType, tokenPos }
    })
    .filter(
      (
        value,
      ): value is { app: DesktopAppEntry; index: number; category: number; matchType: number; tokenPos: number } =>
        value !== null,
    )
    .sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType - b.matchType
      if (a.category !== b.category) return a.category - b.category
      if (a.tokenPos !== b.tokenPos) return a.tokenPos - b.tokenPos
      return a.index - b.index
    })
    .map((entry) => entry.app)
}
