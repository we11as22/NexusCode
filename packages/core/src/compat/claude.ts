import type { NexusConfig } from "../types.js"

export interface ClaudeCompatibilityOptions {
  enabled: boolean
  includeGlobalDir: boolean
  includeProjectDir: boolean
  includeLocalInstructions: boolean
  includeRules: boolean
  includeSettings: boolean
  includeCommands: boolean
  includeSkills: boolean
  includeAgents: boolean
  includePlugins: boolean
}

export function getClaudeCompatibilityOptions(config?: Pick<NexusConfig, "compatibility"> | null): ClaudeCompatibilityOptions {
  const claude = config?.compatibility?.claude
  const enabled = claude?.enabled === true
  return {
    enabled,
    includeGlobalDir: enabled && claude?.includeGlobalDir !== false,
    includeProjectDir: enabled && claude?.includeProjectDir !== false,
    includeLocalInstructions: enabled && claude?.includeLocalInstructions !== false,
    includeRules: enabled && claude?.includeRules !== false,
    includeSettings: enabled && claude?.includeSettings !== false,
    includeCommands: enabled && claude?.includeCommands !== false,
    includeSkills: enabled && claude?.includeSkills !== false,
    includeAgents: enabled && claude?.includeAgents !== false,
    includePlugins: enabled && claude?.includePlugins !== false,
  }
}
