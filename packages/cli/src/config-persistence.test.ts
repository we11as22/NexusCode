import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const commandFiles = [
  "nexusIndex.tsx",
  "nexusEmbeddings.tsx",
  "nexusSkills.tsx",
  "nexusModel.tsx",
  "nexusVector.tsx",
]

describe("CLI config persistence wiring", () => {
  it.each(commandFiles)(
    "%s writes only an explicit raw project patch",
    (fileName) => {
      const source = readFileSync(
        path.join(process.cwd(), "src", "commands", fileName),
        "utf8",
      )
      expect(source).toContain("patchProjectConfig")
      expect(source).not.toMatch(/\bwriteConfig\s*\(/)
    },
  )

  it("persists MCP configuration through the host-owned global layer", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "commands", "nexusMcp.tsx"),
      "utf8",
    )
    expect(source).toContain("patchGlobalConfig")
    expect(source).not.toMatch(/\bwriteConfig\s*\(/)
    expect(source).not.toContain("deepMerge(current, patch)")
  })

  it("requires an explicit terminal action before promoting project MCP", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "components", "NexusMcpPanel.tsx"),
      "utf8",
    )
    expect(source).toContain("pendingProjectServers")
    expect(source).toContain("approval required")
    expect(source).toContain("A approve pending")
    expect(source).toContain("onSave({ mcp: { servers: nextServers } })")
  })

  it("does not retain a whole-effective-config save callback in the REPL", () => {
    const entrypoint = readFileSync(
      path.join(process.cwd(), "src", "entrypoints", "cli.tsx"),
      "utf8",
    )
    const repl = readFileSync(
      path.join(process.cwd(), "src", "screens", "REPL.tsx"),
      "utf8",
    )
    expect(entrypoint).not.toContain("nexusSaveConfig=")
    expect(repl).not.toContain("nexusSaveConfig")
  })
})
