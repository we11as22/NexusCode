import type { Mode, PermissionAction, ModeConfig } from "../types.js"

export type ToolGroup = "read" | "write" | "execute" | "search" | "browser" | "mcp" | "skills" | "agents" | "always"

/**
 * Core built-in tool groups per mode.
 * These are ALWAYS active if the mode permits — no classifier applied.
 * Classifier only applies to MCP tools and custom skills when count exceeds threshold.
 */
export const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]> = {
  agent: ["always", "read", "write", "execute", "search", "browser", "mcp", "skills", "agents"],
  plan:  ["always", "read", "search", "mcp", "skills"],
  debug: ["always", "read", "write", "execute", "search", "mcp", "skills"],
  ask:   ["always", "read", "search", "mcp"],
}

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
}

/**
 * In plan mode, write is restricted to .md/.txt plan files only.
 */
export const PLAN_MODE_WRITE_REGEX = /\.(md|txt|yaml|yml|json)$/i

/**
 * Read-only tools that can be parallelized.
 */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "list_code_definitions",
  "search_files",
  "codebase_search",
  "web_fetch",
  "web_search",
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
 * Check if a tool is allowed in a given mode.
 */
export function isToolAllowedInMode(toolName: string, mode: Mode): boolean {
  const allowed = getBuiltinToolsForMode(mode)
  return allowed.includes(toolName)
}

/**
 * Get auto-approve permissions for a mode based on config.
 */
export function getAutoApproveActions(mode: Mode, modeConfig?: ModeConfig): Set<PermissionAction> {
  const defaults: Record<Mode, PermissionAction[]> = {
    agent: ["read"],
    plan:  ["read"],
    debug: ["read"],
    ask:   ["read"],
  }
  const configured = modeConfig?.autoApprove ?? defaults[mode]
  return new Set(configured)
}

/**
 * Mode descriptions for system prompt.
 */
export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  agent: "You are in AGENT mode. You have full access to read/write files, run commands, search the codebase, use browser, and interact with MCP servers. Complete tasks autonomously and efficiently.",
  plan:  "You are in PLAN mode. You can read files and explore the codebase, but you MUST NOT modify source code files. Create implementation plans as markdown files in .nexus/plans/. When your plan is complete, call attempt_completion with the plan summary.",
  debug: "You are in DEBUG mode. Your goal is to identify and fix bugs. Approach: reproduce → isolate → identify root cause → fix → verify. Add targeted logging if needed. Run tests to verify the fix.",
  ask:   "You are in ASK mode. Answer questions, explain code, review implementations. You can read files but MUST NOT modify anything. Be precise and concise.",
}
