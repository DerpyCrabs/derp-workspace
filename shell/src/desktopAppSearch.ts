import { desktopAppLaunchCount, type DesktopAppUsageCounts } from './desktopAppUsage'
import type { DesktopAppEntry } from './shellBridge'

type SearchMatch = {
  category: number
  matchType: number
  tokenPos: number
}

type PreparedSearchField = {
  category: number
  tokens: string[]
}

type PreparedSearchApp = {
  fields: PreparedSearchField[]
}

const PREFIX_MATCH = 1
const SUBSTRING_MATCH = 2
const preparedSearchApps = new WeakMap<DesktopAppEntry, PreparedSearchApp>()

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

function bestPreparedTokenMatch(tokens: string[], queryToken: string, category: number): SearchMatch | null {
  if (tokens.length === 0) return null
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

function prepareSearchApp(app: DesktopAppEntry): PreparedSearchApp {
  const cached = preparedSearchApps.get(app)
  if (cached) return cached
  const prepared = {
    fields: [
      { category: 1, tokens: tokenizeForSearch(app.name) },
      { category: 2, tokens: tokenizeForSearch(app.executable ?? '') },
      ...(app.keywords ?? []).map((keyword) => ({
        category: 3,
        tokens: tokenizeForSearch(keyword),
      })),
      { category: 4, tokens: tokenizeForSearch(app.generic_name ?? '') },
      { category: 5, tokens: tokenizeForSearch(app.full_name ?? '') },
    ],
  }
  preparedSearchApps.set(app, prepared)
  return prepared
}

function bestFieldMatch(app: DesktopAppEntry, queryToken: string): SearchMatch | null {
  const matches = prepareSearchApp(app).fields
    .map((field) => bestPreparedTokenMatch(field.tokens, queryToken, field.category))
    .filter((value): value is SearchMatch => value !== null)
  if (matches.length === 0) return null
  matches.sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType - b.matchType
    if (a.category !== b.category) return a.category - b.category
    return a.tokenPos - b.tokenPos
  })
  return matches[0]
}

export function searchDesktopApplications(
  apps: DesktopAppEntry[],
  query: string,
  usageCounts: DesktopAppUsageCounts = {},
): DesktopAppEntry[] {
  const queryTokens = tokenizeForSearch(query)
  if (queryTokens.length === 0) {
    return apps
      .map((app, index) => ({
        app,
        index,
        launchCount: desktopAppLaunchCount(app, usageCounts),
      }))
      .sort((a, b) => {
        if (a.launchCount !== b.launchCount) return b.launchCount - a.launchCount
        return a.index - b.index
      })
      .map((entry) => entry.app)
  }
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
      return {
        app,
        index,
        category,
        matchType,
        tokenPos,
        launchCount: desktopAppLaunchCount(app, usageCounts),
      }
    })
    .filter(
      (
        value,
      ): value is {
        app: DesktopAppEntry
        index: number
        category: number
        matchType: number
        tokenPos: number
        launchCount: number
      } =>
        value !== null,
    )
    .sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType - b.matchType
      if (a.category !== b.category) return a.category - b.category
      if (a.launchCount !== b.launchCount) return b.launchCount - a.launchCount
      if (a.tokenPos !== b.tokenPos) return a.tokenPos - b.tokenPos
      return a.index - b.index
    })
    .map((entry) => entry.app)
}
