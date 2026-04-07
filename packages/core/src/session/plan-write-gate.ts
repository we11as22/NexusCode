import * as path from "node:path"
import type { ISession, MessagePart, ToolPart } from "../types.js"
import { PLAN_MODE_ALLOWED_WRITE_PATTERN } from "../agent/modes.js"

function normalizePlanPath(raw: string, cwd: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const rel = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw
  return rel.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * True if the assistant message contains a Write/Edit tool part targeting `.nexus/plans/*.md|txt`
 * (any status — used while the same turn is still streaming).
 */
export function messageHasPlanFileWrite(session: ISession, messageId: string, cwd: string): boolean {
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !Array.isArray(msg.content)) return false
  for (const p of msg.content as MessagePart[]) {
    if (p.type !== "tool") continue
    const tp = p as ToolPart
    if (tp.tool !== "Write" && tp.tool !== "Edit") continue
    const raw = (tp.input?.file_path ?? tp.input?.path) as string | undefined
    const normalized = raw ? normalizePlanPath(raw, cwd) : null
    if (normalized && PLAN_MODE_ALLOWED_WRITE_PATTERN.test(normalized)) return true
  }
  return false
}

/**
 * True if any **completed** Write/Edit in this session targeted a plan file (OpenClaude-style: plan must
 * come from tool work in-session, not only a pre-existing file on disk).
 */
export function sessionHasCompletedPlanFileWrite(session: ISession, cwd: string): boolean {
  for (const msg of session.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const p of msg.content as MessagePart[]) {
      if (p.type !== "tool") continue
      const tp = p as ToolPart
      if (tp.status !== "completed") continue
      if (tp.tool !== "Write" && tp.tool !== "Edit") continue
      const raw = (tp.input?.file_path ?? tp.input?.path) as string | undefined
      const normalized = raw ? normalizePlanPath(raw, cwd) : null
      if (normalized && PLAN_MODE_ALLOWED_WRITE_PATTERN.test(normalized)) return true
    }
  }
  return false
}

/** PlanExit is allowed after a plan write in the current assistant message or any prior completed plan write in this session. */
export function planExitWriteGateSatisfied(session: ISession, currentAssistantMessageId: string, cwd: string): boolean {
  return (
    messageHasPlanFileWrite(session, currentAssistantMessageId, cwd) ||
    sessionHasCompletedPlanFileWrite(session, cwd)
  )
}
