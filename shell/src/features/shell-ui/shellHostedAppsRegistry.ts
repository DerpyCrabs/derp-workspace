import type { BackedShellWindowKind } from '@/features/shell-ui/backedShellWindows'

export type ShellHostedProgramsMenuDef = {
  kind: BackedShellWindowKind
  label: string
  badge?: string
  title?: string
  matchTokens: string[]
}

export type ShellHostedAppRegistryEntry = {
  kind: BackedShellWindowKind
  programsMenu?: ShellHostedProgramsMenuDef
  sessionCaptureCompositorFallback?: boolean
}

export const SHELL_HOSTED_APP_REGISTRY: ShellHostedAppRegistryEntry[] = [
  {
    kind: 'debug',
    sessionCaptureCompositorFallback: false,
  },
  {
    kind: 'settings',
    sessionCaptureCompositorFallback: false,
  },
  {
    kind: 'test',
    sessionCaptureCompositorFallback: false,
  },
  {
    kind: 'file_browser',
    sessionCaptureCompositorFallback: true,
    programsMenu: {
      kind: 'file_browser',
      label: 'Files',
      badge: 'shell',
      title: 'Open the shell file browser',
      matchTokens: ['files', 'browser', 'folder', 'shell'],
    },
  },
]

const registryByKind = new Map<BackedShellWindowKind, ShellHostedAppRegistryEntry>(
  SHELL_HOSTED_APP_REGISTRY.map((e) => [e.kind, e]),
)

export function shellHostedRegistryEntry(kind: BackedShellWindowKind): ShellHostedAppRegistryEntry | undefined {
  return registryByKind.get(kind)
}

export function shellHostedProgramsMenuDefinitions(): ShellHostedProgramsMenuDef[] {
  const out: ShellHostedProgramsMenuDef[] = []
  for (const entry of SHELL_HOSTED_APP_REGISTRY) {
    if (entry.programsMenu) out.push(entry.programsMenu)
  }
  return out
}

export function shellHostedKindUsesCompositorSessionCapture(kind: BackedShellWindowKind): boolean {
  return registryByKind.get(kind)?.sessionCaptureCompositorFallback === true
}

export function shellHostedProgramsBuiltinMatchesQuery(queryLower: string, tokens: readonly string[]): boolean {
  if (queryLower.length === 0) return true
  return tokens.some((token) => token.includes(queryLower) || queryLower.includes(token))
}
