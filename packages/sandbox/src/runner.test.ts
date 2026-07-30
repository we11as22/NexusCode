import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runSandboxed, startSandboxed } from "./runner.js"
import type { NativeSandboxRequest } from "./types.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function request(): NativeSandboxRequest {
  const cwd = os.tmpdir()
  return {
    version: 1,
    executionId: "runner-test",
    argv: ["/bin/sh", "-c", "echo ignored"],
    cwd,
    readableRoots: [path.parse(cwd).root],
    writableRoots: [],
    readOnlyRoots: [],
    deniedRoots: [],
    network: "restricted",
    timeoutMillis: 1_000,
    inheritEnv: true,
    environment: {},
    allowUnixSockets: [],
  }
}

function helper(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-runner-"))
  roots.push(root)
  const file = path.join(root, "helper")
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\ncat >/dev/null\n${body}\n`, {
    mode: 0o700,
  })
  return file
}

describe.skipIf(process.platform === "win32")("runSandboxed", () => {
  it("uses the helper control channel and keeps command streams separate", async () => {
    const binaryPath = helper(`
printf '%s\\n' '{"version":1,"type":"started","executionId":"runner-test","sandbox":"seatbelt"}' >&3
printf 'hello-out'
printf 'hello-err' >&2
printf '%s\\n' '{"version":1,"type":"exited","executionId":"runner-test","sandbox":"seatbelt","exitCode":0}' >&3
exit 0
`)
    const result = await runSandboxed(request(), { binaryPath })
    expect(result).toMatchObject({
      stdout: "hello-out",
      stderr: "hello-err",
      exitCode: 0,
      sandbox: "seatbelt",
      timedOut: false,
      denied: false,
    })
  })

  it("does not expose loader injection variables to the trusted helper", async () => {
    const binaryPath = helper(`
if env | grep -E '^(LD_|DYLD_)' >/dev/null; then
  printf 'loader environment leaked' >&2
  exit 125
fi
printf '%s\\n' '{"version":1,"type":"started","executionId":"runner-test","sandbox":"seatbelt"}' >&3
printf '%s\\n' '{"version":1,"type":"exited","executionId":"runner-test","sandbox":"seatbelt","exitCode":0}' >&3
exit 0
`)
    const previous = {
      LD_PRELOAD: process.env.LD_PRELOAD,
      DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES,
    }
    process.env.LD_PRELOAD = "/tmp/untrusted-linux-loader.so"
    process.env.DYLD_INSERT_LIBRARIES = "/tmp/untrusted-macos-loader.dylib"
    try {
      const result = await runSandboxed(request(), { binaryPath })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
    } finally {
      if (previous.LD_PRELOAD === undefined) delete process.env.LD_PRELOAD
      else process.env.LD_PRELOAD = previous.LD_PRELOAD
      if (previous.DYLD_INSERT_LIBRARIES === undefined) {
        delete process.env.DYLD_INSERT_LIBRARIES
      } else {
        process.env.DYLD_INSERT_LIBRARIES = previous.DYLD_INSERT_LIBRARIES
      }
    }
  })

  it("fails closed on a helper setup error", async () => {
    const binaryPath = helper(`
printf '%s\\n' '{"version":1,"type":"error","executionId":"runner-test","errorCode":"sandbox_setup_failed","message":"no sandbox"}' >&3
exit 125
`)
    const result = await runSandboxed(request(), { binaryPath })
    expect(result.exitCode).toBe(125)
    expect(result.setupError).toEqual({
      code: "sandbox_setup_failed",
      message: "no sandbox",
    })
    expect(result.sandbox).toBe("none")
  })

  it("classifies a sandbox denial without treating ordinary failures as setup errors", async () => {
    const binaryPath = helper(`
printf '%s\\n' '{"version":1,"type":"started","executionId":"runner-test","sandbox":"seatbelt"}' >&3
printf 'Operation not permitted' >&2
printf '%s\\n' '{"version":1,"type":"exited","executionId":"runner-test","sandbox":"seatbelt","exitCode":1}' >&3
exit 1
`)
    const result = await runSandboxed(request(), { binaryPath })
    expect(result.denied).toBe(true)
    expect(result.setupError).toBeUndefined()
  })

  it("rejects mismatched control-channel execution identity", async () => {
    const binaryPath = helper(`
printf '%s\\n' '{"version":1,"type":"started","executionId":"other","sandbox":"seatbelt"}' >&3
exit 0
`)
    const result = await runSandboxed(request(), { binaryPath })
    expect(result.setupError?.code).toBe("invalid_control_message")
    expect(result.exitCode).not.toBe(0)
  })

  it("returns a stoppable handle for background execution", async () => {
    const binaryPath = helper(`
printf '%s\\n' '{"version":1,"type":"started","executionId":"runner-test","sandbox":"seatbelt"}' >&3
trap 'exit 130' TERM INT
while :; do sleep 1; done
    `)
    const handle = startSandboxed(request(), { binaryPath })
    expect(handle.pid).toBeGreaterThan(0)
    await expect(handle.ready).resolves.toBe("seatbelt")
    expect(handle.stop()).toBe(true)
    const result = await handle.result
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox).toBe("seatbelt")
  })
})
