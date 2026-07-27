import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createNexusRunServices } from "../../agent/run-services.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { globFileSearchTool } from "./glob-file-search.js"
import { listDefinitionsTool } from "./list-definitions.js"
import {
  planVerifyExecutionTool,
  pluginValidateTool,
} from "./orchestration-tools.js"
import { readFileTool } from "./read-file.js"
import { grepTool, listTool } from "./search-files.js"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((entry) =>
      rm(entry, { recursive: true, force: true })
    ),
  )
})

describe("host-owned filesystem boundary", () => {
  it("never lets Read bypass a host denial with direct node:fs access", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-vfs-boundary-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside", "secret.txt")
    await mkdir(workspace)
    await mkdir(path.dirname(outside))
    await writeFile(outside, "HOST_BOUNDARY_SECRET", "utf8")

    const readFile = vi.fn(async () => {
      throw new Error("Path is outside the workspace capability")
    })
    const context: ToolContext = {
      cwd: workspace,
      host: createFakeHost({ cwd: workspace, readFile }),
      session: createFakeSession(workspace),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await readFileTool.execute(
      { file_path: outside },
      context,
    )

    expect(readFile).toHaveBeenCalledWith(outside, {
      maxBytes: 20 * 1024 * 1024,
    })
    expect(result.success).toBe(false)
    expect(result.output).not.toContain("HOST_BOUNDARY_SECRET")
  })

  it.each([
    {
      name: "List",
      run: (outside: string, context: ToolContext) =>
        listTool.execute({ path: outside }, context),
    },
    {
      name: "Glob",
      run: (outside: string, context: ToolContext) =>
        globFileSearchTool.execute(
          { path: outside, pattern: "**/*.ts" },
          context,
        ),
    },
    {
      name: "Grep",
      run: (outside: string, context: ToolContext) =>
        grepTool.execute(
          {
            path: outside,
            pattern: "HOST_BOUNDARY_SYMBOL",
            output_mode: "content",
          },
          context,
        ),
    },
    {
      name: "ListCodeDefinitions",
      run: (outside: string, context: ToolContext) =>
        listDefinitionsTool.execute({ path: outside }, context),
    },
  ])("$name cannot enumerate an absolute path denied by the host", async ({ run }) => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-vfs-enumeration-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside")
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(
      path.join(outside, "secret.ts"),
      "export function HOST_BOUNDARY_SYMBOL() { return true }\n",
      "utf8",
    )

    const context: ToolContext = {
      cwd: workspace,
      host: createFakeHost({
        cwd: workspace,
        async resolvePath() {
          throw new Error("Path is outside the workspace capability")
        },
        async readFile() {
          throw new Error("Path is outside the workspace capability")
        },
      }),
      session: createFakeSession(workspace),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await run(outside, context)

    expect(result.output).not.toContain("HOST_BOUNDARY_SYMBOL")
    expect(result.output).not.toContain("secret.ts")
  })

  it("rejects Glob parent traversal before searching outside the capability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-vfs-glob-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside")
    await mkdir(workspace)
    await mkdir(outside)
    await writeFile(path.join(outside, "secret.ts"), "HOST_BOUNDARY_SECRET\n")

    const resolvePath = vi.fn(async (candidate: string) => {
      const resolved = path.resolve(workspace, candidate)
      const relative = path.relative(workspace, resolved)
      if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error("Path is outside the workspace capability")
      }
      return resolved
    })
    const context: ToolContext = {
      cwd: workspace,
      host: createFakeHost({ cwd: workspace, resolvePath }),
      session: createFakeSession(workspace),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await globFileSearchTool.execute(
      { pattern: "../outside/**/*.ts" },
      context,
    )

    expect(resolvePath).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.output).toContain("cannot contain parent traversal")
    expect(result.output).not.toContain("secret.ts")
    expect(result.output).not.toContain("HOST_BOUNDARY_SECRET")
  })

  it("re-authorizes each Glob match and drops anything the host denies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-vfs-glob-link-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const candidate = path.join(workspace, "candidate.ts")
    await mkdir(workspace)
    await writeFile(candidate, "HOST_BOUNDARY_SECRET\n")

    const resolvePath = vi.fn(async (requested: string) => {
      const resolved = path.resolve(workspace, requested)
      if (resolved === candidate) {
        throw new Error("Host revoked access to this match")
      }
      return resolved
    })
    const context: ToolContext = {
      cwd: workspace,
      host: createFakeHost({ cwd: workspace, resolvePath }),
      session: createFakeSession(workspace),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await globFileSearchTool.execute(
      { pattern: "**/*.ts" },
      context,
    )

    expect(resolvePath).toHaveBeenCalledWith(candidate, "read")
    expect(result.success).toBe(true)
    expect(result.output).toContain("No files matched")
    expect(result.output).not.toContain("candidate.ts")
    expect(result.output).not.toContain("HOST_BOUNDARY_SECRET")
  })

  it.each([
    {
      name: "PluginValidate",
      fileName: "plugin.json",
      content: JSON.stringify({ name: "HOST_BOUNDARY_SECRET" }),
      run: (outside: string, context: ToolContext) =>
        pluginValidateTool.execute({ manifest_path: outside }, context),
    },
    {
      name: "PlanVerifyExecution",
      fileName: "plan.md",
      content: "## HOST_BOUNDARY_SECRET\n",
      run: (outside: string, context: ToolContext) =>
        planVerifyExecutionTool.execute({ file_path: outside }, context),
    },
  ])("$name cannot directly read a path denied by the host", async ({
    fileName,
    content,
    run,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-vfs-orchestration-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const outside = path.join(root, "outside", fileName)
    await mkdir(workspace)
    await mkdir(path.dirname(outside))
    await writeFile(outside, content)

    const resolvePath = vi.fn(async () => {
      throw new Error("Path is outside the workspace capability")
    })
    const readFile = vi.fn(async () => {
      throw new Error("Path is outside the workspace capability")
    })
    const context: ToolContext = {
      cwd: workspace,
      host: createFakeHost({ cwd: workspace, resolvePath, readFile }),
      session: createFakeSession(workspace),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await run(outside, context)

    expect(resolvePath).toHaveBeenCalledWith(outside, "read")
    expect(readFile).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.output).not.toContain("HOST_BOUNDARY_SECRET")
  })
})
