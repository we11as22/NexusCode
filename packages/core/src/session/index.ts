import * as crypto from "node:crypto"
import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"
import {
  saveSession,
  loadSession,
  loadSessionMessages,
  getSessionMeta,
  generateSessionId,
  canonicalProjectRoot,
  type StoredSession,
} from "./storage.js"
import { estimateActiveContextSessionTokens } from "../context/context-usage.js"
import type { StoredContextUsage } from "./storage.js"

const SESSION_TITLE_MAX_LEN = 80

/** Derive session title from first user message. */
export function deriveSessionTitle(messages: SessionMessage[]): string {
  const user = messages.find((m) => m.role === "user")
  if (!user) return ""
  let text = ""
  if (typeof user.content === "string") {
    text = user.content
  } else if (Array.isArray(user.content)) {
    const part = (user.content as MessagePart[]).find((p) => p.type === "text")
    if (part && "text" in part) text = part.text
  }
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? ""
  return firstLine.slice(0, SESSION_TITLE_MAX_LEN)
}

/**
 * In-memory session implementation backed by JSONL storage.
 */
export class Session implements ISession {
  readonly id: string
  private _messages: SessionMessage[] = []
  private _todo: string = ""
  private cwd: string
  /** Ephemeral sessions are never persisted to disk (used for sub-agents). */
  private _ephemeral: boolean
  /** Cached token estimate for the active context; invalidated on every session mutation. */
  private _tokenEstimateCache: number | null = null
  /** Last context_usage from agent (full formula). Cleared when messages change. */
  private _contextUsageSnapshot: StoredContextUsage | null = null

  constructor(
    id: string,
    cwd: string,
    messages?: SessionMessage[],
    initialTodo?: string,
    ephemeral = false,
    contextUsageSnapshot?: StoredContextUsage | null,
  ) {
    this.id = id
    this.cwd = canonicalProjectRoot(cwd)
    this._messages = messages ?? []
    this._todo = typeof initialTodo === "string" ? initialTodo : ""
    this._ephemeral = ephemeral
    this._contextUsageSnapshot = contextUsageSnapshot ?? null
  }

  get messages(): SessionMessage[] {
    return this._messages
  }

  invalidateTokenEstimate(): void {
    this._tokenEstimateCache = null
  }

  private clearContextUsageSnapshot(): void {
    this._contextUsageSnapshot = null
  }

  addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage {
    const full: SessionMessage = {
      ...msg,
      id: `msg_${crypto.randomBytes(6).toString("hex")}`,
      ts: Date.now(),
    }
    this._messages.push(full)
    this.invalidateTokenEstimate()
    // Only clear on a new user turn — assistant/tool updates happen after context_usage emit and must keep the last snapshot for CLI/extension idle display.
    if (msg.role === "user") {
      this.clearContextUsageSnapshot()
    }
    return full
  }

  updateMessage(id: string, updates: Partial<SessionMessage>): void {
    const idx = this._messages.findIndex(m => m.id === id)
    if (idx === -1) return
    this._messages[idx] = { ...this._messages[idx]!, ...updates }
    this.invalidateTokenEstimate()
  }

  addToolPart(messageId: string, part: ToolPart): void {
    const msg = this._messages.find(m => m.id === messageId)
    if (!msg) return
    // Append in chronological order (text, then each tool_call as it is emitted — including MCP)
    if (typeof msg.content === "string") {
      const textPart: MessagePart = { type: "text", text: msg.content }
      msg.content = [textPart, part]
    } else {
      ;(msg.content as MessagePart[]).push(part)
    }
    this.invalidateTokenEstimate()
  }

  updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void {
    const msg = this._messages.find(m => m.id === messageId)
    if (!msg || typeof msg.content === "string") return

    const parts = msg.content as MessagePart[]
    const idx = parts.findIndex(p => p.type === "tool" && (p as ToolPart).id === partId)
    if (idx === -1) return

    parts[idx] = { ...(parts[idx] as ToolPart), ...updates } as ToolPart
    this.invalidateTokenEstimate()
  }

  updateTodo(markdown: string): void {
    this._todo = markdown
  }

  getTodo(): string {
    return this._todo
  }

  getTokenEstimate(): number {
    if (this._tokenEstimateCache != null) return this._tokenEstimateCache
    const total = estimateActiveContextSessionTokens(this._messages)
    this._tokenEstimateCache = total
    return total
  }

  getLastContextUsageSnapshot(): StoredContextUsage | undefined {
    return this._contextUsageSnapshot ?? undefined
  }

  recordContextUsage(snapshot: StoredContextUsage): void {
    this._contextUsageSnapshot = { ...snapshot }
  }

  fork(messageId: string): ISession {
    const idx = this._messages.findIndex(m => m.id === messageId)
    const messages = idx === -1 ? [...this._messages] : this._messages.slice(0, idx + 1)
    return new Session(generateSessionId(), this.cwd, JSON.parse(JSON.stringify(messages)), undefined, false, null)
  }

  /** Rewind chat to timestamp. Keeps only messages with ts <= timestamp. */
  rewindToTimestamp(timestamp: number): void {
    const keep = this._messages.filter(m => m.ts <= timestamp)
    if (keep.length < this._messages.length) {
      this._messages = keep
      this.invalidateTokenEstimate()
      this.clearContextUsageSnapshot()
    }
  }

  /** Rewind so that only messages strictly before this timestamp remain (used for rollback before a given message). */
  rewindBeforeTimestamp(timestamp: number): void {
    const keep = this._messages.filter(m => m.ts < timestamp)
    if (keep.length < this._messages.length) {
      this._messages = keep
      this.invalidateTokenEstimate()
      this.clearContextUsageSnapshot()
    }
  }

  /** Rewind so that only messages strictly before a specific message remain. */
  rewindBeforeMessageId(messageId: string): void {
    const idx = this._messages.findIndex((m) => m.id === messageId)
    if (idx <= 0) {
      if (idx === 0) {
        this._messages = []
        this.invalidateTokenEstimate()
        this.clearContextUsageSnapshot()
      }
      return
    }
    this._messages = this._messages.slice(0, idx)
    this.invalidateTokenEstimate()
    this.clearContextUsageSnapshot()
  }

  async save(): Promise<void> {
    if (this._ephemeral) return  // sub-agent sessions are never persisted
    const title = deriveSessionTitle(this._messages)
    const stored: StoredSession = {
      id: this.id,
      cwd: this.cwd,
      ts: Date.now(),
      title: title || undefined,
      todo: this._todo,
      ...(this._contextUsageSnapshot ? { contextUsage: this._contextUsageSnapshot } : {}),
      messages: this._messages,
    }
    await saveSession(stored)
  }

  async load(): Promise<void> {
    const stored = await loadSession(this.id, this.cwd)
    if (stored) {
      this._messages = stored.messages
      this._todo = typeof stored.todo === "string" ? stored.todo : ""
      this._contextUsageSnapshot = stored.contextUsage ?? null
      this.invalidateTokenEstimate()
    }
  }

  static create(cwd: string): Session {
    return new Session(generateSessionId(), cwd)
  }

  /** Create a session that is never saved to disk (for sub-agents). */
  static createEphemeral(cwd: string): Session {
    return new Session(generateSessionId(), cwd, undefined, undefined, true)
  }

  static async resume(sessionId: string, cwd: string): Promise<Session | null> {
    const stored = await loadSession(sessionId, cwd)
    if (!stored) return null
    const todo = typeof stored.todo === "string" ? stored.todo : ""
    return new Session(sessionId, cwd, stored.messages, todo, false, stored.contextUsage ?? null)
  }

  static async resumeWindow(sessionId: string, cwd: string, limit: number, offset: number): Promise<Session | null> {
    const loaded = await loadSessionMessages(sessionId, cwd, limit, offset)
    if (!loaded) return null
    return new Session(sessionId, cwd, loaded.messages, loaded.meta.todo ?? "", false, null)
  }

  static async getMeta(sessionId: string, cwd: string) {
    return getSessionMeta(sessionId, cwd)
  }
}

export {
  generateSessionId,
  listSessions,
  deleteSession,
  getSessionMeta,
  loadSessionMessages,
  canonicalProjectRoot,
  saveSession,
  loadSession,
} from "./storage.js"
