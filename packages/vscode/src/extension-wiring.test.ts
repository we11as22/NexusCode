import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const extensionSource = readFileSync(
  path.join(process.cwd(), "src", "extension.ts"),
  "utf8",
)
const controllerSource = readFileSync(
  path.join(process.cwd(), "src", "controller.ts"),
  "utf8",
)
const esbuildSource = readFileSync(
  path.join(process.cwd(), "esbuild.mjs"),
  "utf8",
)
const vscodeIgnore = readFileSync(
  path.join(process.cwd(), ".vscodeignore"),
  "utf8",
)

describe("VS Code command wiring", () => {
  it("does not run the coding agent in an untrusted VS Code workspace", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { capabilities?: { untrustedWorkspaces?: { supported?: boolean } } }

    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false)
  })

  it("does not ship production extension source maps or packaging scripts", () => {
    expect(esbuildSource).toContain("sourcemap: watch")
    expect(vscodeIgnore).toContain("**/*.map")
    expect(vscodeIgnore).toMatch(/^scripts$/m)
    expect(vscodeIgnore).toContain("vitest.config.*")
  })

  it.each([
    ["nexuscode.newTask", "provider?.createNewSession()"],
    ["nexuscode.compact", "provider?.compact()"],
    ["nexuscode.clearChat", "provider?.clearChat()"],
  ])("%s executes its controller action", (command, action) => {
    const start = extensionSource.indexOf(`registerCommand("${command}"`)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(extensionSource.slice(start, start + 260)).toContain(action)
  })

  it("does not write an activation log unless debug logging is enabled", () => {
    const activationBody = extensionSource.slice(
      extensionSource.indexOf("export function activate"),
      extensionSource.indexOf("// Register sidebar view provider"),
    )
    expect(activationBody).not.toContain("appendFileSync")
  })

  it("does not contribute plaintext API-key settings", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { contributes?: { configuration?: { properties?: Record<string, unknown> } } }
    const properties = manifest.contributes?.configuration?.properties ?? {}

    expect(properties).not.toHaveProperty("nexuscode.apiKey")
    expect(properties).not.toHaveProperty("nexuscode.embeddingsApiKey")
    expect(properties).not.toHaveProperty("nexuscode.autocomplete.apiKey")
  })

  it("redacts API keys before sending configuration to the webview", () => {
    expect(controllerSource).toContain("stripSecretsFromConfig(")
    expect(controllerSource).not.toContain(
      'type: "configLoaded", config: this.config',
    )
  })

  it("uses the real session lifecycle for Clear Chat", () => {
    const clearChatCase = controllerSource.slice(
      controllerSource.indexOf('case "clearChat"'),
      controllerSource.indexOf('case "setMode"'),
    )
    expect(clearChatCase).toContain("await this.createNewSession()")
    expect(clearChatCase).not.toContain("Session.create(")
  })

  it("does not create local checkpoints for server-owned runs", () => {
    const runStart = controllerSource.indexOf("private async runAgent(")
    const serverUrl = controllerSource.indexOf(
      "const serverUrl = this.getServerUrl()",
      runStart,
    )
    const serverBranch = controllerSource.indexOf("if (serverUrl)", serverUrl)
    expect(controllerSource.slice(serverUrl, serverBranch))
      .not.toContain("commitCheckpointForUserMessage")
  })

  it("keeps a run busy until its loop has actually unwound after abort", () => {
    const abortCase = controllerSource.slice(
      controllerSource.indexOf('case "abort"'),
      controllerSource.indexOf('case "compact"'),
    )
    expect(abortCase).toContain("this.abortController?.abort()")
    expect(abortCase).not.toContain("this.isRunning = false")
  })
})
