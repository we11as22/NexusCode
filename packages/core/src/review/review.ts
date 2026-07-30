/** Builds a command-scoped, read-only reviewer turn from a validated Git target. */

import { execa } from "execa"
import type {
  DiffFile,
  DiffHunk,
  DiffResult,
  ReviewRequest,
  ReviewTarget,
} from "./types.js"

const REVIEW_RUBRIC = `You are a dedicated code reviewer. Review the requested Git change and report findings only. Do not modify files, create tasks, or implement fixes.

## Review standard

- Report only actionable defects introduced by the reviewed change: correctness bugs, regressions, security issues, data loss, meaningful performance problems, and important missing tests.
- Do not report style preferences, naming tastes, speculative risks, or pre-existing problems outside the changed lines.
- Read enough surrounding code and tests to establish that each finding is real.
- Every finding must identify the smallest useful line range in the changed code. Keep ranges short; avoid ranges larger than 10 lines unless the defect truly spans them.
- Order findings by priority:
  - **P0** — release-blocking or catastrophic for nearly all users.
  - **P1** — high-impact defect that should be fixed immediately.
  - **P2** — normal correctness issue that should be fixed.
  - **P3** — low-impact but concrete defect.
- If there are no qualifying findings, say so plainly. Do not invent suggestions to fill the report.

## Output

Start with findings, ordered by priority:

### Findings

For each finding:

\`[P1] Imperative title\` — \`path/to/file.ts:lineStart-lineEnd\`

Then one compact paragraph explaining the failure scenario, why it is caused by this change, and the concrete impact. Do not include a full patch.

After all findings, include:

### Overall

- **Verdict:** \`APPROVE\` or \`NEEDS CHANGES\`
- **Summary:** one or two sentences describing the change and the review result.
- **Residual risks / test gaps:** only material gaps that remain after the review, or "None identified."

Do not ask whether to apply fixes. The review turn ends after the report.`

function cleanToken(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, "")
}

const REVIEW_REVISION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/@~^{}:+-]*$/u

function validatedReviewRevision(value: string): string {
  const revision = cleanToken(value)
  if (
    revision.length === 0 ||
    revision.length > 256 ||
    revision.startsWith("-") ||
    !REVIEW_REVISION_PATTERN.test(revision)
  ) {
    throw new TypeError("Git revision contains unsupported characters")
  }
  return revision
}

export function parseReviewRequest(input: string): ReviewRequest {
  const trimmed = input.trim()
  if (!trimmed || /^uncommitted$/iu.test(trimmed)) {
    return { target: { kind: "uncommitted" } }
  }
  const uncommitted = trimmed.match(/^uncommitted\s+([\s\S]+)$/iu)
  if (uncommitted) {
    const guidance = cleanToken(uncommitted[1] ?? "")
    return {
      target: { kind: "uncommitted" },
      ...(guidance ? { guidance } : {}),
    }
  }

  const branch = trimmed.match(/^branch(?:\s+(\S+))?(?:\s+([\s\S]+))?$/iu)
  if (branch) {
    const rawBase = cleanToken(branch[1] ?? "")
    const base = rawBase ? validatedReviewRevision(rawBase) : ""
    const guidance = cleanToken(branch[2] ?? "")
    return {
      target: { kind: "branch", ...(base ? { base } : {}) },
      ...(guidance ? { guidance } : {}),
    }
  }

  const commit = trimmed.match(/^commit\s+(\S+)(?:\s+([\s\S]+))?$/iu)
  if (commit) {
    const ref = validatedReviewRevision(commit[1] ?? "")
    const guidance = cleanToken(commit[2] ?? "")
    if (ref) {
      return {
        target: { kind: "commit", ref },
        ...(guidance ? { guidance } : {}),
      }
    }
  }

  return {
    target: { kind: "uncommitted" },
    guidance: cleanToken(trimmed),
  }
}

async function revisionExists(cwd: string, value: string): Promise<boolean> {
  const revision = validatedReviewRevision(value)
  const result = await execa(
    "git",
    ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    { cwd, reject: false },
  )
  return result.exitCode === 0
}

/**
 * Resolve ambiguous command text against the repository without ever invoking
 * a shell. Kilo's strongest `/review` behavior treats the first token after
 * `branch` as a base only when it is an actual Git ref; otherwise it remains
 * user guidance. A bare resolvable revision selects a commit review.
 */
export async function resolveReviewRequest(
  cwd: string,
  input: string,
): Promise<ReviewRequest> {
  const trimmed = input.trim()
  const branch = trimmed.match(/^branch(?:\s+([\s\S]+))?$/iu)
  if (branch) {
    const remainder = branch[1]?.trim() ?? ""
    if (!remainder) return { target: { kind: "branch" } }

    const explicit = remainder.match(
      /^(?:base\s*=\s*|base\s+|against\s+|compare\s+to\s+|vs\s+)(\S+)(?:\s+([\s\S]+))?$/iu,
    )
    if (explicit) {
      const base = validatedReviewRevision(explicit[1] ?? "")
      if (!(await revisionExists(cwd, base))) {
        throw new TypeError(`Git revision was not found: ${base}`)
      }
      const guidance = cleanToken(explicit[2] ?? "")
      return {
        target: { kind: "branch", base },
        ...(guidance ? { guidance } : {}),
      }
    }

    const [candidate = "", ...rest] = remainder.split(/\s+/u)
    if (
      candidate &&
      REVIEW_REVISION_PATTERN.test(candidate) &&
      !candidate.startsWith("-") &&
      await revisionExists(cwd, candidate)
    ) {
      const guidance = cleanToken(rest.join(" "))
      return {
        target: {
          kind: "branch",
          base: validatedReviewRevision(candidate),
        },
        ...(guidance ? { guidance } : {}),
      }
    }
    return {
      target: { kind: "branch" },
      guidance: cleanToken(remainder),
    }
  }

  const parsed = parseReviewRequest(trimmed)
  if (
    parsed.target.kind === "commit" &&
    !(await revisionExists(cwd, parsed.target.ref))
  ) {
    throw new TypeError(`Git revision was not found: ${parsed.target.ref}`)
  }
  if (
    parsed.target.kind === "uncommitted" &&
    parsed.guidance &&
    !/\s/u.test(parsed.guidance) &&
    REVIEW_REVISION_PATTERN.test(parsed.guidance) &&
    !parsed.guidance.startsWith("-") &&
    await revisionExists(cwd, parsed.guidance)
  ) {
    return {
      target: {
        kind: "commit",
        ref: validatedReviewRevision(parsed.guidance),
      },
    }
  }
  return parsed
}

function targetInstructions(target: ReviewTarget): {
  scope: string
  inspections: string[]
} {
  if (target.kind === "commit") {
    return {
      scope: `commit \`${target.ref}\``,
      inspections: [
        `\`GitInspect({ operation: "show", revision: "${target.ref}" })\``,
      ],
    }
  }
  if (target.kind === "branch") {
    const base = target.base
    return {
      scope: base
        ? `topic-branch changes from the merge-base of \`${base}\` and \`HEAD\``
        : "topic-branch changes from the repository's primary base branch",
      inspections: base
        ? [
            `\`GitInspect({ operation: "diff", revision: "${base}", mergeBase: true })\``,
          ]
        : [
            "`GitInspect({ operation: \"log\", limit: 50 })` to identify the primary base branch (prefer the tracked origin default, then origin/main, main, origin/master, or master)",
            "`GitInspect({ operation: \"diff\", revision: \"<identified-base>\", mergeBase: true })`",
          ],
    }
  }
  return {
    scope: "all uncommitted changes (staged, unstaged, and untracked)",
    inspections: [
      '`GitInspect({ operation: "status" })`',
      '`GitInspect({ operation: "diff" })`',
    ],
  }
}

export function buildReviewInstruction(request: ReviewRequest): string {
  const target = targetInstructions(request.target)
  const guidance = request.guidance?.trim()
  return `${REVIEW_RUBRIC}

## Review target

Review ${target.scope}.

Use the read-only Git inspection capability with:
${target.inspections.map((inspection) => `- ${inspection}`).join("\n")}

${guidance ? `## User focus\n\n${guidance}\n\n` : ""}Inspect the actual change and enough surrounding code before producing the report.`
}

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
 * Includes an initial snapshot for fast orientation; GitInspect remains the
 * source of truth during the reviewer turn.
 */
export async function buildReviewPromptUncommitted(
  cwd: string,
  guidance?: string,
): Promise<string> {
  const diff = await getUncommittedChanges(cwd)
  const instruction = buildReviewInstruction({
    target: { kind: "uncommitted" },
    ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
  })
  const snapshot =
    diff.files.length > 0
      ? `\n\n## Initial changed-file snapshot\n\n${formatFileList(diff.files)}`
      : "\n\n## Initial changed-file snapshot\n\nNo tracked diff was detected. Still inspect `git status --short` for untracked files before concluding that there is nothing to review."
  return `${instruction}${snapshot}`
}

/**
 * Build review prompt for branch diff vs base branch.
 * Includes an initial branch snapshot while preserving read-only inspection.
 */
export async function buildReviewPromptBranch(
  cwd: string,
  baseBranch?: string,
  guidance?: string,
): Promise<string> {
  const base = baseBranch?.trim() || (await getBaseBranch(cwd))
  const diff = await getBranchChanges(cwd, base)
  const instruction = buildReviewInstruction({
    target: { kind: "branch", base },
    ...(guidance?.trim() ? { guidance: guidance.trim() } : {}),
  })
  const snapshot =
    diff.files.length > 0
      ? `\n\n## Initial changed-file snapshot\n\n${formatFileList(diff.files)}`
      : "\n\n## Initial changed-file snapshot\n\nNo changed files were detected for this branch target."
  return `${instruction}${snapshot}`
}
