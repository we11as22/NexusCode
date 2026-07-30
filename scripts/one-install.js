#!/usr/bin/env node
/**
 * One-command local installation for contributors and demos.
 *
 * It installs dependencies incrementally, builds the shared core once, builds
 * and installs the CLI, packages the VSIX with the current platform sandbox
 * helper, installs it into VS Code/Cursor when their CLI is available, and
 * finishes with `nexus doctor`.
 */
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync, spawnSync } = require("child_process")

const root = path.resolve(__dirname, "..")
const dryRun = process.env.NEXUS_ONE_INSTALL_DRY_RUN === "1"
process.chdir(root)

function requiredNodeVersion() {
  const versionFile = path.join(root, ".nvmrc")
  return fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim().replace(/^v/u, "")
    : "24.18.0"
}

function nodeVersion(candidate) {
  if (!candidate) return null
  const probe = spawnSync(candidate, ["-p", "process.versions.node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  })
  return probe.status === 0 ? probe.stdout.trim() : null
}

function findPinnedNode(required) {
  const executable = process.platform === "win32" ? "node.exe" : "node"
  const candidates = [
    process.env.NEXUS_NODE,
    process.execPath,
    process.env.NVM_DIR
      ? path.join(
          process.env.NVM_DIR,
          "versions",
          "node",
          `v${required}`,
          "bin",
          executable,
        )
      : null,
    path.join(
      os.homedir(),
      ".nvm",
      "versions",
      "node",
      `v${required}`,
      "bin",
      executable,
    ),
    path.join(os.homedir(), ".volta", "bin", executable),
    "node",
    "nodejs",
  ]
  return candidates.find((candidate) => nodeVersion(candidate) === required)
}

const requiredNode = requiredNodeVersion()
if (process.versions.node !== requiredNode) {
  const pinnedNode = findPinnedNode(requiredNode)
  if (!pinnedNode) {
    console.error(
      `NexusCode requires Node.js ${requiredNode}; current runtime is ${process.versions.node}.`,
    )
    console.error(
      `Install it once (for nvm: source "$HOME/.nvm/nvm.sh" && nvm install ${requiredNode}) and rerun this same command.`,
    )
    process.exit(1)
  }
  if (process.env.NEXUS_ONE_INSTALL_REEXEC === "1") {
    throw new Error(
      `Failed to switch installer runtime to Node.js ${requiredNode}`,
    )
  }
  const resolvedNode = path.isAbsolute(pinnedNode)
    ? path.resolve(pinnedNode)
    : pinnedNode
  const selectedNodePath = path.isAbsolute(resolvedNode)
    ? `${path.dirname(resolvedNode)}${path.delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH ?? ""
  console.log(
    `[bootstrap] Switching Node.js ${process.versions.node} → ${requiredNode}`,
  )
  const child = spawnSync(resolvedNode, [__filename, ...process.argv.slice(2)], {
    cwd: root,
    env: {
      ...process.env,
      NEXUS_ONE_INSTALL_REEXEC: "1",
      PATH: selectedNodePath,
    },
    stdio: "inherit",
    windowsHide: true,
  })
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}

// `corepack` must resolve next to the exact Node runtime selected above, not
// from an older nvm installation earlier in the caller's PATH.
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`

function run(program, args, options = {}) {
  process.stdout.write(`> ${program} ${args.join(" ")}\n`)
  if (dryRun) return ""
  return execFileSync(program, args, {
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    cwd: options.cwd ?? root,
    encoding: options.capture ? "utf8" : undefined,
    env: process.env,
    shell:
      process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(program),
  })
}

function executableWorks(candidate) {
  if (!candidate) return false
  const probe = spawnSync(candidate, ["--version"], {
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
    shell:
      process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(candidate),
  })
  return probe.status === 0
}

function resolveExecutable(candidate) {
  if (!candidate) return null
  if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
    return candidate
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""]
  for (const directory of pathEntries()) {
    for (const extension of extensions) {
      const resolved = path.join(directory, `${candidate}${extension}`)
      try {
        fs.accessSync(resolved, fs.constants.X_OK)
        if (fs.statSync(resolved).isFile()) return resolved
      } catch {
        // Keep looking through PATH.
      }
    }
  }
  return candidate
}

function findEditorClis() {
  const candidates = [
    process.env.NEXUS_VSCODE_CLI,
    "code",
    "code-insiders",
    "cursor",
  ]
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      path.join(
        os.homedir(),
        "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ),
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    )
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
    if (local) {
      candidates.push(
        path.join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
        path.join(local, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      )
    }
  }
  const unique = new Map()
  for (const candidate of candidates) {
    if (!executableWorks(candidate)) continue
    const resolved = resolveExecutable(candidate)
    let identity = resolved
    try {
      identity = fs.realpathSync(resolved)
    } catch {
      // PATH-only executable names are still valid and are de-duplicated by name.
    }
    if (!unique.has(identity)) unique.set(identity, resolved)
  }
  return [...unique.values()]
}

function pathEntries() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
}

function isWritableDirectory(directory) {
  try {
    fs.accessSync(directory, fs.constants.W_OK)
    return fs.statSync(directory).isDirectory()
  } catch {
    return false
  }
}

function chooseBinDir() {
  if (process.env.NEXUS_BIN_DIR) {
    return path.resolve(process.env.NEXUS_BIN_DIR)
  }
  const entries = pathEntries()
  const preferred =
    process.platform === "win32"
      ? [
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")
            : null,
          process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
          path.join(os.homedir(), "bin"),
        ].filter(Boolean)
      : [
          path.join(os.homedir(), "bin"),
          path.join(os.homedir(), ".local", "bin"),
          "/usr/local/bin",
          "/opt/homebrew/bin",
        ]
  const onPath = preferred.find(
    (candidate) =>
      entries.includes(path.resolve(candidate)) &&
      isWritableDirectory(candidate),
  )
  return onPath ?? path.join(os.homedir(), "bin")
}

function installRuntime() {
  const packageJson = require(path.join(root, "packages", "cli", "package.json"))
  const installRoot =
    process.env.NEXUS_INSTALL_DIR ||
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
          "NexusCode",
        )
      : path.join(os.homedir(), ".local", "share", "nexuscode"))
  const runtime = path.join(installRoot, `runtime-${packageJson.version}`)
  const staging = `${runtime}.staging-${process.pid}`
  const backup = `${runtime}.backup-${process.pid}`
  fs.mkdirSync(installRoot, { recursive: true })
  fs.rmSync(staging, { recursive: true, force: true })
  run("corepack", [
    "pnpm",
    "--offline",
    "--filter",
    "@nexuscode/cli",
    "deploy",
    "--prod",
    "--legacy",
    staging,
  ])

  const entry = path.join(staging, "dist", "index.js")
  const target = `${process.platform}-${process.arch}`
  const helperName =
    process.platform === "win32" ? "nexus-sandbox.exe" : "nexus-sandbox"
  const helper = path.join(staging, "vendor", target, helperName)
  if (!fs.statSync(entry).isFile() || !fs.statSync(helper).isFile()) {
    throw new Error(
      `Deployed CLI runtime is incomplete: ${staging}`,
    )
  }

  let movedExisting = false
  try {
    fs.rmSync(backup, { recursive: true, force: true })
    if (fs.existsSync(runtime)) {
      fs.renameSync(runtime, backup)
      movedExisting = true
    }
    fs.renameSync(staging, runtime)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(runtime) && movedExisting && fs.existsSync(backup)) {
      fs.renameSync(backup, runtime)
    }
    throw error
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return {
    root: runtime,
    cliEntry: path.join(runtime, "dist", "index.js"),
  }
}

function installCliWrapper(cliEntry) {
  const binDir = chooseBinDir()
  fs.mkdirSync(binDir, { recursive: true })
  if (!fs.statSync(cliEntry).isFile()) {
    throw new Error(`Installed CLI runtime is missing: ${cliEntry}`)
  }

  if (process.platform === "win32") {
    const wrapper = path.join(binDir, "nexus.cmd")
    fs.writeFileSync(
      wrapper,
      `@echo off\r\n"${process.execPath}" "${cliEntry}" %*\r\n`,
      "utf8",
    )
    return wrapper
  }

  const wrapper = path.join(binDir, "nexus")
  const temporary = `${wrapper}.tmp-${process.pid}`
  fs.writeFileSync(
    temporary,
    `#!/usr/bin/env sh\nexec "${process.execPath}" "${cliEntry}" "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  )
  fs.renameSync(temporary, wrapper)
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

execFileSync(process.execPath, [path.join(root, "scripts", "check-node.js")], {
  stdio: "inherit",
  cwd: root,
})

console.log("[1/7] Installing dependencies incrementally...")
run("corepack", ["pnpm", "install"])
console.log("[2/7] Building shared core...")
run("corepack", ["pnpm", "build:core"])
console.log("[3/7] Building CLI with the native sandbox...")
run("corepack", ["pnpm", "build:cli"])
console.log("[4/7] Building and packaging the VS Code extension...")
run("corepack", ["pnpm", "--filter", "nexuscode", "build"])
run("corepack", ["pnpm", "--filter", "nexuscode", "package"])

if (dryRun) {
  console.log("Dry run complete.")
  process.exit(0)
}

console.log("[5/7] Installing an isolated CLI runtime...")
const runtime = installRuntime()
console.log("[6/7] Installing local launchers and editor extension...")
const wrapper = installCliWrapper(runtime.cliEntry)
const vscodePackage = require(path.join(root, "packages", "vscode", "package.json"))
const vsix = path.join(
  root,
  "packages",
  "vscode",
  `nexuscode-${vscodePackage.version}.vsix`,
)
if (!fs.statSync(vsix).isFile()) {
  throw new Error(`VSIX build is missing: ${vsix}`)
}
if (process.env.NEXUS_VSCODE_INSTALL !== "0") {
  const editorClis = findEditorClis()
  if (editorClis.length > 0) {
    for (const editorCli of editorClis) {
      console.log(`Installing extension through: ${editorCli}`)
      run(editorCli, ["--install-extension", vsix, "--force"])
      const installed = run(
        editorCli,
        ["--list-extensions", "--show-versions"],
        { capture: true },
      )
      const expected = `nexuscode.nexuscode@${vscodePackage.version}`
      if (
        !installed
          .split(/\r?\n/u)
          .some((entry) => entry.trim().toLowerCase() === expected)
      ) {
        throw new Error(
          `Editor did not report ${expected} after installing the VSIX`,
        )
      }
    }
    console.log(
      "If the editor was already open, run “Developer: Reload Window” once so it activates the freshly installed build.",
    )
  } else {
    console.warn(
      `VS Code/Cursor CLI was not found. CLI installation succeeded; install this VSIX manually: ${vsix}`,
    )
  }
}

console.log("[7/7] Verifying the installed CLI and OS sandbox...")
run(wrapper, ["doctor", "--cwd", root])
console.log(`Installed CLI: ${wrapper}`)
console.log(`Installed runtime: ${runtime.root}`)
console.log(`Built VSIX: ${vsix}`)
if (!pathEntries().includes(path.dirname(wrapper))) {
  console.warn(
    `Open a new terminal or add ${path.dirname(wrapper)} to PATH before running: nexus`,
  )
}
console.log("NexusCode local installation is ready.")
