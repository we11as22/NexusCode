/**
 * Global data directory for NexusCode (Kilo-style: terminal outputs and large tool output
 * live outside the project so the project tree stays clean).
 *
 * - Background run logs: <data>/run/run_<ts>.log
 * - Large blocking / truncated output: <data>/tool-output/tool_*.out
 */
import * as path from "node:path"
import * as os from "node:os"

export function getNexusDataDir(): string {
  return process.env.NEXUS_DATA_HOME || path.join(os.homedir(), ".nexus", "data")
}

export function getToolOutputDir(): string {
  return path.join(getNexusDataDir(), "tool-output")
}

export function getRunLogsDir(): string {
  return path.join(getNexusDataDir(), "run")
}
