import crypto from "crypto"
import * as vscode from "vscode"
import type { NexusConfig } from "@nexuscode/core"
import { t } from "./shims/i18n"
import { TelemetryProxy, TelemetryEventName } from "./telemetry.js"
import { AutocompleteModel } from "./AutocompleteModel.js"
import { AutocompleteStatusBar } from "./AutocompleteStatusBar.js"
import { AutocompleteCodeActionProvider } from "./AutocompleteCodeActionProvider.js"
import { AutocompleteInlineCompletionProvider } from "./classic-auto-complete/AutocompleteInlineCompletionProvider.js"
import { AutocompleteTelemetry } from "./classic-auto-complete/AutocompleteTelemetry.js"

export interface AutocompleteServiceSettings {
  enableAutoTrigger?: boolean
  enableSmartInlineTaskKeybinding?: boolean
  enableChatAutocomplete?: boolean
  snoozeUntil?: number
}

function readSettings(): AutocompleteServiceSettings {
  const c = vscode.workspace.getConfiguration()
  return {
    enableAutoTrigger: c.get<boolean>("nexuscode.autocomplete.enableAutoTrigger") ?? true,
    enableSmartInlineTaskKeybinding:
      c.get<boolean>("nexuscode.autocomplete.enableSmartInlineTaskKeybinding") ?? false,
    enableChatAutocomplete: c.get<boolean>("nexuscode.autocomplete.enableChatAutocomplete") ?? false,
    snoozeUntil: c.get<number>("nexuscode.autocomplete.snoozeUntil"),
  }
}

async function writeSettings(patch: Partial<AutocompleteServiceSettings>): Promise<void> {
  const c = vscode.workspace.getConfiguration()
  const entries: [keyof AutocompleteServiceSettings, string][] = [
    ["enableAutoTrigger", "nexuscode.autocomplete.enableAutoTrigger"],
    ["enableSmartInlineTaskKeybinding", "nexuscode.autocomplete.enableSmartInlineTaskKeybinding"],
    ["enableChatAutocomplete", "nexuscode.autocomplete.enableChatAutocomplete"],
    ["snoozeUntil", "nexuscode.autocomplete.snoozeUntil"],
  ]
  for (const [k, cfgKey] of entries) {
    if (patch[k] !== undefined) {
      await c.update(cfgKey, patch[k], vscode.ConfigurationTarget.Global)
    }
  }
}

export class AutocompleteServiceManager implements vscode.Disposable {
  private readonly model: AutocompleteModel
  private readonly context: vscode.ExtensionContext
  private settings: AutocompleteServiceSettings | null = null

  private taskId: string | null = null

  private statusBar: AutocompleteStatusBar | null = null
  private sessionCost: number = 0
  private completionCount: number = 0
  private sessionStartTime: number = Date.now()

  private snoozeTimer: NodeJS.Timeout | null = null

  public readonly codeActionProvider: AutocompleteCodeActionProvider
  public readonly inlineCompletionProvider: AutocompleteInlineCompletionProvider
  private inlineCompletionProviderDisposable: vscode.Disposable | null = null

  constructor(
    context: vscode.ExtensionContext,
    getNexusConfig: () => NexusConfig | undefined,
  ) {
    this.context = context

    this.model = new AutocompleteModel(getNexusConfig)

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""

    this.codeActionProvider = new AutocompleteCodeActionProvider()
    this.inlineCompletionProvider = new AutocompleteInlineCompletionProvider(
      this.context,
      this.model,
      this.updateCostTracking.bind(this),
      () => this.settings,
      workspacePath,
      new AutocompleteTelemetry(),
      (status) => this.handleFatalAutocompleteError(status),
    )

    void this.load()
  }

  public async load(): Promise<void> {
    this.settings = readSettings()

    await this.updateGlobalContext()
    this.updateStatusBar()
    await this.ensureInlineCompletionProviderRegistration()
    this.setupSnoozeTimerIfNeeded()
  }

  private async ensureInlineCompletionProviderRegistration(): Promise<void> {
    const shouldBeRegistered = (this.settings?.enableAutoTrigger ?? false) && !this.isSnoozed()
    const isRegistered = this.inlineCompletionProviderDisposable !== null

    if (shouldBeRegistered === isRegistered) {
      return
    }

    if (!shouldBeRegistered) {
      this.inlineCompletionProviderDisposable!.dispose()
      this.inlineCompletionProviderDisposable = null
      return
    }

    this.inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file" },
      this.inlineCompletionProvider,
    )
  }

  public async disable(): Promise<void> {
    await writeSettings({
      enableAutoTrigger: false,
      enableSmartInlineTaskKeybinding: false,
    })

    TelemetryProxy.capture(TelemetryEventName.GHOST_SERVICE_DISABLED)

    await this.load()
  }

  public isSnoozed(): boolean {
    const snoozeUntil = this.settings?.snoozeUntil
    if (!snoozeUntil) {
      return false
    }
    return Date.now() < snoozeUntil
  }

  public getSnoozeRemainingSeconds(): number {
    const snoozeUntil = this.settings?.snoozeUntil
    if (!snoozeUntil) {
      return 0
    }
    return Math.max(0, Math.ceil((snoozeUntil - Date.now()) / 1000))
  }

  public async snooze(seconds: number): Promise<void> {
    if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer)
      this.snoozeTimer = null
    }

    const snoozeUntil = Date.now() + seconds * 1000
    await writeSettings({ snoozeUntil })

    this.snoozeTimer = setTimeout(() => {
      void this.unsnooze()
    }, seconds * 1000)

    await this.load()
  }

  public async unsnooze(): Promise<void> {
    if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer)
      this.snoozeTimer = null
    }

    await writeSettings({ snoozeUntil: undefined })

    await this.load()
  }

  private setupSnoozeTimerIfNeeded(): void {
    if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer)
      this.snoozeTimer = null
    }

    const remainingMs = this.getSnoozeRemainingMs()
    if (remainingMs <= 0) {
      return
    }

    this.snoozeTimer = setTimeout(() => {
      void this.unsnooze()
    }, remainingMs)
  }

  private getSnoozeRemainingMs(): number {
    const snoozeUntil = this.settings?.snoozeUntil
    if (!snoozeUntil) {
      return 0
    }
    return Math.max(0, snoozeUntil - Date.now())
  }

  public async codeSuggestion(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      return
    }

    this.taskId = crypto.randomUUID()
    TelemetryProxy.capture(TelemetryEventName.INLINE_ASSIST_AUTO_TASK, {
      taskId: this.taskId,
    })

    const document = editor.document

    const position = editor.selection.active
    const context: vscode.InlineCompletionContext = {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: undefined,
    }
    const tokenSource = new vscode.CancellationTokenSource()

    const completions = await this.inlineCompletionProvider.provideInlineCompletionItems_Internal(
      document,
      position,
      context,
      tokenSource.token,
    )
    tokenSource.dispose()

    if (completions && (Array.isArray(completions) ? completions.length > 0 : completions.items.length > 0)) {
      const items = Array.isArray(completions) ? completions : completions.items
      const firstCompletion = items[0]

      if (firstCompletion?.insertText) {
        const insertText =
          typeof firstCompletion.insertText === "string" ? firstCompletion.insertText : firstCompletion.insertText.value

        await editor.edit((editBuilder) => {
          editBuilder.insert(position, insertText)
        })
      }
    }
  }

  private async updateGlobalContext(): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "nexuscode.autocomplete.enableSmartInlineTaskKeybinding",
      this.settings?.enableSmartInlineTaskKeybinding || false,
    )
  }

  private initializeStatusBar(): void {
    this.statusBar = new AutocompleteStatusBar({
      enabled: false,
      model: "loading...",
      provider: "loading...",
      totalSessionCost: 0,
      completionCount: 0,
      sessionStartTime: this.sessionStartTime,
    })
  }

  private hasNoUsableProvider(): boolean {
    return !this.model.hasValidCredentials()
  }

  private handleFatalAutocompleteError(status: number | null): void {
    const msg =
      status === 402
        ? t("nexuscode:autocomplete.creditsExhausted.message")
        : t("nexuscode:autocomplete.authError.message")

    if (status === 402) {
      void vscode.window.showWarningMessage(
        msg,
        t("nexuscode:autocomplete.creditsExhausted.openSettings"),
      ).then((choice) => {
        if (choice === t("nexuscode:autocomplete.creditsExhausted.openSettings")) {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "nexuscode.autocomplete.enableAutoTrigger",
          )
        }
      })
    } else {
      void vscode.window.showWarningMessage(msg)
    }
  }

  private updateCostTracking(cost: number, _inputTokens: number, _outputTokens: number): void {
    this.completionCount++
    this.sessionCost += cost
    this.updateStatusBar()
  }

  private updateStatusBar(): void {
    if (!this.statusBar) {
      this.initializeStatusBar()
    }

    this.statusBar?.update({
      enabled: this.settings?.enableAutoTrigger,
      snoozed: this.isSnoozed(),
      model: this.model.getModelName(),
      provider: this.model.getProviderDisplayName(),
      profileName: this.model.profileName,
      hasNoUsableProvider: this.hasNoUsableProvider(),
      totalSessionCost: this.sessionCost,
      completionCount: this.completionCount,
      sessionStartTime: this.sessionStartTime,
    })
  }

  public async showIncompatibilityExtensionPopup(): Promise<void> {
    const message = t("nexuscode:autocomplete.incompatibilityExtensionPopup.message")
    const disableCopilot = t("nexuscode:autocomplete.incompatibilityExtensionPopup.disableCopilot")
    const disableInlineAssist = t("nexuscode:autocomplete.incompatibilityExtensionPopup.disableInlineAssist")
    const response = await vscode.window.showErrorMessage(message, disableCopilot, disableInlineAssist)

    if (response === disableCopilot) {
      await vscode.commands.executeCommand("github.copilot.completions.disable")
    } else if (response === disableInlineAssist) {
      await vscode.commands.executeCommand("nexuscode.autocomplete.disable")
    }
  }

  public dispose(): void {
    this.statusBar?.dispose()

    if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer)
      this.snoozeTimer = null
    }

    if (this.inlineCompletionProviderDisposable) {
      this.inlineCompletionProviderDisposable.dispose()
      this.inlineCompletionProviderDisposable = null
    }

    this.inlineCompletionProvider.dispose()
  }
}
