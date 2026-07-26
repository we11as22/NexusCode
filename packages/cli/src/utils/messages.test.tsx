import { describe, expect, it } from 'vitest'

import type { ToolUseContext } from '../Tool.js'
import { processUserInput } from './messages.js'

function context(
  resolvePromptCommand: NonNullable<
    ToolUseContext['options']['resolvePromptCommand']
  >,
): ToolUseContext & {
  setForkConvoWithMessagesOnTheNextRender: () => void
} {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      forkNumber: 0,
      messageLogName: 'test',
      maxThinkingTokens: 0,
      resolvePromptCommand,
    },
    readFileTimestamps: {},
    setForkConvoWithMessagesOnTheNextRender() {},
  }
}

describe('Nexus custom slash commands', () => {
  it('submits a resolved prompt command as the user prompt', async () => {
    const messages = await processUserInput(
      '/plugin:demo:review careful',
      'prompt',
      () => {},
      context(async (name, args) => ({
        status: 'resolved',
        prompt: `${name}:${args}`,
      })),
      null,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'user',
      message: { content: 'plugin:demo:review:careful' },
    })
  })

  it('reports ambiguous plugin shorthands without querying the model', async () => {
    const messages = await processUserInput(
      '/review',
      'prompt',
      () => {},
      context(async () => ({
        status: 'ambiguous',
        candidates: ['plugin:alpha:review', 'plugin:beta:review'],
      })),
      null,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('assistant')
    expect(JSON.stringify(messages[0])).toContain('/plugin:alpha:review')
  })
})
