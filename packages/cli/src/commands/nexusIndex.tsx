import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusIndexPanel } from '../components/NexusIndexPanel.js'
import React from 'react'
import { patchProjectConfig } from '@nexuscode/core'
import type { NexusConfig } from '@nexuscode/core'

export function createNexusIndexCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'index',
    description: 'Toggle codebase index and vector (semantic) search',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'index'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const config = await loadCliWorkspaceConfig(cwd, {
        loadEnv: !nexus.serverUrl,
        hostAuthority: !nexus.serverUrl,
      })
      const onSave = async (patch: Partial<NexusConfig>) => {
        await patchProjectConfig(
          patch as unknown as Record<string, unknown>,
          cwd,
        )
      }
      return (
        <NexusIndexPanel
          initialConfig={config}
          onSave={onSave}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
