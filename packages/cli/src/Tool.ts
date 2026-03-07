import type * as React from 'react'
import type { z } from 'zod'

export type ValidationResult =
  | { result: true }
  | { result: false; message: string; meta?: Record<string, unknown> }

export type SetToolJSXFn = (arg: {
  jsx: React.ReactNode
  shouldHidePromptInput: boolean
} | null) => void

export type ToolUseContext = {
  abortController: AbortController
  options: {
    commands: unknown[]
    tools: Tool[]
    slowAndCapableModel?: unknown
    forkNumber: number
    messageLogName: string
    maxThinkingTokens: number
    dangerouslySkipPermissions?: boolean
  }
  messageId?: string
  readFileTimestamps?: Record<string, number>
}

export type ToolCallProgressResult = {
  type: 'progress'
  content: { type: 'assistant'; message: { content: unknown[] }; uuid: string }
  normalizedMessages: unknown[]
  tools: Tool[]
}

export type ToolCallResultResult<TOut = unknown> = {
  type: 'result'
  resultForAssistant: string | unknown[]
  data: TOut
}

export type ToolCallYield<TOut = unknown> =
  | ToolCallProgressResult
  | ToolCallResultResult<TOut>

export interface Tool<TIn = unknown, TOut = unknown> {
  name: string
  description: (input?: TIn) => Promise<string>
  prompt: () => Promise<string>
  inputSchema: z.ZodType<TIn>
  isReadOnly: () => boolean
  userFacingName: () => string
  isEnabled: () => Promise<boolean>
  needsPermissions?: (input: TIn) => Promise<boolean> | boolean
  renderToolUseMessage: (
    input: TIn,
    options: { verbose?: boolean },
  ) => string
  renderToolResultMessage: (
    output: TOut,
    options: { verbose?: boolean },
  ) => React.ReactNode
  renderToolUseRejectedMessage?: (message: string) => React.ReactNode
  validateInput?: (
    input: TIn,
    context: ToolUseContext,
  ) => Promise<ValidationResult> | ValidationResult
  call: (
    input: TIn,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
  ) => AsyncGenerator<ToolCallYield<TOut>, void>
}
