import * as fs from "node:fs/promises"
import * as path from "node:path"
import { PLAN_MODE_ALLOWED_WRITE_PATTERN } from "../agent/modes.js"
import type {
  ISession,
  MessagePart,
  Mode,
  SessionMessage,
  ToolPart,
} from "../types.js"

const MAX_PLAN_FOLLOWUP_BYTES = 1024 * 1024
const MODES = new Set<Mode>(["agent", "plan", "ask", "debug", "review"])

/**
 * Kilocode-style: detect if the last assistant message completed plan_exit,
 * so the host can show "Ready to implement?" (New session / Continue here).
 */
export function hadPlanExit(session: ISession): boolean {
  const messages = session.messages
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  if (!lastAssistant) return false
  const content = lastAssistant.content
  if (typeof content === "string") return false
  const parts = content as MessagePart[]
  return parts.some(
    (p) =>
      p.type === "tool" &&
      ["plan_exit", "PlanExit"].includes((p as ToolPart).tool) &&
      (p as ToolPart).status === "completed"
  )
}

function getTextFromMessage(msg: SessionMessage): string {
  if (typeof msg.content === "string") return msg.content.trim()
  const parts = msg.content as MessagePart[]
  const texts = parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text)
  return texts.join("\n").trim()
}

function planToolPath(part: ToolPart): string | null {
  if (
    !["Write", "Edit", "write_to_file", "replace_in_file"].includes(
      part.tool,
    ) ||
    part.status !== "completed"
  ) {
    return null
  }
  const raw =
    part.path ??
    (part.input?.file_path as string | undefined) ??
    (part.input?.path as string | undefined)
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

async function readSafePlanFile(
  cwd: string,
  rawPath: string,
): Promise<string | null> {
  const resolvedCwd = path.resolve(cwd)
  const candidate = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(resolvedCwd, rawPath)
  const relative = path
    .relative(resolvedCwd, candidate)
    .replace(/\\/g, "/")
  if (
    !isPathInside(resolvedCwd, candidate) ||
    !PLAN_MODE_ALLOWED_WRITE_PATTERN.test(relative)
  ) {
    return null
  }

  try {
    const [plansRoot, fileInfo] = await Promise.all([
      fs.realpath(path.join(resolvedCwd, ".nexus", "plans")),
      fs.lstat(candidate),
    ])
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return null
    const realCandidate = await fs.realpath(candidate)
    if (!isPathInside(plansRoot, realCandidate)) return null
    const stat = await fs.stat(realCandidate)
    if (!stat.isFile() || stat.size > MAX_PLAN_FOLLOWUP_BYTES) return null
    const content = (await fs.readFile(realCandidate, "utf8")).trim()
    return content || null
  } catch {
    return null
  }
}

function latestCompletedPlanToolPath(session: ISession): string | null {
  for (let messageIndex = session.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = session.messages[messageIndex]
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    const parts = message.content as MessagePart[]
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex]
      if (part?.type !== "tool") continue
      const filePath = planToolPath(part as ToolPart)
      if (filePath) return filePath
    }
  }
  return null
}

async function readMostRecentlyModifiedPlan(cwd: string): Promise<string | null> {
  const plansDir = path.join(cwd, ".nexus", "plans")
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true })
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(plansDir, entry.name)
          const stat = await fs.stat(filePath).catch(() => null)
          return stat?.isFile()
            ? { filePath, mtimeMs: stat.mtimeMs }
            : null
        }),
    )
    candidates.sort((a, b) => (b?.mtimeMs ?? -1) - (a?.mtimeMs ?? -1))
    for (const candidate of candidates) {
      if (!candidate) continue
      const content = await readSafePlanFile(cwd, candidate.filePath)
      if (content) return content
    }
  } catch {
    // No readable plan directory.
  }
  return null
}

/**
 * Recover the per-session execution mode after replay/switching sessions.
 * New transcripts persist it on user turns; completed legacy PlanExit sessions
 * recover as plan so the approval surface remains reachable.
 */
export function getSessionModeForResume(
  session: ISession,
  fallback: Mode = "agent",
): Mode {
  const persisted = session.getMode()
  if (persisted && MODES.has(persisted)) return persisted
  const latestUser = [...session.messages]
    .reverse()
    .find((message) => message.role === "user" && MODES.has(message.mode as Mode))
  if (latestUser?.mode && MODES.has(latestUser.mode)) return latestUser.mode
  if (hadPlanExit(session)) return "plan"
  return fallback
}

/**
 * Plan content for follow-up: the exact latest completed plan Write/Edit,
 * otherwise the most recently modified safe plan file, otherwise assistant text.
 * Used to inject "Implement the following plan: ..." into a new session or continue message.
 */
export async function getPlanContentForFollowup(session: ISession, cwd: string): Promise<string> {
  const exactPlanPath = latestCompletedPlanToolPath(session)
  if (exactPlanPath) {
    const exact = await readSafePlanFile(cwd, exactPlanPath)
    if (exact) return exact
  }

  const newestPlan = await readMostRecentlyModifiedPlan(cwd)
  if (newestPlan) return newestPlan

  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant")
  if (lastAssistant) {
    const text = getTextFromMessage(lastAssistant)
    if (text) return text
  }
  return "Plan is in .nexus/plans/ (see plan file from the previous turn)."
}
