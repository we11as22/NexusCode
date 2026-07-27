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
})
