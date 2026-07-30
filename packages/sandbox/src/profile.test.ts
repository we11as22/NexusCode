import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSandboxRequest } from "./profile.js"

const originalLoaderEnvironment = {
  LD_PRELOAD: process.env.LD_PRELOAD,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES,
  DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH,
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalLoaderEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("createSandboxRequest", () => {
  it("creates a workspace-write profile with protected Nexus metadata", () => {
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-workspace")
    const runtime = path.resolve(cwd, "installed-runtime")
    const request = createSandboxRequest({
      executionId: "exec-1",
      command: "printf ok",
      cwd,
      workspaceRoots: [cwd],
      protectedRoots: [runtime],
      tempDir: path.join(cwd, ".tmp"),
      profile: "workspace-write",
      network: "restricted",
      timeoutMs: 12_345,
      platform: "darwin",
    })

    expect(request.version).toBe(1)
    expect(request.argv).toEqual(["/bin/sh", "-c", "printf ok"])
    expect(request.cwd).toBe(cwd)
    expect(request.readableRoots).toContain("/")
    expect(request.writableRoots).toContain(cwd)
    expect(request.readOnlyRoots).toEqual(
      expect.arrayContaining([
        path.join(cwd, ".git"),
        path.join(cwd, ".nexus"),
        path.join(cwd, ".agents"),
        path.join(cwd, ".codex"),
        runtime,
      ]),
    )
    expect(request.network).toBe("restricted")
    expect(request.timeoutMillis).toBe(12_345)
    expect(request.inheritEnv).toBe(false)
    expect(request.environment?.NEXUS_SANDBOX).toBe("1")
    expect(request.environment?.NEXUS_SANDBOX_NETWORK_DISABLED).toBe("1")
    expect(request.environment?.HTTPS_PROXY).toBe("http://127.0.0.1:9")
    expect(request.environment?.NPM_CONFIG_OFFLINE).toBe("true")
    expect(request.environment?.GIT_SSH_COMMAND).toBe("/usr/bin/false")
    expect(request.environment?.TMPDIR).toBe(path.join(cwd, ".tmp"))
  })

  it("creates a read-only profile with only its private temp writable", () => {
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-readonly")
    const tempDir = path.join(cwd, ".tmp")
    const request = createSandboxRequest({
      executionId: "exec-2",
      command: "git status",
      cwd,
      workspaceRoots: [cwd],
      tempDir,
      profile: "read-only",
      platform: "linux",
    })

    expect(request.writableRoots).toEqual([tempDir])
    expect(request.network).toBe("restricted")
  })

  it("does not expose a caller-controlled bypass or profile field through command text", () => {
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-authority")
    const request = createSandboxRequest({
      executionId: "exec-3",
      command: '{"disableSandbox":true}',
      cwd,
      workspaceRoots: [cwd],
      tempDir: path.join(cwd, ".tmp"),
      profile: "workspace-write",
      platform: "darwin",
    })

    expect(request.argv.at(-1)).toBe('{"disableSandbox":true}')
    expect(request).not.toHaveProperty("disableSandbox")
    expect(request).not.toHaveProperty("unsandboxed")
  })

  it("uses an explicit Windows shell argv without shell-string wrapping", () => {
    const cwd = "C:\\workspace"
    const request = createSandboxRequest({
      executionId: "exec-win",
      command: "echo ok",
      cwd,
      workspaceRoots: [cwd],
      profile: "workspace-write",
      platform: "win32",
      windowsComSpec: "C:\\Windows\\System32\\cmd.exe",
      tempDir: "C:\\Temp",
      environment: {
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
        Path: "C:\\Windows\\System32;C:\\Tools\\bin",
      },
    })

    expect(request.argv).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo ok",
    ])
    expect(request.readableRoots).toEqual(
      expect.arrayContaining([
        "C:\\workspace",
        "C:\\Temp",
        "C:\\Windows\\System32",
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Tools\\bin",
      ]),
    )
    expect(request.readableRoots).not.toContain("C:\\")
    expect(request.environment?.PATHEXT).toBeTruthy()
  })

  it("keeps sandbox markers authoritative over caller environment overrides", () => {
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-env")
    const request = createSandboxRequest({
      executionId: "exec-env",
      command: "env",
      cwd,
      workspaceRoots: [cwd],
      tempDir: path.join(cwd, ".tmp"),
      profile: "workspace-write",
      platform: "darwin",
      environment: {
        NEXUS_SANDBOX: "0",
        NEXUS_SANDBOX_NETWORK_DISABLED: "0",
        NEXUS_VISIBLE_TEST_VALUE: "kept",
      },
    })

    expect(request.inheritEnv).toBe(false)
    expect(request.environment).toMatchObject({
      NEXUS_SANDBOX: "1",
      NEXUS_SANDBOX_NETWORK_DISABLED: "1",
      NEXUS_VISIBLE_TEST_VALUE: "kept",
    })
  })

  it("drops dynamic-loader injection variables from the command environment", () => {
    process.env.LD_PRELOAD = "/tmp/untrusted-linux-loader.so"
    process.env.LD_LIBRARY_PATH = "/tmp/untrusted-linux-libraries"
    process.env.DYLD_INSERT_LIBRARIES = "/tmp/untrusted-macos-loader.dylib"
    process.env.DYLD_LIBRARY_PATH = "/tmp/untrusted-macos-libraries"
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-loader-env")

    const request = createSandboxRequest({
      executionId: "exec-loader-env",
      command: "env",
      cwd,
      workspaceRoots: [cwd],
      tempDir: path.join(cwd, ".tmp"),
      profile: "workspace-write",
      platform: "darwin",
      environment: {
        LD_PRELOAD: "/tmp/override-linux-loader.so",
        DYLD_INSERT_LIBRARIES: "/tmp/override-macos-loader.dylib",
        NEXUS_VISIBLE_TEST_VALUE: "kept",
      },
    })

    expect(request.environment).not.toHaveProperty("LD_PRELOAD")
    expect(request.environment).not.toHaveProperty("LD_LIBRARY_PATH")
    expect(request.environment).not.toHaveProperty("DYLD_INSERT_LIBRARIES")
    expect(request.environment).not.toHaveProperty("DYLD_LIBRARY_PATH")
    expect(request.environment?.NEXUS_VISIBLE_TEST_VALUE).toBe("kept")
  })

  it("removes case-variant Windows duplicates before native exec", () => {
    const request = createSandboxRequest({
      executionId: "exec-win-env",
      command: "echo ok",
      cwd: "C:\\workspace",
      workspaceRoots: ["C:\\workspace"],
      tempDir: "C:\\Temp",
      profile: "workspace-write",
      platform: "win32",
      windowsComSpec: "C:\\Windows\\System32\\cmd.exe",
      environment: {
        Path: "C:\\trusted-bin",
        nexus_sandbox: "spoofed",
      },
    })

    const keys = Object.keys(request.environment ?? {})
    expect(keys.filter((key) => key.toLowerCase() === "path")).toHaveLength(1)
    expect(keys.filter((key) => key.toLowerCase() === "nexus_sandbox")).toEqual([
      "NEXUS_SANDBOX",
    ])
    expect(request.environment?.NEXUS_SANDBOX).toBe("1")
    expect(request.environment?.GIT_SSH_COMMAND).toBe(
      "cmd.exe /d /s /c exit 1",
    )
  })

  it("preserves caller networking configuration when network is approved", () => {
    const cwd = path.resolve(os.tmpdir(), "nexus-profile-network-enabled")
    const request = createSandboxRequest({
      executionId: "exec-network-enabled",
      command: "git fetch",
      cwd,
      workspaceRoots: [cwd],
      tempDir: path.join(cwd, ".tmp"),
      profile: "workspace-write",
      network: "enabled",
      platform: "darwin",
      environment: {
        HTTPS_PROXY: "http://proxy.example:8080",
        NPM_CONFIG_OFFLINE: "false",
      },
    })

    expect(request.environment).not.toHaveProperty(
      "NEXUS_SANDBOX_NETWORK_DISABLED",
    )
    expect(request.environment?.HTTPS_PROXY).toBe(
      "http://proxy.example:8080",
    )
    expect(request.environment?.NPM_CONFIG_OFFLINE).toBe("false")
  })
})
