/**
 * Process-wide registry of spilled tool outputs (OpenClaude-style toolResultStorage parity).
 * Survives in memory for the process lifetime so hooks and compaction can resolve paths even if
 * a ToolPart was rebuilt before outputSpillPath was persisted.
 */
import * as path from "node:path"

import {
  canonicalDataWorkspaceRoot,
  getToolOutputSessionDir,
} from "../data-dir.js"
import { TOOL_OUTPUT_ARTIFACT_FILE_PATTERN } from "./tool-output-format.js"

export type ToolSpillRegistryEntry = {
  absolutePath: string
  artifactId: string
  toolName: string
  workspaceCwd: string
  /** Session whose output directory physically owns the file. */
  ownerSessionId: string
  /** Session whose transcript currently references the file. */
  sessionId: string
  partId: string
  createdAt: number
}

const registry = new Map<string, ToolSpillRegistryEntry>()
const MAX_ENTRIES = 8000

function key(sessionId: string, partId: string): string {
  return `${sessionId}\0${partId}`
}

export function registerToolOutputSpill(args: {
  cwd: string
  sessionId: string
  partId: string
  absolutePath: string
  artifactId?: string
  toolName: string
  /** Used only when an owned subagent artifact is projected into its parent. */
  ownerSessionId?: string
}): void {
  const ownerSessionId = args.ownerSessionId ?? args.sessionId
  assertSpillPathOwnedBySession(args.absolutePath, args.cwd, ownerSessionId)
  const pathArtifactId = artifactIdFromAbsolutePath(args.absolutePath)
  const artifactId = args.artifactId?.toLowerCase() ?? pathArtifactId
  if (artifactId !== pathArtifactId) {
    throw new Error("Tool spill artifact id does not match its owned path")
  }
  const k = key(args.sessionId, args.partId)
  registry.set(k, {
    sessionId: args.sessionId,
    ownerSessionId,
    workspaceCwd: canonicalDataWorkspaceRoot(args.cwd),
    partId: args.partId,
    absolutePath: path.resolve(args.absolutePath),
    artifactId,
    toolName: args.toolName,
    createdAt: Date.now(),
  })
  if (registry.size > MAX_ENTRIES) {
    pruneOldestSpillEntries(Math.floor(MAX_ENTRIES / 2))
  }
}

export function getToolOutputSpill(sessionId: string, partId: string): ToolSpillRegistryEntry | undefined {
  return registry.get(key(sessionId, partId))
}

/**
 * Re-key spill registry when a subagent {@link ToolPart} is cloned into the parent session (new part id).
 * Uses {@link ToolPart.outputSpillPath} if set, else looks up the subagent session + source part id.
 */
export function inheritSpillRegistryForMergedToolPart(args: {
  cwd: string
  parentSessionId: string
  newPartId: string
  subagentSessionId: string
  sourcePartId: string
  toolName: string
  outputSpillPath?: string
  outputArtifactId?: string
  outputArtifactOwnerSessionId?: string
}): string | undefined {
  const source = getToolOutputSpill(
    args.subagentSessionId,
    args.sourcePartId,
  )
  let absolute = source?.absolutePath
  let ownerSessionId = source?.ownerSessionId
  if (!absolute) {
    absolute = args.outputSpillPath?.trim()
    ownerSessionId = args.subagentSessionId
  }
  if (!absolute && args.outputArtifactId?.trim()) {
    const artifactId = args.outputArtifactId.trim().toLowerCase()
    ownerSessionId =
      args.outputArtifactOwnerSessionId?.trim() ||
      args.subagentSessionId
    absolute = path.join(
      getToolOutputSessionDir(args.cwd, ownerSessionId),
      `${artifactId}.out`,
    )
  }
  if (!absolute) return undefined
  registerToolOutputSpill({
    cwd: args.cwd,
    sessionId: args.parentSessionId,
    ownerSessionId,
    partId: args.newPartId,
    absolutePath: absolute,
    artifactId: source?.artifactId ?? args.outputArtifactId,
    toolName: args.toolName,
  })
  return absolute
}

export function clearToolSpillsForSession(sessionId: string): void {
  for (const k of registry.keys()) {
    if (k.startsWith(`${sessionId}\0`)) registry.delete(k)
  }
}

function pruneOldestSpillEntries(targetSize: number): void {
  if (registry.size <= targetSize) return
  const entries = [...registry.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
  const remove = entries.length - targetSize
  for (let i = 0; i < remove; i++) {
    registry.delete(entries[i]![0])
  }
}

/** All spills for a session (e.g. auto-dream / diagnostics). */
export function listToolSpillsForSession(sessionId: string): ToolSpillRegistryEntry[] {
  const out: ToolSpillRegistryEntry[] = []
  for (const [, v] of registry) {
    if (v.sessionId === sessionId) out.push(v)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Snapshot all live capabilities for one workspace. Retention uses this to
 * avoid unlinking an artifact that is owned by an ephemeral sub-agent but is
 * still projected into a live parent session.
 */
export function listToolSpillsForWorkspace(cwd: string): ToolSpillRegistryEntry[] {
  const workspaceCwd = canonicalDataWorkspaceRoot(cwd)
  const out: ToolSpillRegistryEntry[] = []
  for (const entry of registry.values()) {
    if (entry.workspaceCwd !== workspaceCwd) continue
    out.push({ ...entry })
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

function assertSpillPathOwnedBySession(
  absolutePath: string,
  cwd: string,
  ownerSessionId: string,
): void {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error("Tool spill path must be absolute")
  }
  const ownerRoot = path.resolve(getToolOutputSessionDir(cwd, ownerSessionId))
  const candidate = path.resolve(absolutePath)
  const relative = path.relative(ownerRoot, candidate)
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Tool spill path is outside the owning session output directory",
    )
  }
}

export function artifactIdFromAbsolutePath(absolutePath: string): string {
  const basename = path.basename(absolutePath)
  if (!TOOL_OUTPUT_ARTIFACT_FILE_PATTERN.test(basename)) {
    throw new Error("Tool spill path does not contain a valid artifact id")
  }
  return basename.slice(0, -".out".length).toLowerCase()
}
