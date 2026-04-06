import type { AgentEvent, Mode, SessionMessage } from "./types.js"
import { canonicalProjectRoot } from "./session/storage.js"

export interface NexusServerClientOptions {
  baseUrl: string
  directory: string
}

/**
 * Client for NexusCode server — list/create sessions, get messages, stream agent events.
 * Shared by extension and CLI when serverUrl is set.
 */
export class NexusServerClient {
  private baseUrl: string
  private directory: string

  constructor(opts: NexusServerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.directory = canonicalProjectRoot(opts.directory)
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-nexus-directory": this.directory,
    }
  }

  private url(path: string, search?: Record<string, string>): string {
    const u = `${this.baseUrl}${path}`
    if (search && Object.keys(search).length > 0) {
      const q = new URLSearchParams(search).toString()
      return `${u}?${q}`
    }
    return u
  }

  async listSessions(): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number }>> {
    const res = await fetch(this.url("/session", { directory: this.directory }), {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Server listSessions: ${res.status} ${await res.text()}`)
    return res.json() as Promise<Array<{ id: string; ts: number; title?: string; messageCount: number }>>
  }

  async createSession(): Promise<{ id: string; cwd: string; ts: number; messageCount: number }> {
    const res = await fetch(this.url("/session"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`Server createSession: ${res.status} ${await res.text()}`)
    return res.json() as Promise<{ id: string; cwd: string; ts: number; messageCount: number }>
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SessionMessage[]> {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
    const offset = Math.max(0, opts?.offset ?? 0)
    const res = await fetch(
      this.url(`/session/${sessionId}/message`, {
        directory: this.directory,
        limit: String(limit),
        offset: String(offset),
      }),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Server getMessages: ${res.status} ${await res.text()}`)
    return res.json() as Promise<SessionMessage[]>
  }

  async getSession(sessionId: string): Promise<{ id: string; cwd: string; ts: number; messageCount: number }> {
    const res = await fetch(this.url(`/session/${sessionId}`, { directory: this.directory }), {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Server getSession: ${res.status} ${await res.text()}`)
    return res.json() as Promise<{ id: string; cwd: string; ts: number; messageCount: number }>
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await fetch(this.url(`/session/${sessionId}`, { directory: this.directory }), {
      method: "DELETE",
      headers: this.headers(),
    })
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`Server deleteSession: ${res.status} ${await res.text()}`)
    return true
  }

  /**
   * Send message and stream AgentEvents as NDJSON. Yields each event (heartbeat lines are skipped).
   * Malformed lines yield an error event. Throws on fetch error.
   */
  async *streamMessage(
    sessionId: string,
    content: string,
    mode: Mode,
    presetName?: string,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const maxReconnects = 3
    let reconnectAttempt = 0
    let runId = ""
    let lastSeq = 0

    const parseLine = (line: string): { event: AgentEvent | null; seq: number | null } => {
      const t = line.trim()
      if (!t) return { event: null, seq: null }
      try {
        const parsed = JSON.parse(t) as { type?: string; ts?: number; seq?: number; event?: AgentEvent }
        if (parsed?.type === "heartbeat") return { event: null, seq: null }
        if (typeof parsed.seq === "number" && parsed.event) {
          return { event: parsed.event, seq: parsed.seq }
        }
        return { event: parsed as AgentEvent, seq: null }
      } catch {
        const preview = t.length > 80 ? `${t.slice(0, 80)}…` : t
        return { event: { type: "error", error: `Invalid stream line: ${preview}` }, seq: null }
      }
    }

    while (true) {
      const res = await fetch(this.url(`/session/${sessionId}/message`, { directory: this.directory }), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(
          runId
            ? { runId, afterSeq: lastSeq }
            : { content, mode, presetName },
        ),
        signal,
      })
      if (!res.ok) {
        const text = await res.text()
        yield { type: "error", error: `Server: ${res.status} ${text}` }
        return
      }
      runId = res.headers.get("x-nexus-run-id") ?? runId
      const reader = res.body?.getReader()
      if (!reader) {
        yield { type: "error", error: "No response body" }
        return
      }
      const decoder = new TextDecoder()
      let buffer = ""
      let completedNormally = false
      try {
        while (true) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("heartbeat timeout")), DEFAULT_HEARTBEAT_TIMEOUT_MS),
            ),
          ])
          const { value, done } = chunk
          if (done) {
            completedNormally = true
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const parsed = parseLine(line)
            if (typeof parsed.seq === "number") lastSeq = parsed.seq
            if (parsed.event) yield parsed.event
          }
        }
        for (const line of buffer.split("\n")) {
          const parsed = parseLine(line)
          if (typeof parsed.seq === "number") lastSeq = parsed.seq
          if (parsed.event) yield parsed.event
        }
      } catch (error) {
        if (signal?.aborted) return
        if (!runId || reconnectAttempt >= maxReconnects) {
          yield {
            type: "remote_session_updated",
            remoteSession: {
              id: `remote-${sessionId}`,
              url: this.url(`/session/${sessionId}`),
              sessionId,
              runId,
              status: "error",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              reconnectAttempts: reconnectAttempt,
              reconnectable: false,
              error: `Server stream failed: ${(error as Error).message}`,
              metadata: { source: "client-stream" },
            },
          }
          yield { type: "error", error: `Server stream failed: ${(error as Error).message}` }
          return
        }
        reconnectAttempt++
        yield {
          type: "remote_session_updated",
          remoteSession: {
            id: `remote-${sessionId}`,
            url: this.url(`/session/${sessionId}`),
            sessionId,
            runId,
            status: "reconnecting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reconnectAttempts: reconnectAttempt,
            reconnectable: true,
            metadata: { source: "client-stream", lastSeq },
          },
        }
        continue
      } finally {
        reader.releaseLock()
      }
      if (reconnectAttempt > 0) {
        yield {
          type: "remote_session_updated",
          remoteSession: {
            id: `remote-${sessionId}`,
            url: this.url(`/session/${sessionId}`),
            sessionId,
            runId,
            status: "connected",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reconnectAttempts: reconnectAttempt,
            reconnectable: true,
            metadata: { source: "client-stream", resumedAfterSeq: lastSeq },
          },
        }
      }
      if (completedNormally) return
    }
  }
}

/** If no event (including heartbeat) received for this long, consider stream dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000
