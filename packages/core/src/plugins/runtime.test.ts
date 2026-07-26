import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { NexusConfigSchema } from "../config/schema.js"
import { createFakeHost } from "../test/fakes.js"
import type { NexusConfig } from "../types.js"
import { runPluginHooks } from "./runtime.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("plugin hook execution", () => {
  it("quotes trusted hook paths as data instead of executable shell syntax", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-hook-"))
    roots.push(root)
    const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
    const hookName = "hook'$(echo hacked).sh"
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(path.join(pluginRoot, hookName), "#!/bin/sh\n", "utf8")
    await writeFile(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "demo", hooks: [`after_tool:${hookName}`] }),
      "utf8",
    )
    let command = ""
    const host = createFakeHost({
      cwd: root,
      async runCommand(value) {
        command = value
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const config = NexusConfigSchema.parse({ plugins: { trusted: ["demo"] } }) as NexusConfig

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
    await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "demo" }), "utf8")
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
    const config = NexusConfigSchema.parse({ plugins: { trusted: ["demo"] } }) as NexusConfig

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
})
