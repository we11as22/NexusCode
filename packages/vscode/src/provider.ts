import * as vscode from "vscode"
import * as path from "node:path"
import * as crypto from "crypto"
import * as fs from "node:fs"
import { setIndexTelemetrySink } from "@nexuscode/core"
import { Controller, type WebviewMessage, type ExtensionMessage } from "./controller.js"
import { registerAutocompleteProvider } from "./services/autocomplete/index.js"

/**
 * VS Code WebviewView provider for NexusCode.
 * Cline-style: owns webview(s), delegates all state and agent logic to Controller.
 */
export class NexusProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "nexuscode.sidebar"
  private static readonly DEBUG_FILE_LOG_ENABLED = process.env.NEXUSCODE_DEBUG_FILE_LOG === "1"
  private view?: vscode.WebviewView
  private panel?: vscode.WebviewPanel
  private controller: Controller
  private disposables: vscode.Disposable[] = []
  private readonly output = vscode.window.createOutputChannel("NexusCode")
  private readonly readyWebviews = new WeakMap<vscode.Webview, boolean>()
  private readonly pendingMessages = new WeakMap<vscode.Webview, ExtensionMessage[]>()
  private latestMessages = new Map<ExtensionMessage["type"], ExtensionMessage>()
  private outboundSeq = 0

  constructor(private readonly context: vscode.ExtensionContext) {
    this.writeDebugFileLog("NexusProvider.constructor")
    setIndexTelemetrySink((event, payload) => {
      this.output.appendLine(`[nexus:index:${event}] ${JSON.stringify(payload ?? {})}`)
    })
    this.controller = new Controller(context, (msg) => this.postMessage(msg))
    const autocompleteManager = registerAutocompleteProvider(context, () => this.controller.getConfig())
    this.controller.setAutocompleteConfigReady(() => {
      void autocompleteManager.load()
    })
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.debugLog("resolveWebviewView")
    this.view = webviewView
    this.setupWebview(webviewView.webview)
    void this.controller.ensureInitialized()

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.controller.postStateToWebview(true)
        this.sendIndexStatus()
      }
    }, null, this.disposables)
  }

  async openPanel(): Promise<void> {
    this.debugLog("openPanel")
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
    void this.controller.ensureInitialized()

    this.panel.onDidDispose(() => {
      this.panel = undefined
    }, null, this.disposables)
  }

  private sendIndexStatus(): void {
    this.controller.postStateToWebview(true)
  }

  private markWebviewReady(webview: vscode.Webview): void {
    this.readyWebviews.set(webview, true)
    this.debugLog("webview marked ready")
  }

  private markWebviewNotReady(webview: vscode.Webview): void {
    this.readyWebviews.set(webview, false)
    this.pendingMessages.set(webview, [])
    this.debugLog("webview marked not ready")
  }

  private isWebviewReady(webview: vscode.Webview): boolean {
    return this.readyWebviews.get(webview) === true
  }

  private cloneMessageForWebview<T extends ExtensionMessage>(msg: T): T {
    try {
      return structuredClone(msg)
    } catch {
      return JSON.parse(JSON.stringify(msg)) as T
    }
  }

  private stampMessage(msg: ExtensionMessage): ExtensionMessage {
    if (typeof msg.seq === "number" && Number.isFinite(msg.seq)) return msg
    return { ...msg, seq: ++this.outboundSeq }
  }

  private queueMessageForWebview(webview: vscode.Webview, msg: ExtensionMessage): void {
    const queued = this.pendingMessages.get(webview) ?? []
    queued.push(this.cloneMessageForWebview(msg))
    this.pendingMessages.set(webview, queued)
    this.debugLog(`queued outbound message: ${msg.type} (queue=${queued.length})`)
  }

  private async flushPendingMessages(webview: vscode.Webview): Promise<void> {
    if (!this.isWebviewReady(webview)) return
    const queued = this.pendingMessages.get(webview)
    if (!queued || queued.length === 0) return
    this.debugLog(`flushing queued webview messages: ${queued.length}`)
    this.pendingMessages.set(webview, [])
    for (const msg of queued) {
      try {
        await webview.postMessage(msg)
      } catch (error) {
        console.warn("[NexusCode] Failed to flush queued webview message:", error)
        this.queueMessageForWebview(webview, msg)
        return
      }
    }
  }

  private rememberLatestMessage(msg: ExtensionMessage): void {
    switch (msg.type) {
      case "stateUpdate":
      case "sessionList":
      case "sessionListLoading":
      case "indexStatus":
      case "configLoaded":
      case "skillDefinitions":
      case "modelsCatalog":
      case "agentPresets":
      case "agentPresetOptions":
      case "mcpServerStatus":
        this.latestMessages.set(msg.type, this.cloneMessageForWebview(msg))
        break
      default:
        break
    }
  }

  private async replayLatestMessages(webview: vscode.Webview): Promise<void> {
    if (!this.isWebviewReady(webview) || this.latestMessages.size === 0) return
    const order: ExtensionMessage["type"][] = [
      "configLoaded",
      "skillDefinitions",
      "modelsCatalog",
      "agentPresets",
      "agentPresetOptions",
      "sessionListLoading",
      "sessionList",
      "indexStatus",
      "mcpServerStatus",
      "stateUpdate",
    ]
    for (const type of order) {
      const msg = this.latestMessages.get(type)
      if (!msg) continue
      try {
        await webview.postMessage(msg)
      } catch (error) {
        console.warn(`[NexusCode] Failed to replay cached webview message (${type}):`, error)
        return
      }
    }
    this.debugLog(`replayed cached snapshot messages: ${this.latestMessages.size}`)
  }

  private debugLog(message: string, details?: unknown): void {
    const line =
      details === undefined
        ? `[${new Date().toISOString()}] ${message}`
        : `[${new Date().toISOString()}] ${message} ${safeStringify(details)}`
    this.output.appendLine(line)
    this.writeDebugFileLog(line)
    if (details === undefined) {
      console.log(`[NexusCode] ${message}`)
      return
    }
    console.log(`[NexusCode] ${message}`, details)
  }

  private writeDebugFileLog(line: string): void {
    if (!NexusProvider.DEBUG_FILE_LOG_ENABLED) return
    try {
      fs.appendFileSync("/tmp/nexuscode-extension.log", `[${new Date().toISOString()}] ${line}\n`)
    } catch {}
  }

  private async postMessageToTarget(webview: vscode.Webview, msg: ExtensionMessage): Promise<void> {
    if (!this.isWebviewReady(webview)) {
      this.queueMessageForWebview(webview, msg)
      return
    }
    try {
      this.debugLog(`posting outbound message: ${msg.type}`, summarizeExtensionMessage(msg))
      await webview.postMessage(msg)
    } catch (error) {
      console.warn("[NexusCode] Failed to post message to webview:", error)
    }
  }

  private setupWebview(webview: vscode.Webview): void {
    this.debugLog("setupWebview")
    const webviewDistPath = vscode.Uri.joinPath(
      this.context.extensionUri, "webview-ui", "dist"
    )
    this.markWebviewNotReady(webview)
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, webviewDistPath],
    }

    webview.onDidReceiveMessage(async (msg: WebviewMessage | Record<string, unknown>) => {
      const type = typeof msg?.type === "string" ? msg.type : "(unknown)"
      this.debugLog(`inbound webview message: ${type}`)
      if (type === "webviewBootstrap" || type === "webviewScriptError" || type === "webviewRuntimeError") {
        this.debugLog(`webview debug event: ${type}`, msg)
        return
      }
      this.markWebviewReady(webview)
      await this.flushPendingMessages(webview)
      await this.replayLatestMessages(webview)
      await this.controller.handleWebviewMessage(msg as WebviewMessage)
    }, null, this.disposables)

    webview.html = this.getHtml(webview)

    queueMicrotask(() => {
      this.controller.postStateToWebview(true)
      this.sendIndexStatus()
    })
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    await this.controller.handleWebviewMessage(msg)
  }

  private postMessage(msg: ExtensionMessage): void {
    const stamped = this.stampMessage(msg)
    this.rememberLatestMessage(stamped)
    const targets: vscode.Webview[] = []
    if (this.view?.webview) targets.push(this.view.webview)
    if (this.panel?.webview && this.panel.webview !== this.view?.webview) targets.push(this.panel.webview)
    for (const webview of targets) {
      void this.postMessageToTarget(webview, stamped)
    }
  }

  addToChat(text: string): void {
    this.controller.addToChat(text)
  }

  /** Start controller init in background so first message is less likely to wait on ensureInitialized. */
  warmup(): void {
    void this.controller.ensureInitialized()
  }

  /** Switch webview tab from sidebar title. */
  switchView(view: "chat" | "sessions" | "settings"): void {
    this.postMessage({ type: "action", action: "switchView", view })
  }

  async runAgentWithPrompt(content: string, mode?: import("@nexuscode/core").Mode): Promise<void> {
    await this.controller.runAgentWithPrompt(content, mode)
  }

  async reindex(): Promise<void> {
    await this.controller.reindex()
  }

  async clearIndex(): Promise<void> {
    await this.controller.clearIndex()
  }

  async fullRebuildIndex(): Promise<void> {
    await this.controller.fullRebuildIndex()
  }

  /** Explorer context: remove index data for this folder/file prefix only (one shared collection per workspace). */
  async deleteIndexForResource(uri: vscode.Uri): Promise<void> {
    const cwd = this.controller.getCwd()
    const rel = path.relative(cwd, uri.fsPath).replace(/\\/g, "/")
    if (rel.startsWith("..")) {
      void vscode.window.showErrorMessage("NexusCode: That path is outside the active workspace folder for indexing.")
      return
    }
    if (!rel || rel === ".") {
      const pick = await vscode.window.showWarningMessage(
        "Delete the entire NexusCode index for this workspace (tracker + vector collection)? Nothing will be rebuilt automatically.",
        { modal: true },
        "Delete all",
        "Cancel",
      )
      if (pick !== "Delete all") return
      await this.controller.clearIndex()
      void vscode.window.showInformationMessage("NexusCode: Workspace index removed.")
      return
    }
    const label = rel.endsWith("/") ? rel.slice(0, -1) : rel
    const pick = await vscode.window.showWarningMessage(
      `Remove NexusCode index entries under “${label}” only? Other paths stay indexed.`,
      { modal: true },
      "Delete scoped",
      "Cancel",
    )
    if (pick !== "Delete scoped") return
    await this.controller.deleteIndexScope(rel)
    void vscode.window.showInformationMessage(`NexusCode: Index data removed under “${label}”.`)
  }

  private getCwd(): string {
    return this.controller.getCwd()
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
      `connect-src ${webview.cspSource} http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*`,
      `img-src ${webview.cspSource} data: https:`,
    ].join("; ")
    const extraStyles = [
      ".container { height: 100%; width: 100%; min-width: 0; min-height: 100%; display: flex; flex-direction: column; overflow: hidden; background-color: var(--vscode-editor-background, #1e1e1e); }",
      "#root { min-height: 0; }",
    ].join(" ")

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>NexusCode</title>
  <style>
    html { scrollbar-color: auto; }
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; box-sizing: border-box; }
    body {
      background-color: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-foreground, #d4d4d4);
      font-family: var(--vscode-font-family, var(--monaco-monospace-font, 'Segoe UI', sans-serif));
    }
    #root { height: 100%; width: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
    #root .loading-msg { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--vscode-foreground, #d4d4d4); }
    #root.loaded .loading-msg { display: none; }
    #root.loaded .loading-hint { display: none; }
    .loading-hint { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); font-size: 10px; color: var(--vscode-descriptionForeground, #858585); pointer-events: none; }
    #root.error .loading-msg { display: flex; color: #f48771; }
    ${extraStyles}
  </style>
</head>
<body>
  <div id="root">
    <span class="loading-msg" aria-live="polite">Loading NexusCode…</span>
    <span class="loading-hint">Right‑click here → Inspect → Console tab for errors</span>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptUri}" id="main-script"></script>
  <script nonce="${nonce}">
    var vscode = window.__NEXUS_VSCODE_API__ || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null);
    if (vscode) {
      window.__NEXUS_VSCODE_API__ = vscode;
    }
    function reportToExtension(type, payload) {
      try {
        if (vscode && typeof vscode.postMessage === 'function') {
          vscode.postMessage(Object.assign({ type: type }, payload || {}));
        }
      } catch {}
    }
    reportToExtension('webviewBootstrap', { phase: 'inline-script-loaded' });
    document.getElementById('main-script').addEventListener('error', function(e) {
      var r = document.getElementById('root');
      r.className = 'error';
      r.innerHTML = '<span class="loading-msg">Failed to load script. Right‑click panel → Inspect → Console for errors.</span>';
      reportToExtension('webviewScriptError', { message: 'Failed to load main script' });
    });
    window.addEventListener('error', function(ev) {
      var r = document.getElementById('root');
      if (!r || r.classList.contains('loaded')) return;
      r.className = 'error';
      r.innerHTML = '<span class="loading-msg">Error: ' + (ev.message || 'Unknown') + '</span>';
      reportToExtension('webviewRuntimeError', {
        message: ev.message || 'Unknown',
        source: ev.filename || '',
        line: ev.lineno || 0,
        column: ev.colno || 0
      });
    });
    window.addEventListener('unhandledrejection', function(ev) {
      var reason = ev && ev.reason;
      reportToExtension('webviewRuntimeError', {
        message: reason && reason.message ? reason.message : String(reason || 'Unhandled rejection'),
        source: 'unhandledrejection',
        line: 0,
        column: 0
      });
    });
  </script>
</body>
</html>`
  }

  /**
   * Dispose all resources. Called when extension is deactivated.
   */
  dispose(): void {
    setIndexTelemetrySink(undefined)
    this.controller.dispose()
    this.panel?.dispose()
    this.panel = undefined
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
    this.output.dispose()
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex")
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function summarizeExtensionMessage(msg: ExtensionMessage): Record<string, unknown> {
  if (msg.type === "agentEvent") {
    const event = msg.event as Record<string, unknown>
    return {
      eventType: event.type,
      messageId: typeof event.messageId === "string" ? event.messageId : undefined,
      partId: typeof event.partId === "string" ? event.partId : undefined,
      tool: typeof event.tool === "string" ? event.tool : undefined,
      error:
        event.error instanceof Error
          ? event.error.message
          : typeof event.error === "string"
            ? event.error
            : undefined,
    }
  }
  if (msg.type === "stateUpdate") {
    const messages = Array.isArray(msg.state.messages) ? msg.state.messages : []
    const last = messages[messages.length - 1] as { role?: string; id?: string; content?: unknown } | undefined
    return {
      sessionId: msg.state.sessionId,
      isRunning: msg.state.isRunning,
      messageCount: messages.length,
      lastRole: last?.role,
      lastId: last?.id,
      lastHasContent:
        typeof last?.content === "string"
          ? last.content.trim().length > 0
          : Array.isArray(last?.content)
            ? last.content.length > 0
            : false,
    }
  }
  return {}
}
