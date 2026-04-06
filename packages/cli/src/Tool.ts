import type * as React from 'react'
import type { z } from 'zod'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'

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
    commands: Command[]
    tools: Tool[]
    slowAndCapableModel?: string
    forkNumber: number
    messageLogName: string
    maxThinkingTokens: number
    verbose?: boolean
    dangerouslySkipPermissions?: boolean
  }
  messageId?: string
  readFileTimestamps: Record<string, number>
  setToolJSX?: SetToolJSXFn
  onNexusConfigSaved?: () => void | Promise<void>
}

export type ToolCallProgressResult = {
  type: 'progress'
  content: { type: 'assistant'; message: { content: unknown[] }; uuid: string }
  normalizedMessages: unknown[]
  tools: Tool[]
}

export type ToolCallResultResult<TOut = any> = {
  type: 'result'
  resultForAssistant: string | unknown[] | React.ReactNode
  data: TOut
}

export type ToolCallYield<TOut = any> =
  | ToolCallProgressResult
  | ToolCallResultResult<TOut>

type ToolInput<TSchema extends z.ZodTypeAny> = z.infer<TSchema>

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TOut = any> {
  name: string
  description: (input?: any) => Promise<string>
  prompt: (...args: any[]) => Promise<string>
  inputSchema: TSchema
  isReadOnly: () => boolean
  userFacingName: (...args: any[]) => string
  isEnabled: () => Promise<boolean>
  needsPermissions?: (input: any) => Promise<boolean> | boolean
  renderToolUseMessage: (
    input: any,
    options: Record<string, unknown>,
  ) => string
  renderToolResultMessage?: (
    output: any,
    options: Record<string, unknown>,
  ) => React.ReactNode
  renderResultForAssistant: (output: TOut) => string | unknown[] | React.ReactNode
  renderToolUseRejectedMessage?: (...args: any[]) => React.ReactNode
  validateInput?: (
    input: any,
    context?: ToolUseContext,
  ) => Promise<ValidationResult> | ValidationResult
  call: (
    input: any,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
  ) => AsyncGenerator<ToolCallYield<TOut>, void>
}
