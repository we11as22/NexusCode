import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Hunk } from 'diff'
import { Box, Text } from 'ink'
import * as React from 'react'
import { Tool } from '../../../Tool.js'
import { Message, UserMessage } from '../../../query.js'
import { useGetToolFromMessages } from './utils.js'
import { FileEditToolUpdatedMessage } from '../../FileEditToolUpdatedMessage.js'
import {
  EditAppliedReplacementsPreview,
  type AppliedReplacement,
} from './EditAppliedReplacementsPreview.js'

type CoreDiffLine = {
  type: 'add' | 'remove' | 'context'
  lineNum: number
  line: string
}

type CoreToolResultData = {
  tool?: string
  output?: string
  path?: string
  diffStats?: { added: number; removed: number }
  diffHunks?: CoreDiffLine[]
  metadata?: Record<string, unknown>
  compacted?: boolean
}

type ParallelMetadataResult = {
  tool?: unknown
  success?: unknown
  output?: unknown
}

function isCoreToolResultData(value: unknown): value is CoreToolResultData {
  if (!value || typeof value !== 'object') return false
  if (!('output' in value) && !('path' in value) && !('diffHunks' in value)) {
    return false
  }
  return true
}

function getEditAppliedReplacements(meta: unknown): AppliedReplacement[] | null {
  if (!meta || typeof meta !== 'object') return null
  const raw = (meta as { appliedReplacements?: unknown }).appliedReplacements
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: AppliedReplacement[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const o = item as { oldSnippet?: unknown; newSnippet?: unknown }
    if (typeof o.oldSnippet !== 'string' || typeof o.newSnippet !== 'string') {
      return null
    }
    out.push({ oldSnippet: o.oldSnippet, newSnippet: o.newSnippet })
  }
  return out
}

function toStructuredPatch(lines: CoreDiffLine[]): Hunk[] {
  if (lines.length === 0) return []
  const oldStart =
    lines.find(l => l.type !== 'add')?.lineNum ?? lines[0]?.lineNum ?? 1
  const newStart =
    lines.find(l => l.type !== 'remove')?.lineNum ?? lines[0]?.lineNum ?? 1
  const oldLines = lines.filter(l => l.type !== 'add').length
  const newLines = lines.filter(l => l.type !== 'remove').length
  return [
    {
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: lines.map(l => `${l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}${l.line}`),
    },
  ]
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map(_ => _.trim())
    .find(Boolean)
  return line ?? ''
}

function extractFilePathFromReadOutput(text: string): string | null {
  const match = text.match(/<file_content\s+path="([^"]+)"/)
  return match?.[1] ?? null
}

function getParallelMetadataResults(
  core: CoreToolResultData | null,
): ParallelMetadataResult[] {
  const rawResults = core?.metadata?.results
  if (!Array.isArray(rawResults)) return []
  return rawResults.filter(
    (item): item is ParallelMetadataResult =>
      typeof item === 'object' && item !== null,
  )
}

function summarizeParallelResults(results: ParallelMetadataResult[]): string {
  const total = results.length
  const successful = results.filter(item => item.success === true).length
  const toolNames = results
    .map(item => (typeof item.tool === 'string' ? item.tool : ''))
    .filter(Boolean)
  const uniqueTools = [...new Set(toolNames)]
  if (uniqueTools.length === 1 && uniqueTools[0] === 'Read') {
    return `Read ${total} ${total === 1 ? 'file' : 'files'}`
  }
  if (uniqueTools.length === 1 && uniqueTools[0]) {
    return `${uniqueTools[0]} ${total} ${total === 1 ? 'call' : 'calls'} (${successful}/${total})`
  }
  return `Parallel execution (${successful}/${total} successful)`
}

function summarizeToolResult(
  toolName: string,
  paramContent: unknown,
  core: CoreToolResultData | null,
): string {
  if (core?.path && core.diffStats) {
    const added = core.diffStats.added
    const removed = core.diffStats.removed
    return `${toolName} ${core.path} (+${added}/-${removed})`
  }

  if (toolName === 'Parallel') {
    const parallelResults = getParallelMetadataResults(core)
    if (parallelResults.length > 0) {
      return summarizeParallelResults(parallelResults)
    }
  }

  if (toolName === 'Read') {
    const candidate =
      (typeof core?.output === 'string' ? core.output : undefined) ??
      (typeof paramContent === 'string' ? paramContent : '')
    const readPath = extractFilePathFromReadOutput(candidate)
    if (readPath) return readPath
  }

  if (typeof core?.output === 'string' && core.output.trim()) {
    return firstLine(core.output)
  }

  if (typeof paramContent === 'string' && paramContent.trim()) {
    return firstLine(paramContent)
  }

  return `${toolName} completed`
}

type Props = {
  param: ToolResultBlockParam
  message: UserMessage
  messages: Message[]
  verbose: boolean
  tools: Tool[]
  width: number | string
}

export function UserToolSuccessMessage({
  param,
  message,
  messages,
  tools,
  verbose,
  width,
}: Props): React.ReactNode {
  const { tool } = useGetToolFromMessages(param.tool_use_id, tools, messages)
  const resultData = message.toolUseResult?.data ?? param.content
  const coreData = isCoreToolResultData(resultData) ? resultData : null

  if (
    coreData?.path &&
    coreData.diffStats &&
    (tool.name === 'Edit' || tool.name === 'Write')
  ) {
    if (tool.name === 'Edit') {
      const applied = getEditAppliedReplacements(coreData.metadata)
      if (applied && applied.length > 0) {
        return (
          <Box flexDirection="column" width={width}>
            <EditAppliedReplacementsPreview
              filePath={coreData.path}
              replacements={applied}
              verbose={verbose}
            />
          </Box>
        )
      }
    }

    const patch = Array.isArray(coreData.diffHunks) && coreData.diffHunks.length > 0
      ? toStructuredPatch(coreData.diffHunks)
      : []
    return (
      <Box flexDirection="column" width={width}>
        <FileEditToolUpdatedMessage
          filePath={coreData.path}
          structuredPatch={patch}
          verbose={verbose}
          diffStats={coreData.diffStats}
        />
      </Box>
    )
  }

  const summary = summarizeToolResult(tool.name, param.content, coreData)

  return (
    <Box flexDirection="column" width={width}>
      <Text>
        {'  '}⎿ {summary}
      </Text>
    </Box>
  )
}
