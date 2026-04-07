import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import type { NexusConfig } from "../types.js"
import { loadAutoMemoryMarkdown } from "./auto-memory.js"
import { loadRules } from "./rules.js"
import { loadTeamMemoryMarkdown } from "./team-memory.js"

/**
 * Full instruction bundle for the agent: rules cascade + team memory + auto-memory (OpenClaude-class).
 * Call at session/bootstrap; rules are stable for the run. Session-memory is read separately each loop.
 */
export async function loadAgentInstructionBundle(
  cwd: string,
  rulePatterns: string[],
  config: NexusConfig,
  compatibility?: ClaudeCompatibilityOptions,
): Promise<string> {
  const rules = await loadRules(cwd, rulePatterns, compatibility).catch(() => "")
  const team = await loadTeamMemoryMarkdown(cwd, config).catch(() => "")
  const auto = await loadAutoMemoryMarkdown(cwd, config).catch(() => "")

  const parts: string[] = []
  if (rules.trim()) parts.push(rules)
  if (team.trim()) {
    parts.push(`---\n\n## Team memory\n\n${team}`)
  }
  if (auto.trim()) {
    parts.push(`---\n\n## Auto-generated / project memory files\n\n${auto}`)
  }
  return parts.join("\n\n")
}
