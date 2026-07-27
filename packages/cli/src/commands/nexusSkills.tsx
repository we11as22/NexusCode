import type { Command } from '../commands.js'
import {
  loadCliWorkspaceConfig,
  type NexusBootstrapResult,
} from '../nexus-bootstrap.js'
import { NexusSkillsPanel } from '../components/NexusSkillsPanel.js'
import React from 'react'
import { patchProjectConfig } from '@nexuscode/core'
import type { NexusConfig } from '@nexuscode/core'

export function createNexusSkillsCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local-jsx',
    name: 'skills',
    description: 'Manage skills — enable or disable skill files',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'skills'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const config = await loadCliWorkspaceConfig(cwd, {
        loadEnv: !nexus.serverUrl,
        hostAuthority: !nexus.serverUrl,
      })
      const onSave = async (patch: Partial<NexusConfig>) => {
        const rawPatch = { ...patch } as Record<string, unknown>
        if (Array.isArray(rawPatch['skillsConfig'])) {
          rawPatch['skills'] = rawPatch['skillsConfig'].map((entry) => {
            const skill = entry as { path: string; enabled: boolean }
            return skill.enabled
              ? skill.path
              : { path: skill.path, enabled: false }
          })
          delete rawPatch['skillsConfig']
        }
        await patchProjectConfig(rawPatch, cwd)
      }
      return (
        <NexusSkillsPanel
          initialConfig={config}
          cwd={cwd}
          onSave={onSave}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
