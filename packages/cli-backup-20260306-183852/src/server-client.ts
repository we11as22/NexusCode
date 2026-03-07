import type { AgentEvent, Mode, SessionMessage } from "@nexuscode/core"

export interface NexusServerClientOptions {
  baseUrl: string
  directory: string
}

/**
 * Client for NexusCode server — list/create sessions, get messages, stream agent events.
 */
export class NexusServerClient {
  private baseUrl: string
  private directory: string

  constructor(opts: NexusServerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.directory = opts.directory
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
    return res.json()
  }

  async createSession(): Promise<{ id: string; cwd: string; ts: number; messageCount: number }> {
    const res = await fetch(this.url("/session"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`Server createSession: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SessionMessage[]> {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
    const offset = Math.max(0, opts?.offset ?? 0)
    const res = await fetch(
      this.url(`/session/${sessionId}/message`, { directory: this.directory, limit: String(limit), offset: String(offset) }),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Server getMessages: ${res.status} ${await res.text()}`)
    return res.json()
  }

  /**
   * Get session meta including message count (for pagination).
   */
  async getSession(sessionId: string): Promise<{ id: string; cwd: string; ts: number; messageCount: number }> {
    const res = await fetch(this.url(`/session/${sessionId}`, { directory: this.directory }), {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Server getSession: ${res.status} ${await res.text()}`)
    return res.json()
  }

  /**
   * Delete a session and its messages.
   */
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
   * Send message and stream AgentEvents as NDJSON. Yields each event; throws on fetch error.
   */
  async *streamMessage(
    sessionId: string,
    content: string,
    mode: Mode,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const res = await fetch(this.url(`/session/${sessionId}/message`, { directory: this.directory }), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content, mode }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text()
      yield { type: "error", error: `Server: ${res.status} ${text}` }
      return
    }
    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: "error", error: "No response body" }
      return
    }
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const t = line.trim()
          if (!t) continue
          try {
            yield JSON.parse(t) as AgentEvent
          } catch {
            // skip malformed lines
          }
        }
      }
      for (const line of buffer.split("\n")) {
        const t = line.trim()
        if (!t) continue
        try {
          yield JSON.parse(t) as AgentEvent
        } catch {}
      }
    } finally {
      reader.releaseLock()
    }
  }
}
