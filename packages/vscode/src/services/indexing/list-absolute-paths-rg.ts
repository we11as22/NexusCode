/**
 * Roo-Code–style `listFiles` using the ripgrep binary shipped with VS Code (`@vscode/ripgrep`).
 * @see sources/Roo-Code/src/services/glob/list-files.ts
 */
import * as child_process from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import * as vscode from "vscode"
import type { ListIndexAbsolutePathsFn } from "@nexuscode/core"

const isWin = process.platform.startsWith("win")
const rgName = isWin ? "rg.exe" : "rg"

/** Same as Roo `DIRS_TO_IGNORE` (glob negations for `rg --files`). */
const ROO_DIRS_TO_IGNORE = [
  "node_modules",
  "__pycache__",
  "env",
  "venv",
  "target/dependency",
  "build/dependencies",
  "dist",
  "out",
  "bundle",
  "vendor",
  "tmp",
  "temp",
  "deps",
  "pkg",
  "Pods",
  ".git",
  ".*",
]

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function resolveRipgrepPath(): Promise<string | undefined> {
  const appRoot = vscode.env.appRoot
  const candidates = [
    path.join(appRoot, "node_modules/@vscode/ripgrep/bin/", rgName),
    path.join(appRoot, "node_modules/vscode-ripgrep/bin", rgName),
    path.join(appRoot, "node_modules.asar.unpacked/vscode-ripgrep/bin/", rgName),
    path.join(appRoot, "node_modules.asar.unpacked/@vscode/ripgrep/bin/", rgName),
  ]
  for (const c of candidates) {
    if (await pathExists(c)) return c
  }
  return undefined
}

function buildRgFilesArgs(root: string): string[] {
  const args: string[] = ["--files", "--hidden", "--follow"]
  const normalizedPath = path.normalize(root)
  const parts = normalizedPath.split(path.sep).filter((p) => p.length > 0)
  const isTargetingHiddenDir = parts.some((p) => p.startsWith("."))
  const targetDirName = path.basename(root)
  const isTargetInIgnoreList = ROO_DIRS_TO_IGNORE.includes(targetDirName)

  for (const dir of ROO_DIRS_TO_IGNORE) {
    if (dir === ".*") {
      if (!isTargetingHiddenDir) {
        args.push("-g", "!**/.*/**")
      }
      continue
    }
    if (dir === targetDirName && isTargetInIgnoreList) continue
    args.push("-g", `!**/${dir}/**`)
  }
  args.push(root)
  return args
}

export const listAbsolutePathsRipgrep: ListIndexAbsolutePathsFn = (root, maxList, signal) => {
  if (maxList <= 0) return Promise.resolve({ paths: [], limitReached: false })

  return (async () => {
    const rg = await resolveRipgrepPath()
    if (!rg) throw new Error("ripgrep binary not found in VS Code installation")

    const args = buildRgFilesArgs(root)
    return await new Promise<{ paths: string[]; limitReached: boolean }>((resolve, reject) => {
      const proc = child_process.spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
      const onAbort = (): void => {
        proc.kill("SIGTERM")
      }
      signal.addEventListener("abort", onAbort)

      const paths: string[] = []
      let stderr = ""
      let settled = false
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString()
      })

      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })
      rl.on("line", (line) => {
        if (signal.aborted) return
        const t = line.trim()
        if (!t) return
        paths.push(path.resolve(root, t))
        if (paths.length >= maxList) {
          proc.kill("SIGTERM")
        }
      })

      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        if (err) {
          reject(err)
          return
        }
        const limitReached = paths.length >= maxList
        if (stderr.trim().length > 0 && paths.length === 0 && !signal.aborted) {
          reject(new Error(stderr.trim().slice(0, 500)))
          return
        }
        resolve({ paths, limitReached })
      }

      rl.on("close", () => finish())
      proc.on("error", (err) => finish(err))
    })
  })()
}
