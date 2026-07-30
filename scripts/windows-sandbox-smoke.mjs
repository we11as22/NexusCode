import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

if (process.platform !== "win32") {
  throw new Error("windows-sandbox-smoke.mjs must run on Windows")
}

const helper = path.resolve(
  process.env.NEXUS_SANDBOX_HELPER ??
    path.join(
      "packages",
      "sandbox",
      "vendor",
      `win32-${process.arch}`,
      "nexus-sandbox.exe",
    ),
)
if (!fs.existsSync(helper) || !fs.statSync(helper).isFile()) {
  throw new Error(`Windows sandbox helper not found: ${helper}`)
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-win-smoke-"))
const sandboxTemp = fs.mkdtempSync(path.join(workspace, ".sandbox-temp-"))
const protectedGit = path.join(workspace, ".git")
const deniedSecret = path.join(workspace, "denied-secret")
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-win-outside-"))
const outsideFile = path.join(outsideRoot, "must-not-write.txt")
const escapedChildFile = path.join(workspace, "child-escaped.txt")
const serverPortFile = path.join(workspace, "loopback-port.txt")
fs.mkdirSync(protectedGit)
fs.mkdirSync(deniedSecret)
fs.writeFileSync(path.join(deniedSecret, "value.txt"), "must-not-read\n")

const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"
const programFilesX86 =
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
const programData = process.env.ProgramData ?? "C:\\ProgramData"
const comSpec =
  process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe")
const powershell = path.join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

function request(
  argv,
  {
    network = "restricted",
    workspaceWritable = true,
    deniedRoots = [],
    timeoutMillis = 15_000,
  } = {},
) {
  return {
    version: 1,
    executionId: randomUUID(),
    argv,
    cwd: workspace,
    readableRoots: [
      workspace,
      sandboxTemp,
      path.dirname(helper),
      path.dirname(process.execPath),
      systemRoot,
      programFiles,
      programFilesX86,
      programData,
    ],
    writableRoots: workspaceWritable
      ? [workspace, sandboxTemp]
      : [sandboxTemp],
    readOnlyRoots: [
      protectedGit,
      path.join(workspace, ".nexus"),
      path.join(workspace, ".agents"),
      path.join(workspace, ".codex"),
    ],
    deniedRoots,
    network,
    timeoutMillis,
    inheritEnv: false,
    environment: {
      SystemRoot: systemRoot,
      ComSpec: comSpec,
      PATH: process.env.PATH ?? path.dirname(comSpec),
      PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      TEMP: sandboxTemp,
      TMP: sandboxTemp,
      NEXUS_SANDBOX: "1",
      NEXUS_SANDBOX_NETWORK_DISABLED:
        network === "restricted" ? "1" : "0",
    },
    allowUnixSockets: [],
  }
}

function runSandbox(payload) {
  const result = spawnSync(helper, [], {
    cwd: workspace,
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: 30_000,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    control: result.output?.[3]?.toString() ?? "",
  }
}

function waitForFile(file, timeoutMillis) {
  const deadline = Date.now() + timeoutMillis
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${file}`)
    }
    Atomics.wait(waitBuffer, 0, 0, 20)
  }
}

const loopbackServer = spawn(
  process.execPath,
  [
    "-e",
    [
      "const fs=require('fs');",
      "const http=require('http');",
      "const server=http.createServer((_req,res)=>res.end('ok'));",
      `server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(serverPortFile)},String(server.address().port)));`,
    ].join(""),
  ],
  {
    windowsHide: true,
    stdio: "ignore",
  },
)

try {
  waitForFile(serverPortFile, 5_000)
  const loopbackPort = Number(fs.readFileSync(serverPortFile, "utf8"))
  if (!Number.isInteger(loopbackPort) || loopbackPort <= 0) {
    throw new Error(`invalid loopback test port: ${loopbackPort}`)
  }

  const write = runSandbox(
    request([
      comSpec,
      "/d",
      "/s",
      "/c",
      "echo sandbox-ok> allowed.txt",
    ]),
  )
  if (write.status !== 0) {
    throw new Error(`workspace write failed: ${JSON.stringify(write)}`)
  }
  if (
    fs.readFileSync(path.join(workspace, "allowed.txt"), "utf8").trim() !==
    "sandbox-ok"
  ) {
    throw new Error("workspace write produced unexpected content")
  }

  const outsideWrite = runSandbox(
    request([
      comSpec,
      "/d",
      "/s",
      "/c",
      `echo must-not-write> "${outsideFile}"`,
    ]),
  )
  if (outsideWrite.status === 0 || fs.existsSync(outsideFile)) {
    throw new Error(
      `outside write escaped the sandbox: ${JSON.stringify(outsideWrite)}`,
    )
  }

  const protectedWrite = runSandbox(
    request([
      comSpec,
      "/d",
      "/s",
      "/c",
      "echo must-not-write> .git\\blocked.txt",
    ]),
  )
  if (
    protectedWrite.status === 0 ||
    fs.existsSync(path.join(protectedGit, "blocked.txt"))
  ) {
    throw new Error(
      `protected metadata write escaped the sandbox: ${JSON.stringify(protectedWrite)}`,
    )
  }

  const readOnlyAfterWrite = runSandbox(
    request(
      [
        comSpec,
        "/d",
        "/s",
        "/c",
        "echo must-not-overwrite> allowed.txt",
      ],
      { workspaceWritable: false },
    ),
  )
  if (
    readOnlyAfterWrite.status === 0 ||
    fs.readFileSync(path.join(workspace, "allowed.txt"), "utf8").trim() !==
      "sandbox-ok"
  ) {
    throw new Error(
      `historical write authority escaped into read-only mode: ${JSON.stringify(readOnlyAfterWrite)}`,
    )
  }

  const deniedRead = runSandbox(
    request(
      [
        comSpec,
        "/d",
        "/s",
        "/c",
        "type denied-secret\\value.txt",
      ],
      { deniedRoots: [deniedSecret] },
    ),
  )
  if (deniedRead.status === 0 || deniedRead.stdout.includes("must-not-read")) {
    throw new Error(
      `explicit deny-read root escaped the sandbox: ${JSON.stringify(deniedRead)}`,
    )
  }

  const onlineNetwork = runSandbox(
    request([
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:${loopbackPort} | Out-Null`,
    ], { network: "enabled" }),
  )
  if (onlineNetwork.status !== 0) {
    throw new Error(
      `online sandbox could not reach approved loopback service: ${JSON.stringify(onlineNetwork)}`,
    )
  }

  const offlineNetwork = runSandbox(
    request([
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:${loopbackPort} | Out-Null`,
    ]),
  )
  if (offlineNetwork.status === 0) {
    throw new Error("offline sandbox unexpectedly reached loopback")
  }

  const childTree = runSandbox(
    request(
      [
        process.execPath,
        "-e",
        [
          "const {spawn}=require('child_process');",
          "spawn(process.execPath,['-e',",
          JSON.stringify(
            `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(escapedChildFile)},'escaped'),3000)`,
          ),
          "],{stdio:'ignore'});",
          "setTimeout(()=>{},20000);",
        ].join(""),
      ],
      { timeoutMillis: 500 },
    ),
  )
  if (childTree.status === 0) {
    throw new Error("timeout test unexpectedly completed successfully")
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_000)
  if (fs.existsSync(escapedChildFile)) {
    throw new Error("grandchild survived kill-on-close Job Object")
  }

  process.stdout.write(
    "Windows sandbox smoke passed: write/outside deny, write→read-only, metadata/deny-read, offline/online network, process-tree kill\n",
  )
} finally {
  loopbackServer.kill()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(outsideRoot, { recursive: true, force: true })
}
