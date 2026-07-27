import { createReadStream } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"

import {
  getToolOutputSessionDir,
  getToolOutputWorkspaceDir,
} from "../../data-dir.js"
import { TOOL_OUTPUT_ARTIFACT_ID_PATTERN } from "../../context/tool-output-format.js"
import { listToolSpillsForSession } from "../../context/tool-output-registry.js"
import type {
  ISession,
  MessagePart,
  ToolDef,
  ToolPart,
} from "../../types.js"

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024 + 1024
const DEFAULT_LIMIT = 200
const MAX_LINES = 2_000
const MAX_OUTPUT_CHARS = 48_000
const MAX_LINE_CHARS = 4_000

const schema = z
  .object({
    artifact_id: z
      .string()
      .regex(TOOL_OUTPUT_ARTIFACT_ID_PATTERN)
      .describe(
        "Opaque artifact id returned by a truncated tool result. This is not a filesystem path.",
      ),
    offset: z.coerce
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .optional()
      .describe("1-based source line to start scanning from. Defaults to 1."),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_LINES)
      .optional()
      .describe(`Maximum returned lines or matches. Defaults to ${DEFAULT_LIMIT}.`),
    search: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe(
        "Optional literal text search. This is deliberately not a regular expression.",
      ),
    case_sensitive: z
      .boolean()
      .optional()
      .describe("Whether literal search is case-sensitive. Defaults to true."),
  })
  .strict()

export const toolOutputReadTool: ToolDef<z.infer<typeof schema>> = {
  name: "ToolOutputRead",
  searchHint:
    "read or search a truncated Nexus tool-output artifact by opaque artifact_id",
  description: `Reads a bounded slice of a large tool result saved by Nexus.

Use only an opaque \`artifact_id\` returned in a tool result. Filesystem paths are not accepted.
The capability is restricted to the exact workspace and current session; artifacts inherited from
an owned sub-agent remain readable through transcript provenance. Use \`search\` for a literal
bounded scan, or \`offset\` + \`limit\` for a line slice. Never request the entire artifact at once.`,
  parameters: schema,
  readOnly: true,

  async execute(
    { artifact_id, offset, limit, search, case_sensitive },
    ctx,
  ) {
    let artifactPath: string
    try {
      artifactPath = await resolveOwnedArtifactPath({
        cwd: ctx.cwd,
        session: ctx.session,
        artifactId: artifact_id,
      })
    } catch (error) {
      return {
        success: false,
        output:
          `Tool output artifact is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
      }
    }

    const startLine = offset ?? 1
    const maxResults = limit ?? DEFAULT_LIMIT
    const needle =
      search && case_sensitive === false ? search.toLocaleLowerCase() : search
    const lines: string[] = []
    let outputChars = 0
    let sourceLine = 0
    let truncatedByChars = false
    let matched = 0
    const stream = createReadStream(artifactPath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    })
    const onAbort = () => {
      stream.destroy(new Error("ToolOutputRead aborted"))
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    const reader = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    try {
      for await (const rawLine of reader) {
        sourceLine += 1
        if (sourceLine < startLine) continue
        if (needle !== undefined) {
          const haystack =
            case_sensitive === false
              ? rawLine.toLocaleLowerCase()
              : rawLine
          if (!haystack.includes(needle)) continue
        }
        matched += 1
        const boundedLine =
          rawLine.length <= MAX_LINE_CHARS
            ? rawLine
            : `${rawLine.slice(0, MAX_LINE_CHARS)}…[line truncated]`
        const rendered = `${sourceLine.toString().padStart(7)}|${boundedLine}`
        const projectedChars = outputChars + rendered.length + 1
        if (projectedChars > MAX_OUTPUT_CHARS) {
          truncatedByChars = true
          break
        }
        lines.push(rendered)
        outputChars = projectedChars
        if (lines.length >= maxResults) break
      }
    } catch (error) {
      return {
        success: false,
        output:
          `Failed to read tool output artifact: ${
            error instanceof Error ? error.message : String(error)
          }`,
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
      reader.close()
      stream.destroy()
    }

    if (lines.length === 0) {
      return {
        success: true,
        output: search
          ? `No literal matches found in artifact ${artifact_id} from line ${startLine}.`
          : `Artifact ${artifact_id} has no content at or after line ${startLine}.`,
      }
    }

    const operation = search
      ? `literal matches for ${JSON.stringify(search)}`
      : `lines from ${startLine}`
    const continuation =
      truncatedByChars || lines.length >= maxResults
        ? "\n\n[Bounded result complete. Increase offset or refine search to inspect another slice.]"
        : ""
    return {
      success: true,
      output:
        `Artifact ${artifact_id} — ${operation} (${lines.length} returned` +
        `${search ? `, ${matched} encountered` : ""}):\n\n` +
        lines.join("\n") +
        continuation,
    }
  },
}

async function resolveOwnedArtifactPath(args: {
  cwd: string
  session: ISession
  artifactId: string
}): Promise<string> {
  if (!TOOL_OUTPUT_ARTIFACT_ID_PATTERN.test(args.artifactId)) {
    throw new Error("invalid artifact id")
  }

  const registryEntry = listToolSpillsForSession(args.session.id).find(
    (entry) => entry.artifactId === args.artifactId,
  )
  const transcriptOwner = findTranscriptArtifactOwner(
    args.session,
    args.artifactId,
  )
  const ownerSessionId =
    registryEntry?.ownerSessionId ??
    transcriptOwner ??
    args.session.id
  const expected = path.join(
    getToolOutputSessionDir(args.cwd, ownerSessionId),
    `${args.artifactId}.out`,
  )
  if (
    registryEntry &&
    path.resolve(registryEntry.absolutePath) !== path.resolve(expected)
  ) {
    throw new Error("artifact registry ownership mismatch")
  }

  // A foreign owner is usable only when the parent transcript or live
  // registry proves that this exact sub-agent artifact was inherited.
  if (
    ownerSessionId !== args.session.id &&
    !registryEntry &&
    !transcriptOwner
  ) {
    throw new Error("artifact is not owned by this session")
  }

  const workspaceRoot = getToolOutputWorkspaceDir(args.cwd)
  const [workspaceInfo, artifactInfo] = await Promise.all([
    lstat(workspaceRoot),
    lstat(expected),
  ])
  if (
    workspaceInfo.isSymbolicLink() ||
    !workspaceInfo.isDirectory() ||
    artifactInfo.isSymbolicLink() ||
    !artifactInfo.isFile()
  ) {
    throw new Error("artifact storage is not a regular private file")
  }
  if (artifactInfo.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  }
  const [realWorkspace, realArtifact] = await Promise.all([
    realpath(workspaceRoot),
    realpath(expected),
  ])
  const relative = path.relative(realWorkspace, realArtifact)
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("artifact resolves outside this workspace")
  }
  return realArtifact
}

function findTranscriptArtifactOwner(
  session: ISession,
  artifactId: string,
): string | undefined {
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as MessagePart[]) {
      if (part.type !== "tool") continue
      const tool = part as ToolPart
      if (
        tool.outputArtifactId === artifactId &&
        tool.outputArtifactOwnerSessionId
      ) {
        return tool.outputArtifactOwnerSessionId
      }
    }
  }
  return undefined
}
