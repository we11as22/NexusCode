import React from "react"

import type { Command } from "../commands.js"
import { NexusAuthorityPanel } from "../components/NexusAuthorityPanel.js"
import type { NexusBootstrapResult } from "../nexus-bootstrap.js"
import { listPendingProjectAuthority } from "../project-authority.js"

export function createNexusAuthorityCommand(
  nexus: NexusBootstrapResult,
): Command {
  return {
    type: "local-jsx",
    name: "authority",
    aliases: ["trust-requests"],
    description:
      "Review inert project endpoint, executable, and external-path requests",
    isEnabled: !nexus.serverUrl,
    isHidden: false,
    userFacingName() {
      return "authority"
    },
    async call(onDone) {
      const pending = await listPendingProjectAuthority(nexus.cwd)
      return (
        <NexusAuthorityPanel
          cwd={nexus.cwd}
          initialRequests={pending}
          onClose={onDone}
        />
      )
    },
  } satisfies Command
}
