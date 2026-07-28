import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

test("one-command setup preserves installed dependencies and uses incremental pnpm commands", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "nexus-one-install-"))
  const scriptsDir = path.join(fixture, "scripts")
  const fakeBin = path.join(fixture, "bin")
  const sentinel = path.join(fixture, "node_modules", "keep.txt")
  const commandLog = path.join(fixture, "corepack.log")

  try {
    await mkdir(scriptsDir, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await mkdir(path.dirname(sentinel), { recursive: true })
    await cp(new URL("./one-install.js", import.meta.url), path.join(scriptsDir, "one-install.js"))
    await cp(new URL("./check-node.js", import.meta.url), path.join(scriptsDir, "check-node.js"))
    await cp(new URL("./runtime-version.mjs", import.meta.url), path.join(scriptsDir, "runtime-version.mjs"))
    await writeFile(sentinel, "preserve me")
    await writeFile(
      path.join(fakeBin, "corepack"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${commandLog}"\n`,
    )
    await chmod(path.join(fakeBin, "corepack"), 0o755)

    await execFileAsync(process.execPath, [path.join(scriptsDir, "one-install.js")], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    })

    assert.equal(await readFile(sentinel, "utf8"), "preserve me")
    assert.equal(
      await readFile(commandLog, "utf8"),
      "pnpm install\npnpm build\n",
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
