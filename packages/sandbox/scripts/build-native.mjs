import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(packageRoot, "..", "..")
const nativeRoot = path.join(repositoryRoot, "native", "sandbox")
const bubblewrapSourceRoot = path.join(nativeRoot, "vendor", "bubblewrap")

function target(platform, arch) {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`Unsupported Nexus sandbox platform: ${platform}`)
  }
  if (!["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported Nexus sandbox architecture: ${arch}`)
  }
  return `${platform}-${arch}`
}

const requested = process.env.NEXUS_SANDBOX_TARGETS?.trim()
const targets = requested
  ? requested.split(",").map((value) => value.trim()).filter(Boolean)
  : [target(process.platform, process.arch)]

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? nativeRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "pipe",
  })
  if (result.error) {
    throw new Error(
      `Failed to start ${program}: ${result.error.message}`,
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    )
  }
  return result.stdout?.trim() ?? ""
}

function shellWords(value) {
  const words = []
  let current = ""
  let quote = null
  let escaped = false
  for (const character of value.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else current += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/u.test(character)) {
      if (current) {
        words.push(current)
        current = ""
      }
    } else {
      current += character
    }
  }
  if (escaped || quote) {
    throw new Error(`Invalid pkg-config output: ${value}`)
  }
  if (current) words.push(current)
  return words
}

function buildBundledBubblewrap(outputDir, targetValue) {
  if (process.platform !== "linux") {
    throw new Error(
      `Bundled bubblewrap for ${targetValue} must be built on Linux; ` +
        `run this target in the Linux release job`,
    )
  }
  if (targetValue !== target(process.platform, process.arch)) {
    throw new Error(
      `Bundled bubblewrap cross-compilation is unsupported (${targetValue}); ` +
        `build it on the matching Linux architecture`,
    )
  }

  const requiredFiles = [
    "bubblewrap.c",
    "bind-mount.c",
    "network.c",
    "utils.c",
    "bind-mount.h",
    "network.h",
    "utils.h",
    "COPYING",
  ]
  for (const file of requiredFiles) {
    const source = path.join(bubblewrapSourceRoot, file)
    if (!fs.statSync(source).isFile()) {
      throw new Error(`Vendored bubblewrap source is missing: ${source}`)
    }
  }

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bwrap-build-"))
  try {
    fs.writeFileSync(
      path.join(buildDir, "config.h"),
      '#pragma once\n#define PACKAGE_STRING "bubblewrap 0.11.2 (NexusCode bundled build)"\n',
    )
    let libcap
    try {
      libcap = shellWords(run("pkg-config", ["--cflags", "--libs", "libcap"]))
    } catch (error) {
      throw new Error(
        "Building the bundled Linux sandbox requires pkg-config and libcap headers " +
          "(Debian/Ubuntu: libcap-dev; Fedora: libcap-devel).\n" +
          String(error),
      )
    }
    const compiler = process.env.CC?.trim() || "cc"
    const output = path.join(outputDir, "nexus-bwrap")
    run(compiler, [
      "-O2",
      "-fPIE",
      "-pie",
      "-D_GNU_SOURCE",
      `-I${buildDir}`,
      `-I${bubblewrapSourceRoot}`,
      path.join(bubblewrapSourceRoot, "bubblewrap.c"),
      path.join(bubblewrapSourceRoot, "bind-mount.c"),
      path.join(bubblewrapSourceRoot, "network.c"),
      path.join(bubblewrapSourceRoot, "utils.c"),
      ...libcap,
      "-o",
      output,
    ])
    fs.chmodSync(output, 0o755)
    const version = run(output, ["--version"], { cwd: outputDir })
    if (!/^bubblewrap \d/u.test(version)) {
      throw new Error(`Bundled bubblewrap version probe failed: ${version}`)
    }
    fs.copyFileSync(
      path.join(bubblewrapSourceRoot, "COPYING"),
      path.join(outputDir, "COPYING.bubblewrap"),
    )
    process.stdout.write(
      `[nexus-sandbox] built ${targetValue} bubblewrap: ${output}\n`,
    )
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true })
  }
}

function writeIntegrityManifest(outputDir, targetValue, files) {
  const hashes = {}
  for (const file of files) {
    const source = path.join(outputDir, file)
    hashes[file] = createHash("sha256")
      .update(fs.readFileSync(source))
      .digest("hex")
  }
  fs.writeFileSync(
    path.join(outputDir, "SHA256SUMS.json"),
    `${JSON.stringify({ schema: 1, target: targetValue, files: hashes }, null, 2)}\n`,
  )
}

for (const value of targets) {
  const [platform, arch] = value.split("-")
  if (target(platform, arch) !== value) {
    throw new Error(`Invalid Nexus sandbox target: ${value}`)
  }
  const goos = platform === "win32" ? "windows" : platform
  const goarch = arch === "x64" ? "amd64" : "arm64"
  const binaryName = platform === "win32" ? "nexus-sandbox.exe" : "nexus-sandbox"
  const outputDir = path.join(packageRoot, "vendor", value)
  const output = path.join(outputDir, binaryName)
  fs.mkdirSync(outputDir, { recursive: true })
  const result = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      "-s -w -X main.version=0.1.0",
      "-o",
      output,
      "./cmd/nexus-sandbox",
    ],
    {
      cwd: nativeRoot,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: goos,
        GOARCH: goarch,
        GOCACHE: path.join(os.tmpdir(), "nexus-go-build"),
        GOMODCACHE: path.join(os.tmpdir(), "nexus-go-mod"),
      },
      encoding: "utf8",
      stdio: "pipe",
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `Failed to build ${value} Nexus sandbox:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    )
  }
  if (platform !== "win32") fs.chmodSync(output, 0o755)
  if (platform === "linux") buildBundledBubblewrap(outputDir, value)
  writeIntegrityManifest(
    outputDir,
    value,
    platform === "linux"
      ? [binaryName, "nexus-bwrap", "COPYING.bubblewrap"]
      : [binaryName],
  )
  process.stdout.write(`[nexus-sandbox] built ${value}: ${output}\n`)
}
