import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { rgPath } = require("@vscode/ripgrep")
if (typeof rgPath !== "string" || rgPath.length === 0) {
  throw new Error("@vscode/ripgrep did not provide a binary path")
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const platformDir =
  process.platform === "win32"
    ? "x64-win32"
    : `${process.arch}-${process.platform}`
const binaryName = process.platform === "win32" ? "rg.exe" : "rg"
const destination = path.join(
  packageRoot,
  "dist",
  "vendor",
  "ripgrep",
  platformDir,
  binaryName,
)

await mkdir(path.dirname(destination), { recursive: true })
await copyFile(rgPath, destination)
if (process.platform !== "win32") {
  await chmod(destination, 0o755)
}
execFileSync(destination, ["--version"], { stdio: "ignore" })
console.log(`Bundled ripgrep: ${destination}`)
