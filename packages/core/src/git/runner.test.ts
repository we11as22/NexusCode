import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  GitCommandExecutionError,
  GitCommandRunner,
  createSanitizedGitEnvironment,
} from "./runner.js"

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-git-runner-"))
  temporaryDirectories.push(directory)
  return directory
}

async function makeExecutable(
  directory: string,
  source: string,
): Promise<string> {
  const executable = path.join(directory, "fake-git")
  await fs.writeFile(executable, `#!/bin/sh\n${source}\n`, {
    encoding: "utf8",
    mode: 0o700,
  })
  return executable
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("createSanitizedGitEnvironment", () => {
  it("removes inherited repository routing and disables interactive side effects", () => {
    const environment = createSanitizedGitEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/safe/home",
      CUSTOM_VALUE: "preserved",
      GIT_DIR: "/attacker/repository",
      GIT_WORK_TREE: "/attacker/worktree",
      GIT_INDEX_FILE: "/attacker/index",
      GIT_OBJECT_DIRECTORY: "/attacker/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/attacker/alternates",
      GIT_CEILING_DIRECTORIES: "/attacker/ceiling",
      GIT_TEMPLATE_DIR: "/attacker/templates",
      GIT_CONFIG_GLOBAL: "/attacker/config",
      GIT_CONFIG_SYSTEM: "/attacker/system-config",
      GIT_PAGER: "dangerous-pager",
      GIT_ASKPASS: "dangerous-askpass",
      SSH_ASKPASS: "dangerous-ssh-askpass",
    })

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/safe/home",
      CUSTOM_VALUE: "preserved",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
    })
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CEILING_DIRECTORIES",
      "GIT_TEMPLATE_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
    ]) {
      expect(environment).not.toHaveProperty(key)
    }
  })
})

describe("GitCommandRunner", () => {
  it("passes arguments literally without shell interpretation", async () => {
    const directory = await makeTemporaryDirectory()
    const executable = await makeExecutable(
      directory,
      'printf "%s\\n" "$@"',
    )
    const runner = new GitCommandRunner(directory, { executable })
    const marker = path.join(directory, "shell-created")
    const hostileArgument = `literal; touch ${marker}`

    const result = await runner.run(["show", hostileArgument])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString("utf8")).toContain(hostileArgument)
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("terminates a command which exceeds its deadline", async () => {
    const directory = await makeTemporaryDirectory()
    const executable = await makeExecutable(directory, "sleep 5")
    const runner = new GitCommandRunner(directory, {
      executable,
      defaultLimits: {
        timeoutMs: 25,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      },
    })

    const startedAt = Date.now()
    await expect(runner.run(["status"])).rejects.toMatchObject({
      name: "GitCommandExecutionError",
      kind: "timeout",
    } satisfies Partial<GitCommandExecutionError>)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it("terminates and reports a typed error when stdout exceeds its cap", async () => {
    const directory = await makeTemporaryDirectory()
    const executable = await makeExecutable(
      directory,
      "yes 0123456789",
    )
    const runner = new GitCommandRunner(directory, {
      executable,
      defaultLimits: {
        timeoutMs: 2_000,
        maxStdoutBytes: 128,
        maxStderrBytes: 64,
      },
    })

    await expect(runner.run(["diff"])).rejects.toMatchObject({
      name: "GitCommandExecutionError",
      kind: "output_limit",
      result: {
        truncated: true,
      },
    })
  })

  it("returns non-zero Git exit codes instead of hiding them as empty output", async () => {
    const directory = await makeTemporaryDirectory()
    const executable = await makeExecutable(
      directory,
      'printf "missing revision" >&2\nexit 17',
    )
    const runner = new GitCommandRunner(directory, { executable })

    const result = await runner.run(["show", "missing"])

    expect(result.exitCode).toBe(17)
    expect(result.stderr.toString("utf8")).toBe("missing revision")
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
  })
})
