import type { Command } from '../commands.js'
import type { NexusBootstrapResult } from '../nexus-bootstrap.js'
import { NexusModelPanel } from '../components/NexusModelPanel.js'
import React from 'react'
import { loadConfig, writeConfig, getModelsCatalog } from '@nexuscode/core'
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

export function createNexusModelCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'model',
    description: 'Choose LLM: free models from catalog or enter custom model ID',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'model'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const [config, catalog] = await Promise.all([
        loadConfig(cwd),
        getModelsCatalog().catch((e) => ({ error: String(e) })),
      ])
      const catalogData = 'error' in catalog ? null : catalog
      const catalogError = 'error' in catalog ? (catalog as { error: string }).error : null
      const onSave = async (patch: Partial<NexusConfig>) => {
        const current = await loadConfig(cwd)
        const merged = deepMerge(current, patch) as NexusConfig
        writeConfig(merged, cwd)
      }
      return (
        <NexusModelPanel
          cwd={cwd}
          initialConfig={config}
          catalog={catalogData}
          catalogError={catalogError}
          onSave={onSave}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
