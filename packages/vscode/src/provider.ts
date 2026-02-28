import * as vscode from "vscode"
import * as path from "path"
import type { AgentEvent, NexusConfig, Mode, SessionMessage, IndexStatus } from "@nexuscode/core"
import {
  loadConfig, Session, listSessions, createLLMClient, ToolRegistry, loadSkills,
  loadRules, McpClient, setMcpClientInstance, createCompaction,
  ParallelAgentManager, createSpawnAgentTool, runAgentLoop,
  CheckpointTracker, CodebaseIndexer,
} from "@nexuscode/core"
import { VsCodeHost } from "./host.js"

export type WebviewMessage =
  | { type: "newMessage"; content: string; mode: Mode; mentions?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setMaxMode"; enabled: boolean }
  | { type: "getState" }
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView
    this.setupWebview(webviewView.webview)
    await this.ensureInitialized()

    // Re-initialize if the webview is re-opened after being hidden
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postStateUpdate()
        this.sendIndexStatus()
      }
    }, null, this.disposables)
  }

  /**
   * Open NexusCode in a panel to the right (ViewColumn.Beside)
   */
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
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
        ],
      }
    )

    this.setupWebview(this.panel.webview)
    await this.ensureInitialized()

    this.panel.onDidDispose(() => {
      this.panel = undefined
    }, null, this.disposables)
  }

  private setupWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview-ui", "dist"),
      ],
    }

    webview.html = this.getHtml(webview)

    webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg)
    }, null, this.disposables)
  }

  /**
   * Initialize once — guard prevents double-init when both sidebar and panel are active.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      // Just send the current state to the newly connected webview
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
      // Fallback: try loading with empty cwd defaults
      try {
        this.config = await loadConfig(process.cwd())
      } catch {}
    }

    if (!this.config) return

    // Init session
    this.session = Session.create(cwd)

    // Init MCP
    if (this.config.mcp.servers.length > 0) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
      await this.mcpClient.connectAll(this.config.mcp.servers).catch(err => {
        console.warn("[nexus] MCP connection error:", err)
      })
    }

    // Init indexer and file watcher
    if (this.config.indexing.enabled) {
      this.indexer = new CodebaseIndexer(cwd, this.config)

      // Subscribe to index status changes to push updates to webview
      this.indexStatusUnsubscribe = this.indexer.onStatusChange((status) => {
        this.sendIndexStatus(status)
        // Emit index_update agent event so CLI and webview can react
        this.postMessage({
          type: "agentEvent",
          event: { type: "index_update", status },
        })
      })

      this.indexer.startIndexing().catch(err => {
        console.warn("[nexus] Indexer start error:", err)
      })

      // File watcher for auto-updating the index on file changes
      this.setupFileWatcher(cwd)
    }

    this.postStateUpdate()
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
        if (this.config) this.config.maxMode.enabled = msg.enabled
        this.postStateUpdate()
        break

      case "getState":
        this.postStateUpdate()
        this.sendIndexStatus()
        await this.sendSessionList()
        break

      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "nexuscode")
        break

      case "saveConfig":
        // Merge config updates
        if (this.config && msg.config) {
          Object.assign(this.config, msg.config)
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
      if (event.type === "done" || event.type === "error") {
        this.isRunning = false
        this.postStateUpdate()
      }
    })

    const client = createLLMClient(this.config.model)
    const maxModeClient = this.config.maxMode.enabled
      ? createLLMClient(this.config.maxMode)
      : undefined

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
        maxModeClient,
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
    if (!this.indexer || !this.config) return
    this.indexer.close()
    const cwd = this.getCwd()
    this.indexer = new CodebaseIndexer(cwd, this.config)
    this.indexStatusUnsubscribe?.()
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status) => {
      this.sendIndexStatus(status)
      this.postMessage({ type: "agentEvent", event: { type: "index_update", status } })
    })
    await this.indexer.startIndexing().catch(console.warn)
    this.sendIndexStatus()
    this.postStateUpdate()
  }

  addToChat(text: string): void {
    this.postMessage({
      type: "agentEvent",
      event: { type: "text_delta", delta: `\n\`\`\`\n${text}\n\`\`\``, messageId: "" },
    })
    vscode.commands.executeCommand("nexuscode.sidebar.focus")
  }

  private postStateUpdate(): void {
    if (!this.session || !this.config) return

    const status = this.indexer?.status() ?? { state: "idle" as const }

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

    const nonce = generateNonce()

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>NexusCode</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
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

function generateNonce(): string {
  let text = ""
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
