import type { Command } from '../commands.js'
import type { NexusBootstrapResult } from '../nexus-bootstrap.js'
import { NexusVectorPanel } from '../components/NexusVectorPanel.js'
import React from 'react'
import { loadConfig, writeConfig, createCodebaseIndexer, ensureQdrantRunning } from '@nexuscode/core'
import type { NexusConfig, CodebaseIndexer } from '@nexuscode/core'

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

export function createNexusVectorCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'vector',
    description: 'Enable/disable vector DB (Qdrant) and semantic index',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'vector'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const config = await loadConfig(cwd)
      const onSave = async (patch: Partial<NexusConfig>) => {
        const current = await loadConfig(cwd)
        const merged = deepMerge(current, patch) as NexusConfig
        writeConfig(merged, cwd)
        const wantsVector = Boolean(merged.indexing?.vector && merged.vectorDb?.enabled)
        if (wantsVector) {
          const progress = (msg: string) => console.warn('[nexus]', msg)
          const indexer = await createCodebaseIndexer(cwd, merged, {
            onWarning: progress,
            onProgress: progress,
          }).catch(() => undefined)
          if (indexer) {
            ;(nexus as { indexer?: CodebaseIndexer }).indexer = indexer
            indexer.startIndexing().catch(() => {})
          }
        } else {
          ;(nexus as { indexer?: CodebaseIndexer }).indexer = undefined
        }
      }
      const onConnectQdrant = async (url: string) => {
        const progress = (msg: string) => console.warn('[nexus]', msg)
        const result = await ensureQdrantRunning({
          url: url.trim() || 'http://127.0.0.1:6333',
          autoStart: true,
          onProgress: progress,
          log: progress,
        })
        if (!result.available && result.warning) throw new Error(result.warning)
      }
      return (
        <NexusVectorPanel
          initialConfig={config}
          onSave={onSave}
          onClose={onDone}
          onConnectQdrant={onConnectQdrant}
        />
      )
    },
  } satisfies Command
}
