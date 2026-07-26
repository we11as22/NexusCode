import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import type { NexusConfig } from "../types.js"
import { loadRules } from "./rules.js"

/**
 * Trusted instruction bundle for the agent.
 *
 * Agent-authored auto/team/session memory must never be concatenated here:
 * this string is rendered as authoritative project rules. Memory is selected,
 * cited, and rendered through the explicitly untrusted memory prompt block.
 */
export async function loadAgentInstructionBundle(
  cwd: string,
  rulePatterns: string[],
  _config: NexusConfig,
  compatibility?: ClaudeCompatibilityOptions,
): Promise<string> {
  return loadRules(cwd, rulePatterns, compatibility)
}
