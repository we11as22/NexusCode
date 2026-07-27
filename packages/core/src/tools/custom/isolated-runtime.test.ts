import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

function runModuleEval(source: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

describe("IsolatedToolModule host isolation", () => {
  it("does not inherit module-mode exec flags from the host process", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "nexus-custom-tool-worker-flags-"),
    )
    try {
      const runtimeBundle = path.join(root, "isolated-runtime.mjs")
      const toolModule = path.join(root, "tool.mjs")
      await build({
        entryPoints: [
          path.resolve(
            process.cwd(),
            "src/tools/custom/isolated-runtime.ts",
          ),
        ],
        outfile: runtimeBundle,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
      })
      await writeFile(
        toolModule,
        [
          "export default {",
          '  name: "WorkerFlagsTool",',
          '  description: "worker flag isolation",',
          '  inputSchema: { type: "object" },',
          "  async execute() {",
          '    return { success: true, output: "module-flags-ok" };',
          "  },",
          "};",
        ].join("\n"),
      )

      const script = [
        `const { IsolatedToolModule } = await import(${JSON.stringify(pathToFileURL(runtimeBundle).href)});`,
        `const loaded = await IsolatedToolModule.load(${JSON.stringify(toolModule)}, {`,
        '  generation: "flags-test",',
        "  loadTimeoutMs: 5000,",
        "  callTimeoutMs: 5000,",
        "});",
        "try {",
        "  const controller = new AbortController();",
        '  const result = await loaded.runtime.call("default:0", {}, {',
        `    cwd: ${JSON.stringify(root)},`,
        '    mode: "agent",',
        "    signal: controller.signal,",
        "  });",
        "  process.stdout.write(result.output);",
        "} finally {",
        "  await loaded.runtime.close();",
        "}",
      ].join("\n")
      const result = await runModuleEval(script)

      expect(
        {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        result.stderr,
      ).toEqual({
        code: 0,
        stdout: "module-flags-ok",
        stderr: "",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
