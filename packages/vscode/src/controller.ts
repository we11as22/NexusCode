/**
 * Controller — Cline-style single owner of task/session state and agent run.
 * Owns session, config, run state, and posts state/events to webview via postMessage.
 */

import * as vscode from "vscode"
import * as path from "path"
import type { AgentEvent, NexusConfig, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"
import {
  loadConfig,
  writeConfig,
  writeGlobalProfiles,
  Session,
  listSessions,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadRules,
  McpClient,
  setMcpClientInstance,
  createCompaction,
  ParallelAgentManager,
  createSpawnAgentTool,
  runAgentLoop,
  CheckpointTracker,
  CodebaseIndexer,
  createCodebaseIndexer,
  NexusConfigSchema,
} from "@nexuscode/core"
import { VsCodeHost } from "./host.js"

export type WebviewMessage =
  | { type: "newMessage"; content: string; mode: Mode; mentions?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setProfile"; profile: string }
  | { type: "getState" }
  | { type: "webviewDidLaunch" }
  | { type: "openSettings" }
  | { type: "saveConfig"; config: Partial<NexusConfig> }
  | { type: "switchSession"; sessionId: string }
  | { type: "forkSession"; messageId: string }
  | { type: "reindex" }
  | { type: "clearIndex" }
  | { type: "openFileAtLocation"; path: string; line?: number; endLine?: number }
  | { type: "setServerUrl"; url: string }

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "addToChatContent"; content: string }

export interface WebviewState {
  messages: SessionMessage[]
  mode: Mode
  isRunning: boolean
  model: string
  provider: string
  sessionId: string
  projectDir?: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatus
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  serverUrl?: string
}

function getContextLimit(modelId: string): number {
  const lower = modelId.toLowerCase()
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) return 200000
  if (lower.includes("gpt-4o")) return 128000
  if (lower.includes("gpt-4")) return 128000
  if (lower.includes("gpt-3.5")) return 16000
  if (lower.includes("gemini-2")) return 1000000
  if (lower.includes("gemini")) return 200000
  return 128000
}

export class Controller {
  private session?: Session
  private config?: NexusConfig
  private defaultModelProfile?: NexusConfig["model"]
  private mode: Mode = "agent"
  private isRunning = false
  private abortController?: AbortController
  private checkpoint?: CheckpointTracker
  private indexer?: CodebaseIndexer
  private mcpClient?: McpClient
  private serverSessionId?: string
  private initialized = false
  private initPromise?: Promise<void>
  private indexStatusUnsubscribe?: () => void
  private disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postMessageToWebview: (msg: ExtensionMessage) => void
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nexuscode")) return
        if (this.config) {
          this.applyVscodeOverrides(this.config)
          this.postStateToWebview()
        }
      })
    )
  }

  getCwd(): string {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders[0]!.uri.fsPath
    }
    return process.cwd()
  }

  getServerUrl(): string {
    return vscode.workspace.getConfiguration("nexuscode").get<string>("serverUrl")?.trim() ?? ""
  }

  getSession(): Session | undefined {
    return this.session
  }

  getConfig(): NexusConfig | undefined {
    return this.config
  }

  getIsRunning(): boolean {
    return this.isRunning
  }

  /** Build full state for webview (Cline-style getStateToPostToWebview). */
  getStateToPostToWebview(): WebviewState {
    const status = this.indexer?.status() ?? { state: "idle" as const }
    if (!this.session || !this.config) {
      return {
        messages: [],
        mode: this.mode,
        isRunning: false,
        model: "—",
        provider: "—",
        sessionId: "",
        projectDir: this.getCwd(),
        todo: "",
        indexReady: status.state === "ready",
        indexStatus: status,
        contextUsedTokens: 0,
        contextLimitTokens: 128000,
        contextPercent: 0,
        serverUrl: this.getServerUrl(),
      }
    }
    const contextUsedTokens = this.session.getTokenEstimate()
    const contextLimitTokens = getContextLimit(this.config.model.id)
    const contextPercent =
      contextLimitTokens > 0
        ? Math.min(100, Math.round((contextUsedTokens / contextLimitTokens) * 100))
        : 0
    return {
      messages: this.session.messages,
      mode: this.mode,
      isRunning: this.isRunning,
      model: this.config.model.id,
      provider: this.config.model.provider,
      sessionId: this.session.id,
      projectDir: this.getCwd(),
      todo: this.session.getTodo(),
      indexReady: status.state === "ready",
      indexStatus: status,
      contextUsedTokens,
      contextLimitTokens,
      contextPercent,
      serverUrl: this.getServerUrl(),
    }
  }

  /** Push current state to webview (Cline-style postStateToWebview). */
  postStateToWebview(): void {
    const state = this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "stateUpdate", state })
  }

  /** Clear current task/session and reset run state. */
  async clearTask(): Promise<void> {
    this.abortController?.abort()
    this.session = undefined
    this.checkpoint = undefined
    this.serverSessionId = undefined
    this.postStateToWebview()
  }

  /** Cancel running agent (abort + keep session, then post state). */
  async cancelTask(): Promise<void> {
    this.abortController?.abort()
    this.isRunning = false
    this.postStateToWebview()
  }

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
      this.postStateToWebview()
      this.sendIndexStatus()
      return
    }
    this.initPromise = (async () => {
      this.initialized = true
      const cwd = this.getCwd()
      try {
        this.config = await loadConfig(cwd)
      } catch {
        this.config = undefined
      }
      if (!this.config) {
        try {
          this.config = await loadConfig(process.cwd())
        } catch {}
      }
      if (!this.config) {
        this.config = NexusConfigSchema.parse({}) as NexusConfig
      }
      this.applyVscodeOverrides(this.config)
      this.defaultModelProfile = { ...this.config.model }
      try {
        this.session = Session.create(cwd)
        this.postStateToWebview()
        this.sendIndexStatus()
        this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.reconnectMcpServers().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
        })
        void this.initializeIndexer(cwd).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
        })
      } catch (err) {
        console.warn("[nexus] Init error:", err)
        this.postStateToWebview()
      }
    })()
    await this.initPromise
    this.initPromise = Promise.resolve()
  }

  async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "newMessage":
        await this.ensureInitialized()
        await this.runAgent(msg.content, msg.mode)
        break
      case "abort":
        this.abortController?.abort()
        this.isRunning = false
        this.postStateToWebview()
        break
      case "compact":
        await this.compactHistory()
        break
      case "clearChat":
        this.session = Session.create(this.getCwd())
        this.checkpoint = undefined
        this.serverSessionId = undefined
        this.postStateToWebview()
        break
      case "setMode":
        this.mode = msg.mode
        this.postStateToWebview()
        break
      case "setProfile":
        if (this.config) {
          if (!msg.profile) {
            if (this.defaultModelProfile) {
              this.config.model = { ...this.defaultModelProfile }
            }
            this.postMessageToWebview({ type: "configLoaded", config: this.config })
            this.postStateToWebview()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.config.model = { ...this.config.model, ...profile }
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
          this.postStateToWebview()
        }
        break
      case "getState":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) this.postMessageToWebview({ type: "configLoaded", config: this.config })
        await this.sendSessionList()
        break
      case "webviewDidLaunch":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) this.postMessageToWebview({ type: "configLoaded", config: this.config })
        await this.sendSessionList()
        break
      case "openSettings":
        try {
          await vscode.commands.executeCommand("workbench.action.openSettings", "nexuscode")
        } catch {
          try {
            await vscode.commands.executeCommand("workbench.action.openSettings")
          } catch {}
        }
        break
      case "saveConfig":
        await this.handleSaveConfig(msg.config)
        break
      case "switchSession":
        await this.switchSession(msg.sessionId)
        break
      case "forkSession":
        if (this.session && msg.messageId) {
          this.session = this.session.fork(msg.messageId) as Session
          if (this.getServerUrl()) this.serverSessionId = undefined
          this.postStateToWebview()
        }
        break
      case "reindex":
        await this.reindex()
        break
      case "clearIndex":
        await this.clearIndex()
        break
      case "openFileAtLocation": {
        const cwd = this.getCwd()
        const absPath = path.isAbsolute(msg.path) ? msg.path : path.join(cwd, msg.path)
        const uri = vscode.Uri.file(absPath)
        const line = Math.max(0, (msg.line ?? 1) - 1)
        const endLine = msg.endLine != null ? Math.max(0, msg.endLine - 1) : line
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Range(line, 0, endLine, 0),
            preview: false,
          })
          editor.revealRange(new vscode.Range(line, 0, endLine, 0), vscode.TextEditorRevealType.InCenter)
        } catch {
          vscode.window.showErrorMessage(`NexusCode: Could not open ${msg.path}`)
        }
        break
      }
      case "setServerUrl": {
        const url = typeof msg.url === "string" ? msg.url.trim() : ""
        await vscode.workspace.getConfiguration("nexuscode").update("serverUrl", url || undefined, vscode.ConfigurationTarget.Global)
        this.postStateToWebview()
        break
      }
    }
  }

  private async handleSaveConfig(patch: Partial<NexusConfig>): Promise<void> {
    if (!this.config || !patch) return
    const modelPatch = (patch as Record<string, unknown>).model as Record<string, unknown> | undefined
    if (modelPatch && (modelPatch.apiKey === "" || modelPatch.apiKey === undefined)) {
      const existing = (this.config as Record<string, unknown>).model as Record<string, unknown> | undefined
      if (existing?.apiKey) modelPatch.apiKey = existing.apiKey
    }
    if (modelPatch && (modelPatch.baseUrl === "" || modelPatch.baseUrl === undefined)) {
      const existing = (this.config as Record<string, unknown>).model as Record<string, unknown> | undefined
      if (existing?.baseUrl) modelPatch.baseUrl = existing.baseUrl
    }
    const indexBefore = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    const mcpBefore = JSON.stringify({ mcp: this.config.mcp })
    deepMergeInto(this.config as Record<string, unknown>, patch as Record<string, unknown>)
    this.defaultModelProfile = { ...this.config.model }
    if (patch.profiles && typeof patch.profiles === "object") {
      writeGlobalProfiles(patch.profiles as Record<string, unknown>)
    }
    const cwd = this.getCwd()
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(
        "NexusCode: Open a workspace folder first so settings can be saved to .nexus/nexus.yaml in the project.",
        { modal: false }
      )
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
      this.postStateToWebview()
      return
    }
    try {
      writeConfig(this.config, cwd)
      vscode.window.showInformationMessage("NexusCode: Settings saved.", { modal: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save settings — ${message}`)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `Save failed: ${message}` } })
    }
    const mcpAfter = JSON.stringify({ mcp: this.config.mcp })
    if (mcpBefore !== mcpAfter) {
      void this.reconnectMcpServers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
      })
    }
    const indexAfter = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    if (indexBefore !== indexAfter) {
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
    }
    this.postMessageToWebview({ type: "configLoaded", config: this.config })
    this.postStateToWebview()
  }

  private async runAgent(content: string, mode?: Mode): Promise<void> {
    if (this.isRunning) return
    if (!this.session || !this.config) {
      this.isRunning = false
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: "NexusCode is still initializing. Please retry in a moment." },
      })
      this.postStateToWebview()
      return
    }
    this.mode = mode ?? this.mode
    this.isRunning = true
    this.abortController = new AbortController()
    this.session.addMessage({ role: "user", content })
    this.postStateToWebview()

    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()

    if (serverUrl) {
      try {
        let sid = this.serverSessionId
        if (!sid) {
          const createRes = await fetch(`${serverUrl.replace(/\/$/, "")}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: "{}",
          })
          if (!createRes.ok) throw new Error(`Server create session: ${createRes.status}`)
          const created = (await createRes.json()) as { id: string }
          sid = created.id
          this.serverSessionId = sid
        }
        const res = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sid}/message?directory=${encodeURIComponent(cwd)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: JSON.stringify({ content, mode: this.mode }),
            signal: this.abortController!.signal,
          }
        )
        if (!res.ok) {
          this.postMessageToWebview({
            type: "agentEvent",
            event: { type: "error", error: `Server: ${res.status} ${await res.text()}` },
          })
          this.isRunning = false
          this.postStateToWebview()
          return
        }
        const reader = res.body?.getReader()
        if (!reader) {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: "No response body" } })
          this.isRunning = false
          this.postStateToWebview()
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
                this.postMessageToWebview({ type: "agentEvent", event: JSON.parse(t) as AgentEvent })
              } catch {}
            }
          }
          for (const line of buffer.split("\n")) {
            const t = line.trim()
            if (!t) continue
            try {
              this.postMessageToWebview({ type: "agentEvent", event: JSON.parse(t) as AgentEvent })
            } catch {}
          }
        } finally {
          reader.releaseLock()
        }
        try {
          const metaRes = await fetch(
            `${serverUrl.replace(/\/$/, "")}/session/${sid}?directory=${encodeURIComponent(cwd)}`,
            { headers: { "x-nexus-directory": cwd } }
          )
          if (metaRes.ok) {
            const meta = (await metaRes.json()) as { messageCount: number }
            const offset = Math.max(0, meta.messageCount - 100)
            const msgRes = await fetch(
              `${serverUrl.replace(/\/$/, "")}/session/${sid}/message?directory=${encodeURIComponent(cwd)}&limit=100&offset=${offset}`,
              { headers: { "x-nexus-directory": cwd } }
            )
            if (msgRes.ok) {
              const messages = (await msgRes.json()) as SessionMessage[]
              this.session = new Session(sid!, cwd, messages)
            }
          }
        } catch {}
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes("abort")) {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: msg } })
        }
      } finally {
        this.isRunning = false
        this.postStateToWebview()
      }
      return
    }

    const host = new VsCodeHost(cwd, (event: AgentEvent) => {
      this.postMessageToWebview({ type: "agentEvent", event })
      if (event.type === "error") {
        this.isRunning = false
        this.postStateToWebview()
      }
    })

    const timeoutMs = 10 * 60_000
    const timeout = setTimeout(() => {
      if (!this.isRunning) return
      this.abortController?.abort()
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: `LLM request timed out after ${Math.round(timeoutMs / 60000)} minutes.` },
      })
    }, timeoutMs)

    try {
      const client = createLLMClient(this.config.model)
      const toolRegistry = new ToolRegistry()
      if (this.mcpClient) {
        for (const tool of this.mcpClient.getTools()) {
          toolRegistry.register(tool)
        }
      }
      const parallelManager = new ParallelAgentManager()
      toolRegistry.register(createSpawnAgentTool(parallelManager, this.config))
      const { builtin: tools, dynamic } = toolRegistry.getForMode(this.mode)
      const allTools = [...tools, ...dynamic]
      const rulesContent = await loadRules(cwd, this.config.rules.files).catch(() => "")
      const skills = await loadSkills(this.config.skills, cwd).catch(() => [])
      const compaction = createCompaction()
      if (this.config.checkpoint.enabled && !this.checkpoint) {
        this.checkpoint = new CheckpointTracker(this.session.id, cwd)
        await this.checkpoint.init(this.config.checkpoint.timeoutMs).catch(console.warn)
      }
      if (this.checkpoint) {
        host.setCheckpoint(this.checkpoint)
      }
      await this.refreshIndexerFromGit(cwd)
      await runAgentLoop({
        session: this.session,
        client,
        host,
        config: this.config,
        mode: this.mode,
        tools: allTools,
        skills,
        rulesContent,
        indexer: this.indexer,
        compaction,
        signal: this.abortController!.signal,
        checkpoint: this.checkpoint,
      })
    } catch (err) {
      const errMsg = (err as Error).message
      if (errMsg !== "AbortError" && !errMsg.includes("aborted")) {
        console.error("[nexus] Agent loop error:", err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: errMsg } })
      }
    } finally {
      clearTimeout(timeout)
      this.isRunning = false
      await this.session!.save().catch(() => {})
      this.postStateToWebview()
    }
  }

  private async reconnectMcpServers(): Promise<void> {
    if (!this.config) return
    if (!this.mcpClient) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
    }
    await this.mcpClient.disconnectAll().catch(() => {})
    if (this.config.mcp.servers.length === 0) return
    await this.mcpClient.connectAll(this.config.mcp.servers).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
  }

  private async compactHistory(): Promise<void> {
    if (!this.session || !this.config) return
    if (this.getServerUrl()) {
      vscode.window.showInformationMessage("NexusCode: Compaction is not supported when using NexusCode Server.")
      return
    }
    const client = createLLMClient(this.config.model)
    const compaction = createCompaction()
    this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_start" } })
    try {
      await compaction.compact(this.session, client)
    } finally {
      this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_end" } })
      this.postStateToWebview()
    }
  }

  async reindex(): Promise<void> {
    if (!this.indexer || !this.config) return
    try {
      await this.indexer.reindex()
    } catch (err) {
      console.warn("[nexus] Reindex error:", err)
    }
  }

  async clearIndex(): Promise<void> {
    if (!this.config || !this.config.indexing.enabled) return
    const cwd = this.getCwd()
    await this.initializeIndexer(cwd)
    await this.indexer?.reindex()
    this.sendIndexStatus()
    this.postStateToWebview()
  }

  addToChat(text: string): void {
    this.postMessageToWebview({ type: "addToChatContent", content: text })
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
  }

  async runAgentWithPrompt(content: string, mode?: Mode): Promise<void> {
    await this.ensureInitialized()
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
    await this.runAgent(content, mode)
  }

  private sendIndexStatus(status?: IndexStatus): void {
    const s = status ?? this.indexer?.status() ?? { state: "idle" as const }
    this.postMessageToWebview({ type: "indexStatus", status: s })
  }

  private async sendSessionList(): Promise<void> {
    const serverUrl = this.getServerUrl()
    const cwd = this.getCwd()
    this.postMessageToWebview({ type: "sessionListLoading", loading: true })
    try {
      if (serverUrl) {
        try {
          const res = await fetch(
            `${serverUrl.replace(/\/$/, "")}/session?directory=${encodeURIComponent(cwd)}`,
            { headers: { "x-nexus-directory": cwd } }
          )
          if (res.ok) {
            const sessions = (await res.json()) as Array<{ id: string; ts: number; title?: string; messageCount: number }>
            this.postMessageToWebview({ type: "sessionList", sessions })
            return
          }
        } catch {}
      }
      const sessions = await listSessions(cwd).catch(() => [])
      this.postMessageToWebview({ type: "sessionList", sessions })
    } finally {
      this.postMessageToWebview({ type: "sessionListLoading", loading: false })
    }
  }

  private async switchSession(sessionId: string): Promise<void> {
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const metaRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}?directory=${encodeURIComponent(cwd)}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!metaRes.ok) return
        const meta = (await metaRes.json()) as { messageCount: number }
        const offset = Math.max(0, meta.messageCount - 100)
        const msgRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message?directory=${encodeURIComponent(cwd)}&limit=100&offset=${offset}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!msgRes.ok) return
        const messages = (await msgRes.json()) as SessionMessage[]
        this.session = new Session(sessionId, cwd, messages)
        this.serverSessionId = sessionId
        this.checkpoint = undefined
        this.postStateToWebview()
      } catch {}
      return
    }
    const loaded = await Session.resume(sessionId, cwd)
    if (loaded) {
      this.session = loaded
      this.checkpoint = undefined
      this.postStateToWebview()
    }
  }

  private applyVscodeOverrides(config: NexusConfig): void {
    const cfg = vscode.workspace.getConfiguration("nexuscode")
    const provider = cfg.get<string>("provider")
    if (provider != null && provider !== "") {
      if (provider === "openrouter") {
        config.model.provider = "openai-compatible"
        if (!config.model.baseUrl) config.model.baseUrl = "https://openrouter.ai/api/v1"
      } else {
        config.model.provider = provider as NexusConfig["model"]["provider"]
      }
    }
    const model = cfg.get<string>("model")
    if (model != null && model !== "") config.model.id = model
    const apiKey = cfg.get<string>("apiKey")
    if (apiKey != null && apiKey !== "") config.model.apiKey = apiKey
    const baseUrl = cfg.get<string>("baseUrl")
    if (baseUrl != null && baseUrl !== "") config.model.baseUrl = baseUrl
    const temperature = cfg.get<number>("temperature")
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      config.model.temperature = Math.max(0, Math.min(2, temperature))
    }
    const enableCheckpoints = cfg.get<boolean>("enableCheckpoints")
    if (typeof enableCheckpoints === "boolean") config.checkpoint.enabled = enableCheckpoints
    const autoApproveRead = cfg.get<boolean>("autoApproveRead")
    if (typeof autoApproveRead === "boolean") config.permissions.autoApproveRead = autoApproveRead
    const autoApproveWrite = cfg.get<boolean>("autoApproveWrite")
    if (typeof autoApproveWrite === "boolean") config.permissions.autoApproveWrite = autoApproveWrite
    const autoApproveCommand = cfg.get<boolean>("autoApproveCommand")
    if (typeof autoApproveCommand === "boolean") config.permissions.autoApproveCommand = autoApproveCommand
  }

  private async initializeIndexer(cwd: string): Promise<void> {
    this.indexStatusUnsubscribe?.()
    this.indexStatusUnsubscribe = undefined
    this.indexer?.close()
    this.indexer = undefined
    if (!this.config?.indexing.enabled) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    this.indexer = await createCodebaseIndexer(cwd, this.config, { onWarning: (message: string) => console.warn(message) })
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status: IndexStatus) => {
      this.sendIndexStatus(status)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "index_update", status } })
    })
    this.indexer.startIndexing().catch((err: unknown) => console.warn("[nexus] Indexer start error:", err))
  }

  private async refreshIndexerFromGit(cwd: string): Promise<void> {
    if (!this.indexer?.refreshFileNow) return
    const { execa } = await import("execa")
    const runGit = async (args: string[]): Promise<string> => {
      const res = await execa("git", ["-C", cwd, ...args], { reject: false, timeout: 4000 })
      if (res.exitCode !== 0) return ""
      return (res.stdout ?? "").trim()
    }
    const [changedTracked, changedStaged, untracked, deletedTracked, deletedStaged] = await Promise.all([
      runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"]),
      runGit(["ls-files", "--others", "--exclude-standard"]),
      runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=D"]),
    ])
    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const line of [changedTracked, changedStaged, untracked].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) changed.add(p)
    }
    for (const line of [deletedTracked, deletedStaged].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) deleted.add(p)
    }
    const all = [...changed, ...deleted].slice(0, 512)
    for (let i = 0; i < all.length; i += 16) {
      const chunk = all.slice(i, i + 16)
      await Promise.allSettled(
        chunk.map((relPath) => this.indexer!.refreshFileNow!(path.resolve(cwd, relPath)))
      )
    }
  }

  dispose(): void {
    this.abortController?.abort()
    this.indexStatusUnsubscribe?.()
    this.indexer?.close()
    this.indexer = undefined
    this.mcpClient?.disconnectAll().catch(() => {})
    this.mcpClient = undefined
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
    this.initialized = false
    this.initPromise = undefined
  }
}

function deepMergeInto<T extends Record<string, unknown>>(target: T, patch: Partial<T>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = target[key as keyof T]
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      deepMergeInto(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      (target as Record<string, unknown>)[key] = value as unknown
    }
  }
  return target
}
