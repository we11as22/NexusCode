import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Message } from '../../../query.js'
import { useMemo } from 'react'
import { Tool } from '../../../Tool.js'
import { getGenericToolForCoreName } from '../../../tools/GenericCoreTool.js'
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
    // Nexus runAgentLoop uses part_* ids; those tool result/input payloads differ from legacy CLI tools.
    // Use generic renderer for Nexus tool uses to avoid shape-mismatch crashes in legacy renderers.
    const isNexusToolUse = toolUseID.startsWith('part_')
    const found = isNexusToolUse ? undefined : tools.find(_ => _.name === toolUse.name)
    const tool = found ?? getGenericToolForCoreName(toolUse.name)
    if (!found && !isNexusToolUse) {
      logEvent('tengu_nexus_generic_tool_display', { name: toolUse.name })
    }
    return { tool, toolUse }
  }, [toolUseID, messages, tools])
}
