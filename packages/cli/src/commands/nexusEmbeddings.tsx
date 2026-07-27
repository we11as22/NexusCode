import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusEmbeddingsPanel } from '../components/NexusEmbeddingsPanel.js'
import React from 'react'
import {
  credentialIdentityKey,
  getEmbeddingCredentialIdentity,
  mergeEmbeddingConfigSafely,
  patchProjectConfig,
  persistSecretsFromConfig,
} from '@nexuscode/core'
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

export function createNexusEmbeddingsCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'embeddings',
    description: 'Set embedding provider and model for vector search',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'embeddings'
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
        if (patch.embeddings) {
          merged.embeddings = current.embeddings
            ? mergeEmbeddingConfigSafely(current.embeddings, patch.embeddings)
            : { ...patch.embeddings }
        }
        const scopeChanged =
          current.embeddings && merged.embeddings && patch.embeddings
            ? credentialIdentityKey(
                getEmbeddingCredentialIdentity(current.embeddings),
              ) !==
              credentialIdentityKey(
                getEmbeddingCredentialIdentity(merged.embeddings),
              )
            : false
        await persistSecretsFromConfig(
          merged as unknown as Record<string, unknown>,
          nexus.secretsStore,
          {
            remove: scopeChanged
              ? { embeddings: current.embeddings }
              : {},
          },
        )
        await patchProjectConfig(
          patch as unknown as Record<string, unknown>,
          cwd,
        )
      }
      const onRemoveApiKey = async () => {
        const current = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        if (!current.embeddings) return
        await persistSecretsFromConfig(
          current as unknown as Record<string, unknown>,
          nexus.secretsStore,
          { remove: { embeddings: true } },
        )
      }
      return (
        <NexusEmbeddingsPanel
          initialConfig={config}
          onSave={onSave}
          onRemoveApiKey={onRemoveApiKey}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
