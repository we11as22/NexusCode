/**
 * Process-wide registry of spilled tool outputs (OpenClaude-style toolResultStorage parity).
 * Survives in memory for the process lifetime so hooks and compaction can resolve paths even if
 * a ToolPart was rebuilt before outputSpillPath was persisted.
 */

export type ToolSpillRegistryEntry = {
  absolutePath: string
  toolName: string
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
  sessionId: string
  partId: string
  absolutePath: string
  toolName: string
}): void {
  const k = key(args.sessionId, args.partId)
  registry.set(k, {
    sessionId: args.sessionId,
    partId: args.partId,
    absolutePath: args.absolutePath,
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
  parentSessionId: string
  newPartId: string
  subagentSessionId: string
  sourcePartId: string
  toolName: string
  outputSpillPath?: string
}): string | undefined {
  let absolute = args.outputSpillPath?.trim()
  if (!absolute) {
    absolute = getToolOutputSpill(args.subagentSessionId, args.sourcePartId)?.absolutePath
  }
  if (!absolute) return undefined
  registerToolOutputSpill({
    sessionId: args.parentSessionId,
    partId: args.newPartId,
    absolutePath: absolute,
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
