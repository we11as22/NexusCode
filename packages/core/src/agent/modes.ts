import type { Mode, PermissionAction, ModeConfig } from "../types.js"

export type ToolGroup = "read" | "write" | "execute" | "search" | "browser" | "mcp" | "skills" | "agents" | "always" | "context" | "plan_exit"

/**
 * Core built-in tool groups per mode.
 * Access control is enforced in the backend (getBuiltinToolsForMode + getBlockedToolsForMode in loop);
 * prompts only describe behaviour — they do not grant or revoke tool access.
 */
export const MODE_TOOL_GROUPS: Record<Mode, ToolGroup[]> = {
  agent: ["always", "read", "write", "execute", "search", "browser", "mcp", "skills", "agents", "context"],
  plan:  ["always", "read", "write", "search", "browser", "mcp", "skills", "agents", "context", "plan_exit"],
  ask:   ["always", "read", "search", "browser", "mcp", "skills", "agents", "context"],
}

/**
 * Tools that are explicitly BLOCKED per mode (even if passed as dynamic tools).
 * Enforced in the agent loop: blocked tools are never included in resolvedTools and never sent to the LLM.
 * Plan: only write to .nexus/plans/*.md|.txt; no execute.
 * Ask: read-only + no plan work — no write, no execute, no plan_exit (spawn_agent allowed with ask permissions).
 */
export const MODE_BLOCKED_TOOLS: Record<Mode, string[]> = {
  agent: ["plan_exit"],
  plan:  ["execute_command"],
  ask:   ["write_to_file", "replace_in_file", "execute_command", "create_rule", "plan_exit"],
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
  always:  ["attempt_completion", "ask_followup_question", "update_todo_list", "thinking_preamble"],
  read:    ["read_file", "list_files", "list_code_definitions", "batch"],
  write:   ["write_to_file", "replace_in_file", "create_rule", "batch"],
  execute: ["execute_command"],
  search:  ["search_files", "codebase_search", "web_fetch", "web_search", "exa_web_search", "exa_code_search"],
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
  "exa_web_search",
  "exa_code_search",
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
  agent: "AGENT mode: full access — read/write files, run commands, search, browser, MCP, skills, spawn sub-agents (with full agent permissions). Execute tasks end-to-end. After plan approval, run with the approved plan and a detailed todo (fuller task descriptions).",
  plan:  "PLAN mode: (1) Study the task thoroughly — read codebase, search, browser, MCP, skills; write only the plan to .nexus/plans/*.md. (2) You may use spawn_agent for parallel research subtasks (sub-agents run in ask mode). (3) Call plan_exit when the plan is ready; user may approve (then execution continues in agent mode with the plan and detailed todo), revise, or abandon.",
  ask:   "ASK mode: read-only. Answer questions, explain code, analyze — use read, search, browser, MCP, skills. You may use spawn_agent for parallel read-only subtasks (sub-agents run in ask mode). Do NOT modify files, run commands, or use plan_exit.",
}
