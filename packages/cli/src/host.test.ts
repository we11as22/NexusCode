import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CliHost,
  resolveNonInteractiveApproval,
  shouldAutoApprovePrint,
} from "./host.js"
import {
  ChangeSetService,
  FileChangeSetStore,
  hashFileContent,
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
  it("does not advertise interactive questions without the TUI", () => {
    const host = new CliHost(process.cwd(), () => {})

    expect(host.capabilities).toEqual({
      interactiveQuestions: false,
    })
  })

  it("advertises interactive questions when a TUI resolver is attached", () => {
    const host = new CliHost(
      process.cwd(),
      () => {},
      false,
      { current: null },
    )

    expect(host.capabilities).toEqual({
      interactiveQuestions: true,
    })
  })

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

describe("trusted CLI runtime boundary", () => {
  it("rejects model file mutations under the packaged runtime", async () => {
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    )
    const host = new CliHost(packageRoot, () => {})

    await expect(
      host.resolvePath(path.join(packageRoot, "dist", "immutable-probe.js"), "write"),
    ).rejects.toThrow(/immutable NexusCode runtime/i)
    await expect(
      host.resolvePath(path.join(packageRoot, "src", "editable-probe.ts"), "write"),
    ).resolves.toBe(path.join(packageRoot, "src", "editable-probe.ts"))
  })
})

describe.runIf(
  process.platform === "darwin" &&
    process.env.NEXUS_NATIVE_SANDBOX_SMOKE === "1",
)("native OS sandbox integration", () => {
  it("writes in the workspace and protects Nexus metadata", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "nexus-cli-sandbox-smoke-"),
    )
    try {
      const host = new CliHost(workspace, () => {}, true)
      const write = await host.runSandboxedCommand(
        {
          executionId: "cli-native-write",
          command: "printf 'sandbox-ok' > inside.txt",
          cwd: workspace,
          workspaceRoots: [workspace],
          profile: "workspace-write",
          network: "restricted",
          timeoutMs: 10_000,
        },
      )
      expect(write).toMatchObject({
        exitCode: 0,
        sandbox: "seatbelt",
        denied: false,
      })
      await expect(
        fs.readFile(path.join(workspace, "inside.txt"), "utf8"),
      ).resolves.toBe("sandbox-ok")

      const protectedWrite = await host.runSandboxedCommand(
        {
          executionId: "cli-native-protected",
          command: "mkdir -p .nexus && printf blocked > .nexus/config.json",
          cwd: workspace,
          workspaceRoots: [workspace],
          profile: "workspace-write",
          network: "restricted",
          timeoutMs: 10_000,
        },
      )
      expect(protectedWrite.exitCode).not.toBe(0)
      expect(protectedWrite.denied).toBe(true)
      await expect(
        fs.readFile(path.join(workspace, ".nexus", "config.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
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

  it("applies durable file mutations only against exact bytes and mode", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "durable.txt")
    await fs.writeFile(file, "before", { mode: 0o640 })
    const host = new CliHost(workspace, () => {}, true)
    const captured = await host.readFileState("durable.txt")
    expect(captured.exists).toBe(true)
    if (!captured.exists) throw new Error("missing fixture")
    const digest = hashFileContent(captured.content)

    await host.applyFileMutation({
      path: "durable.txt",
      expected: {
        exists: true,
        ...digest,
        blob: digest.hash,
        mode: captured.mode,
      },
      next: {
        exists: true,
        content: Buffer.from("after"),
        mode: captured.mode,
      },
    })

    await expect(fs.readFile(file, "utf8")).resolves.toBe("after")
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
  })

  it("leaves later user bytes untouched when durable CAS detects drift", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "durable-drift.txt")
    await fs.writeFile(file, "before")
    const host = new CliHost(workspace, () => {}, true)
    const captured = await host.readFileState("durable-drift.txt")
    if (!captured.exists) throw new Error("missing fixture")
    const digest = hashFileContent(captured.content)
    await fs.writeFile(file, "manual")

    await expect(host.applyFileMutation({
      path: "durable-drift.txt",
      expected: {
        exists: true,
        ...digest,
        blob: digest.hash,
        mode: captured.mode,
      },
      next: {
        exists: true,
        content: Buffer.from("agent"),
        mode: captured.mode,
      },
    })).rejects.toThrow(/precondition failed/i)
    await expect(fs.readFile(file, "utf8")).resolves.toBe("manual")
  })

  it("uses durable change sets for two-phase last-turn undo compensation", async () => {
    const workspace = await makeTempDirectory()
    const file = path.join(workspace, "durable-undo.txt")
    await fs.writeFile(file, "before")
    const host = new CliHost(workspace, () => {}, true)
    const store = new FileChangeSetStore("workspace-durable", {
      rootDir: workspace,
    })
    const service = new ChangeSetService({
      workspaceId: "workspace-durable",
      store,
      files: {
        readFileState: (filePath) => host.readFileState(filePath),
        applyFileMutation: (mutation) =>
          host.applyFileMutation(mutation),
      },
      idFactory: () => "change-durable",
    })
    host.bindDurableChangeReview(service, "session-1", "turn-1")
    const proposed = await service.propose({
      identity: {
        workspaceId: "workspace-durable",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        messageId: "message-1",
        partId: "part-1",
        toolCallId: "call-1",
      },
      files: [{
        path: "durable-undo.txt",
        after: { exists: true, content: "agent" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)

    await expect(host.revertLastTurnFiles()).resolves.toMatchObject({
      reverted: ["durable-undo.txt"],
      conflicts: [],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")
    await expect(host.rollbackLastTurnFileRevert()).resolves.toEqual({
      reverted: [],
      conflicts: [],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("agent")

    await host.revertLastTurnFiles()
    host.commitLastTurnFileRevert()
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")

    await service.reapply(proposed.id)
    await host.revertLastTurnFiles()
    vi.spyOn(service, "reapply").mockImplementation(async (id) => {
      const record = await service.get(id)
      if (!record) throw new Error(`missing change set ${id}`)
      return { ...record, state: "conflicted" }
    })
    await expect(host.rollbackLastTurnFileRevert()).resolves.toMatchObject({
      reverted: ["change-durable"],
      conflicts: [{
        path: "change-durable",
        reason:
          "failed to restore the agent-written durable change: " +
          "change set change-durable recovered to conflicted",
      }],
    })
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before")
  })

  it("fails last-turn file undo closed without durable change ownership", async () => {
    const workspace = await makeTempDirectory()
    const host = new CliHost(workspace, () => {}, true)

    await expect(host.revertLastTurnFiles()).resolves.toEqual({
      reverted: [],
      conflicts: [{
        path: "(change service)",
        reason:
          "durable change ownership is unavailable; no files were changed",
      }],
    })
  })

})
