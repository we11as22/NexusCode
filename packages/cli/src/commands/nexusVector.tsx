import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusVectorPanel } from '../components/NexusVectorPanel.js'
import React from 'react'
import {
  createCodebaseIndexer,
  ensureQdrantRunning,
  finalizeConfigCredentials,
  getConfigEnvironment,
  patchProjectConfig,
  persistSecretsFromConfig,
} from '@nexuscode/core'
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
      const config = await loadCliWorkspaceConfig(cwd, {
        loadEnv: !nexus.serverUrl,
        hostAuthority: !nexus.serverUrl,
      })
      const onSave = async (patch: Partial<NexusConfig>) => {
        const current = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        const merged = deepMerge(current, patch) as NexusConfig
        await persistSecretsFromConfig(
          merged as unknown as Record<string, unknown>,
          nexus.secretsStore,
        )
        await patchProjectConfig(
          patch as unknown as Record<string, unknown>,
          cwd,
        )
        const effective = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        const wantsVector = Boolean(
          effective.indexing?.vector && effective.vectorDb?.enabled,
        )
        if (wantsVector && !nexus.serverUrl) {
          const progress = (msg: string) => console.warn('[nexus]', msg)
          const runtimeConfig = await finalizeConfigCredentials(
            effective as unknown as Record<string, unknown>,
            nexus.secretsStore,
            {
              profileName: nexus.cliModelSelection.profileOverride,
              environment: getConfigEnvironment(effective),
            },
          ) as unknown as NexusConfig
          const indexer = await createCodebaseIndexer(cwd, runtimeConfig, {
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
      const onRemoveApiKey = async () => {
        const current = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        await persistSecretsFromConfig(
          current as unknown as Record<string, unknown>,
          nexus.secretsStore,
          { remove: { qdrant: true } },
        )
      }
      const onConnectQdrant = async (url: string) => {
        if (nexus.serverUrl) {
          throw new Error('Qdrant is managed by the remote NexusCode Server')
        }
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
          onRemoveApiKey={onRemoveApiKey}
        />
      )
    },
  } satisfies Command
}
