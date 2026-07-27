import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusModelPanel } from '../components/NexusModelPanel.js'
import React from 'react'
import {
  getModelsCatalog,
  credentialIdentityKey,
  getEmbeddingCredentialIdentity,
  getProviderCredentialIdentity,
  mergeEmbeddingConfigSafely,
  mergeProviderConfigSafely,
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
        loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        }),
        getModelsCatalog().catch((e) => ({ error: String(e) })),
      ])
      const catalogData = 'error' in catalog ? null : catalog
      const catalogError = 'error' in catalog ? (catalog as { error: string }).error : null
      const onSave = async (patch: Partial<NexusConfig>) => {
        const current = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        const merged = deepMerge(current, patch) as NexusConfig
        if (patch.model) {
          merged.model = mergeProviderConfigSafely(current.model, patch.model)
        }
        if (current.embeddings && patch.embeddings) {
          merged.embeddings = mergeEmbeddingConfigSafely(
            current.embeddings,
            patch.embeddings,
          )
        }
        const modelScopeChanged = patch.model
          ? credentialIdentityKey(getProviderCredentialIdentity(current.model)) !==
            credentialIdentityKey(getProviderCredentialIdentity(merged.model))
          : false
        const embeddingScopeChanged =
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
            remove: {
              ...(modelScopeChanged ? { model: current.model } : {}),
              ...(embeddingScopeChanged
                ? { embeddings: current.embeddings }
                : {}),
            },
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
        await persistSecretsFromConfig(
          current as unknown as Record<string, unknown>,
          nexus.secretsStore,
          { remove: { model: true } },
        )
      }
      const onRemoveProfileApiKey = async (profileName: string) => {
        const current = await loadCliWorkspaceConfig(cwd, {
          loadEnv: !nexus.serverUrl,
          hostAuthority: !nexus.serverUrl,
        })
        await persistSecretsFromConfig(
          current as unknown as Record<string, unknown>,
          nexus.secretsStore,
          { remove: { profileNames: [profileName] } },
        )
      }
      return (
        <NexusModelPanel
          cwd={cwd}
          initialConfig={config}
          catalog={catalogData}
          catalogError={catalogError}
          onSave={onSave}
          onRemoveApiKey={onRemoveApiKey}
          onRemoveProfileApiKey={onRemoveProfileApiKey}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
