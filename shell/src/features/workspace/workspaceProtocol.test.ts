/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WORKSPACE_DERIVED_FIELDS,
  WORKSPACE_MONITOR_LAYOUT_TYPES,
  WORKSPACE_MUTATION_TYPES,
  WORKSPACE_PROTOCOL_VERSION,
  WORKSPACE_SLOT_RULE_FIELDS,
  WORKSPACE_SLOT_RULE_OPS,
  WORKSPACE_STATE_FIELDS,
} from './workspaceProtocol'

type WorkspaceProtocolManifest = {
  version: number
  workspaceStateFields: string[]
  workspaceDerivedFields: string[]
  monitorLayoutTypes: string[]
  slotRuleFields: string[]
  slotRuleOps: string[]
  mutationTypes: string[]
}

function loadManifest(): WorkspaceProtocolManifest {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../resources/workspace-protocol.json'), 'utf8'))
}

describe('workspace protocol manifest', () => {
  it('matches the shell protocol constants', () => {
    const manifest = loadManifest()
    expect(WORKSPACE_PROTOCOL_VERSION).toBe(manifest.version)
    expect([...WORKSPACE_STATE_FIELDS]).toEqual(manifest.workspaceStateFields)
    expect([...WORKSPACE_DERIVED_FIELDS]).toEqual(manifest.workspaceDerivedFields)
    expect([...WORKSPACE_MONITOR_LAYOUT_TYPES]).toEqual(manifest.monitorLayoutTypes)
    expect([...WORKSPACE_SLOT_RULE_FIELDS]).toEqual(manifest.slotRuleFields)
    expect([...WORKSPACE_SLOT_RULE_OPS]).toEqual(manifest.slotRuleOps)
    expect([...WORKSPACE_MUTATION_TYPES]).toEqual(manifest.mutationTypes)
  })
})
