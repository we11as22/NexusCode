import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import type { AgentEvent, NexusConfig, Mode, SessionMessage } from "@nexuscode/core"
import {
  loadConfig, Session, createLLMClient, ToolRegistry, loadSkills,
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

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "indexStatus"; status: unknown }
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
}

/**
 * VS Code WebviewView provider for NexusCode.
 * Manages the agent session, webview, and all state.
 */
export class NexusProvider implements vscode.WebviewViewProvider {
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView
    this.setupWebview(webviewView.webview)
    await this.initialize()
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
    await this.initialize()

    this.panel.onDidDispose(() => {
      this.panel = undefined
    })
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
    })
  }

  private async initialize(): Promise<void> {
    const cwd = this.getCwd()

    try {
      this.config = await loadConfig(cwd)
    } catch {
      this.config = await loadConfig(cwd).catch(() => undefined)
    }

    if (!this.config) return

    // Init session
    this.session = Session.create(cwd)

    // Init MCP
    if (this.config.mcp.servers.length > 0) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
      await this.mcpClient.connectAll(this.config.mcp.servers)
    }

    // Init indexer in background
    if (this.config.indexing.enabled) {
      this.indexer = new CodebaseIndexer(cwd, this.config)
      this.indexer.startIndexing().catch(console.warn)
    }

    this.postStateUpdate()
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
        break

      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "nexuscode")
        break

      case "forkSession":
        if (this.session && msg.messageId) {
          this.session = this.session.fork(msg.messageId) as Session
          this.postStateUpdate()
        }
        break
    }
  }

  private async runAgent(content: string, mode?: Mode): Promise<void> {
    if (this.isRunning || !this.session || !this.config) return

    this.mode = mode ?? this.mode
    this.isRunning = true
    this.abortController = new AbortController()

    // Add user message
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

    // Add MCP tools
    if (this.mcpClient) {
      for (const tool of this.mcpClient.getTools()) {
        toolRegistry.register(tool)
      }
    }

    // Add spawn_agent tool
    const parallelManager = new ParallelAgentManager()
    toolRegistry.register(createSpawnAgentTool(parallelManager, this.config))

    const { builtin: tools, dynamic } = toolRegistry.getForMode(this.mode)
    const allTools = [...tools, ...dynamic]

    const rulesContent = await loadRules(cwd, this.config.rules.files).catch(() => "")
    const skills = await loadSkills(this.config.skills, cwd).catch(() => [])
    const compaction = createCompaction()

    // Init checkpoint
    if (this.config.checkpoint.enabled && !this.checkpoint) {
      const taskId = this.session.id
      this.checkpoint = new CheckpointTracker(taskId, cwd)
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
      if ((err as Error).message !== "AbortError") {
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
    await compaction.compact(this.session, client)
    this.postStateUpdate()
  }

  addToChat(text: string): void {
    const msg = `\n\`\`\`\n${text}\n\`\`\``
    this.postMessage({
      type: "agentEvent",
      event: { type: "text_delta", delta: msg, messageId: "" },
    })
    // Focus the sidebar
    vscode.commands.executeCommand("nexuscode.sidebar.focus")
  }

  private postStateUpdate(): void {
    if (!this.session || !this.config) return

    const state: WebviewState = {
      messages: this.session.messages,
      mode: this.mode,
      maxMode: this.maxMode,
      isRunning: this.isRunning,
      model: this.config.model.id,
      provider: this.config.model.provider,
      sessionId: this.session.id,
      todo: this.session.getTodo(),
      indexReady: this.indexer?.status().state === "ready",
    }

    this.postMessage({ type: "stateUpdate", state })
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
}

function generateNonce(): string {
  let text = ""
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
