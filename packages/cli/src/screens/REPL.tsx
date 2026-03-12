import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Newline, Static, Text } from 'ink'
import ProjectOnboarding, {
  markProjectOnboardingComplete,
} from '../ProjectOnboarding.js'
import { CostThresholdDialog } from '../components/CostThresholdDialog.js'
import { NexusApprovalPanel } from '../components/NexusApprovalPanel.js'
import { NexusSubagentBlock } from '../components/NexusSubagentBlock.js'
import { NexusTodoBlock } from '../components/NexusTodoBlock.js'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Command } from '../commands.js'
import { Logo } from '../components/Logo.js'
import { Message } from '../components/Message.js'
import { MessageSelector } from '../components/MessageSelector.js'
import {
  PermissionRequest,
  ToolUseConfirm,
} from '../components/permissions/PermissionRequest.js'
import PromptInput from '../components/PromptInput.js'
import { Spinner } from '../components/Spinner.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getContext } from '../context.js'
import { getTotalCost, useCostSummary } from '../cost-tracker.js'
import { useLogStartupTime } from '../hooks/useLogStartupTime.js'
import { addToHistory } from '../history.js'
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js'
import { useCancelRequest } from '../hooks/useCancelRequest.js'
import useCanUseTool from '../hooks/useCanUseTool.js'
import { useLogMessages } from '../hooks/useLogMessages.js'
import { setMessagesGetter, setMessagesSetter } from '../messages.js'
import {
  AssistantMessage,
  BinaryFeedbackResult,
  Message as MessageType,
  ProgressMessage,
  query,
} from '../query.js'
import { queryNexus } from '../nexus-query.js'
import type { NexusApprovalMessage, NexusBannerMessage, NexusTodoMessage } from '../nexus-query.js'
import type { AutoApprovePermissions } from '../nexus-query.js'
import type { WrappedClient } from '../services/mcpClient.js'
import type { Tool } from '../Tool.js'
import { AutoUpdaterResult } from '../utils/autoUpdater.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logEvent } from '../services/statsig.js'
import { getNextAvailableLogForkNumber } from '../utils/log.js'
import {
  getErroredToolUseMessages,
  getInProgressToolUseIDs,
  getLastAssistantMessageId,
  getToolUseID,
  getUnresolvedToolUseIDs,
  INTERRUPT_MESSAGE,
  isNotEmptyMessage,
  type NormalizedMessage,
  normalizeMessages,
  normalizeMessagesForAPI,
  processUserInput,
  reorderMessages,
} from '../utils/messages.js'
import { getSlowAndCapableModel } from '../utils/model.js'
import { clearTerminal, updateTerminalTitle } from '../utils/terminal.js'
import { BinaryFeedback } from '../components/binary-feedback/BinaryFeedback.js'
import { getMaxThinkingTokens } from '../utils/thinking.js'
import { getOriginalCwd } from '../utils/state.js'
import type { ConfigSnapshot } from '../nexus-bootstrap.js'
import { reduceSubagentEvent } from '../nexus-subagents.js'
import type { RestoreType } from '../task-restore.js'
import type { SessionMessage, ToolPart } from '@nexuscode/core'
import type { SessionDiffEntry } from '../components/NexusSessionDiffBlock.js'
import { NexusSessionDiffBlock } from '../components/NexusSessionDiffBlock.js'

const NEXUS_MODES = ['agent', 'plan', 'ask', 'debug', 'review'] as const
function cycleNexusMode(current: string): string {
  const i = NEXUS_MODES.indexOf(current as (typeof NEXUS_MODES)[number])
  return NEXUS_MODES[(i + 1) % NEXUS_MODES.length] ?? 'agent'
}

function buildInitialAutoApproveState(
  snapshot: ConfigSnapshot | undefined,
): AutoApprovePermissions {
  const perms = snapshot?.permissions
  return {
    read: perms?.autoApproveRead ?? true,
    write: perms?.autoApproveWrite ?? false,
    execute: perms?.autoApproveCommand ?? false,
    mcp: perms?.autoApproveMcp ?? false,
    browser: perms?.autoApproveBrowser ?? false,
  }
}

function getSessionDiffFromMessages(messages: SessionMessage[] | undefined): SessionDiffEntry[] {
  if (!messages?.length) return []
  const entries: SessionDiffEntry[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const p of content) {
      if (p.type !== 'tool') continue
      const tp = p as ToolPart
      if ((tp.tool === 'Write' || tp.tool === 'Edit') && tp.status === 'completed' && tp.path) {
        entries.push({
          file: tp.path,
          additions: tp.diffStats?.added ?? 0,
          deletions: tp.diffStats?.removed ?? 0,
        })
      }
    }
  }
  return entries
}

type Props = {
  commands: Command[]
  dangerouslySkipPermissions?: boolean
  debug?: boolean
  initialForkNumber?: number | undefined
  initialPrompt: string | undefined
  // A unique name for the message log file, used to identify the fork
  messageLogName: string
  shouldShowPromptInput: boolean
  tools: Tool[]
  verbose: boolean | undefined
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[]
  // MCP clients
  mcpClients?: WrappedClient[]
  // Flag to indicate if current model is default
  isDefaultModel?: boolean
  // Nexus integration (optional until agent is wired)
  nexusConfigSnapshot?: ConfigSnapshot
  nexusInitialMode?: string
  nexusNoIndex?: boolean
  nexusSessionId?: string
  nexusGetCheckpointList?: () => Promise<Array<{ hash: string; ts: number; description?: string }>>
  nexusOnRestoreCheckpoint?: (checkpointId: string, type: RestoreType) => Promise<void>
  nexusGetSessionList?: () => Promise<Array<{ id: string }>>
  nexusOnSwitchSession?: (sessionId: string) => Promise<void>
  nexusOnDeleteSession?: (sessionId: string) => Promise<void>
  nexusSaveConfig?: () => Promise<void>
  nexusOnReindex?: () => void
  /** Full bootstrap result for Nexus agent (when set, REPL uses queryNexus instead of query) */
  nexusBootstrap?: import('../nexus-bootstrap.js').NexusBootstrapResult
  /** Called when a Nexus panel saves config so the header can show the new model/index */
  onNexusConfigSaved?: () => void | Promise<void>
}

function getUserPromptFromMessage(m: MessageType): string {
  if (m.type !== 'user') return ''
  const c = m.message.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .map((block) => (block.type === 'text' ? (block as { text: string }).text : ''))
      .join('')
      .trim()
  }
  return ''
}

export type BinaryFeedbackContext = {
  m1: AssistantMessage
  m2: AssistantMessage
  resolve: (result: BinaryFeedbackResult) => void
}

export function REPL({
  commands,
  dangerouslySkipPermissions,
  debug = false,
  initialForkNumber = 0,
  initialPrompt,
  messageLogName,
  shouldShowPromptInput,
  tools,
  verbose: verboseFromCLI,
  initialMessages,
  mcpClients = [],
  isDefaultModel = true,
  nexusConfigSnapshot,
  nexusInitialMode,
  nexusNoIndex,
  nexusSessionId,
  nexusGetCheckpointList,
  nexusOnRestoreCheckpoint,
  nexusGetSessionList,
  nexusOnSwitchSession,
  nexusOnDeleteSession,
  nexusSaveConfig,
  nexusOnReindex,
  nexusBootstrap,
  onNexusConfigSaved,
}: Props): React.ReactNode {
  // TODO: probably shouldn't re-read config from file synchronously on every keystroke
  const verbose = verboseFromCLI ?? getGlobalConfig().verbose

  // Used to force the logo to re-render and conversation log to use a new file
  const [forkNumber, setForkNumber] = useState(
    getNextAvailableLogForkNumber(messageLogName, initialForkNumber, 0),
  )

  const [
    forkConvoWithMessagesOnTheNextRender,
    setForkConvoWithMessagesOnTheNextRender,
  ] = useState<MessageType[] | null>(null)

  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [autoUpdaterResult, setAutoUpdaterResult] =
    useState<AutoUpdaterResult | null>(null)
  const [toolJSX, setToolJSX] = useState<{
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
  } | null>(null)
  const [toolUseConfirm, setToolUseConfirm] = useState<ToolUseConfirm | null>(
    null,
  )
  const [messages, setMessages] = useState<MessageType[]>(initialMessages ?? [])
  const [inputValue, setInputValue] = useState('')
  const [inputMode, setInputMode] = useState<'bash' | 'prompt'>('prompt')
  const [submitCount, setSubmitCount] = useState(0)
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] =
    useState(false)
  const [showCostDialog, setShowCostDialog] = useState(false)
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(
    getGlobalConfig().hasAcknowledgedCostThreshold,
  )

  const [binaryFeedbackContext, setBinaryFeedbackContext] =
    useState<BinaryFeedbackContext | null>(null)

  /** Ref for Nexus agent approval dialog (write/execute/mcp/doom_loop). When set, panel calls it to resolve. */
  const tuiApprovalRef = useRef<((r: import('@nexuscode/core').PermissionResult) => void) | null>(null)
  /** Active Nexus approval request shown inline below chat (prevents scroll jump to top). */
  const [nexusApprovalAction, setNexusApprovalAction] = useState<
    { action: import('@nexuscode/core').ApprovalAction; partId: string } | null
  >(null)
  /** Host from last completed Nexus run; used by /undo to revert file edits. */
  const lastNexusHostRef = useRef<import('../host.js').CliHost | null>(null)
  /** Banner above input (e.g. "Compacting conversation…", "Loop detected…"). */
  const [nexusBannerText, setNexusBannerText] = useState('')
  /** Todo list from agent (TodoWrite). Rendered above input, below progress. */
  const [nexusTodo, setNexusTodo] = useState('')

  /** Subagents per SpawnAgents tool partId (single and multiple). Updated via onSubagentEvent from queryNexus. */
  const [subagentsByPartId, setSubagentsByPartId] = useState<
    Record<string, import('../nexus-subagents.js').SubAgentState[]>
  >({})

  /** Nexus mode for the next run (agent/plan/ask/debug/review). Shown below input; Shift+Tab to change mode. */
  const [nexusModeOverride, setNexusModeOverride] = useState<string>(
    () => nexusInitialMode ?? 'agent',
  )

  /** Granular auto-approve controls for Nexus tools (read/write/execute/mcp/browser). */
  const [nexusAutoApprove, setNexusAutoApprove] = useState<AutoApprovePermissions>(
    () => buildInitialAutoApproveState(nexusConfigSnapshot),
  )
  useEffect(() => {
    if (!nexusConfigSnapshot) return
    setNexusAutoApprove(buildInitialAutoApproveState(nexusConfigSnapshot))
  }, [nexusConfigSnapshot])
  const nexusAcceptEditsEnabled = useMemo(
    () =>
      nexusAutoApprove.read &&
      nexusAutoApprove.write &&
      nexusAutoApprove.execute &&
      nexusAutoApprove.mcp &&
      nexusAutoApprove.browser,
    [nexusAutoApprove],
  )
  /** Collapsed/expanded details for tool inputs in chat. Toggle with Ctrl+O. */
  const [toolDetailsExpanded, setToolDetailsExpanded] = useState(false)

  const hasRunningSubagent = useMemo(
    () =>
      Object.values(subagentsByPartId)
        .flat()
        .some(sa => sa.status === 'running'),
    [subagentsByPartId],
  )

  const sessionDiffEntries = useMemo(
    () => getSessionDiffFromMessages(nexusBootstrap?.session?.messages),
    [nexusBootstrap?.session?.messages, messages.length],
  )

  const toggleNexusAutoApproveAction = useCallback(
    (action: keyof AutoApprovePermissions) => {
      setNexusAutoApprove(prev => ({ ...prev, [action]: !prev[action] }))
    },
    [],
  )

  const toggleNexusAutoApproveAll = useCallback(() => {
    setNexusAutoApprove(prev => {
      const enableAll = !(prev.read && prev.write && prev.execute && prev.mcp && prev.browser)
      return {
        read: enableAll,
        write: enableAll,
        execute: enableAll,
        mcp: enableAll,
        browser: enableAll,
      }
    })
  }, [])

  /** Revert last assistant turn and file edits (/undo). */
  const onNexusUndo = useCallback(async () => {
    const host = lastNexusHostRef.current
    const session = nexusBootstrap?.session
    if (!host || !session || session.messages.length < 2) return
    const msgs = session.messages
    const lastUserIdx = [...msgs].reverse().findIndex(m => m.role === 'user')
    if (lastUserIdx === -1) return
    const lastUserMessage = msgs[msgs.length - 1 - lastUserIdx]
    if (!lastUserMessage) return
    session.rewindBeforeTimestamp(lastUserMessage.ts)
    await host.revertLastTurnFiles()
    await session.save().catch(() => {})
    setMessages(prev => (prev.length >= 2 ? prev.slice(0, -2) : prev))
  }, [nexusBootstrap])

  const getBinaryFeedbackResponse = useCallback(
    (
      m1: AssistantMessage,
      m2: AssistantMessage,
    ): Promise<BinaryFeedbackResult> => {
      return new Promise<BinaryFeedbackResult>(resolvePromise => {
        setBinaryFeedbackContext({
          m1,
          m2,
          resolve: resolvePromise,
        })
      })
    },
    [],
  )

  const readFileTimestamps = useRef<{
    [filename: string]: number
  }>({})

  const { status: apiKeyStatus, reverify } = useApiKeyVerification()
  function onCancel() {
    if (!isLoading) {
      return
    }
    setIsLoading(false)
    if (toolUseConfirm) {
      // Tool use confirm handles the abort signal itself
      toolUseConfirm.onAbort()
    } else {
      abortController?.abort()
    }
  }

  useCancelRequest(
    setToolJSX,
    setToolUseConfirm,
    setBinaryFeedbackContext,
    onCancel,
    isLoading,
    isMessageSelectorVisible,
    abortController?.signal,
    !!toolJSX,
  )

  useEffect(() => {
    if (forkConvoWithMessagesOnTheNextRender) {
      setForkNumber(_ => _ + 1)
      setForkConvoWithMessagesOnTheNextRender(null)
      setMessages(forkConvoWithMessagesOnTheNextRender)
    }
  }, [forkConvoWithMessagesOnTheNextRender])

  useEffect(() => {
    const totalCost = getTotalCost()
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {})
      setShowCostDialog(true)
    }
  }, [messages, showCostDialog, haveShownCostDialog])

  const canUseTool = useCanUseTool(setToolUseConfirm)

  async function onInit() {
    reverify()

    if (!initialPrompt) {
      return
    }

    setIsLoading(true)

    const abortController = new AbortController()
    setAbortController(abortController)

    const model = await getSlowAndCapableModel()
    const newMessages = await processUserInput(
      initialPrompt,
      'prompt',
      setToolJSX,
      {
        abortController,
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          slowAndCapableModel: model,
          maxThinkingTokens: 0,
        },
        messageId: getLastAssistantMessageId(messages),
        setForkConvoWithMessagesOnTheNextRender,
        readFileTimestamps: readFileTimestamps.current,
      },
      null,
    )

    if (newMessages.length) {
      for (const message of newMessages) {
        if (message.type === 'user') {
          addToHistory(initialPrompt)
          // TODO: setHistoryIndex
        }
      }
      setMessages(_ => [..._, ...newMessages])

      // The last message is an assistant message if the user input was a bash command,
      // or if the user input was an invalid slash command.
      const lastMessage = newMessages[newMessages.length - 1]!
      if (lastMessage.type === 'assistant') {
        setAbortController(null)
        setIsLoading(false)
        return
      }

      const [systemPrompt, context, model, maxThinkingTokens] =
        await Promise.all([
          getSystemPrompt(),
          getContext(),
          getSlowAndCapableModel(),
          getMaxThinkingTokens([...messages, ...newMessages]),
        ])

      if (nexusBootstrap) {
        const userPrompt = newMessages.map(getUserPromptFromMessage).filter(Boolean).join('\n') || ''
        if (!userPrompt) {
          setIsLoading(false)
          return
        }
        for await (const message of queryNexus({
          nexus: nexusBootstrap,
          userPrompt,
          repoTools: tools,
          signal: abortController.signal,
          autoApprove: !!dangerouslySkipPermissions,
          autoApprovePermissions: nexusAutoApprove,
          modeOverride: nexusModeOverride,
          tuiApprovalRef,
          onSubagentEvent: (partId, event) => {
            setSubagentsByPartId(prev => ({
              ...prev,
              [partId]: reduceSubagentEvent(prev[partId] ?? [], event),
            }))
          },
          onRunComplete: (h) => { lastNexusHostRef.current = h },
        })) {
          if (message && 'type' in message && message.type === 'nexus_approval') {
            const approvalMsg = message as NexusApprovalMessage
            setNexusApprovalAction({
              action: approvalMsg.action,
              partId: approvalMsg.partId,
            })
            continue
          }
          if (message && 'type' in message && message.type === 'nexus_banner') {
            setNexusBannerText((message as NexusBannerMessage).text)
            continue
          }
          if (message && 'type' in message && message.type === 'nexus_todo') {
            setNexusTodo((message as NexusTodoMessage).todo)
            continue
          }
          setMessages(oldMessages => [...oldMessages, message as MessageType])
        }
      } else {
        for await (const message of query(
          [...messages, ...newMessages],
          systemPrompt,
          context,
          canUseTool,
          {
            options: {
              commands,
              forkNumber,
              messageLogName,
              tools,
              slowAndCapableModel: model,
              verbose,
              dangerouslySkipPermissions,
              maxThinkingTokens,
            },
            messageId: getLastAssistantMessageId([...messages, ...newMessages]),
            readFileTimestamps: readFileTimestamps.current,
            abortController,
            setToolJSX,
          },
          getBinaryFeedbackResponse,
        )) {
          setMessages(oldMessages => [...oldMessages, message])
        }
      }
    } else {
      addToHistory(initialPrompt)
      // TODO: setHistoryIndex
    }

    setHaveShownCostDialog(
      getGlobalConfig().hasAcknowledgedCostThreshold || false,
    )

    setNexusApprovalAction(null)
    setIsLoading(false)
  }

  async function onQuery(
    newMessages: MessageType[],
    abortController: AbortController,
  ) {
    setMessages(oldMessages => [...oldMessages, ...newMessages])

    // Mark onboarding as complete when any user message is sent
    markProjectOnboardingComplete()

    // The last message is an assistant message if the user input was a bash command,
    // or if the user input was an invalid slash command.
    const lastMessage = newMessages[newMessages.length - 1]!

    // Update terminal title based on user message
    if (
      lastMessage.type === 'user' &&
      typeof lastMessage.message.content === 'string'
    ) {
      updateTerminalTitle(lastMessage.message.content)
    }
    if (lastMessage.type === 'assistant') {
      setAbortController(null)
      setIsLoading(false)
      return
    }

    const [systemPrompt, context, model, maxThinkingTokens] = await Promise.all(
      [
        getSystemPrompt(),
        getContext(),
        getSlowAndCapableModel(),
        getMaxThinkingTokens([...messages, lastMessage]),
      ],
    )

    if (nexusBootstrap) {
      const userPrompt = getUserPromptFromMessage(lastMessage)
      if (!userPrompt) {
        setIsLoading(false)
        return
      }
      for await (const message of queryNexus({
        nexus: nexusBootstrap,
        userPrompt,
        repoTools: tools,
        signal: abortController.signal,
        autoApprove: !!dangerouslySkipPermissions,
        autoApprovePermissions: nexusAutoApprove,
        modeOverride: nexusModeOverride,
        tuiApprovalRef,
        onSubagentEvent: (partId, event) => {
          setSubagentsByPartId(prev => ({
            ...prev,
            [partId]: reduceSubagentEvent(prev[partId] ?? [], event),
          }))
        },
        onRunComplete: (h) => { lastNexusHostRef.current = h },
      })) {
        if (message && 'type' in message && message.type === 'nexus_approval') {
          const approvalMsg = message as NexusApprovalMessage
          setNexusApprovalAction({
            action: approvalMsg.action,
            partId: approvalMsg.partId,
          })
          continue
        }
        if (message && 'type' in message && message.type === 'nexus_banner') {
          setNexusBannerText((message as NexusBannerMessage).text)
          continue
        }
        if (message && 'type' in message && message.type === 'nexus_todo') {
          setNexusTodo((message as NexusTodoMessage).todo)
          continue
        }
        setMessages(oldMessages => [...oldMessages, message as MessageType])
      }
    } else {
      for await (const message of query(
        [...messages, lastMessage],
        systemPrompt,
        context,
        canUseTool,
        {
          options: {
            commands,
            forkNumber,
            messageLogName,
            tools,
            slowAndCapableModel: model,
            verbose,
            dangerouslySkipPermissions,
            maxThinkingTokens,
          },
          messageId: getLastAssistantMessageId([...messages, lastMessage]),
          readFileTimestamps: readFileTimestamps.current,
          abortController,
          setToolJSX,
        },
        getBinaryFeedbackResponse,
      )) {
        setMessages(oldMessages => [...oldMessages, message])
      }
    }
    setNexusApprovalAction(null)
    setIsLoading(false)
  }

  // Register cost summary tracker
  useCostSummary()

  // Register messages getter and setter
  useEffect(() => {
    const getMessages = () => messages
    setMessagesGetter(getMessages)
    setMessagesSetter(setMessages)
  }, [messages])

  // Record transcripts locally, for debugging and conversation recovery
  useLogMessages(messages, messageLogName, forkNumber)

  // Log startup time
  useLogStartupTime()

  // Initial load
  useEffect(() => {
    onInit()
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Print resume hint on exit when in Nexus mode
  useEffect(() => {
    return () => {
      if (nexusSessionId) {
        process.stdout.write(
          '\nResume this session with:\nnexus --session ' +
            nexusSessionId +
            '\n',
        )
      }
    }
  }, [nexusSessionId])

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages).filter(isNotEmptyMessage),
    [messages],
  )

  const unresolvedToolUseIDs = useMemo(
    () => getUnresolvedToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const inProgressToolUseIDs = useMemo(
    () => getInProgressToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const erroredToolUseIDs = useMemo(
    () =>
      new Set(
        getErroredToolUseMessages(normalizedMessages).map(
          _ => (_.message.content[0]! as ToolUseBlockParam).id,
        ),
      ),
    [normalizedMessages],
  )

  const messagesJSX = useMemo(
    () =>
      reorderMessages(normalizedMessages)
        .map(_ => {
          // Progress items are only for in-flight tool calls.
          // Once a matching tool_result arrives, hide progress and keep the final tool_use line.
          if (_.type === 'progress' && !unresolvedToolUseIDs.has(_.toolUseID)) {
            return null
          }
          const toolUseID = getToolUseID(_)
          const message =
            _.type === 'progress' ? (
              _.content.message.content[0]?.type === 'text' &&
              // AgentTool interrupts use text progress payloads.
              _.content.message.content[0].text === INTERRUPT_MESSAGE ? (
                <Message
                  message={_.content}
                  messages={_.normalizedMessages}
                  addMargin={false}
                  tools={_.tools}
                  verbose={verbose ?? false}
                  debug={debug}
                  erroredToolUseIDs={new Set()}
                  inProgressToolUseIDs={new Set()}
                  unresolvedToolUseIDs={new Set()}
                  shouldAnimate={false}
                  shouldShowDot={true}
                  subagentsByPartId={subagentsByPartId}
                  expandToolDetails={toolDetailsExpanded}
                />
              ) : (
                <Message
                  message={_.content}
                  messages={_.normalizedMessages}
                  addMargin={false}
                  tools={_.tools}
                  verbose={verbose ?? false}
                  debug={debug}
                  erroredToolUseIDs={new Set()}
                  inProgressToolUseIDs={new Set()}
                  unresolvedToolUseIDs={
                    new Set([
                      (_.content.message.content[0]! as ToolUseBlockParam).id,
                    ])
                  }
                  shouldAnimate={false}
                  shouldShowDot={true}
                  subagentsByPartId={subagentsByPartId}
                  expandToolDetails={toolDetailsExpanded}
                />
              )
            ) : (
              <Message
                message={_}
                messages={normalizedMessages}
                addMargin={true}
                tools={tools}
                verbose={verbose}
                debug={debug}
                erroredToolUseIDs={erroredToolUseIDs}
                inProgressToolUseIDs={inProgressToolUseIDs}
                shouldAnimate={
                  !toolJSX &&
                  !toolUseConfirm &&
                  !isMessageSelectorVisible &&
                  (!toolUseID || inProgressToolUseIDs.has(toolUseID))
                }
                shouldShowDot={true}
                unresolvedToolUseIDs={unresolvedToolUseIDs}
                subagentsByPartId={subagentsByPartId}
                expandToolDetails={toolDetailsExpanded}
              />
            )

          const type = shouldRenderStatically(
            _,
            normalizedMessages,
            unresolvedToolUseIDs,
          )
            ? 'static'
            : 'transient'

          if (debug) {
            return {
              type,
              jsx: (
                <Box
                  borderStyle="single"
                  borderColor={type === 'static' ? 'green' : 'red'}
                  key={_.uuid}
                  width="100%"
                >
                  {message}
                </Box>
              ),
            }
          }

          return {
            type,
            jsx: (
              <Box key={_.uuid} width="100%">
                {message}
              </Box>
            ),
          }
        })
        .filter(
          (
            item,
          ): item is {
            type: 'static' | 'transient'
            jsx: React.ReactNode
          } => item !== null,
        ),
    [
      normalizedMessages,
      tools,
      verbose,
      debug,
      erroredToolUseIDs,
      inProgressToolUseIDs,
      toolJSX,
      toolUseConfirm,
      isMessageSelectorVisible,
      unresolvedToolUseIDs,
      mcpClients,
      isDefaultModel,
      nexusBootstrap,
      nexusConfigSnapshot,
      nexusModeOverride,
      nexusSessionId,
      subagentsByPartId,
      toolDetailsExpanded,
    ],
  )

  const staticMessageItems = messagesJSX.filter(_ => _.type === 'static')
  const staticItemsWithHeader = useMemo(
    () => [{ id: 'header' as const }, ...staticMessageItems],
    [staticMessageItems],
  )

  // only show the dialog once not loading
  const showingCostDialog = !isLoading && showCostDialog

  // When approval is requested (Nexus), show todo list above the approval panel instead of chat
  if (toolJSX) {
    return (
      <>
        <Box flexDirection="column" width="100%">
          {nexusBootstrap ? (
            <NexusSubagentBlock
              subagentsByPartId={subagentsByPartId}
              isLoading={isLoading}
            />
          ) : null}
          {nexusBootstrap && nexusTodo.trim() ? (
            <NexusTodoBlock todo={nexusTodo} />
          ) : null}
          {toolJSX.jsx}
        </Box>
        <Newline />
      </>
    )
  }

  return (
    <>
      <Static
        key={`static-messages-${forkNumber}`}
        items={staticItemsWithHeader}
      >
        {item =>
          item.id === 'header' ? (
            <Box key="nexus-header" flexDirection="column">
              <Logo
                mcpClients={mcpClients}
                isDefaultModel={isDefaultModel}
                nexusMode={nexusBootstrap ? nexusModeOverride : undefined}
                nexusModel={nexusConfigSnapshot?.model?.id}
                nexusIndexEnabled={
                  nexusConfigSnapshot?.indexing?.enabled ??
                  (nexusBootstrap ? nexusBootstrap.indexEnabled : undefined)
                }
                nexusSessionId={nexusSessionId}
              />
              <ProjectOnboarding workspaceDir={getOriginalCwd()} />
            </Box>
          ) : (
            item.jsx
          )
        }
      </Static>
      {messagesJSX.filter(_ => _.type === 'transient').map(_ => _.jsx)}
      <Box
        borderColor="red"
        borderStyle={debug ? 'single' : undefined}
        flexDirection="column"
        width="100%"
      >
        {!toolUseConfirm && !binaryFeedbackContext && isLoading && (
          !(nexusBootstrap && hasRunningSubagent) ? <Spinner /> : null
        )}
        {!toolJSX && binaryFeedbackContext && !isMessageSelectorVisible && (
          <BinaryFeedback
            m1={binaryFeedbackContext.m1}
            m2={binaryFeedbackContext.m2}
            resolve={result => {
              binaryFeedbackContext.resolve(result)
              setTimeout(() => setBinaryFeedbackContext(null), 0)
            }}
            verbose={verbose}
            normalizedMessages={normalizedMessages}
            tools={tools}
            debug={debug}
            erroredToolUseIDs={erroredToolUseIDs}
            inProgressToolUseIDs={inProgressToolUseIDs}
            unresolvedToolUseIDs={unresolvedToolUseIDs}
          />
        )}
        {!toolJSX &&
          toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext && (
            <PermissionRequest
              toolUseConfirm={toolUseConfirm}
              onDone={() => setToolUseConfirm(null)}
              verbose={verbose}
            />
          )}
        {!toolJSX &&
          !toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          nexusApprovalAction && (
            <>
              {nexusBootstrap ? (
                <NexusSubagentBlock
                  subagentsByPartId={subagentsByPartId}
                  isLoading={isLoading}
                />
              ) : null}
              {nexusBootstrap && nexusTodo.trim() ? (
                <NexusTodoBlock todo={nexusTodo} />
              ) : null}
              <NexusApprovalPanel
                action={nexusApprovalAction.action}
                partId={nexusApprovalAction.partId}
                approvalRef={tuiApprovalRef}
                onClose={() => setNexusApprovalAction(null)}
                cwd={getOriginalCwd()}
              />
            </>
          )}

        {!toolJSX &&
          !toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          !nexusApprovalAction &&
          showingCostDialog && (
            <CostThresholdDialog
              onDone={() => {
                setShowCostDialog(false)
                setHaveShownCostDialog(true)
                const projectConfig = getGlobalConfig()
                saveGlobalConfig({
                  ...projectConfig,
                  hasAcknowledgedCostThreshold: true,
                })
                logEvent('tengu_cost_threshold_acknowledged', {})
              }}
            />
          )}

        {!toolUseConfirm &&
          shouldShowPromptInput &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          !nexusApprovalAction &&
          !showingCostDialog && (
            <>
              {nexusBannerText ? (
                <Box paddingX={1} marginTop={1}>
                  <Text dimColor>{nexusBannerText}</Text>
                </Box>
              ) : null}
              {nexusBootstrap ? (
                <NexusSubagentBlock
                  subagentsByPartId={subagentsByPartId}
                  isLoading={isLoading}
                />
              ) : null}
              {nexusBootstrap && nexusTodo.trim() ? (
                <NexusTodoBlock todo={nexusTodo} />
              ) : null}
              {nexusBootstrap && sessionDiffEntries.length > 0 ? (
                <NexusSessionDiffBlock entries={sessionDiffEntries} />
              ) : null}
              <PromptInput
                commands={commands}
                forkNumber={forkNumber}
                messageLogName={messageLogName}
                tools={tools}
                isDisabled={apiKeyStatus === 'invalid'}
                isLoading={isLoading}
                onQuery={onQuery}
                debug={debug}
                verbose={verbose}
                messages={messages}
                setToolJSX={setToolJSX}
                onAutoUpdaterResult={setAutoUpdaterResult}
                autoUpdaterResult={autoUpdaterResult}
                input={inputValue}
                onInputChange={setInputValue}
                mode={inputMode}
                onModeChange={setInputMode}
                submitCount={submitCount}
                onSubmitCountChange={setSubmitCount}
                setIsLoading={setIsLoading}
                setAbortController={setAbortController}
                onShowMessageSelector={() =>
                  setIsMessageSelectorVisible(prev => !prev)
                }
                setForkConvoWithMessagesOnTheNextRender={
                  setForkConvoWithMessagesOnTheNextRender
                }
                readFileTimestamps={readFileTimestamps.current}
                nexusMode={nexusBootstrap ? nexusModeOverride : undefined}
                onCycleNexusMode={
                  nexusBootstrap
                    ? () => setNexusModeOverride(prev => cycleNexusMode(prev))
                    : undefined
                }
                nexusAcceptEditsEnabled={nexusAcceptEditsEnabled}
                onNexusToggleAcceptEdits={
                  nexusBootstrap
                    ? toggleNexusAutoApproveAll
                    : undefined
                }
                nexusAutoApprove={nexusAutoApprove}
                onToggleNexusAutoApproveAction={
                  nexusBootstrap
                    ? toggleNexusAutoApproveAction
                    : undefined
                }
                onNexusConfigSaved={onNexusConfigSaved}
                onNexusUndo={nexusBootstrap ? onNexusUndo : undefined}
                onToggleToolDetails={() =>
                  setToolDetailsExpanded(prev => !prev)
                }
                toolDetailsExpanded={toolDetailsExpanded}
              />
            </>
          )}
      </Box>
      {isMessageSelectorVisible && (
        <MessageSelector
          erroredToolUseIDs={erroredToolUseIDs}
          unresolvedToolUseIDs={unresolvedToolUseIDs}
          messages={normalizeMessagesForAPI(messages)}
          onSelect={async message => {
            setIsMessageSelectorVisible(false)

            // If the user selected the current prompt, do nothing
            if (!messages.includes(message)) {
              return
            }

            // Cancel tool use calls/requests
            onCancel()

            // Hack: make sure the "Interrupted by user" message is
            // rendered in response to the cancellation. Otherwise,
            // the screen will be cleared but there will remain a
            // vestigial "Interrupted by user" message at the top.
            setImmediate(async () => {
              // Clear messages, and re-render
              await clearTerminal()
              setMessages([])
              setForkConvoWithMessagesOnTheNextRender(
                messages.slice(0, messages.indexOf(message)),
              )

              // Populate/reset the prompt input
              if (typeof message.message.content === 'string') {
                setInputValue(message.message.content)
              }
            })
          }}
          onEscape={() => setIsMessageSelectorVisible(false)}
          tools={tools}
        />
      )}
      {/** Fix occasional rendering artifact */}
      <Newline />
    </>
  )
}

function shouldRenderStatically(
  message: NormalizedMessage,
  messages: NormalizedMessage[],
  unresolvedToolUseIDs: Set<string>,
): boolean {
  switch (message.type) {
    case 'user':
    case 'assistant': {
      const toolUseID = getToolUseID(message)
      if (!toolUseID) {
        return true
      }
      if (unresolvedToolUseIDs.has(toolUseID)) {
        return false
      }

      const correspondingProgressMessage = messages.find(
        _ => _.type === 'progress' && _.toolUseID === toolUseID,
      ) as ProgressMessage | null
      if (!correspondingProgressMessage) {
        return true
      }

      return !intersects(
        unresolvedToolUseIDs,
        correspondingProgressMessage.siblingToolUseIDs,
      )
    }
    case 'progress':
      return !intersects(unresolvedToolUseIDs, message.siblingToolUseIDs)
  }
}

function intersects<A>(a: Set<A>, b: Set<A>): boolean {
  return a.size > 0 && b.size > 0 && [...a].some(_ => b.has(_))
}
