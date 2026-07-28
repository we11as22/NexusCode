import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const hostSource = readFileSync(
  path.join(process.cwd(), "src", "host.ts"),
  "utf8",
)

function methodBody(start: string, end: string): string {
  const startIndex = hostSource.indexOf(start)
  const endIndex = hostSource.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return hostSource.slice(startIndex, endIndex)
}

describe("VS Code host workspace authority wiring", () => {
  it("uses the shared canonical workspace path authorizer", () => {
    expect(hostSource).toContain("resolveAuthorizedWorkspacePath")
    expect(
      methodBody("private resolveWorkspacePath(", "async resolvePath("),
    ).toContain("resolveAuthorizedWorkspacePath(this.cwd, filePath)")
  })

  it.each([
    ["async readFile(", "async writeFile("],
    ["async writeFile(", "async deleteFile("],
    ["async deleteFile(", "async exists("],
    ["async exists(", "async showDiff("],
  ])("authorizes the path used by %s", (start, end) => {
    expect(methodBody(start, end)).toContain("this.resolveWorkspacePath(filePath)")
  })

  it("authorizes command and working-directory cwd values", () => {
    expect(methodBody("async runCommand(", "async requestMcpAuthentication("))
      .toContain("this.resolveWorkspacePath(cwd || this.cwd)")
    expect(methodBody("async setWorkingDirectory(", "async queryLanguageServer("))
      .toContain("this.resolveWorkspacePath(cwd)")
  })

  it("does not report opening an MCP login URL as completed authentication", () => {
    const body = methodBody(
      "async requestMcpAuthentication(",
      "private getOrCreateNexusTerminal(",
    )
    expect(body).toContain("success: false")
    expect(body).toContain("pending: true")
    expect(body).not.toContain("success: true")
  })

  it("authorizes language-server input and filters output locations", () => {
    const body = methodBody(
      "async queryLanguageServer(",
      "function getLanguageFromExtension(",
    )
    expect(body).toContain("this.resolveWorkspacePath(request.filePath")
    expect(body).toContain("this.isAuthorizedWorkspacePath")
  })

  it("exposes only the durable CAS file-mutation boundary", () => {
    expect(
      methodBody("async readFileState(", "async applyFileMutation("),
    ).toContain("this.resolveWorkspacePath(filePath)")
    expect(
      methodBody("async applyFileMutation(", "async runCommand("),
    ).toContain("capturedMatchesExpected")
    expect(hostSource).not.toContain("openFileEdit")
    expect(hostSource).not.toContain("saveFileEdit")
    expect(hostSource).not.toContain("revertSavedFileEdit")
  })

  it("persists folder grants through the host-owned exact-workspace store", () => {
    expect(
      methodBody("async addAllowedCommand(", "async addAllowedPattern("),
    ).toContain('{ kind: "command"')
    expect(
      methodBody("async addAllowedPattern(", "async addAllowedMcpTool("),
    ).toContain('{ kind: "command-pattern"')
    expect(
      methodBody("async addAllowedMcpTool(", "async getProblems("),
    ).toContain('{ kind: "mcp-tool"')
    expect(hostSource).not.toContain("allowed-commands.json")
    expect(hostSource).not.toContain("settings.local.json")
  })
})
