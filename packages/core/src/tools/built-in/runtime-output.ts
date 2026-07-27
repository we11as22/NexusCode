import * as fs from "node:fs/promises"
import * as path from "node:path"
import { getRunLogsDir } from "../../data-dir.js"

export const MAX_RUNTIME_OUTPUT_BYTES = 50 * 1024 * 1024

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

export async function readTrustedRuntimeOutput(filePath: string): Promise<string> {
  const requested = path.resolve(filePath)
  const requestedStat = await fs.lstat(requested)
  if (requestedStat.isSymbolicLink()) {
    throw new Error("Task output must not be a symbolic link")
  }
  if (!requestedStat.isFile()) {
    throw new Error("Task output is not a regular file")
  }
  if (requestedStat.size > MAX_RUNTIME_OUTPUT_BYTES) {
    throw new Error(
      `Task output exceeds the ${MAX_RUNTIME_OUTPUT_BYTES}-byte limit`,
    )
  }

  const [runRoot, canonical] = await Promise.all([
    fs.realpath(getRunLogsDir()),
    fs.realpath(requested),
  ])
  if (!isPathInside(runRoot, canonical)) {
    throw new Error("Task output path is outside the runtime-owned log directory")
  }
  const content = await fs.readFile(canonical)
  if (content.byteLength > MAX_RUNTIME_OUTPUT_BYTES) {
    throw new Error(
      `Task output exceeds the ${MAX_RUNTIME_OUTPUT_BYTES}-byte limit`,
    )
  }
  return content.toString("utf8")
}
