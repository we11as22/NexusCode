import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const extensionSource = readFileSync(
  path.join(process.cwd(), "src", "extension.ts"),
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
})
