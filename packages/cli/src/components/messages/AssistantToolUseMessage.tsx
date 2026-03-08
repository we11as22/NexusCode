import { Box, Text } from 'ink'
import React from 'react'
import { logError } from '../../utils/log.js'
import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Tool } from '../../Tool.js'
import { Cost } from '../Cost.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { getTheme } from '../../utils/theme.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { ThinkTool } from '../../tools/ThinkTool/ThinkTool.js'
import type { SubAgentState } from '../../nexus-subagents.js'
import { subagentStatusLine, truncateTask } from '../../nexus-subagents.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

type Props = {
  param: ToolUseBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  verbose: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  /** Subagents for SpawnAgents (single or multiple); shown under the tool line. */
  subagents?: SubAgentState[]
}

export function AssistantToolUseMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  verbose,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  subagents = [],
}: Props): React.ReactNode {
  const tool = tools.find(_ => _.name === param.name)
  if (!tool) {
    logError(`Tool ${param.name} not found`)
    return null
  }
  const isQueued =
    !inProgressToolUseIDs.has(param.id) && unresolvedToolUseIDs.has(param.id)
  // Keeping color undefined makes the OS use the default color regardless of appearance
  const color = isQueued ? getTheme().secondaryText : undefined

  // TODO: Avoid this special case
  if (tool === ThinkTool) {
    // params were already validated in query(), so this won't throe
    const { thought } = ThinkTool.inputSchema.parse(param.input)
    return (
      <AssistantThinkingMessage
        param={{ thinking: thought, signature: '', type: 'thinking' }}
        addMargin={addMargin}
      />
    )
  }

  const userFacingToolName = tool.userFacingName(param.input as never)
  const mainBlock = (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Box>
        <Box
          flexWrap="nowrap"
          minWidth={userFacingToolName.length + (shouldShowDot ? 2 : 0)}
        >
          {shouldShowDot &&
            (isQueued ? (
              <Box minWidth={2}>
                <Text color={color}>{BLACK_CIRCLE}</Text>
              </Box>
            ) : (
              <ToolUseLoader
                shouldAnimate={shouldAnimate}
                isUnresolved={unresolvedToolUseIDs.has(param.id)}
                isError={erroredToolUseIDs.has(param.id)}
              />
            ))}
          <Text color={color} bold={!isQueued}>
            {userFacingToolName}
          </Text>
        </Box>
        <Box flexWrap="nowrap">
          {Object.keys(param.input as { [key: string]: unknown }).length >
            0 && (
            <Text color={color}>
              (
              {tool.renderToolUseMessage(param.input as never, {
                verbose,
              })}
              )
            </Text>
          )}
          <Text color={color}>…</Text>
        </Box>
      </Box>
      <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
    </Box>
  )
  const showSubagents = param.name === 'SpawnAgents' && subagents.length > 0
  if (!showSubagents) return mainBlock
  return (
    <Box flexDirection="column" width="100%">
      {mainBlock}
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {subagents.map((sa) => (
          <Box key={sa.id} flexDirection="column" marginBottom={1}>
            <Text color={color}>{truncateTask(sa.task)}</Text>
            <Text color={getTheme().secondaryText}>{subagentStatusLine(sa)}</Text>
            {sa.error && sa.status === 'error' ? (
              <Text color={getTheme().error}>{truncateTask(sa.error, 72)}</Text>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  )
}
