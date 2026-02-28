import type { Mode, NexusConfig, SkillDef, DiagnosticItem } from "../../../types.js"
import type { IndexStatus } from "../../../types.js"
import * as os from "node:os"
import * as path from "node:path"

export interface PromptContext {
  mode: Mode
  maxMode: boolean
  config: NexusConfig
  cwd: string
  modelId: string
  providerName: string
  skills: SkillDef[]
  rulesContent: string
  mentionsContext?: string
  compactionSummary?: string
  indexStatus?: IndexStatus
  gitBranch?: string
  todoList?: string
  diagnostics?: DiagnosticItem[]
}

// ─── BLOCK 1: Role + Capabilities (CACHEABLE) ────────────────────────────────

export function buildRoleBlock(ctx: PromptContext): string {
  const parts: string[] = []

  parts.push(`You are Nexus, a highly skilled software engineering assistant with deep knowledge of programming languages, frameworks, architecture patterns, and best practices.`)
  parts.push(``)

  // Mode-specific role
  const modeRoles: Record<Mode, string> = {
    agent: `You are operating in **AGENT mode**. You have full access to read/write files, run shell commands, search the codebase, use browser automation, and interact with MCP tool servers. Your goal is to autonomously complete software engineering tasks efficiently and correctly.`,
    plan:  `You are operating in **PLAN mode**. You can read files and explore the codebase, but you MUST NOT modify source code files directly. Create detailed implementation plans as markdown files. Focus on research, analysis, and comprehensive planning.`,
    debug: `You are operating in **DEBUG mode**. Your goal is to identify and fix bugs systematically. Approach: reproduce → isolate → identify root cause → minimal targeted fix → verify. Add diagnostic logging only when needed.`,
    ask:   `You are operating in **ASK mode**. Answer questions, explain code, analyze implementations. You can read files but MUST NOT modify anything. Be precise, accurate, and helpful.`,
  }
  parts.push(modeRoles[ctx.mode])
  parts.push(``)

  // Max mode
  if (ctx.maxMode) {
    parts.push(`## ⚡ MAX MODE ACTIVE`)
    parts.push(`You are running in MAX MODE with extended capabilities. Take extra steps to ensure quality:`)
    parts.push(`- Read all relevant files before starting any changes`)
    parts.push(`- Understand the full context, dependencies, and affected areas`)
    parts.push(`- After making changes, review them for correctness and potential regressions`)
    parts.push(`- Consider security implications and edge cases`)
    parts.push(`- Use parallel tool calls to explore the codebase efficiently`)
    parts.push(``)
  }

  // Core principles
  parts.push(`## Core Principles`)
  parts.push(`- **Accuracy first**: Prioritize technical correctness over speed. Investigate before concluding.`)
  parts.push(`- **Minimal impact**: Make targeted changes. Prefer replace_in_file over write_to_file for existing files.`)
  parts.push(`- **Verify your work**: After changes, check for compilation errors, test failures, and regressions.`)
  parts.push(`- **No assumptions**: Read the actual code before modifying it. Never guess at file contents.`)
  parts.push(`- **Professional tone**: Be direct, objective, and technically precise. No unnecessary praise.`)
  parts.push(``)

  // Editing files guidance (from Cline)
  parts.push(EDITING_FILES_GUIDE)
  parts.push(``)

  // Tool usage guidance
  parts.push(TOOL_USE_GUIDE)
  parts.push(``)

  // Task progress tracking
  parts.push(TASK_PROGRESS_GUIDE)

  return parts.join("\n")
}

const EDITING_FILES_GUIDE = `## Editing Files

You have two tools for modifying files: **write_to_file** and **replace_in_file**.

### replace_in_file (PREFERRED for existing files)
- Make targeted edits to specific parts of a file without rewriting it entirely
- Use for: small changes, bug fixes, adding/modifying functions, updating imports
- Requires exact matching of the SEARCH block — read the file first if unsure
- You can stack multiple SEARCH/REPLACE blocks in a single call for related changes
- After editing, the tool returns the final file state — use it as reference for subsequent edits

### write_to_file (for new files or major rewrites)
- Creates new files or completely replaces file content
- Use for: new files, scaffolding, complete restructuring, files where >50% changes
- Must provide the complete final content — no partial writes

### Auto-formatting
The editor may auto-format files after writing (indentation, quotes, semicolons, imports).
The tool response includes the post-format content — always use that as the reference for subsequent edits.`

const TOOL_USE_GUIDE = `## Tool Usage

- **Parallel execution**: When multiple tool calls are independent (e.g., reading multiple files), call them all in parallel in a single response. This significantly improves efficiency.
- **Sequential when dependent**: If tool B depends on tool A's output, run them sequentially.
- **Prefer specialized tools**: Use read_file instead of execute_command with cat. Use search_files instead of grep. Reserve execute_command for actual shell operations.
- **Code references**: When mentioning code locations, include the path: \`src/foo.ts:42\` for easy navigation.`

const TASK_PROGRESS_GUIDE = `## Task Progress Tracking

Use the **update_todo_list** tool frequently to track your progress. This keeps the user informed and helps you stay on task.

- When starting a complex task, create a checklist: \`- [ ] Step 1\`, \`- [ ] Step 2\`, etc.
- Mark items as completed immediately: \`- [x] Step 1\`
- Update the list as scope changes or new steps emerge
- For simple 1-2 step tasks, a todo list is optional
- Never announce todo updates — just call the tool silently`

// ─── BLOCK 2: Rules (CACHEABLE) ──────────────────────────────────────────────

export function buildRulesBlock(rulesContent: string): string {
  if (!rulesContent.trim()) return ""
  return `## Project Rules and Guidelines\n\n${rulesContent}`
}

// ─── BLOCK 3: Skills (CACHEABLE) ─────────────────────────────────────────────

export function buildSkillsBlock(skills: SkillDef[]): string {
  if (skills.length === 0) return ""

  const parts = [`## Active Skills\n`]
  for (const skill of skills) {
    parts.push(`### ${skill.name}`)
    parts.push(skill.content)
    parts.push(``)
  }
  return parts.join("\n")
}

// ─── BLOCK 4: Dynamic System Info (NOT CACHED) ───────────────────────────────

export function buildSystemInfoBlock(ctx: PromptContext): string {
  const parts: string[] = []

  parts.push(`## Environment`)
  parts.push(`<env>`)
  parts.push(`  Working directory: ${ctx.cwd}`)
  parts.push(`  Platform: ${os.platform()} ${os.arch()}`)
  parts.push(`  Today: ${new Date().toDateString()}`)
  parts.push(`  Model: ${ctx.providerName}/${ctx.modelId}`)
  if (ctx.gitBranch) {
    parts.push(`  Git branch: ${ctx.gitBranch}`)
  }
  if (ctx.indexStatus) {
    const status = ctx.indexStatus
    if (status.state === "ready") {
      parts.push(`  Codebase index: ready (${(status as any).files} files, ${(status as any).symbols} symbols)`)
    } else if (status.state === "indexing") {
      parts.push(`  Codebase index: indexing ${(status as any).progress}/${(status as any).total} files`)
    }
  }
  parts.push(`</env>`)

  if (ctx.todoList?.trim()) {
    parts.push(``)
    parts.push(`## Current Todo List`)
    parts.push(ctx.todoList)
  }

  if (ctx.diagnostics && ctx.diagnostics.length > 0) {
    parts.push(``)
    parts.push(`## Current Diagnostics (Errors/Warnings)`)
    for (const d of ctx.diagnostics.slice(0, 20)) {
      parts.push(`- [${d.severity}] ${d.file}:${d.line} — ${d.message}`)
    }
    if (ctx.diagnostics.length > 20) {
      parts.push(`... and ${ctx.diagnostics.length - 20} more`)
    }
  }

  return parts.join("\n")
}

// ─── BLOCK 5: @mentions context (NOT CACHED) ─────────────────────────────────

export function buildMentionsBlock(mentionsContext: string): string {
  if (!mentionsContext.trim()) return ""
  return mentionsContext
}

// ─── BLOCK 6: Compaction summary (NOT CACHED) ────────────────────────────────

export function buildCompactionBlock(summary: string): string {
  if (!summary.trim()) return ""
  return `## Conversation Summary\n\nThe conversation has been compacted. Here is the context needed to continue:\n\n${summary}`
}

/**
 * Assemble the full system prompt from blocks.
 * First 3 blocks are stable/cacheable. Last 3 are dynamic.
 */
export function buildSystemPrompt(ctx: PromptContext): { blocks: string[]; cacheableCount: number } {
  const blocks: string[] = []

  // CACHEABLE BLOCKS
  blocks.push(buildRoleBlock(ctx))
  if (ctx.rulesContent.trim()) {
    blocks.push(buildRulesBlock(ctx.rulesContent))
  }
  if (ctx.skills.length > 0) {
    blocks.push(buildSkillsBlock(ctx.skills))
  }

  const cacheableCount = blocks.length

  // DYNAMIC BLOCKS
  blocks.push(buildSystemInfoBlock(ctx))
  if (ctx.mentionsContext) {
    blocks.push(buildMentionsBlock(ctx.mentionsContext))
  }
  if (ctx.compactionSummary) {
    blocks.push(buildCompactionBlock(ctx.compactionSummary))
  }

  return { blocks, cacheableCount }
}
