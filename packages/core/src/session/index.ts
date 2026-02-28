import * as crypto from "node:crypto"
import type { ISession, SessionMessage, ToolPart, MessagePart } from "../types.js"
import { saveSession, loadSession, generateSessionId, type StoredSession } from "./storage.js"
import { estimateTokens } from "../context/condense.js"

/**
 * In-memory session implementation backed by JSONL storage.
 */
export class Session implements ISession {
  readonly id: string
  private _messages: SessionMessage[] = []
  private _todo: string = ""
  private cwd: string

  constructor(id: string, cwd: string, messages?: SessionMessage[]) {
    this.id = id
    this.cwd = cwd
    this._messages = messages ?? []
  }

  get messages(): SessionMessage[] {
    return this._messages
  }

  addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage {
    const full: SessionMessage = {
      ...msg,
      id: `msg_${crypto.randomBytes(6).toString("hex")}`,
      ts: Date.now(),
    }
    this._messages.push(full)
    return full
  }

  updateMessage(id: string, updates: Partial<SessionMessage>): void {
    const idx = this._messages.findIndex(m => m.id === id)
    if (idx === -1) return
    this._messages[idx] = { ...this._messages[idx]!, ...updates }
  }

  addToolPart(messageId: string, part: ToolPart): void {
    const msg = this._messages.find(m => m.id === messageId)
    if (!msg) return

    if (typeof msg.content === "string") {
      const textPart: MessagePart = { type: "text", text: msg.content }
      msg.content = [textPart, part]
    } else {
      ;(msg.content as MessagePart[]).push(part)
    }
  }

  updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void {
    const msg = this._messages.find(m => m.id === messageId)
    if (!msg || typeof msg.content === "string") return

    const parts = msg.content as MessagePart[]
    const idx = parts.findIndex(p => p.type === "tool" && (p as ToolPart).id === partId)
    if (idx === -1) return

    parts[idx] = { ...(parts[idx] as ToolPart), ...updates } as ToolPart
  }

  updateTodo(markdown: string): void {
    this._todo = markdown
  }

  getTodo(): string {
    return this._todo
  }

  getTokenEstimate(): number {
    let total = 0
    for (const msg of this._messages) {
      if (msg.summary) {
        total += estimateTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))
        continue
      }
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content)
      } else {
        for (const part of msg.content as MessagePart[]) {
          if (part.type === "text") {
            total += estimateTokens(part.text)
          } else if (part.type === "tool") {
            const tp = part as ToolPart
            if (!tp.compacted && tp.output) {
              total += estimateTokens(tp.output)
            }
            if (tp.input) {
              total += estimateTokens(JSON.stringify(tp.input))
            }
          }
        }
      }
    }
    return total
  }

  fork(messageId: string): ISession {
    const idx = this._messages.findIndex(m => m.id === messageId)
    const messages = idx === -1 ? [...this._messages] : this._messages.slice(0, idx + 1)
    return new Session(generateSessionId(), this.cwd, JSON.parse(JSON.stringify(messages)))
  }

  async save(): Promise<void> {
    const stored: StoredSession = {
      id: this.id,
      cwd: this.cwd,
      ts: Date.now(),
      messages: this._messages,
    }
    await saveSession(stored)
  }

  async load(): Promise<void> {
    const stored = await loadSession(this.id, this.cwd)
    if (stored) {
      this._messages = stored.messages
    }
  }

  static create(cwd: string): Session {
    return new Session(generateSessionId(), cwd)
  }

  static async resume(sessionId: string, cwd: string): Promise<Session | null> {
    const stored = await loadSession(sessionId, cwd)
    if (!stored) return null
    return new Session(sessionId, cwd, stored.messages)
  }
}

export { generateSessionId, listSessions } from "./storage.js"
