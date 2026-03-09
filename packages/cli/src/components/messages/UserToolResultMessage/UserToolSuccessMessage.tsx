import { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box } from 'ink'
import * as React from 'react'
import { Tool } from '../../../Tool.js'
import { Message, UserMessage } from '../../../query.js'
import { useGetToolFromMessages } from './utils.js'
import { getGenericToolForCoreName } from '../../../tools/GenericCoreTool.js'

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
  const generic = getGenericToolForCoreName(tool.name)
  const resultData = message.toolUseResult?.data ?? param.content

  let rendered: React.ReactNode
  try {
    rendered = tool.renderToolResultMessage?.(resultData as never, {
      verbose,
    })
  } catch {
    // Some legacy CLI tool renderers expect old structured result shapes.
    // Nexus/core tools often return plain text, so fall back to a generic renderer.
    rendered = generic.renderToolResultMessage?.(param.content as never, {
      verbose,
    })
  }

  return (
    // TODO: Distinguish UserMessage from UserToolResultMessage
    <Box flexDirection="column" width={width}>
      {rendered}
    </Box>
  )
}
