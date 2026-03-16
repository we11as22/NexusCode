import type { Command } from '../commands.js'
import { NexusSessionsPanel } from '../components/NexusSessionsPanel.js'
import React from 'react'
import type { NexusBootstrapResult } from '../nexus-bootstrap.js'
import { listSessions } from '@nexuscode/core'

export function createNexusSessionsCommand(
  nexus: NexusBootstrapResult,
  onSessionSelect: (sessionId: string) => void,
): Command {
  return {
    type: 'local-jsx',
    name: 'sessions',
    description: 'Browse and switch between sessions',
    isEnabled: true,
    isHidden: false,
    userFacingName() {
      return 'sessions'
    },
    async call(onDone) {
      const cwd = nexus.cwd
      const sessions = await listSessions(cwd).catch(() => [])
      return (
        <NexusSessionsPanel
          sessions={sessions}
          onSelect={(session) => {
            onSessionSelect(session.id)
            onDone()
          }}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
