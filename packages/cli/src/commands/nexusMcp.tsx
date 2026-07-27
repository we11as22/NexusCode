import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusMcpPanel } from '../components/NexusMcpPanel.js'
import React from 'react'
import { patchGlobalConfig } from '@nexuscode/core'
import type { NexusConfig } from '@nexuscode/core'

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
      const config = await loadCliWorkspaceConfig(cwd, {
        loadEnv: !nexus.serverUrl,
        hostAuthority: !nexus.serverUrl,
      })
      const onSave = async (patch: Partial<NexusConfig>) => {
        await patchGlobalConfig(
          patch as unknown as Record<string, unknown>,
        )
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
