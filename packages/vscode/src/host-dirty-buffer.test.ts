import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const vscodeState = vi.hoisted(() => ({
  textDocuments: [] as Array<Record<string, unknown>>,
  disk: new Map<string, string>(),
  applyResult: true,
  applyCalls: 0,
  openedExternalUrls: [] as string[],
}))

vi.mock("vscode", () => {
  class Uri {
    readonly scheme = "file"

    constructor(readonly fsPath: string) {}

    static file(filePath: string): Uri {
      return new Uri(filePath)
    }

    static parse(value: string): Uri {
      return new Uri(value.replace(/^file:/u, ""))
    }

    toString(): string {
      return `file:${this.fsPath}`
    }
  }

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class WorkspaceEdit {
    readonly replacements: Array<{
      uri: Uri
      content: string
    }> = []

    replace(uri: Uri, _range: Range, content: string): void {
      this.replacements.push({ uri, content })
    }
  }

  return {
    Uri,
    Position,
    Range,
    WorkspaceEdit,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      textDocuments: vscodeState.textDocuments,
      fs: {
        async stat(uri: Uri) {
          const value = vscodeState.disk.get(uri.fsPath)
          if (value === undefined) throw new Error("ENOENT")
          return {
            type: 1,
            size: Buffer.byteLength(value, "utf8"),
          }
        },
        async readFile(uri: Uri) {
          const value = vscodeState.disk.get(uri.fsPath)
          if (value === undefined) throw new Error("ENOENT")
          return new TextEncoder().encode(value)
        },
        async writeFile(uri: Uri, content: Uint8Array) {
          vscodeState.disk.set(
            uri.fsPath,
            Buffer.from(content).toString("utf8"),
          )
        },
        async createDirectory() {},
        async delete(uri: Uri) {
          vscodeState.disk.delete(uri.fsPath)
        },
      },
      async applyEdit(edit: WorkspaceEdit) {
        vscodeState.applyCalls += 1
        if (!vscodeState.applyResult) return false
        for (const replacement of edit.replacements) {
          const document = vscodeState.textDocuments.find(
            (candidate) =>
              (candidate.uri as Uri | undefined)?.fsPath ===
              replacement.uri.fsPath,
          )
          if (document) {
            ;(document.setText as (value: string) => void)(
              replacement.content,
            )
          }
        }
        return true
      },
    },
    window: {},
    commands: {},
    languages: {},
    env: {
      async openExternal(uri: Uri) {
        vscodeState.openedExternalUrls.push(uri.fsPath)
        return true
      },
    },
  }
})

import * as vscode from "vscode"
import {
  VsCodeHost,
  resolveWebviewApproval,
  type WebviewApprovalResolverSlot,
} from "./host.js"

type FakeDocument = vscode.TextDocument & {
  setText(value: string): void
}

const tempDirectories: string[] = []

function makeWorkspace(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-vscode-dirty-"),
  )
  tempDirectories.push(directory)
  return directory
}

function openDocument(
  filePath: string,
  initialText: string,
  options: { dirty?: boolean; saveResult?: boolean } = {},
): FakeDocument {
  let text = initialText
  let dirty = options.dirty ?? true
  const uri = vscode.Uri.file(filePath)
  const document = {
    uri,
    get isDirty() {
      return dirty
    },
    getText: () => text,
    positionAt(offset: number) {
      const prefix = text.slice(0, offset)
      const lines = prefix.split("\n")
      return new vscode.Position(
        lines.length - 1,
        lines.at(-1)?.length ?? 0,
      )
    },
    setText(value: string) {
      text = value
      dirty = true
    },
    async save() {
      if (options.saveResult === false) return false
      vscodeState.disk.set(filePath, text)
      dirty = false
      return true
    },
  } as unknown as FakeDocument
  vscodeState.textDocuments.push(
    document as unknown as Record<string, unknown>,
  )
  return document
}

beforeEach(() => {
  vscodeState.textDocuments.splice(0)
  vscodeState.disk.clear()
  vscodeState.applyResult = true
  vscodeState.applyCalls = 0
  vscodeState.openedExternalUrls.splice(0)
})

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("VsCodeHost dirty editor authority", () => {
  it("reads the authoritative open buffer without silently saving it", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "disk")
    vscodeState.disk.set(filePath, "disk")
    const document = openDocument(filePath, "unsaved editor text")
    const host = new VsCodeHost(workspace, () => {})

    await expect(host.readFile("file.ts")).resolves.toBe(
      "unsaved editor text",
    )
    expect(document.isDirty).toBe(true)
    expect(vscodeState.disk.get(filePath)).toBe("disk")
  })

  it("applies and saves an approved edit based on the unchanged dirty buffer", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "disk")
    vscodeState.disk.set(filePath, "disk")
    const document = openDocument(filePath, "user draft")
    const host = new VsCodeHost(workspace, () => {})

    await host.openFileEdit("file.ts", {
      originalContent: "user draft",
      newContent: "agent result",
      isNewFile: false,
    })
    await host.saveFileEdit("file.ts")

    expect(document.getText()).toBe("agent result")
    expect(document.isDirty).toBe(false)
    expect(vscodeState.disk.get(filePath)).toBe("agent result")
    expect(vscodeState.applyCalls).toBe(1)
    expect(host.getPendingFileEdit("file.ts")).toBeUndefined()
  })

  it("fails closed when the user changes the buffer after the diff was prepared", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "disk")
    vscodeState.disk.set(filePath, "disk")
    const document = openDocument(filePath, "prepared base")
    const host = new VsCodeHost(workspace, () => {})

    await host.openFileEdit("file.ts", {
      originalContent: "prepared base",
      newContent: "agent result",
      isNewFile: false,
    })
    document.setText("new user edit")

    await expect(host.saveFileEdit("file.ts")).rejects.toThrow(
      /conflict.*changed in the editor/i,
    )
    expect(document.getText()).toBe("new user edit")
    expect(document.isDirty).toBe(true)
    expect(vscodeState.disk.get(filePath)).toBe("disk")
    expect(vscodeState.applyCalls).toBe(0)
    expect(host.getPendingFileEdit("file.ts")).toBeDefined()
  })

  it("never lets a direct host write overwrite a dirty editor buffer", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "disk")
    vscodeState.disk.set(filePath, "disk")
    const document = openDocument(filePath, "unsaved user edit")
    const host = new VsCodeHost(workspace, () => {})

    await expect(host.writeFile("file.ts", "agent result")).rejects.toThrow(
      /refusing to overwrite unsaved editor changes/i,
    )
    expect(document.getText()).toBe("unsaved user edit")
    expect(vscodeState.disk.get(filePath)).toBe("disk")
    expect(vscodeState.applyCalls).toBe(0)
  })

  it("never lets a direct host delete discard a dirty editor buffer", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "disk")
    vscodeState.disk.set(filePath, "disk")
    const document = openDocument(filePath, "unsaved user edit")
    const host = new VsCodeHost(workspace, () => {})

    await expect(host.deleteFile("file.ts")).rejects.toThrow(
      /refusing to delete.*unsaved editor changes/i,
    )
    expect(document.getText()).toBe("unsaved user edit")
    expect(vscodeState.disk.get(filePath)).toBe("disk")
  })

  it("reverts a saved edit only while the agent result is still current", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "agent result")
    vscodeState.disk.set(filePath, "agent result")
    const document = openDocument(filePath, "agent result", { dirty: false })
    const host = new VsCodeHost(workspace, () => {})

    await host.revertSavedFileEdit("file.ts", {
      originalContent: "user draft",
      newContent: "agent result",
      isNewFile: false,
    })

    expect(document.getText()).toBe("user draft")
    expect(document.isDirty).toBe(false)
    expect(vscodeState.disk.get(filePath)).toBe("user draft")
  })

  it("keeps a tracked edit when later dirty-buffer changes conflict with revert", async () => {
    const workspace = makeWorkspace()
    const filePath = path.join(workspace, "file.ts")
    fs.writeFileSync(filePath, "agent result")
    vscodeState.disk.set(filePath, "agent result")
    const document = openDocument(filePath, "later user edit")
    const host = new VsCodeHost(workspace, () => {})

    await expect(
      host.revertSavedFileEdit("file.ts", {
        originalContent: "user draft",
        newContent: "agent result",
        isNewFile: false,
      }),
    ).rejects.toThrow(/conflict.*changed in the editor/i)

    expect(document.getText()).toBe("later user edit")
    expect(document.isDirty).toBe(true)
    expect(vscodeState.disk.get(filePath)).toBe("agent result")
    expect(vscodeState.applyCalls).toBe(0)
  })
})

describe("controller dirty-buffer wiring", () => {
  const controllerSource = fs.readFileSync(
    path.join(process.cwd(), "src", "controller.ts"),
    "utf8",
  )

  it("never silently reverts an editor document after a tool event", () => {
    const start = controllerSource.indexOf(
      "const deliverLocalEvent = (event: AgentEvent)",
    )
    const end = controllerSource.indexOf(
      "const durableEventSink =",
      start,
    )
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(controllerSource.slice(start, end)).not.toContain(
      "workbench.action.files.revert",
    )
  })

  it("retains session edits whose compare-before-revert check fails", () => {
    const start = controllerSource.indexOf('case "undoSessionEdits"')
    const end = controllerSource.indexOf('case "keepAllSessionEdits"', start)
    const body = controllerSource.slice(start, end)

    expect(body).toContain("revertSavedFileEdit")
    expect(body).toContain("remaining.push(e)")
    expect(body).toContain("this.sessionUnacceptedEdits = remaining")
  })

  it("requires host confirmation before a checkpoint can discard dirty buffers", () => {
    const start = controllerSource.indexOf(
      "private async restoreCheckpointToHash(",
    )
    const end = controllerSource.indexOf(
      "/** Show diff between two checkpoints",
      start,
    )
    const body = controllerSource.slice(start, end)
    const confirmation = body.indexOf("including unsaved editor buffers")
    const reset = body.indexOf("await tracker.resetHead(hash)")
    const dirtyRevert = body.indexOf("await this.revertDirtyWorkspaceDocs(cwd)")

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(body).toContain("Stop the current run before restoring")
    expect(body).toContain("Refusing to restore an unknown checkpoint")
    expect(body).toContain('{ modal: true }')
    expect(confirmation).toBeGreaterThanOrEqual(0)
    expect(reset).toBeGreaterThan(confirmation)
    expect(dirtyRevert).toBeGreaterThan(reset)
  })
})

describe("local webview approval identity", () => {
  it("resolves only the exact tool part announced by the host", async () => {
    const workspace = makeWorkspace()
    const slot: WebviewApprovalResolverSlot = { current: null }
    const host = new VsCodeHost(workspace, () => {}, {
      useWebviewApproval: true,
      approvalResolveRef: slot,
    })
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "Run tests",
    }

    host.emit({
      type: "tool_approval_needed",
      partId: "part-current",
      action,
    })
    const pending = host.showApprovalDialog(action)

    expect(slot.current?.partId).toBe("part-current")
    expect(
      resolveWebviewApproval(
        slot,
        "part-stale",
        { approved: true },
      ),
    ).toBe(false)
    expect(slot.current?.partId).toBe("part-current")
    expect(
      resolveWebviewApproval(
        slot,
        "part-current",
        { approved: false },
      ),
    ).toBe(true)
    await expect(pending).resolves.toEqual({ approved: false })
    expect(slot.current).toBeNull()
  })

  it("fails closed if a webview dialog has no emitted part identity", async () => {
    const workspace = makeWorkspace()
    const slot: WebviewApprovalResolverSlot = { current: null }
    const host = new VsCodeHost(workspace, () => {}, {
      useWebviewApproval: true,
      approvalResolveRef: slot,
    })

    await expect(
      host.showApprovalDialog({
        type: "execute",
        tool: "Bash",
        description: "Run tests",
      }),
    ).rejects.toThrow(/missing.*tool-part identity/i)
    expect(slot.current).toBeNull()
  })

  it("clears the exact pending webview approval when its run is aborted", async () => {
    const workspace = makeWorkspace()
    const slot: WebviewApprovalResolverSlot = { current: null }
    const host = new VsCodeHost(workspace, () => {}, {
      useWebviewApproval: true,
      approvalResolveRef: slot,
    })
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "Run tests",
    }
    const abort = new AbortController()

    host.emit({
      type: "tool_approval_needed",
      partId: "part-aborted",
      action,
    })
    const pending = host.showApprovalDialog(action, abort.signal)
    expect(slot.current?.partId).toBe("part-aborted")

    abort.abort()

    await expect(Promise.race([
      pending,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 50)
      }),
    ])).resolves.toEqual({ approved: false })
    expect(slot.current).toBeNull()
  })

  it("binds a persistent command grant to the exact pending command", async () => {
    const workspace = makeWorkspace()
    const slot: WebviewApprovalResolverSlot = { current: null }
    const host = new VsCodeHost(workspace, () => {}, {
      useWebviewApproval: true,
      approvalResolveRef: slot,
    })
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "Run tests",
      content: "pnpm test",
    }

    host.emit({
      type: "tool_approval_needed",
      partId: "part-command",
      action,
    })
    const pending = host.showApprovalDialog(action)

    expect(
      resolveWebviewApproval(
        slot,
        "part-command",
        { approved: true, addToAllowedCommand: "rm -rf project" },
      ),
    ).toBe(false)
    expect(slot.current?.partId).toBe("part-command")
    expect(
      resolveWebviewApproval(
        slot,
        "part-command",
        { approved: true, addToAllowedCommand: "  pnpm   test  " },
      ),
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      approved: true,
      addToAllowedCommand: "pnpm test",
    })
  })

  it("does not apply an always-approved Bash command to different arguments", async () => {
    const workspace = makeWorkspace()
    const slot: WebviewApprovalResolverSlot = { current: null }
    const host = new VsCodeHost(workspace, () => {}, {
      useWebviewApproval: true,
      approvalResolveRef: slot,
    })
    const firstAction = {
      type: "execute" as const,
      tool: "Bash",
      description: "Run tests",
      content: "pnpm test",
    }
    host.emit({
      type: "tool_approval_needed",
      partId: "part-first-command",
      action: firstAction,
    })
    const first = host.showApprovalDialog(firstAction)
    expect(resolveWebviewApproval(
      slot,
      "part-first-command",
      { approved: true, alwaysApprove: true },
    )).toBe(true)
    await first

    const secondAction = {
      ...firstAction,
      description: "Publish package",
      content: "pnpm publish",
    }
    host.emit({
      type: "tool_approval_needed",
      partId: "part-second-command",
      action: secondAction,
    })
    const second = host.showApprovalDialog(secondAction)

    expect(slot.current?.partId).toBe("part-second-command")
    expect(resolveWebviewApproval(
      slot,
      "part-second-command",
      { approved: false },
    )).toBe(true)
    await expect(second).resolves.toEqual({ approved: false })
  })
})

describe("MCP browser handoff", () => {
  it("opens only bounded HTTP(S) authentication URLs", async () => {
    const workspace = makeWorkspace()
    const host = new VsCodeHost(workspace, () => {})

    await expect(
      host.requestMcpAuthentication({
        server: "unsafe",
        startUrl: "javascript:alert(1)",
      }),
    ).resolves.toMatchObject({ success: false })
    expect(vscodeState.openedExternalUrls).toEqual([])

    await expect(
      host.requestMcpAuthentication({
        server: "safe",
        startUrl: "https://auth.example.com/start",
      }),
    ).resolves.toMatchObject({ success: false, pending: true })
    expect(vscodeState.openedExternalUrls).toEqual([
      "https://auth.example.com/start",
    ])
  })
})
