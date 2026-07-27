import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CliHost,
  resolveNonInteractiveApproval,
  shouldAutoApprovePrint,
} from "./host.js"
import {
  loadWorkspaceAuthority,
  type ApprovalAction,
} from "@nexuscode/core"

function action(type: ApprovalAction["type"]): ApprovalAction {
  return {
    type,
    tool: type === "execute" ? "Bash" : `Test${type}`,
    description: `test ${type}`,
  }
}

describe("non-interactive approvals", () => {
  it("denies privileged actions regardless of read policy", () => {
    const policy = { read: true }

    expect(resolveNonInteractiveApproval(action("write"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("execute"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("mcp"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("browser"), policy)).toEqual({
      approved: false,
    })
  })

  it("approves reads only when the explicit policy permits them", () => {
    expect(resolveNonInteractiveApproval(action("read"), {})).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("read"), { read: true })).toEqual({
      approved: true,
    })
  })

  it("uses the dangerous flag as the sole print-mode bypass", () => {
    expect(shouldAutoApprovePrint(undefined)).toBe(false)
    expect(shouldAutoApprovePrint(false)).toBe(false)
    expect(shouldAutoApprovePrint(true)).toBe(true)
  })
})

describe("interactive approval cancellation", () => {
  it("clears the exact TUI resolver when its run is aborted", async () => {
    const approvalRef: {
      current: ((result: { approved: boolean }) => void) | null
    } = { current: null }
    const host = new CliHost(
      process.cwd(),
      () => {},
      false,
      approvalRef,
    )
    const abort = new AbortController()

    const pending = host.showApprovalDialog(
      action("execute"),
      abort.signal,
    )
    expect(approvalRef.current).not.toBeNull()

    abort.abort()

    await expect(pending).resolves.toEqual({ approved: false })
    expect(approvalRef.current).toBeNull()
  })

  it("binds an always-approved Bash action to the exact command", async () => {
    const approvalRef: {
      current: ((result: { approved: boolean; alwaysApprove?: boolean }) => void) | null
    } = { current: null }
    const host = new CliHost(
      process.cwd(),
      () => {},
      false,
      approvalRef,
    )
    const firstAction: ApprovalAction = {
      ...action("execute"),
      content: "pnpm test",
    }
    const first = host.showApprovalDialog(firstAction)
    approvalRef.current?.({ approved: true, alwaysApprove: true })
    await expect(first).resolves.toMatchObject({ approved: true })

    const different = host.showApprovalDialog({
      ...action("execute"),
      content: "pnpm publish",
    })
    expect(approvalRef.current).not.toBeNull()
    approvalRef.current?.({ approved: false })
    await expect(different).resolves.toEqual({ approved: false })

    expect(approvalRef.current).toBeNull()
    await expect(host.showApprovalDialog(firstAction)).resolves.toEqual({
      approved: true,
    })
  })
})

describe("CliHost in a headless process", () => {
  const originalIsTTY = process.stdin.isTTY

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    })
    vi.restoreAllMocks()
  })

  it("fails closed without creating readline and emits one diagnostic", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const host = new CliHost(process.cwd(), () => {}, false, undefined, {
      read: true,
    })

    await expect(host.showApprovalDialog(action("read"))).resolves.toEqual({
      approved: true,
    })
    await expect(host.showApprovalDialog(action("write"))).resolves.toEqual({
      approved: false,
    })
    await expect(host.showApprovalDialog(action("execute"))).resolves.toEqual({
      approved: false,
    })

    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(String(diagnostic.mock.calls[0]?.[0])).toContain(
      "Non-interactive mode",
    )
  })

  it("retains the explicit dangerous bypass", async () => {
    const host = new CliHost(process.cwd(), () => {}, true)
    await expect(host.showApprovalDialog(action("execute"))).resolves.toEqual({
      approved: true,
    })
  })

  it("fails closed for non-public network destinations", async () => {
    const host = new CliHost(process.cwd(), () => {}, true)
    await expect(host.authorizeNetworkRequest({
      url: "http://169.254.169.254/latest/meta-data",
      purpose: "web_fetch",
    })).rejects.toMatchObject({
      name: "NetworkPolicyError",
      code: "blocked_address",
    })
  })

  it("reports an MCP browser handoff as pending rather than authenticated", async () => {
    const host = new CliHost(process.cwd(), () => {}, true)
    await expect(host.requestMcpAuthentication({
      server: "docs",
      startUrl: "https://example.test/login",
    })).resolves.toEqual({
      success: false,
      pending: true,
      message: 'Authenticate MCP server "docs".\nOpen this URL: https://example.test/login',
    })
  })
})

describe("CliHost workspace filesystem authority", () => {
  const tempDirectories: string[] = []

  async function makeTempDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "nexus-cli-host-"),
    )
    tempDirectories.push(directory)
    return directory
  }

  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it("confines reads, existence checks, and future writes to its workspace", async () => {
    const parent = await makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const outside = path.join(parent, "outside")
    await fs.mkdir(workspace)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "public.txt"), "outside")
    const host = new CliHost(workspace, () => {}, true)

    await expect(host.resolvePath("src/future.ts", "write")).resolves.toBe(
      path.join(await fs.realpath(workspace), "src", "future.ts"),
    )
    await expect(
      host.resolvePath(path.join(outside, "public.txt"), "read"),
    ).rejects.toThrow(/outside the authorized workspace/i)
    await expect(
      host.readFile(path.join(outside, "public.txt")),
    ).rejects.toThrow(/outside the authorized workspace/i)
    await expect(
      host.exists(path.join(outside, "public.txt")),
    ).rejects.toThrow(/outside the authorized workspace/i)
  })

  it("rejects an in-workspace symlink that points outside", async () => {
    const parent = await makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const outside = path.join(parent, "outside")
    await fs.mkdir(workspace)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "public.txt"), "outside")
    await fs.symlink(outside, path.join(workspace, "escape"), "dir")
    const host = new CliHost(workspace, () => {}, true)

    await expect(
      host.resolvePath(path.join("escape", "public.txt"), "read"),
    ).rejects.toThrow(/outside the authorized workspace/i)
    await expect(
      host.resolvePath(path.join("escape", "future.txt"), "write"),
    ).rejects.toThrow(/outside the authorized workspace/i)
  })

  it("rejects command working directories outside the workspace", async () => {
    const parent = await makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const outside = path.join(parent, "outside")
    await fs.mkdir(workspace)
    await fs.mkdir(outside)
    const host = new CliHost(workspace, () => {}, true)

    await expect(
      host.runCommand(
        `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        outside,
      ),
    ).rejects.toThrow(/outside the authorized workspace/i)
  })

  it("persists folder grants in the host authority store, never in the repository", async () => {
    const parent = await makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const storePath = path.join(parent, "host-data", "authority", "workspaces.json")
    await fs.mkdir(workspace)
    const host = new CliHost(
      workspace,
      () => {},
      true,
      undefined,
      {},
      { storePath },
    )

    await host.addAllowedCommand(workspace, "  pnpm   test  ")
    await host.addAllowedPattern(workspace, "pnpm run:*")
    await host.addAllowedMcpTool(workspace, "github__search")

    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toMatchObject({
      grants: {
        commands: ["pnpm test"],
        commandPatterns: ["pnpm run:*"],
        mcpTools: ["github__search"],
      },
    })
    await expect(fs.lstat(path.join(workspace, ".nexus"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(fs.lstat(path.join(workspace, ".claude"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects a save when the file drifted after the edit preview", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "drift.txt")
    await fs.writeFile(file, "original", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    await host.openFileEdit(file, {
      originalContent: "original",
      newContent: "agent",
      isNewFile: false,
    })
    await fs.writeFile(file, "manual", "utf8")

    await expect(host.saveFileEdit(file)).rejects.toThrow(/conflict|changed/i)
    await expect(fs.readFile(file, "utf8")).resolves.toBe("manual")

    // A failed compare-and-swap must retain the proposal for a deliberate retry.
    await fs.writeFile(file, "original", "utf8")
    await expect(host.saveFileEdit(file)).resolves.toBeUndefined()
    await expect(fs.readFile(file, "utf8")).resolves.toBe("agent")
  })

  it("coalesces repeated same-file edits so undo restores the true pre-turn content", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "repeated.txt")
    await fs.writeFile(file, "before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    await host.openFileEdit(file, {
      originalContent: "before",
      newContent: "middle",
      isNewFile: false,
    })
    await host.saveFileEdit(file)
    await host.openFileEdit(file, {
      originalContent: "middle",
      newContent: "after",
      isNewFile: false,
    })
    await host.saveFileEdit(file)
    host.startNewTurn()
    const canonicalFile = path.join(await fs.realpath(workspace), "repeated.txt")

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      reverted: [canonicalFile],
      conflicts: [],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")
  })

  it("keeps a successful file undo reversible until the conversation save commits", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "two-phase.txt")
    await fs.writeFile(file, "before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    await host.openFileEdit(file, {
      originalContent: "before",
      newContent: "agent",
      isNewFile: false,
    })
    await host.saveFileEdit(file)
    host.startNewTurn()

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      conflicts: [],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")

    await expect(host.rollbackLastTurnFileRevert()).resolves.toMatchObject({
      conflicts: [],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("agent")
    expect(host.getLastTurnFileEdits()).toHaveLength(1)

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      conflicts: [],
    })
    host.commitLastTurnFileRevert()
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")
    expect(host.getLastTurnFileEdits()).toHaveLength(0)
  })

  it("reports only files which remain restored when undo compensation conflicts", async () => {
    const workspace = await makeTempDirectory()
    const unchanged = path.join(workspace, "still-restored.txt")
    const changed = path.join(workspace, "changed-after-restore.txt")
    await fs.writeFile(unchanged, "unchanged-before", "utf8")
    await fs.writeFile(changed, "changed-before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    for (const [file, before, after] of [
      [unchanged, "unchanged-before", "unchanged-agent"],
      [changed, "changed-before", "changed-agent"],
    ] as const) {
      await host.openFileEdit(file, {
        originalContent: before,
        newContent: after,
        isNewFile: false,
      })
      await host.saveFileEdit(file)
    }
    host.startNewTurn()
    await host.revertLastTurnFiles()
    await fs.writeFile(changed, "manual-after-restore", "utf8")

    const result = await host.rollbackLastTurnFileRevert()
    const canonicalUnchanged = path.join(
      await fs.realpath(workspace),
      "still-restored.txt",
    )
    const canonicalChanged = path.join(
      await fs.realpath(workspace),
      "changed-after-restore.txt",
    )
    expect(result).toMatchObject({
      reverted: [canonicalUnchanged],
      conflicts: [expect.objectContaining({ path: canonicalChanged })],
    })
    await expect(fs.readFile(unchanged, "utf8")).resolves.toBe(
      "unchanged-before",
    )
    await expect(fs.readFile(changed, "utf8")).resolves.toBe(
      "manual-after-restore",
    )
  })

  it("rejects a second same-turn edit after an interleaved manual change", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "interleaved.txt")
    await fs.writeFile(file, "before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    await host.openFileEdit(file, {
      originalContent: "before",
      newContent: "agent-one",
      isNewFile: false,
    })
    await host.saveFileEdit(file)
    await fs.writeFile(file, "manual", "utf8")
    await host.openFileEdit(file, {
      originalContent: "manual",
      newContent: "agent-two",
      isNewFile: false,
    })

    await expect(host.saveFileEdit(file)).rejects.toThrow(
      /between agent edits|interleaved|conflict/i,
    )
    await expect(fs.readFile(file, "utf8")).resolves.toBe("manual")
  })

  it("keeps undo state and refuses to overwrite a later manual edit", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "manual-after.txt")
    await fs.writeFile(file, "before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    await host.openFileEdit(file, {
      originalContent: "before",
      newContent: "agent",
      isNewFile: false,
    })
    await host.saveFileEdit(file)
    host.startNewTurn()
    await fs.writeFile(file, "manual", "utf8")
    const canonicalFile = path.join(
      await fs.realpath(workspace),
      "manual-after.txt",
    )

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      reverted: [],
      conflicts: [expect.objectContaining({ path: canonicalFile })],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("manual")
    expect(host.getLastTurnFileEdits()).toHaveLength(1)
  })

  it("rolls back already-restored files when a later batch restore fails", async () => {
    const workspace = await makeTempDirectory()
    const first = path.join(workspace, "first.txt")
    const second = path.join(workspace, "second.txt")
    await fs.writeFile(first, "first-before", "utf8")
    await fs.writeFile(second, "second-before", "utf8")
    const host = new CliHost(workspace, () => {}, true)

    for (const [file, before, after] of [
      [first, "first-before", "first-agent"],
      [second, "second-before", "second-agent"],
    ] as const) {
      await host.openFileEdit(file, {
        originalContent: before,
        newContent: after,
        isNewFile: false,
      })
      await host.saveFileEdit(file)
    }
    host.startNewTurn()

    const writeFile = host.writeFile.bind(host)
    let injected = false
    vi.spyOn(host, "writeFile").mockImplementation(async (file, content) => {
      if (!injected && file.endsWith("first.txt") && content === "first-before") {
        injected = true
        throw new Error("injected restore failure")
      }
      await writeFile(file, content)
    })

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      reverted: [],
      conflicts: [expect.objectContaining({
        path: expect.stringMatching(/first\.txt$/),
      })],
    })
    await expect(fs.readFile(first, "utf8")).resolves.toBe("first-agent")
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second-agent")
    expect(host.getLastTurnFileEdits()).toHaveLength(2)
  })
})
