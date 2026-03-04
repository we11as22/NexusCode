import * as vscode from "vscode"
import * as crypto from "crypto"
import { Controller, type WebviewMessage, type ExtensionMessage } from "./controller.js"

/**
 * VS Code WebviewView provider for NexusCode.
 * Cline-style: owns webview(s), delegates all state and agent logic to Controller.
 */
export class NexusProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "nexuscode.sidebar"
  private view?: vscode.WebviewView
  private panel?: vscode.WebviewPanel
  private controller: Controller
  private disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {
    this.controller = new Controller(context, (msg) => this.postMessage(msg))
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView
    this.setupWebview(webviewView.webview)
    void this.controller.ensureInitialized()

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.controller.postStateToWebview()
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
    void this.controller.ensureInitialized()

    this.panel.onDidDispose(() => {
      this.panel = undefined
    }, null, this.disposables)
  }

  private sendIndexStatus(): void {
    this.controller.postStateToWebview()
  }

  private setupWebview(webview: vscode.Webview): void {
    const webviewDistPath = vscode.Uri.joinPath(
      this.context.extensionUri, "webview-ui", "dist"
    )
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, webviewDistPath],
    }

    webview.html = this.getHtml(webview)

    webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.controller.handleWebviewMessage(msg)
    }, null, this.disposables)

    queueMicrotask(() => {
      this.controller.postStateToWebview()
      this.sendIndexStatus()
    })
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    await this.controller.handleWebviewMessage(msg)
  }

  private postMessage(msg: ExtensionMessage): void {
    const targets: vscode.Webview[] = []
    if (this.view?.webview) targets.push(this.view.webview)
    if (this.panel?.webview && this.panel.webview !== this.view?.webview) targets.push(this.panel.webview)
    for (const webview of targets) {
      webview.postMessage(msg).then(() => {}, () => {})
    }
  }

  addToChat(text: string): void {
    this.controller.addToChat(text)
  }

  /** Switch webview tab from sidebar title (Roo-Code style). */
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
      "connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
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
    document.getElementById('main-script').addEventListener('error', function(e) {
      var r = document.getElementById('root');
      r.className = 'error';
      r.innerHTML = '<span class="loading-msg">Failed to load script. Right‑click panel → Inspect → Console for errors.</span>';
    });
    window.addEventListener('error', function(ev) {
      var r = document.getElementById('root');
      if (!r || r.classList.contains('loaded')) return;
      r.className = 'error';
      r.innerHTML = '<span class="loading-msg">Error: ' + (ev.message || 'Unknown') + '</span>';
    });
  </script>
</body>
</html>`
  }

  /**
   * Dispose all resources. Called when extension is deactivated.
   */
  dispose(): void {
    this.controller.dispose()
    this.panel?.dispose()
    this.panel = undefined
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex")
}
