import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { NexusConfigSchema } from "../config/schema.js"
import { createFakeHost } from "../test/fakes.js"
import type { NexusConfig } from "../types.js"
import { validatePluginManifestFile } from "./index.js"
import { runPluginHooks, runScopedHooks } from "./runtime.js"
import { grantPluginTrust } from "./trust.js"

const roots: string[] = []
const originalDataHome = process.env["NEXUS_DATA_HOME"]

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env["NEXUS_DATA_HOME"]
  else process.env["NEXUS_DATA_HOME"] = originalDataHome
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function trustManifest(root: string, manifestPath: string): Promise<void> {
  process.env["NEXUS_DATA_HOME"] = path.join(root, "host-data")
  const validated = await validatePluginManifestFile(manifestPath)
  expect(validated.success).toBe(true)
  await grantPluginTrust(validated.plugin!)
}

describe("plugin hook execution", () => {
  it("runs legacy and OpenClaude hook families in deterministic sequence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-hook-order-"))
    roots.push(root)

    const legacyRoot = path.join(root, ".nexus", "plugins", "a-legacy")
    await mkdir(legacyRoot, { recursive: true })
    await writeFile(path.join(legacyRoot, "legacy.sh"), "#!/bin/sh\n", "utf8")
    const legacyManifest = path.join(legacyRoot, "plugin.json")
    await writeFile(
      legacyManifest,
      JSON.stringify({
        name: "a-legacy",
        hooks: ["after_tool:legacy.sh"],
      }),
      "utf8",
    )

    const openClaudeRoot = path.join(root, ".nexus", "plugins", "b-open")
    await mkdir(openClaudeRoot, { recursive: true })
    const openClaudeManifest = path.join(openClaudeRoot, "plugin.json")
    await writeFile(
      openClaudeManifest,
      JSON.stringify({
        name: "b-open",
        hooks: {
          PostToolUse: [{
            hooks: [{ type: "command", command: "open-hook" }],
          }],
        },
      }),
      "utf8",
    )

    await trustManifest(root, legacyManifest)
    await trustManifest(root, openClaudeManifest)

    const order: string[] = []
    let signalOpenStarted: (() => void) | undefined
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve
    })
    const host = createFakeHost({
      cwd: root,
      async runCommand(command) {
        if (command.includes("legacy.sh")) {
          order.push("legacy:start")
          await Promise.race([
            openStarted,
            new Promise<void>((resolve) => setTimeout(resolve, 40)),
          ])
          order.push("legacy:end")
        } else {
          order.push("open:start")
          signalOpenStarted?.()
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    })

    await runPluginHooks(
      root,
      host,
      NexusConfigSchema.parse({}) as NexusConfig,
      "after_tool",
      { toolName: "Read" },
    )

    expect(order).toEqual(["legacy:start", "legacy:end", "open:start"])
  })

  it("quotes trusted hook paths as data instead of executable shell syntax", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-hook-"))
    roots.push(root)
    const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
    const hookName = "hook'$(echo hacked).sh"
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(pluginRoot, hookName), "#!/bin/sh\n", "utf8")
    const manifestPath = path.join(pluginRoot, "plugin.json")
    await writeFile(
      manifestPath,
      JSON.stringify({ name: "demo", hooks: [`after_tool:${hookName}`] }),
      "utf8",
    )
    await trustManifest(root, manifestPath)
    let command = ""
    const host = createFakeHost({
      cwd: root,
      async runCommand(value) {
        command = value
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const config = NexusConfigSchema.parse({}) as NexusConfig

    await runPluginHooks(root, host, config, "after_tool", {})

    expect(command).toContain("bash '")
    expect(command).toContain(`hook'"'"'$(echo hacked).sh'`)
    expect(command).not.toContain('bash "')
  })

  it("loads OpenClaude hooks/hooks.json and maps blocking PreToolUse command hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-openclaude-hook-"))
    roots.push(root)
    const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true })
    const manifestPath = path.join(pluginRoot, "plugin.json")
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        description: "demo hooks",
        hooks: {
          PreToolUse: [{
            matcher: "^Bash$",
            hooks: [{ type: "command", command: "verify-tool", timeout: 2 }],
          }],
        },
      }),
      "utf8",
    )
    await trustManifest(root, manifestPath)
    const canonicalPluginRoot = await realpath(pluginRoot)
    let command = ""
    const host = createFakeHost({
      cwd: root,
      async runCommand(value, commandCwd) {
        command = value
        expect(commandCwd).toBe(canonicalPluginRoot)
        return { stdout: "", stderr: "blocked by policy", exitCode: 2 }
      },
    })
    const config = NexusConfigSchema.parse({}) as NexusConfig

    const results = await runPluginHooks(root, host, config, "before_tool", {
      toolName: "Bash",
      toolInput: { command: "danger" },
    })

    expect(command).toContain("verify-tool")
    expect(results).toMatchObject([{
      pluginName: "demo",
      success: false,
      preventContinuation: true,
      stopReason: "blocked by policy",
    }])
  })

  it("runs one-shot OpenClaude hooks once per session and consumes them only after success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-openclaude-once-"))
    roots.push(root)
    const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true })
    const manifestPath = path.join(pluginRoot, "plugin.json")
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{
            matcher: "^Read$",
            hooks: [{ type: "command", command: "record-read", once: true }],
          }],
        },
      }),
      "utf8",
    )
    await trustManifest(root, manifestPath)
    let executions = 0
    const host = createFakeHost({
      cwd: root,
      async runCommand() {
        executions += 1
        return executions === 1
          ? { stdout: "", stderr: "temporary failure", exitCode: 1 }
          : { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const config = NexusConfigSchema.parse({}) as NexusConfig
    const payload = (sessionId: string) => ({ sessionId, toolName: "Read" })

    await expect(runPluginHooks(root, host, config, "after_tool", payload("session-a")))
      .resolves.toMatchObject([{ success: false }])
    await expect(runPluginHooks(root, host, config, "after_tool", payload("session-a")))
      .resolves.toMatchObject([{ success: true }])
    await expect(runPluginHooks(root, host, config, "after_tool", payload("session-a")))
      .resolves.toEqual([])
    await expect(runPluginHooks(root, host, config, "after_tool", payload("session-b")))
      .resolves.toMatchObject([{ success: true }])
    expect(executions).toBe(3)
  })

  it("routes OpenClaude HTTP hooks through host network authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-openclaude-http-hook-"))
    roots.push(root)
    const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
    const manifestPath = path.join(pluginRoot, "plugin.json")
    await mkdir(path.join(pluginRoot, "hooks"), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(
      path.join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{
            hooks: [{
              type: "http",
              url: "https://hooks.example.test/after-tool",
            }],
          }],
        },
      }),
      "utf8",
    )
    await trustManifest(root, manifestPath)
    const requested: string[] = []
    const host = createFakeHost({
      cwd: root,
      async authorizeNetworkRequest(request) {
        requested.push(request.url)
        throw new Error("host network policy denied the hook")
      },
    })

    const results = await runPluginHooks(
      root,
      host,
      NexusConfigSchema.parse({}) as NexusConfig,
      "after_tool",
      { toolName: "Read" },
    )

    expect(requested).toEqual(["https://hooks.example.test/after-tool"])
    expect(results).toMatchObject([{
      pluginName: "demo",
      success: false,
      output: expect.stringMatching(/authorization failed/i),
    }])
  })

  it("rejects scoped agent hooks that escape the agent definition directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-hook-"))
    roots.push(root)
    const agentRoot = path.join(root, ".nexus", "agents", "reviewer")
    await mkdir(agentRoot, { recursive: true })
    await writeFile(path.join(root, "outside.sh"), "#!/bin/sh\n", "utf8")
    let executed = false
    const host = createFakeHost({
      cwd: root,
      async runCommand() {
        executed = true
        return { stdout: "unexpected", stderr: "", exitCode: 0 }
      },
    })

    const results = await runScopedHooks(
      root,
      host,
      "subagent_start",
      { sessionId: "session-a" },
      [{
        name: "Reviewer",
        rootDir: agentRoot,
        hooks: ["subagent_start:../../../outside.sh"],
      }],
    )

    expect(executed).toBe(false)
    expect(results).toMatchObject([{
      pluginName: "Reviewer",
      success: false,
      output: expect.stringMatching(/escapes/i),
    }])
  })

  it("requires explicit approval before executing a scoped agent hook", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-hook-approval-"))
    roots.push(root)
    const agentRoot = path.join(root, ".nexus", "agents", "reviewer")
    await mkdir(agentRoot, { recursive: true })
    await writeFile(path.join(agentRoot, "start.sh"), "#!/bin/sh\n", "utf8")
    let executed = false
    const host = createFakeHost({
      cwd: root,
      async runCommand() {
        executed = true
        return { stdout: "unexpected", stderr: "", exitCode: 0 }
      },
      async showApprovalDialog() {
        return { approved: false }
      },
    })

    const results = await runScopedHooks(
      root,
      host,
      "subagent_start",
      { sessionId: "session-a" },
      [{
        name: "Reviewer",
        rootDir: agentRoot,
        hooks: ["subagent_start:start.sh"],
      }],
    )

    expect(executed).toBe(false)
    expect(host.approvals).toMatchObject([{
      type: "plugin",
      tool: "AgentHook:Reviewer",
    }])
    expect(results).toMatchObject([{
      success: false,
      output: expect.stringMatching(/denied/i),
    }])
  })
})
