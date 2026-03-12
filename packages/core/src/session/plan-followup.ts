import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"

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
    (p) => p.type === "tool" && (p as ToolPart).tool === "plan_exit" && (p as ToolPart).status === "completed"
  )
}

function getTextFromMessage(msg: SessionMessage): string {
  if (typeof msg.content === "string") return msg.content.trim()
  const parts = msg.content as MessagePart[]
  const texts = parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text)
  return texts.join("\n").trim()
}

/**
 * Plan content for follow-up: last assistant text, or from last Write/Edit to .nexus/plans, or first .nexus/plans/*.md file.
 * Used to inject "Implement the following plan: ..." into a new session or continue message.
 */
export async function getPlanContentForFollowup(session: ISession, cwd: string): Promise<string> {
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant")
  if (lastAssistant) {
    const text = getTextFromMessage(lastAssistant)
    if (text) return text
    const parts = Array.isArray(lastAssistant.content) ? (lastAssistant.content as MessagePart[]) : []
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p?.type !== "tool") continue
      const tp = p as ToolPart
      if (!["Write", "Edit", "write_to_file", "replace_in_file"].includes(tp.tool) || tp.status !== "completed") continue
      const filePath = (tp.input?.path as string) ?? (tp.input?.file_path as string)
      if (!filePath || typeof filePath !== "string") continue
      const normalized = path.normalize(filePath).replace(/\\/g, "/")
      if (!normalized.includes(".nexus/plans") && !normalized.includes(".nexus\\plans")) continue
      const out = (tp.output ?? "").trim()
      if (out) return out
    }
  }
  const plansDir = path.join(cwd, ".nexus", "plans")
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true })
    const mdFirst = entries
      .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const e of mdFirst) {
      const content = await fs.readFile(path.join(plansDir, e.name), "utf8")
      const trimmed = content.trim()
      if (trimmed) return trimmed
    }
  } catch {
    // no .nexus/plans or not readable
  }
  return "Plan is in .nexus/plans/ (see plan file from the previous turn)."
}
