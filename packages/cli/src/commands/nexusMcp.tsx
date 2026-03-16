import type { Command } from '../commands.js'
import type { NexusBootstrapResult } from '../nexus-bootstrap.js'
import { NexusMcpPanel } from '../components/NexusMcpPanel.js'
import React from 'react'
import { loadConfig, writeConfig } from '@nexuscode/core'
import type { NexusConfig } from '@nexuscode/core'

function deepMerge<T extends object>(target: T, patch: Partial<T>): T {
  const out = { ...target }
  for (const k of Object.keys(patch) as (keyof T)[]) {
    const v = patch[k]
    if (v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (target as any)[k] === 'object') {
      (out as any)[k] = deepMerge((target as any)[k] ?? {}, v)
    } else if (v !== undefined) {
      (out as any)[k] = v
    }
  }
  return out
}

export function createNexusMcpCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'mcp',
    description: 'Manage MCP servers — enable or disable connections',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'mcp'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const config = await loadConfig(cwd)
      const onSave = async (patch: Partial<NexusConfig>) => {
        const current = await loadConfig(cwd)
        const merged = deepMerge(current, patch) as NexusConfig
        writeConfig(merged, cwd)
      }
      return (
        <NexusMcpPanel
          initialConfig={config}
          cwd={cwd}
          onSave={onSave}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
