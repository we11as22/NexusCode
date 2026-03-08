import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Message } from '../../../query.js'
import { useMemo } from 'react'
import { Tool } from '../../../Tool.js'
import { GlobTool } from '../../../tools/GlobTool/GlobTool.js'
import { GrepTool } from '../../../tools/GrepTool/GrepTool.js'
import { logEvent } from '../../../services/statsig.js'

function getToolUseFromMessages(
  toolUseID: string,
  messages: Message[],
): ToolUseBlockParam | null {
  let toolUse: ToolUseBlockParam | null = null
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const content of message.message.content) {
        if (content.type === 'tool_use' && content.id === toolUseID) {
          return content
        }
      }
    }
    // Nexus path: tool_use is first emitted inside a ProgressMessage (tool_start);
    // assistant_content_complete may come later. So we must resolve tool_use from progress too.
    if (message.type === 'progress' && Array.isArray(message.content?.message?.content)) {
      for (const content of message.content.message.content) {
        if (content.type === 'tool_use' && content.id === toolUseID) {
          return content
        }
      }
    }
  }
  return toolUse
}

export function useGetToolFromMessages(
  toolUseID: string,
  tools: Tool[],
  messages: Message[],
) {
  return useMemo(() => {
    const toolUse = getToolUseFromMessages(toolUseID, messages)
    if (!toolUse) {
      throw new ReferenceError(
        `Tool use not found for tool_use_id ${toolUseID}`,
      )
    }
    // Hack: we don't expose GlobTool and GrepTool in getTools anymore,
    // but we still want to be able to load old transcripts.
    // TODO: Remove this when logging hits zero
    const tool = [...tools, GlobTool, GrepTool].find(
      _ => _.name === toolUse.name,
    )
    if (tool === GlobTool || tool === GrepTool) {
      logEvent('tengu_legacy_tool_lookup', {})
    }
    if (!tool) {
      throw new ReferenceError(`Tool not found for ${toolUse.name}`)
    }
    return { tool, toolUse }
  }, [toolUseID, messages, tools])
}
