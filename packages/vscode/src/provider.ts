import * as vscode from "vscode"
import * as crypto from "crypto"
import type { AgentEvent, NexusConfig, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"
import {
  loadConfig, writeConfig, writeGlobalProfiles, Session, listSessions, createLLMClient, ToolRegistry, loadSkills,
  loadRules, McpClient, setMcpClientInstance, createCompaction,
  ParallelAgentManager, createSpawnAgentTool, runAgentLoop,
  CheckpointTracker, CodebaseIndexer, createCodebaseIndexer,
} from "@nexuscode/core"
import { VsCodeHost } from "./host.js"

export type WebviewMessage =
  | { type: "newMessage"; content: string; mode: Mode; mentions?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setMaxMode"; enabled: boolean }
  | { type: "setProfile"; profile: string }
  | { type: "getState" }
  | { type: "webviewDidLaunch" }
  | { type: "openSettings" }
  | { type: "saveConfig"; config: Partial<NexusConfig> }
  | { type: "switchSession"; sessionId: string }
  | { type: "forkSession"; messageId: string }
  | { type: "reindex" }
  | { type: "clearIndex" }

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "addToChatContent"; content: string }

export interface WebviewState {
  messages: SessionMessage[]
  mode: Mode
  maxMode: boolean
  isRunning: boolean
  model: string
  provider: string
  sessionId: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatus
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
}

/**
 * VS Code WebviewView provider for NexusCode.
 * Manages the agent session, webview, and all state.
 */
export class NexusProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "nexuscode.sidebar"
  private view?: vscode.WebviewView
  private panel?: vscode.WebviewPanel

  private session?: Session
  private config?: NexusConfig
  private defaultModelProfile?: NexusConfig["model"]
  private mode: Mode = "agent"
  private maxMode = false
  private isRunning = false
  private abortController?: AbortController
  private checkpoint?: CheckpointTracker
  private indexer?: CodebaseIndexer
  private mcpClient?: McpClient

  private initialized = false
  private fileWatcher?: vscode.FileSystemWatcher
  private indexStatusUnsubscribe?: () => void
  private disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nexuscode")) return
        if (this.config) {
          applyVscodeOverrides(this.config)
          this.maxMode = this.config.maxMode.enabled
          this.postStateUpdate()
        }
      })
    )
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView
    this.setupWebview(webviewView.webview)
    // Run init in background so the panel appears immediately; state will update when ready
    void this.ensureInitialized()

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postStateUpdate()
        this.sendIndexStatus()
      }
    }, null, this.disposables)
  }

  async openPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside)
      return
    }

    this.panel = vscode.window.createWebviewPanel(
      "nexuscode.panel",
      "NexusCode",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    )

    this.setupWebview(this.panel.webview)
    void this.ensureInitialized()

    this.panel.onDidDispose(() => {
      this.panel = undefined
    }, null, this.disposables)
  }

  private setupWebview(webview: vscode.Webview): void {
    // Like Roo-Code: whole extension as resource root so webview can load dist assets
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    }

    webview.html = this.getHtml(webview)

    webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg)
    }, null, this.disposables)

    // Send initial state so webview gets data even before getState/webviewDidLaunch
    queueMicrotask(() => {
      this.postStateUpdate()
      this.sendIndexStatus()
    })
  }

  /**
   * Initialize once — guard prevents double-init when both sidebar and panel are active.
   * Sends state to webview immediately after config/session load; MCP and indexer run in background.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      this.postStateUpdate()
      this.sendIndexStatus()
      return
    }

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
      this.postStateUpdate()
      return
    }

    applyVscodeOverrides(this.config)

    this.maxMode = this.config.maxMode.enabled
    this.defaultModelProfile = { ...this.config.model }

    try {
      this.session = Session.create(cwd)

      this.postStateUpdate()
      this.sendIndexStatus()

      if (this.config.mcp.servers.length > 0) {
        this.mcpClient = new McpClient()
        setMcpClientInstance(this.mcpClient)
        this.mcpClient.connectAll(this.config.mcp.servers).catch((err: unknown) => {
          console.warn("[nexus] MCP connection error:", err)
        })
      }

      await this.initializeIndexer(cwd)
      this.postMessage({ type: "configLoaded", config: this.config })
    } catch (err) {
      console.warn("[nexus] Init error:", err)
      this.postStateUpdate()
    }
  }

  private setupFileWatcher(cwd: string): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose()
    }

    // Watch all files in workspace for changes/creates/deletes
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(cwd, "**/*"),
      false, // create
      false, // change
      false  // delete
    )

    const onFileChange = (uri: vscode.Uri) => {
      this.indexer?.refreshFile(uri.fsPath)
    }

    this.fileWatcher.onDidChange(onFileChange, null, this.disposables)
    this.fileWatcher.onDidCreate(onFileChange, null, this.disposables)
    this.fileWatcher.onDidDelete(onFileChange, null, this.disposables)
    this.disposables.push(this.fileWatcher)
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "newMessage":
        await this.runAgent(msg.content, msg.mode)
        break

      case "abort":
        this.abortController?.abort()
        this.isRunning = false
        this.postStateUpdate()
        break

      case "compact":
        await this.compactHistory()
        break

      case "clearChat":
        this.session = Session.create(this.getCwd())
        this.checkpoint = undefined
        this.postStateUpdate()
        break

      case "setMode":
        this.mode = msg.mode
        this.postStateUpdate()
        break

      case "setMaxMode":
        this.maxMode = msg.enabled
        if (this.config) {
          this.config.maxMode.enabled = msg.enabled
          writeConfig(this.config, this.getCwd())
        }
        this.postStateUpdate()
        break

      case "setProfile":
        if (this.config) {
          if (!msg.profile) {
            if (this.defaultModelProfile) {
              this.config.model = { ...this.defaultModelProfile }
            }
            this.postMessage({ type: "configLoaded", config: this.config })
            this.postStateUpdate()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.config.model = {
            ...this.config.model,
            ...profile,
          }
          this.postMessage({ type: "configLoaded", config: this.config })
          this.postStateUpdate()
        }
        break

      case "getState":
        this.postStateUpdate()
        this.sendIndexStatus()
        if (this.config) this.postMessage({ type: "configLoaded", config: this.config })
        await this.sendSessionList()
        break

      case "webviewDidLaunch":
        // Like Roo-Code: webview signals ready → send full state
        this.postStateUpdate()
        this.sendIndexStatus()
        if (this.config) this.postMessage({ type: "configLoaded", config: this.config })
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
        if (this.config && msg.config) {
          const before = JSON.stringify({
            indexing: this.config.indexing,
            vectorDb: this.config.vectorDb,
            embeddings: this.config.embeddings,
          })

          deepMergeInto(this.config as any, normalizeConfigPatch(msg.config as any))
          this.defaultModelProfile = { ...this.config.model }
          if (msg.config.profiles && typeof msg.config.profiles === "object") {
            writeGlobalProfiles(msg.config.profiles as Record<string, unknown>)
          }
          writeConfig(this.config, this.getCwd())
          this.maxMode = this.config.maxMode.enabled

          const after = JSON.stringify({
            indexing: this.config.indexing,
            vectorDb: this.config.vectorDb,
            embeddings: this.config.embeddings,
          })
          if (before !== after) {
            await this.initializeIndexer(this.getCwd())
          }

          this.postMessage({ type: "configLoaded", config: this.config })
          this.postStateUpdate()
        }
        break

      case "switchSession":
        await this.switchSession(msg.sessionId)
        break

      case "forkSession":
        if (this.session && msg.messageId) {
          this.session = this.session.fork(msg.messageId) as Session
          this.postStateUpdate()
        }
        break

      case "reindex":
        await this.reindex()
        break

      case "clearIndex":
        await this.clearIndex()
        break
    }
  }

  private async runAgent(content: string, mode?: Mode): Promise<void> {
    if (this.isRunning || !this.session || !this.config) return

    this.mode = mode ?? this.mode
    this.isRunning = true
    this.abortController = new AbortController()

    this.session.addMessage({ role: "user", content })
    this.postStateUpdate()

    const cwd = this.getCwd()

    const host = new VsCodeHost(cwd, (event: AgentEvent) => {
      this.postMessage({ type: "agentEvent", event })
      if (event.type === "error") {
        this.isRunning = false
        this.postStateUpdate()
      }
    })

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

    // Init checkpoint (once per session, not per message)
    if (this.config.checkpoint.enabled && !this.checkpoint) {
      this.checkpoint = new CheckpointTracker(this.session.id, cwd)
      await this.checkpoint.init(this.config.checkpoint.timeoutMs).catch(console.warn)
    }

    try {
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
        signal: this.abortController.signal,
      })
    } catch (err) {
      const errMsg = (err as Error).message
      if (errMsg !== "AbortError" && !errMsg.includes("aborted")) {
        console.error("[nexus] Agent loop error:", err)
      }
    } finally {
      this.isRunning = false
      await this.session.save().catch(() => {})
      this.postStateUpdate()
    }
  }

  private async compactHistory(): Promise<void> {
    if (!this.session || !this.config) return

    const client = createLLMClient(this.config.model)
    const compaction = createCompaction()
    this.postMessage({ type: "agentEvent", event: { type: "compaction_start" } })
    try {
      await compaction.compact(this.session, client)
    } finally {
      this.postMessage({ type: "agentEvent", event: { type: "compaction_end" } })
      this.postStateUpdate()
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
    this.postStateUpdate()
  }

  addToChat(text: string): void {
    this.postMessage({ type: "addToChatContent", content: text })
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
  }

  private postStateUpdate(): void {
    const status = this.indexer?.status() ?? { state: "idle" as const }
    if (!this.session || !this.config) {
      this.postMessage({
        type: "stateUpdate",
        state: {
          messages: [],
          mode: this.mode,
          maxMode: this.maxMode,
          isRunning: false,
          model: "—",
          provider: "—",
          sessionId: "",
          todo: "",
          indexReady: status.state === "ready",
          indexStatus: status,
          contextUsedTokens: 0,
          contextLimitTokens: 128000,
          contextPercent: 0,
        },
      })
      return
    }

    const contextUsedTokens = this.session.getTokenEstimate()
    const contextLimitTokens = getContextLimit(this.config.model.id)
    const contextPercent = contextLimitTokens > 0
      ? Math.min(100, Math.round((contextUsedTokens / contextLimitTokens) * 100))
      : 0

    const state: WebviewState = {
      messages: this.session.messages,
      mode: this.mode,
      maxMode: this.maxMode,
      isRunning: this.isRunning,
      model: this.config.model.id,
      provider: this.config.model.provider,
      sessionId: this.session.id,
      todo: this.session.getTodo(),
      indexReady: status.state === "ready",
      indexStatus: status,
      contextUsedTokens,
      contextLimitTokens,
      contextPercent,
    }

    this.postMessage({ type: "stateUpdate", state })
  }

  private sendIndexStatus(status?: IndexStatus): void {
    const s = status ?? this.indexer?.status() ?? { state: "idle" as const }
    this.postMessage({ type: "indexStatus", status: s })
  }

  private async sendSessionList(): Promise<void> {
    const sessions = await listSessions(this.getCwd()).catch(() => [])
    this.postMessage({ type: "sessionList", sessions })
  }

  private async switchSession(sessionId: string): Promise<void> {
    const cwd = this.getCwd()
    const loaded = await Session.resume(sessionId, cwd)
    if (loaded) {
      this.session = loaded
      this.checkpoint = undefined
      this.postStateUpdate()
    }
  }

  private postMessage(msg: ExtensionMessage): void {
    const webview = this.view?.webview ?? this.panel?.webview
    if (webview) {
      webview.postMessage(msg).then(() => {}, () => {})
    }
  }

  private getCwd(): string {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders[0]!.uri.fsPath
    }
    return process.cwd()
  }

  private async initializeIndexer(cwd: string): Promise<void> {
    this.indexStatusUnsubscribe?.()
    this.indexStatusUnsubscribe = undefined

    this.indexer?.close()
    this.indexer = undefined

    if (!this.config?.indexing.enabled) {
      this.fileWatcher?.dispose()
      this.fileWatcher = undefined
      this.sendIndexStatus({ state: "idle" })
      return
    }

    this.indexer = await createCodebaseIndexer(cwd, this.config, {
      onWarning: (message: string) => console.warn(message),
    })
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status: IndexStatus) => {
      this.sendIndexStatus(status)
      this.postMessage({ type: "agentEvent", event: { type: "index_update", status } })
    })
    this.indexer.startIndexing().catch((err: unknown) => {
      console.warn("[nexus] Indexer start error:", err)
    })
    this.setupFileWatcher(cwd)
  }

  private getHtml(webview: vscode.Webview): string {
    const webviewDistPath = vscode.Uri.joinPath(
      this.context.extensionUri, "webview-ui", "dist"
    )
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDistPath, "index.js")
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDistPath, "index.css")
    )
    const nonce = getNonce()
    const csp = [
      "default-src 'none'",
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      "connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
      `img-src ${webview.cspSource} data: https:`,
    ].join("; ")
    const extraStyles = ".container { height: 100%; display: flex; flex-direction: column; min-height: 0; }"

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>NexusCode</title>
  <style>
    html { scrollbar-color: auto; }
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    body {
      background-color: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    #root { height: 100%; }
    #root .loading-msg { display: flex; align-items: center; justify-content: center; flex: 1; }
    #root.loaded .loading-msg { display: none; }
    ${extraStyles}
  </style>
</head>
<body>
  <div id="root">
    <span class="loading-msg" aria-live="polite">Loading NexusCode…</span>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}" id="main-script"></script>
  <script nonce="${nonce}">
    document.getElementById('main-script').addEventListener('error', function() {
      var r = document.getElementById('root');
      r.className = 'error';
      r.innerHTML = '<span>Failed to load. Right‑click panel → Inspect → check Console.</span>';
    });
  </script>
</body>
</html>`
  }

  /**
   * Dispose all resources. Called when extension is deactivated.
   */
  dispose(): void {
    this.abortController?.abort()

    this.indexStatusUnsubscribe?.()
    this.indexer?.close()
    this.indexer = undefined

    this.fileWatcher?.dispose()
    this.fileWatcher = undefined

    this.mcpClient?.disconnectAll().catch(() => {})
    this.mcpClient = undefined

    this.panel?.dispose()
    this.panel = undefined

    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []

    this.initialized = false
  }
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

/**
 * Apply VS Code workspace/user settings over the loaded config.
 * File config (.nexus/nexus.yaml) is base; VS Code settings override.
 */
function applyVscodeOverrides(config: NexusConfig): void {
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
  if (model != null && model !== "") {
    config.model.id = model
  }

  const apiKey = cfg.get<string>("apiKey")
  if (apiKey != null && apiKey !== "") {
    config.model.apiKey = apiKey
  }

  const baseUrl = cfg.get<string>("baseUrl")
  if (baseUrl != null && baseUrl !== "") {
    config.model.baseUrl = baseUrl
  }

  const temperature = cfg.get<number>("temperature")
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    config.model.temperature = Math.max(0, Math.min(2, temperature))
  }

  const maxModeEnabled = cfg.get<boolean>("maxModeEnabled")
  if (typeof maxModeEnabled === "boolean") {
    config.maxMode.enabled = maxModeEnabled
  }

  const maxModeTokenBudgetMultiplier = cfg.get<number>("maxModeTokenBudgetMultiplier")
  if (typeof maxModeTokenBudgetMultiplier === "number" && Number.isFinite(maxModeTokenBudgetMultiplier)) {
    config.maxMode.tokenBudgetMultiplier = Math.max(1, Math.min(6, maxModeTokenBudgetMultiplier))
  }

  const enableIndexing = cfg.get<boolean>("enableIndexing")
  if (typeof enableIndexing === "boolean") {
    config.indexing.enabled = enableIndexing
  }

  const enableVectorIndex = cfg.get<boolean>("enableVectorIndex")
  if (typeof enableVectorIndex === "boolean") {
    config.indexing.vector = enableVectorIndex
  }

  const embeddingBatchSize = cfg.get<number>("embeddingBatchSize")
  if (typeof embeddingBatchSize === "number" && Number.isFinite(embeddingBatchSize) && embeddingBatchSize > 0) {
    config.indexing.embeddingBatchSize = Math.floor(embeddingBatchSize)
  }

  const embeddingConcurrency = cfg.get<number>("embeddingConcurrency")
  if (typeof embeddingConcurrency === "number" && Number.isFinite(embeddingConcurrency) && embeddingConcurrency > 0) {
    config.indexing.embeddingConcurrency = Math.floor(embeddingConcurrency)
  }

  const enableVectorDb = cfg.get<boolean>("enableVectorDb")
  if (typeof enableVectorDb === "boolean") {
    config.vectorDb = config.vectorDb ?? {
      enabled: false,
      url: "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: true,
    }
    config.vectorDb.enabled = enableVectorDb
  }

  const vectorDbUrl = cfg.get<string>("vectorDbUrl")
  if (vectorDbUrl != null && vectorDbUrl !== "") {
    config.vectorDb = config.vectorDb ?? {
      enabled: true,
      url: "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: true,
    }
    config.vectorDb.url = vectorDbUrl
  }

  const vectorDbAutoStart = cfg.get<boolean>("vectorDbAutoStart")
  if (typeof vectorDbAutoStart === "boolean") {
    config.vectorDb = config.vectorDb ?? {
      enabled: true,
      url: "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: true,
    }
    config.vectorDb.autoStart = vectorDbAutoStart
  }

  const embeddingsProvider = cfg.get<string>("embeddingsProvider")
  const embeddingsModel = cfg.get<string>("embeddingsModel")
  const embeddingsApiKey = cfg.get<string>("embeddingsApiKey")
  const embeddingsBaseUrl = cfg.get<string>("embeddingsBaseUrl")
  const embeddingsDimensions = cfg.get<number>("embeddingsDimensions")
  if (
    (embeddingsProvider && embeddingsProvider !== "")
    || (embeddingsModel && embeddingsModel !== "")
    || (embeddingsApiKey && embeddingsApiKey !== "")
    || (embeddingsBaseUrl && embeddingsBaseUrl !== "")
    || (typeof embeddingsDimensions === "number" && Number.isFinite(embeddingsDimensions))
  ) {
    config.embeddings = config.embeddings ?? {
      provider: "openai",
      model: "text-embedding-3-small",
    }
    if (embeddingsProvider && embeddingsProvider !== "") {
      if (embeddingsProvider === "openrouter") {
        config.embeddings.provider = "openai-compatible"
        config.embeddings.baseUrl = config.embeddings.baseUrl || "https://openrouter.ai/api/v1"
      } else {
        config.embeddings.provider = embeddingsProvider as "openai" | "openai-compatible" | "ollama" | "local"
      }
    }
    if (embeddingsModel && embeddingsModel !== "") {
      config.embeddings.model = embeddingsModel
    }
    if (embeddingsApiKey && embeddingsApiKey !== "") {
      config.embeddings.apiKey = embeddingsApiKey
    }
    if (embeddingsBaseUrl && embeddingsBaseUrl !== "") {
      config.embeddings.baseUrl = embeddingsBaseUrl
    }
    if (typeof embeddingsDimensions === "number" && Number.isFinite(embeddingsDimensions) && embeddingsDimensions > 0) {
      config.embeddings.dimensions = Math.floor(embeddingsDimensions)
    }
  }

  const toolClassifyThreshold = cfg.get<number>("toolClassifyThreshold")
  if (typeof toolClassifyThreshold === "number" && Number.isFinite(toolClassifyThreshold) && toolClassifyThreshold > 0) {
    config.tools.classifyThreshold = Math.floor(toolClassifyThreshold)
  }

  const skillClassifyThreshold = cfg.get<number>("skillClassifyThreshold")
  if (typeof skillClassifyThreshold === "number" && Number.isFinite(skillClassifyThreshold) && skillClassifyThreshold > 0) {
    config.skillClassifyThreshold = Math.floor(skillClassifyThreshold)
  }

  const enableCheckpoints = cfg.get<boolean>("enableCheckpoints")
  if (typeof enableCheckpoints === "boolean") {
    config.checkpoint.enabled = enableCheckpoints
  }

  const autoApproveRead = cfg.get<boolean>("autoApproveRead")
  if (typeof autoApproveRead === "boolean") {
    config.permissions.autoApproveRead = autoApproveRead
  }

  const autoApproveWrite = cfg.get<boolean>("autoApproveWrite")
  if (typeof autoApproveWrite === "boolean") {
    config.permissions.autoApproveWrite = autoApproveWrite
  }

  const autoApproveCommand = cfg.get<boolean>("autoApproveCommand")
  if (typeof autoApproveCommand === "boolean") {
    config.permissions.autoApproveCommand = autoApproveCommand
  }
}

function deepMergeInto<T extends Record<string, unknown>>(target: T, patch: Partial<T>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue

    const current = target[key as keyof T]
    if (
      current
      && typeof current === "object"
      && !Array.isArray(current)
      && value
      && typeof value === "object"
      && !Array.isArray(value)
    ) {
      deepMergeInto(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      ;(target as Record<string, unknown>)[key] = value as unknown
    }
  }
  return target
}

function normalizeConfigPatch<T extends Record<string, unknown>>(patch: T): T {
  const clone = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>

  const model = clone["model"] as Record<string, unknown> | undefined
  if (model && model["provider"] === "openrouter") {
    model["provider"] = "openai-compatible"
    if (!model["baseUrl"]) model["baseUrl"] = "https://openrouter.ai/api/v1"
  }

  const embeddings = clone["embeddings"] as Record<string, unknown> | undefined
  if (embeddings && embeddings["provider"] === "openrouter") {
    embeddings["provider"] = "openai-compatible"
    if (!embeddings["baseUrl"]) embeddings["baseUrl"] = "https://openrouter.ai/api/v1"
  }

  return clone as T
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex")
}
