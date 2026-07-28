import type React from 'react'
import { describe, expect, it } from 'vitest'
import type { ToolUseContext } from '../Tool.js'
import help from './help.js'

describe('/help command', () => {
  it('closes as a modal without submitting a synthetic chat turn', async () => {
    let closeResult:
      | string
      | { cancelled?: boolean; saved?: boolean }
      | undefined
    const context = {
      abortController: new AbortController(),
      options: {
        commands: [help],
        tools: [],
        forkNumber: 0,
        messageLogName: 'test',
        maxThinkingTokens: 0,
      },
      readFileTimestamps: {},
      setForkConvoWithMessagesOnTheNextRender() {},
    } satisfies ToolUseContext & {
      setForkConvoWithMessagesOnTheNextRender: () => void
    }

    const view = (await help.call(
      result => {
        closeResult = result
      },
      context,
    )) as React.ReactElement<{ onClose: () => void }>

    view.props.onClose()

    expect(closeResult).toEqual({ cancelled: true })
  })
})
