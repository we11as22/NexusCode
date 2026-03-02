import type { Mode, PermissionAction, ModeConfig } from "../types.js"

export type ToolGroup = "read" | "write" | "execute" | "search" | "browser" | "mcp" | "skills" | "agents" | "always" | "context" | "plan_exit"

/**
 * Core built-in tool groups per mode.
 * These are ALWAYS active if the mode permits — no classifier applied.
 * Classifier only applies to MCP/custom tools when count exceeds threshold.
 */
export const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]> = {
  agent: ["always", "read", "write", "execute", "search", "browser", "mcp", "skills", "agents", "context"],
  plan:  ["always", "read", "write", "search", "skills", "context", "plan_exit"],
  ask:   ["always", "read", "search", "context"],
}

/**
 * Tools that are explicitly BLOCKED per mode (even if passed as dynamic tools).
 * Plan mode allows writing .md plan files but blocks code files and commands.
 * Ask mode is fully read-only.
 */
export const MODE_BLOCKED_TOOLS: Record<Mode, string[]> = {
  agent: ["plan_exit"],
  plan:  ["execute_command", "browser_action"],
  ask:   ["write_to_file", "replace_in_file", "apply_patch", "execute_command", "browser_action", "spawn_agent", "create_rule", "plan_exit"],
}

/**
 * Source code file extensions that are blocked in plan mode.
 * Plan mode may only write markdown/text documentation files.
 */
export const PLAN_MODE_BLOCKED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".cs", ".swift", ".kt", ".lua",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql",
])

/**
 * Built-in tool names per group.
 * Tools in "always" group are available in every mode.
 */
export const TOOL_GROUP_MEMBERS: Record<ToolGroup, string[]> = {
  always:  ["attempt_completion", "ask_followup_question", "update_todo_list"],
  read:    ["read_file", "list_files", "list_code_definitions"],
  write:   ["write_to_file", "replace_in_file", "apply_patch", "create_rule"],
  execute: ["execute_command"],
  search:  ["search_files", "codebase_search", "web_fetch", "web_search"],
  browser: ["browser_action"],
  mcp:     [], // populated dynamically from MCP registry
  skills:  ["use_skill"],
  agents:  ["spawn_agent"],
  context: ["condense", "summarize_task"],
  plan_exit: ["plan_exit"],
}

/**
 * In plan mode, write_to_file is allowed ONLY for .md plan files in .nexus/plans/.
 * This regex matches the allowed path patterns.
 */
export const PLAN_MODE_ALLOWED_WRITE_PATTERN = /^\.nexus[\\/]plans[\\/].+\.(md|txt)$/i

/**
 * Read-only tools that can be parallelized safely.
 */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "list_code_definitions",
  "search_files",
  "codebase_search",
  "web_fetch",
  "web_search",
  "use_skill",
  "condense",
  "summarize_task",
])

/**
 * Get all built-in tool names available for a given mode.
 */
export function getBuiltinToolsForMode(mode: Mode): string[] {
  const groups = MODE_TOOL_GROUPS[mode]
  const tools = new Set<string>()
  for (const group of groups) {
    if (group === "mcp") continue // MCP tools are dynamic
    for (const tool of TOOL_GROUP_MEMBERS[group]) {
      tools.add(tool)
    }
  }
  return Array.from(tools)
}

/**
 * Get the set of tools that are hard-blocked in a mode.
 * These tools should never be sent to the LLM and should error if called.
 */
export function getBlockedToolsForMode(mode: Mode): Set<string> {
  return new Set(MODE_BLOCKED_TOOLS[mode])
}

/**
 * Check if a tool is allowed in a given mode.
 */
export function isToolAllowedInMode(toolName: string, mode: Mode): boolean {
  if (getBlockedToolsForMode(mode).has(toolName)) return false
  return getBuiltinToolsForMode(mode).includes(toolName)
}

/**
 * Get auto-approve permissions for a mode based on config.
 */
export function getAutoApproveActions(mode: Mode, modeConfig?: ModeConfig): Set<PermissionAction> {
  const defaults: Record<Mode, PermissionAction[]> = {
    agent: ["read"],
    plan:  ["read"],
    ask:   ["read"],
  }
  const configured = modeConfig?.autoApprove ?? defaults[mode]
  return new Set(configured)
}

/**
 * Mode descriptions for system prompt.
 */
export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  agent: "AGENT mode: full access to read/write files, run commands, search codebase, browser, MCP, and spawn sub-agents. Complete tasks autonomously end-to-end.",
  plan:  "PLAN mode: read-only access + codebase search. MUST NOT modify source code. Write plan files to .nexus/plans/ directory only. When plan is complete, call attempt_completion.",
  ask:   "ASK mode: read-only. Answer questions, explain code, analyze implementations. MUST NOT modify any files or run commands.",
}
