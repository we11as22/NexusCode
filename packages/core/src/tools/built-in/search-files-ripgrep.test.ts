import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createNexusRunServices } from "../../agent/run-services.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { grepTool } from "./search-files.js"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((entry) =>
      rm(entry, { recursive: true, force: true })
    ),
  )
})

describe("host-provided ripgrep runtime", () => {
  it("runs the exact command resolved by the host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-ripgrep-host-"))
    cleanup.push(root)
    const marker = path.join(root, "invoked.txt")
    const fakeRipgrep = path.join(root, "fake-ripgrep.mjs")
    const target = path.join(root, "source.ts")
    await writeFile(target, "export const NEEDLE = true\n", "utf8")
    await writeFile(
      fakeRipgrep,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(marker)}, "host-command")`,
        `console.log(JSON.stringify({ type: "match", data: { path: { text: ${JSON.stringify(target)} }, line_number: 1, lines: { text: "export const NEEDLE = true\\n" } } }))`,
      ].join("\n"),
      "utf8",
    )
    await chmod(fakeRipgrep, 0o755)

    const context: ToolContext = {
      cwd: root,
      host: createFakeHost({
        cwd: root,
        async resolveRipgrepCommand() {
          return {
            command: process.execPath,
            args: [fakeRipgrep],
            source: "test",
          }
        },
      }),
      session: createFakeSession(root),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
    }

    const result = await grepTool.execute(
      {
        path: ".",
        pattern: "NEEDLE",
        output_mode: "content",
      },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("source.ts:1:export const NEEDLE = true")
    expect(await readFile(marker, "utf8")).toBe("host-command")
  })
})
