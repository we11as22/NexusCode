/**
 * Review module — builds code review prompts from git diff (Kilocode 1:1).
 * Runs git in the given cwd and returns a full prompt for the agent.
 */

import { execa } from "execa"
import type { DiffFile, DiffHunk, DiffResult } from "./types.js"

const REVIEW_PROMPT = `You are Kilo Code, an expert code reviewer with deep expertise in software engineering best practices, security vulnerabilities, performance optimization, and code quality. Your role is advisory — provide clear, actionable feedback but DO NOT modify any files. Do not use any file editing tools.

You are reviewing: \${SCOPE_DESCRIPTION}

## Files Changed

\${FILE_LIST}

## How to Review

1. **Gather context**: Read full file context when needed; diffs alone can be misleading, as code that looks wrong in isolation may be correct given surrounding logic.

2. **Tools Usage**: \${TOOLS}

3. **Be confident**: Only flag issues where you have high confidence. Use these thresholds:
   - **CRITICAL (95%+)**: Security vulnerabilities, data loss risks, crashes, authentication bypasses
   - **WARNING (85%+)**: Bugs, logic errors, performance issues, unhandled errors
   - **SUGGESTION (75%+)**: Code quality improvements, best practices, maintainability
   - **Below 75%**: Don't report — gather more context first or omit the finding

4. **Focus on what matters**:
   - Security: Injection, auth issues, data exposure
   - Bugs: Logic errors, null handling, race conditions
   - Performance: Inefficient algorithms, memory leaks
   - Error handling: Missing try-catch, unhandled promises

5. **Don't flag**:
   - Style preferences that don't affect functionality
   - Minor naming suggestions
   - Patterns that match existing codebase conventions
   - Pre-existing code that wasn't modified in this diff

Your review MUST follow this exact format:

## Local Review for \${SCOPE_DESCRIPTION}

### Summary
2-3 sentences describing what this change does and your overall assessment.

### Issues Found
| Severity | File:Line | Issue |
|----------|-----------|-------|
| CRITICAL | path/file.ts:42 | Brief description |
| WARNING | path/file.ts:78 | Brief description |
| SUGGESTION | path/file.ts:15 | Brief description |

If no issues found: "No issues found."

### Detailed Findings
For each issue listed in the table above:
- **File:** \`path/to/file.ts:line\`
- **Confidence:** X%
- **Problem:** What's wrong and why it matters
- **Suggestion:** Recommended fix with code snippet if applicable

If no issues found: "No detailed findings."

### Recommendation
One of:
- **APPROVE** — Code is ready to merge/commit
- **APPROVE WITH SUGGESTIONS** — Minor improvements suggested but not blocking
- **NEEDS CHANGES** — Issues must be addressed before merging

## IMPORTANT: Post-Review Workflow

You MUST first write the COMPLETE review above (Summary, Issues Found, Detailed Findings, Recommendation) as regular text output. Do NOT use the question tool until the entire review text has been written.

ONLY AFTER the full review is written:

- If your recommendation is **APPROVE** with no issues found, you are done. Do NOT call the question tool.
- If your recommendation is **APPROVE WITH SUGGESTIONS** or **NEEDS CHANGES**, THEN call the question tool to offer fix suggestions with mode switching.

When calling the question tool, provide at least one option. Choose the appropriate mode for each option:
- mode "code" for direct code fixes (bugs, missing error handling, clear improvements)
- mode "debug" for issues needing investigation before fixing (race conditions, unclear root causes, intermittent failures)
- mode "orchestrator" when there are many issues (5+) spanning different categories that need coordinated, planned fixes

Option patterns based on review findings:
- **Few clear fixes (1-4 issues, same category):** offer mode "code" fixes
- **Many issues across categories (5+, mixed security/performance/quality):** offer mode "orchestrator" to plan fixes and mode "code" for quick wins
- **Issues needing investigation:** include a mode "debug" option to investigate root causes
- **Suggestions only:** offer mode "code" to apply improvements

Example question tool call (ONLY after full review is written):
{
  "questions": [{
    "question": "What would you like to do?",
    "header": "Next steps",
    "options": [
      { "label": "Fix all issues", "description": "Fix all issues found in this review", "mode": "code" },
      { "label": "Fix critical only", "description": "Fix critical issues only", "mode": "code" }
    ]
  }]
}
`

const EMPTY_DIFF_PROMPT = `You are Kilo Code, an expert code reviewer with deep expertise in software engineering best practices, security vulnerabilities, performance optimization, and code quality. Your role is advisory — provide clear, actionable feedback but DO NOT modify any files. Do not use any file editing tools.

You are reviewing: \${SCOPE_DESCRIPTION}.

There is nothing to review.

Your MUST output to the user this exact format:

## Local Review for \${SCOPE_DESCRIPTION}

### Summary
No changes detected.

### Issues Found
No issues found.

### Recommendation
**APPROVE** — Nothing to review.
`

function countChanges(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.content.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
  }
  return { additions, deletions }
}

function formatFileList(files: DiffFile[]): string {
  return files
    .map((f) => {
      const status =
        f.status === "added" ? "[A]" : f.status === "deleted" ? "[D]" : f.status === "renamed" ? "[R]" : "[M]"
      const renamed = f.oldPath ? ` (was: ${f.oldPath})` : ""
      const { additions, deletions } = countChanges(f)
      return `- ${status} ${f.path}${renamed} (+${additions}, -${deletions})`
    })
    .join("\n")
}

function buildToolsSection(scope: "uncommitted" | "branch", baseBranch?: string, currentBranch?: string): string {
  if (scope === "uncommitted") {
    return `Use these git commands to explore the changes:
  - View all changes: \`git diff && git diff --cached\`
  - View specific file change: \`git diff -- <file> && git diff --cached -- <file>\`
  - View commit history: \`git log\`
  - View file history: \`git blame <file>\``
  }
  return `Use these git commands to explore the changes:
  - View branch diff: \`git diff ${baseBranch}...${currentBranch}\`
  - View specific file diff: \`git diff ${baseBranch}...${currentBranch} -- <file>\`
  - View commit history: \`git log\`
  - View file history: \`git blame <file>\``
}

/**
 * Parse git unified diff output into structured DiffResult.
 */
export function parseDiff(raw: string): DiffResult {
  const files: DiffFile[] = []

  if (!raw.trim()) {
    return { files: [], raw }
  }

  const fileDiffs = raw.split(/^diff --git /m).filter(Boolean)

  for (const fileDiff of fileDiffs) {
    const file = parseFileDiff("diff --git " + fileDiff)
    if (file) files.push(file)
  }

  return { files, raw }
}

function parseFileDiff(content: string): DiffFile | null {
  const lines = content.split("\n")

  const headerMatch = lines[0]?.match(/^diff --git a\/(.+) b\/(.+)$/)
  if (!headerMatch) return null

  const oldPath = headerMatch[1]
  const newPath = headerMatch[2]

  let status: DiffFile["status"] = "modified"
  const isNew = lines.some((l) => l.startsWith("new file mode"))
  const isDeleted = lines.some((l) => l.startsWith("deleted file mode"))
  const isRenamed = lines.some((l) => l.startsWith("rename from"))

  if (isNew) status = "added"
  else if (isDeleted) status = "deleted"
  else if (isRenamed) status = "renamed"

  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let hunkContent: string[] = []

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      if (currentHunk) {
        currentHunk.content = hunkContent.join("\n")
        hunks.push(currentHunk)
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: parseInt(hunkMatch[2] || "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newLines: parseInt(hunkMatch[4] || "1", 10),
        content: "",
      }
      hunkContent = [line]
    } else if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      hunkContent.push(line)
    }
  }

  if (currentHunk) {
    currentHunk.content = hunkContent.join("\n")
    hunks.push(currentHunk)
  }

  return {
    path: newPath,
    status,
    hunks,
    ...(isRenamed && oldPath !== newPath ? { oldPath } : {}),
  }
}

const BASE_BRANCH_CANDIDATES = ["main", "master", "dev", "develop"]

/**
 * Get current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => ({
    stdout: "",
  }))
  return (stdout || "").trim()
}

/**
 * Detect base branch (main, master, dev, develop). Falls back to "main".
 */
export async function getBaseBranch(cwd: string): Promise<string> {
  for (const branch of BASE_BRANCH_CANDIDATES) {
    const remoteCheck = await execa("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd,
    }).catch(() => ({ exitCode: 1 }))
    if (remoteCheck.exitCode === 0) return `origin/${branch}`
  }
  for (const branch of BASE_BRANCH_CANDIDATES) {
    const check = await execa("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd }).catch(
      () => ({ exitCode: 1 })
    )
    if (check.exitCode === 0) return branch
  }
  return "main"
}

/**
 * Get uncommitted changes (staged + unstaged). Uses git diff HEAD.
 */
export async function getUncommittedChanges(cwd: string): Promise<DiffResult> {
  const result = await execa("git", ["-c", "core.quotepath=false", "diff", "HEAD"], { cwd }).catch(() => ({
    stdout: "",
    exitCode: 1,
  }))
  const raw = (result.stdout || "").toString()
  return parseDiff(raw)
}

/**
 * Get branch diff vs base branch. Uses git diff base...HEAD.
 */
export async function getBranchChanges(cwd: string, baseBranch?: string): Promise<DiffResult> {
  const base = baseBranch ?? (await getBaseBranch(cwd))
  const result = await execa("git", ["-c", "core.quotepath=false", "diff", `${base}...HEAD`], { cwd }).catch(() => ({
    stdout: "",
    exitCode: 1,
  }))
  const raw = (result.stdout || "").toString()
  return parseDiff(raw)
}

/**
 * Build review prompt for uncommitted changes only (staged + unstaged).
 * Kilocode 1:1 — same prompt and behaviour.
 */
export async function buildReviewPromptUncommitted(cwd: string): Promise<string> {
  const diff = await getUncommittedChanges(cwd)

  if (diff.files.length === 0) {
    const scopeDescription = "**uncommitted changes**"
    return EMPTY_DIFF_PROMPT.replaceAll("${SCOPE_DESCRIPTION}", scopeDescription)
  }

  const scopeDescription = "**uncommitted changes**"
  const fileList = formatFileList(diff.files)
  return REVIEW_PROMPT.replaceAll("${SCOPE_DESCRIPTION}", scopeDescription)
    .replace("${FILE_LIST}", fileList)
    .replace("${TOOLS}", buildToolsSection("uncommitted"))
}

/**
 * Build review prompt for branch diff vs base branch.
 * Kilocode 1:1 — same prompt and behaviour.
 */
export async function buildReviewPromptBranch(cwd: string): Promise<string> {
  const base = await getBaseBranch(cwd)
  const currentBranch = await getCurrentBranch(cwd)
  const diff = await getBranchChanges(cwd, base)

  if (diff.files.length === 0) {
    const scopeDescription = `**branch diff**: \`${currentBranch}\` -> \`${base}\``
    return EMPTY_DIFF_PROMPT.replaceAll("${SCOPE_DESCRIPTION}", scopeDescription)
  }

  const scopeDescription = `**branch diff**: \`${currentBranch}\` -> \`${base}\``
  const fileList = formatFileList(diff.files)
  return REVIEW_PROMPT.replaceAll("${SCOPE_DESCRIPTION}", scopeDescription)
    .replace("${FILE_LIST}", fileList)
    .replace("${TOOLS}", buildToolsSection("branch", base, currentBranch))
}
