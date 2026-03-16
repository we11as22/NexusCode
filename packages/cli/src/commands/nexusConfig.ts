import type { Command } from '../commands.js'
import type { NexusBootstrapResult } from '../nexus-bootstrap.js'

/**
 * Creates a /nexus-config command that shows current Nexus settings and where to configure
 * LLM, sessions, embeddings, index, MCP, skills.
 */
export function createNexusConfigCommand(nexus: NexusBootstrapResult): Command {
  return {
    type: 'local',
    name: 'nexus-config',
    description: 'Show Nexus config (model, mode, index) and where to set LLM, sessions, embeddings, MCP, skills',
    isEnabled: true,
    isHidden: true,
    userFacingName() {
      return 'nexus-config'
    },
    async call() {
      const { configSnapshot, mode, indexEnabled, cwd } = nexus
      const modelId = configSnapshot.model?.id ?? '—'
      const configDir = cwd ?? process.cwd()
      const lines = [
        'Nexus config:',
        `  Model:    ${modelId}`,
        `  Mode:     ${mode}`,
        `  Index:    ${indexEnabled ? 'on' : 'off'}`,
        '',
        'To change:',
        '  • LLM:       /model — choose free or custom model',
        '  • Index:     /index — toggle indexing and vector search',
        '  • Embeddings: /embeddings — set embedding provider and model',
        '  • Sessions:  use --session <id> or --continue; list with `nexus task checkpoints`',
        '  • MCP:       edit mcp.servers in .nexus/nexus.yaml',
        '  • Skills:    edit skills in .nexus/nexus.yaml',
        '',
        `Config file: ${configDir}/.nexus/nexus.yaml`,
      ]
      return lines.join('\n')
    },
  } satisfies Command
}
