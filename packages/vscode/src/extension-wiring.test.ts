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

describe("VS Code command wiring", () => {
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
})
