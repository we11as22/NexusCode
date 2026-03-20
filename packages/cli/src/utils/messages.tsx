import { randomUUID, UUID } from 'crypto'
import { Box } from 'ink'
import {
  AssistantMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from '../query.js'
import { getCommand, hasCommand } from '../commands.js'
import { MalformedCommandError } from './errors.js'
import { logError } from './log.js'
import { resolve } from 'path'
import { last, memoize } from 'lodash-es'
import { logEvent } from '../services/statsig.js'
import type { SetToolJSXFn, Tool, ToolUseContext } from '../Tool.js'
import { lastX } from '../utils/generators.js'
import { NO_CONTENT_MESSAGE } from '../services/claude.js'
import {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  Message as APIMessage,
  MessageParam,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { setCwd } from './state.js'
import { getCwd } from './state.js'
import chalk from 'chalk'
import * as React from 'react'
import { UserBashInputMessage } from '../components/messages/UserBashInputMessage.js'
import { Spinner } from '../components/Spinner.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const NO_RESPONSE_REQUESTED = 'No response requested.'

export const SYNTHETIC_ASSISTANT_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

function baseCreateAssistantMessage(
  content: ContentBlock[],
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    uuid: randomUUID(),
    message: {
      id: randomUUID(),
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as UsageWithCache,
      content,
    },
    ...extra,
  }
}

export function createAssistantMessage(content: string): AssistantMessage {
  return baseCreateAssistantMessage([
    {
      type: 'text' as const,
      text: content === '' ? NO_CONTENT_MESSAGE : content,
    },
  ])
}

export function createAssistantAPIErrorMessage(
  content: string,
): AssistantMessage {
  return baseCreateAssistantMessage(
    [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
      },
    ],
    { isApiErrorMessage: true },
  )
}

export type FullToolUseResult = {
  data: unknown // Matches tool's `Output` type
  resultForAssistant: ToolResultBlockParam['content']
}

type ContentBlockParam = Exclude<MessageParam['content'], string>[number]
type UsageWithCache = APIMessage['usage'] & {
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export function createUserMessage(
  content: string | ContentBlockParam[],
  toolUseResult?: FullToolUseResult,
): UserMessage {
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    uuid: randomUUID(),
    toolUseResult,
  }
  return m
}

export function createProgressMessage(
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  content: AssistantMessage,
  normalizedMessages: NormalizedMessage[],
  tools: Tool[],
): ProgressMessage {
  return {
    type: 'progress',
    content,
    normalizedMessages,
    siblingToolUseIDs,
    tools,
    toolUseID,
    uuid: randomUUID(),
  }
}

export function createToolResultStopMessage(
  toolUseID: string,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}

export async function processUserInput(
  input: string,
  mode: 'bash' | 'prompt',
  setToolJSX: SetToolJSXFn,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: (
      forkConvoWithMessages: Message[],
    ) => void
  },
  pastedImage: string | null,
): Promise<Message[]> {
  // Bash commands
  if (mode === 'bash') {
    logEvent('tengu_input_bash', {})

    const userMessage = createUserMessage(`<bash-input>${input}</bash-input>`)

    // Special case: cd
    if (input.startsWith('cd ')) {
      const oldCwd = getCwd()
      const newCwd = resolve(oldCwd, input.slice(3))
      try {
        await setCwd(newCwd)
        return [
          userMessage,
          createAssistantMessage(
            `<bash-stdout>Changed directory to ${chalk.bold(`${newCwd}/`)}</bash-stdout>`,
          ),
        ]
      } catch (e) {
        logError(e)
        return [
          userMessage,
          createAssistantMessage(
            `<bash-stderr>cwd error: ${e instanceof Error ? e.message : String(e)}</bash-stderr>`,
          ),
        ]
      }
    }

    // All other bash commands
    setToolJSX({
      jsx: (
        <Box flexDirection="column" marginTop={1}>
          <UserBashInputMessage
            addMargin={false}
            param={{ text: `<bash-input>${input}</bash-input>`, type: 'text' }}
          />
          <Spinner />
        </Box>
      ),
      shouldHidePromptInput: false,
    })
    try {
      const validationResult = await BashTool.validateInput({ command: input })
      if (!validationResult.result) {
        return [userMessage, createAssistantMessage(validationResult.message)]
      }
      const { data } = await lastX(BashTool.call({ command: input }, context))
      return [
        userMessage,
        createAssistantMessage(
          `<bash-stdout>${data.stdout}</bash-stdout><bash-stderr>${data.stderr}</bash-stderr>`,
        ),
      ]
    } catch (e) {
      return [
        userMessage,
        createAssistantMessage(
          `<bash-stderr>Command failed: ${e instanceof Error ? e.message : String(e)}</bash-stderr>`,
        ),
      ]
    } finally {
      setToolJSX(null)
    }
  }

  // Slash commands
  if (input.startsWith('/')) {
    const words = input.slice(1).split(' ')
    let commandName = words[0]
    if (words.length > 1 && words[1] === '(MCP)') {
      commandName = commandName + ' (MCP)'
    }
    if (!commandName) {
      logEvent('tengu_input_slash_missing', { input })
      return [
        createAssistantMessage('Commands are in the form `/command [args]`'),
      ]
    }

    // Check if it's a real command before processing
    if (!hasCommand(commandName, context.options.commands)) {
      // If not a real command, treat it as a regular user input
      logEvent('tengu_input_prompt', {})
      return [createUserMessage(input)]
    }

    const args = input.slice(commandName.length + 2)
    const newMessages = await getMessagesForSlashCommand(
      commandName,
      args,
      setToolJSX,
      context,
    )

    // Local JSX commands
    if (newMessages.length === 0) {
      logEvent('tengu_input_command', { input })
      return []
    }

    // For invalid commands, preserve both the user message and error
    if (
      newMessages.length === 2 &&
      newMessages[0]!.type === 'user' &&
      newMessages[1]!.type === 'assistant' &&
      typeof newMessages[1]!.message.content === 'string' &&
      // @ts-expect-error: TODO: this is probably a bug
      newMessages[1]!.message.content.startsWith('Unknown command:')
    ) {
      logEvent('tengu_input_slash_invalid', { input })
      return newMessages
    }

    // User-Assistant pair (eg. local commands)
    if (newMessages.length === 2) {
      logEvent('tengu_input_command', { input })
      return newMessages
    }

    // A valid command
    logEvent('tengu_input_command', { input })
    return newMessages
  }

  // Regular user prompt
  logEvent('tengu_input_prompt', {})
  if (pastedImage) {
    return [
      createUserMessage([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: pastedImage,
          },
        },
        {
          type: 'text',
          text: input,
        },
      ]),
    ]
  }
  return [createUserMessage(input)]
}

async function getMessagesForSlashCommand(
  commandName: string,
  args: string,
  setToolJSX: SetToolJSXFn,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: (
      forkConvoWithMessages: Message[],
    ) => void
  },
): Promise<Message[]> {
  try {
    const command = getCommand(commandName, context.options.commands)
    switch (command.type) {
      case 'local-jsx': {
        return new Promise(resolve => {
          command
            .call(async r => {
              setToolJSX(null)
              // Model panel (and similar) close without adding messages to chat
              if (
                r &&
                typeof r === 'object' &&
                ('cancelled' in r || 'saved' in r)
              ) {
                const ctx = context as { onNexusConfigSaved?: () => void | Promise<void> }
                await ctx.onNexusConfigSaved?.()
                resolve([])
                return
              }
              resolve([
                createUserMessage(`<command-name>${command.userFacingName()}</command-name>
          <command-message>${command.userFacingName()}</command-message>
          <command-args>${args}</command-args>`),
                typeof r === 'string'
                  ? createAssistantMessage(r)
                  : createAssistantMessage(NO_RESPONSE_REQUESTED),
              ])
            }, context)
            .then(jsx => {
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
              })
            })
        })
      }
      case 'local': {
        const userMessage =
          createUserMessage(`<command-name>${command.userFacingName()}</command-name>
        <command-message>${command.userFacingName()}</command-message>
        <command-args>${args}</command-args>`)

        try {
          const result = await command.call(args, context)

          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stdout>${result}</local-command-stdout>`,
            ),
          ]
        } catch (e) {
          logError(e)
          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stderr>${String(e)}</local-command-stderr>`,
            ),
          ]
        }
      }
      case 'prompt': {
        const prompt = await command.getPromptForCommand(args)
        return prompt.map(_ => {
          if (typeof _.content === 'string') {
            return {
              message: {
                role: _.role,
                content: `<command-message>${command.userFacingName()} is ${command.progressMessage}…</command-message>
                    <command-name>${command.userFacingName()}</command-name>
                    <command-args>${args}</command-args>
                    <command-contents>${JSON.stringify(
                      _.content,
                      null,
                      2,
                    )}</command-contents>`,
              },
              type: 'user',
              uuid: randomUUID(),
            }
          }
          return {
            message: {
              role: _.role,
              content: _.content.map(_ => {
                switch (_.type) {
                  case 'text':
                    return {
                      ..._,
                      text: `
                        <command-message>${command.userFacingName()} is ${command.progressMessage}…</command-message>
                        <command-name>${command.userFacingName()}</command-name>
                        <command-args>${args}</command-args>
                        <command-contents>${JSON.stringify(
                          _,
                          null,
                          2,
                        )}</command-contents>
                      `,
                    }
                  // TODO: These won't render properly
                  default:
                    return _
                }
              }),
            },
            type: 'user',
            uuid: randomUUID(),
          }
        })
      }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return [createAssistantMessage(e.message)]
    }
    throw e
  }
}

export function extractTagFromMessage(
  message: Message,
  tagName: string,
): string | null {
  if (message.type === 'progress') {
    return null
  }
  if (typeof message.message.content !== 'string') {
    return null
  }
  return extractTag(message.message.content, tagName)
}

export function extractTag(html: string, tagName: string): string | null {
  if (!html.trim() || !tagName.trim()) {
    return null
  }

  // Escape special characters in the tag name
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Create regex pattern that handles:
  // 1. Self-closing tags
  // 2. Tags with attributes
  // 3. Nested tags of the same type
  // 4. Multiline content
  const pattern = new RegExp(
    `<${escapedTag}(?:\\s+[^>]*)?>` + // Opening tag with optional attributes
      '([\\s\\S]*?)' + // Content (non-greedy match)
      `<\\/${escapedTag}>`, // Closing tag
    'gi',
  )

  let match
  let depth = 0
  let lastIndex = 0
  const openingTag = new RegExp(`<${escapedTag}(?:\\s+[^>]*?)?>`, 'gi')
  const closingTag = new RegExp(`<\\/${escapedTag}>`, 'gi')

  while ((match = pattern.exec(html)) !== null) {
    // Check for nested tags
    const content = match[1]
    const beforeMatch = html.slice(lastIndex, match.index)

    // Reset depth counter
    depth = 0

    // Count opening tags before this match
    openingTag.lastIndex = 0
    while (openingTag.exec(beforeMatch) !== null) {
      depth++
    }

    // Count closing tags before this match
    closingTag.lastIndex = 0
    while (closingTag.exec(beforeMatch) !== null) {
      depth--
    }

    // Only include content if we're at the correct nesting level
    if (depth === 0 && content) {
      return content
    }

    lastIndex = match.index + match[0].length
  }

  return null
}

export function isNotEmptyMessage(message: Message): boolean {
  if (message.type === 'progress') {
    return true
  }

  if (typeof message.message.content === 'string') {
    return message.message.content.trim().length > 0
  }

  if (message.message.content.length === 0) {
    return false
  }

  // Skip multi-block messages for now
  if (message.message.content.length > 1) {
    return true
  }

  if (message.message.content[0]!.type !== 'text') {
    return true
  }

  return (
    message.message.content[0]!.text.trim().length > 0 &&
    message.message.content[0]!.text !== NO_CONTENT_MESSAGE &&
    message.message.content[0]!.text !== INTERRUPT_MESSAGE_FOR_TOOL_USE
  )
}

// TODO: replace this with plain UserMessage if/when PR #405 lands
type NormalizedUserMessage = {
  message: {
    content: [
      | TextBlockParam
      | ImageBlockParam
      | ToolUseBlockParam
      | ToolResultBlockParam,
    ]
    role: 'user'
  }
  type: 'user'
  uuid: UUID
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | AssistantMessage
  | ProgressMessage

// Split messages, so each content block gets its own message
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  return messages.flatMap(message => {
    if (message.type === 'progress') {
      return [message] as NormalizedMessage[]
    }
    if (typeof message.message.content === 'string') {
      return [message] as NormalizedMessage[]
    }
    return message.message.content.map(_ => {
      switch (message.type) {
        case 'assistant':
          return {
            type: 'assistant',
            uuid: randomUUID(),
            message: {
              ...message.message,
              content: [_],
            },
            costUSD:
              (message as AssistantMessage).costUSD /
              message.message.content.length,
            durationMs: (message as AssistantMessage).durationMs,
          } as NormalizedMessage
        case 'user': {
          // Mirror assistant splitting: one UI row per block so tool results sit next to the
          // correct tool_use (fixes errors showing under the previous tool row).
          const block = _
          const base = message as UserMessage
          return {
            type: 'user',
            uuid: randomUUID(),
            message: {
              ...base.message,
              content: [block] as NormalizedUserMessage['message']['content'],
            },
            ...(base.toolUseResult && block.type === 'tool_result'
              ? { toolUseResult: base.toolUseResult }
              : {}),
          } as NormalizedMessage
        }
      }
    })
  })
}

type ToolUseRequestMessage = AssistantMessage & {
  message: { content: ToolUseBlock[] }
}

function isToolUseRequestMessage(
  message: Message,
): message is ToolUseRequestMessage {
  return (
    message.type === 'assistant' &&
    'costUSD' in message &&
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly
    message.message.content.some(_ => _.type === 'tool_use')
  )
}

// Re-order, to move result messages to be after their tool use messages
export function reorderMessages(
  messages: NormalizedMessage[],
): NormalizedMessage[] {
  const ms: NormalizedMessage[] = []
  const toolUseMessages: ToolUseRequestMessage[] = []

  for (const message of messages) {
    // track tool use messages we've seen
    if (isToolUseRequestMessage(message)) {
      toolUseMessages.push(message)
    }

    // if it's a tool progress message...
    if (message.type === 'progress') {
      // replace any existing progress messages with this one
      const existingProgressMessage = ms.find(
        _ => _.type === 'progress' && _.toolUseID === message.toolUseID,
      )
      if (existingProgressMessage) {
        ms[ms.indexOf(existingProgressMessage)] = message
        continue
      }
      // otherwise, insert it after its tool use (match any content block — not only [0])
      const toolUseMessage = toolUseMessages.find((m) =>
        Array.isArray(m.message.content) &&
        m.message.content.some(
          (b): b is ToolUseBlockParam =>
            b?.type === 'tool_use' && b.id === message.toolUseID,
        ),
      )
      if (toolUseMessage) {
        ms.splice(ms.indexOf(toolUseMessage) + 1, 0, message)
        continue
      }
    }

    // Tool results: place after the matching progress row, else after the assistant tool_use.
    const toolResultBlock =
      message.type === 'user' && Array.isArray(message.message.content)
        ? message.message.content.find(
            (b): b is ToolResultBlockParam => b?.type === 'tool_result',
          )
        : undefined
    if (toolResultBlock) {
      const toolUseID = toolResultBlock.tool_use_id

      const lastProgressMessage = ms.find(
        _ => _.type === 'progress' && _.toolUseID === toolUseID,
      )
      if (lastProgressMessage) {
        ms.splice(ms.indexOf(lastProgressMessage) + 1, 0, message)
        continue
      }

      const toolUseMessage = toolUseMessages.find((m) =>
        Array.isArray(m.message.content) &&
        m.message.content.some(
          (b): b is ToolUseBlockParam =>
            b?.type === 'tool_use' && b.id === toolUseID,
        ),
      )
      if (toolUseMessage) {
        ms.splice(ms.indexOf(toolUseMessage) + 1, 0, message)
        continue
      }
      ms.push(message)
      continue
    }

    ms.push(message)
  }

  return ms
}

function buildToolUseResultErrorMap(
  normalizedMessages: NormalizedMessage[],
): Record<string, boolean> {
  return Object.fromEntries(
    normalizedMessages.flatMap(_ => {
      if (_.type !== 'user' || !Array.isArray(_.message.content)) {
        return [] as [string, boolean][]
      }
      return _.message.content
        .filter((b): b is ToolResultBlockParam => b?.type === 'tool_result')
        .map(b => [b.tool_use_id, b.is_error ?? false] as [string, boolean])
    }),
  )
}

const getToolResultIDs = memoize(
  (normalizedMessages: NormalizedMessage[]): { [toolUseID: string]: boolean } =>
    buildToolUseResultErrorMap(normalizedMessages),
)

/** tool_use_id → tool result was error (for CLI "Attempt …" in Exploring block). */
export function getToolUseResultErrorMap(
  normalizedMessages: NormalizedMessage[],
): Record<string, boolean> {
  return buildToolUseResultErrorMap(normalizedMessages)
}

export function getUnresolvedToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  const toolResults = getToolResultIDs(normalizedMessages)
  const ids = new Set<string>()
  for (const m of normalizedMessages) {
    if (m.type !== 'assistant' || !Array.isArray(m.message.content)) continue
    for (const b of m.message.content) {
      if (b.type === 'tool_use' && !(b.id in toolResults)) {
        ids.add(b.id)
      }
    }
  }
  return ids
}

/**
 * Tool uses are in flight if either:
 * 1. They have a corresponding progress message and no result message
 * 2. They are the first unresoved tool use
 *
 * TODO: Find a way to harden this logic to make it more explicit
 */
export function getInProgressToolUseIDs(
  normalizedMessages: NormalizedMessage[],
): Set<string> {
  const unresolvedToolUseIDs = getUnresolvedToolUseIDs(normalizedMessages)
  const toolUseIDsThatHaveProgressMessages = new Set(
    normalizedMessages.filter(_ => _.type === 'progress').map(_ => _.toolUseID),
  )
  const out = new Set<string>()
  for (const id of unresolvedToolUseIDs) {
    if (toolUseIDsThatHaveProgressMessages.has(id)) {
      out.add(id)
    }
  }
  // Progress row may lag behind tool_start; still show loaders for any unresolved tools
  if (out.size === 0 && unresolvedToolUseIDs.size > 0) {
    for (const id of unresolvedToolUseIDs) {
      out.add(id)
    }
  }
  return out
}

export function getErroredToolUseMessages(
  normalizedMessages: NormalizedMessage[],
): AssistantMessage[] {
  const toolResults = getToolResultIDs(normalizedMessages)
  return normalizedMessages.filter((m): m is AssistantMessage => {
    if (m.type !== 'assistant' || !Array.isArray(m.message.content)) return false
    return m.message.content.some(
      b =>
        b.type === 'tool_use' &&
        b.id in toolResults &&
        toolResults[b.id],
    )
  })
}

export function normalizeMessagesForAPI(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  messages
    .filter(_ => _.type !== 'progress')
    .forEach(message => {
      switch (message.type) {
        case 'user': {
          // If the current message is not a tool result, add it to the result
          if (
            !Array.isArray(message.message.content) ||
            message.message.content[0]?.type !== 'tool_result'
          ) {
            result.push(message)
            return
          }

          // If the last message is not a tool result, add it to the result
          const lastMessage = last(result)
          if (
            !lastMessage ||
            lastMessage?.type === 'assistant' ||
            !Array.isArray(lastMessage.message.content) ||
            lastMessage.message.content[0]?.type !== 'tool_result'
          ) {
            result.push(message)
            return
          }

          // Otherwise, merge the current message with the last message
          result[result.indexOf(lastMessage)] = {
            ...lastMessage,
            message: {
              ...lastMessage.message,
              content: [
                ...lastMessage.message.content,
                ...message.message.content,
              ],
            },
          }
          return
        }
        case 'assistant':
          result.push(message)
          return
      }
    })
  return result
}

// Sometimes the API returns empty messages (eg. "\n\n"). We need to filter these out,
// otherwise they will give an API error when we send them to the API next time we call query().
export function normalizeContentFromAPI(
  content: APIMessage['content'],
): APIMessage['content'] {
  const filteredContent = content.filter(
    _ => _.type !== 'text' || _.text.trim().length > 0,
  )

  if (filteredContent.length === 0) {
    return [{ type: 'text', text: NO_CONTENT_MESSAGE }]
  }

  return filteredContent
}

export function isEmptyMessageText(text: string): boolean {
  return (
    stripSystemMessages(text).trim() === '' ||
    text.trim() === NO_CONTENT_MESSAGE
  )
}
const STRIPPED_TAGS = [
  'commit_analysis',
  'context',
  'function_analysis',
  'pr_analysis',
]

export function stripSystemMessages(content: string): string {
  const regex = new RegExp(`<(${STRIPPED_TAGS.join('|')})>.*?</\\1>\n?`, 'gs')
  return content.replace(regex, '').trim()
}

export function getToolUseID(message: NormalizedMessage): string | null {
  switch (message.type) {
    case 'assistant': {
      if (!Array.isArray(message.message.content)) return null
      const tu = message.message.content.find(
        (b): b is ToolUseBlockParam => b?.type === 'tool_use',
      )
      return tu?.id ?? null
    }
    case 'user': {
      const content = message.message.content
      if (!Array.isArray(content)) return null
      const tr = content.find(
        (b): b is ToolResultBlockParam => b?.type === 'tool_result',
      )
      return tr?.tool_use_id ?? null
    }
    case 'progress':
      return message.toolUseID
  }
}

export function getLastAssistantMessageId(
  messages: Message[],
): string | undefined {
  // Iterate from the end of the array to find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      return message.message.id
    }
  }
  return undefined
}
