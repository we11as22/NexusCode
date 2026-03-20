/**
 * Generic display-only tool for Nexus/core tool names that have no CLI counterpart.
 * Ensures "Tool not found for X" never happens: any core tool_use can be rendered.
 */
import type { Tool } from '../Tool.js'
import { Box, Text } from 'ink'
import * as React from 'react'
import { z } from 'zod'

const anyInputSchema = z.record(z.unknown())

const cache = new Map<string, Tool>()

function formatResult(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null && 'resultForAssistant' in data) {
    const r = (data as { resultForAssistant?: unknown }).resultForAssistant
    if (typeof r === 'string') return r
    if (Array.isArray(r)) return r.map(String).join('\n')
  }
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

export function getGenericToolForCoreName(name: string): Tool {
  let t = cache.get(name)
  if (t) return t
  t = {
    name,
    async description() {
      return `Core tool: ${name}`
    },
    async prompt() {
      return ''
    },
    inputSchema: anyInputSchema,
    isReadOnly: () => true,
    userFacingName: () => name,
    isEnabled: async () => true,
    renderToolUseMessage: (input: unknown) =>
      typeof input === 'object' && input !== null
        ? JSON.stringify(input)
        : String(input ?? ''),
    renderToolResultMessage: (output: unknown) => (
      <Box flexDirection="column">
        <Text>{formatResult(output)}</Text>
      </Box>
    ),
    renderResultForAssistant: (output: unknown) => formatResult(output),
    call: async function* () {
      throw new Error(`Generic display tool ${name} is not callable`)
    },
  }
  cache.set(name, t)
  return t
}
