import { Box, Text, useInput } from 'ink'
import { sample } from 'lodash-es'
import { getExampleCommands } from '../utils/exampleCommands.js'
import * as React from 'react'
import { type Message } from '../query.js'
import { processUserInput } from '../utils/messages.js'
import { useArrowKeyHistory } from '../hooks/useArrowKeyHistory.js'
import { useSlashCommandTypeahead, type CommandSuggestion } from '../hooks/useSlashCommandTypeahead.js'
import { addToHistory } from '../history.js'
import TextInput from './TextInput.js'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { countCachedTokens, countTokens } from '../utils/tokens.js'
import { SentryErrorBoundary } from './SentryErrorBoundary.js'
import { AutoUpdater } from './AutoUpdater.js'
import { AutoUpdaterResult } from '../utils/autoUpdater.js'
import type { Command } from '../commands.js'
import type { SetToolJSXFn, Tool } from '../Tool.js'
import { TokenWarning, WARNING_THRESHOLD, MAX_TOKENS } from './TokenWarning.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'
import { getSlowAndCapableModel } from '../utils/model.js'
import { setTerminalTitle } from '../utils/terminal.js'
import terminalSetup, {
  isShiftEnterKeyBindingInstalled,
} from '../commands/terminalSetup.js'

type Props = {
  commands: Command[]
  forkNumber: number
  messageLogName: string
  isDisabled: boolean
  isLoading: boolean
  onQuery: (
    newMessages: Message[],
    abortController: AbortController,
  ) => Promise<void>
  debug: boolean
  verbose: boolean
  messages: Message[]
  setToolJSX: SetToolJSXFn
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void
  autoUpdaterResult: AutoUpdaterResult | null
  tools: Tool[]
  input: string
  onInputChange: (value: string) => void
  mode: 'bash' | 'prompt'
  onModeChange: (mode: 'bash' | 'prompt') => void
  submitCount: number
  onSubmitCountChange: (updater: (prev: number) => number) => void
  setIsLoading: (isLoading: boolean) => void
  setAbortController: (abortController: AbortController) => void
  onShowMessageSelector: () => void
  setForkConvoWithMessagesOnTheNextRender: (
    forkConvoWithMessages: Message[],
  ) => void
  readFileTimestamps: { [filename: string]: number }
  /** When set (Nexus), show current mode below input; cycle mode with Shift+Tab. */
  nexusMode?: string
  onCycleNexusMode?: () => void
  /** Current Nexus model shown in footer status line. */
  nexusModel?: string
  /** Current Nexus index state shown in footer status line. */
  nexusIndexEnabled?: boolean
  /** Current Nexus session id shown in footer status line. */
  nexusSessionId?: string
  /** Granular auto-approve state for Nexus actions. */
  nexusAutoApprove?: {
    read: boolean
    write: boolean
    execute: boolean
    mcp: boolean
    browser: boolean
  }
  /** Toggle one granular auto-approve action (read/write/execute/mcp/browser). */
  onToggleNexusAutoApproveAction?: (
    action: 'read' | 'write' | 'execute' | 'mcp' | 'browser',
  ) => void
  /** Called when a Nexus panel (e.g. /model) saves config so the header can refresh */
  onNexusConfigSaved?: () => void | Promise<void>
  /** When set (Nexus), /undo reverts the last message and file changes. */
  onNexusUndo?: () => Promise<void>
  /** When set (Nexus), /compact triggers core compaction. */
  onNexusCompact?: () => Promise<void>
  /** Handle post-plan followup choices (1/2/3/4/custom). Return true if consumed. */
  onNexusPlanFollowupSubmit?: (input: string) => Promise<boolean>
  /** Toggle expanded/collapsed tool input details in chat. */
  onToggleToolDetails?: () => void
  /** Current expanded/collapsed state for tool input details. */
  toolDetailsExpanded?: boolean
  /** Toggle session diff panel (Ctrl+I). */
  onToggleSessionDiffPanel?: () => void
  /** Current state of session diff panel visibility. */
  sessionDiffPanelVisible?: boolean
  /** Toggle generic tool output visibility (Ctrl+O). */
  onToggleToolOutputs?: () => void
  /** Current state of generic tool output visibility. */
  toolOutputsVisible?: boolean
  /** Directly set the Nexus agent mode (used by /mode command). */
  onSetNexusMode?: (mode: string) => void
  /** Open a file in the user's $EDITOR (used by /skills, /mcp, /create-skill, /create-rule). */
  onOpenInEditor?: (filePath: string) => Promise<void>
}

function getPastedTextPrompt(text: string): string {
  const lines = getPastedLineCount(text)
  const kind = looksLikeTerminalPaste(text) ? 'bash' : 'text'
  return `[📋 ${kind} (1-${lines})] `
}

function getPastedLineCount(text: string): number {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function looksLikeTerminalPaste(text: string): boolean {
  const head = text.split(/\r?\n/).slice(0, 6).join('\n')
  return /(^|\n)\s*(\$|>|#|PS\s|C:\\|\/root\/)/.test(head)
}
function PromptInput({
  commands,
  forkNumber,
  messageLogName,
  isDisabled,
  isLoading,
  onQuery,
  debug,
  verbose,
  messages,
  setToolJSX,
  onAutoUpdaterResult,
  autoUpdaterResult,
  tools,
  input,
  onInputChange,
  mode,
  onModeChange,
  submitCount,
  onSubmitCountChange,
  setIsLoading,
  setAbortController,
  onShowMessageSelector,
  setForkConvoWithMessagesOnTheNextRender,
  readFileTimestamps,
  nexusMode,
  onCycleNexusMode,
  nexusModel,
  nexusIndexEnabled,
  nexusSessionId,
  nexusAutoApprove,
  onToggleNexusAutoApproveAction,
  onNexusConfigSaved,
  onNexusUndo,
  onNexusCompact,
  onNexusPlanFollowupSubmit,
  onToggleToolDetails,
  toolDetailsExpanded = false,
  onToggleSessionDiffPanel,
  sessionDiffPanelVisible = false,
  onToggleToolOutputs,
  toolOutputsVisible = true,
  onSetNexusMode,
  onOpenInEditor,
}: Props): React.ReactNode {
  const [isAutoUpdating, setIsAutoUpdating] = useState(false)
  const [exitMessage, setExitMessage] = useState<{
    show: boolean
    key?: string
  }>({ show: false })
  const [message, setMessage] = useState<{
    show: boolean
    text?: string
  }>({ show: false })
  const [pastedImage, setPastedImage] = useState<string | null>(null)
  const [placeholder, setPlaceholder] = useState('')
  const [cursorOffset, setCursorOffset] = useState<number>(input.length)
  const cursorOffsetRef = React.useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset
  const setCursorOffsetAndRef = React.useCallback((off: number) => {
    cursorOffsetRef.current = off
    setCursorOffset(off)
  }, [])
  const [pastedText, setPastedText] = useState<string | null>(null)
  /** Pending create-skill/rule scope selection: { description, isSkill } */
  const [pendingCreate, setPendingCreate] = useState<{
    description: string
    isSkill: boolean
    scopeIndex: number
  } | null>(null)

  useEffect(() => {
    getExampleCommands().then(commands => {
      setPlaceholder(`Try "${sample(commands)}"`)
    })
  }, [])
  const { columns } = useTerminalSize()

  const commandWidth = useMemo(
    () => Math.max(...commands.map(cmd => cmd.userFacingName().length)) + 5,
    [commands],
  )

  const {
    suggestions,
    selectedSuggestion,
    updateSuggestions,
    clearSuggestions,
  } = useSlashCommandTypeahead({
    commands,
    onInputChange,
    onSubmit,
    setCursorOffset,
    isNexus: nexusMode != null,
  })

  const onChange = useCallback(
    (value: string) => {
      if (value.startsWith('!')) {
        onModeChange('bash')
        return
      }
      updateSuggestions(value)
      onInputChange(value)
    },
    [onModeChange, onInputChange, updateSuggestions],
  )

  const { resetHistory, onHistoryUp, onHistoryDown } = useArrowKeyHistory(
    (value: string, mode: 'bash' | 'prompt') => {
      onChange(value)
      setCursorOffsetAndRef(value.length)
      onModeChange(mode)
    },
    input,
  )

  // Only use history navigation when there are 0 or 1 slash command suggestions
  const handleHistoryUp = () => {
    if (suggestions.length <= 1) {
      onHistoryUp()
    }
  }

  const handleHistoryDown = () => {
    if (suggestions.length <= 1) {
      onHistoryDown()
    }
  }

  async function onSubmit(input: string, isSubmittingSlashCommand = false) {
    if (input === '') {
      return
    }
    if (isDisabled) {
      return
    }
    if (isLoading) {
      return
    }

    if (onNexusPlanFollowupSubmit) {
      const consumed = await onNexusPlanFollowupSubmit(input)
      if (consumed) {
        onInputChange('')
        addToHistory(input.trim())
        resetHistory()
        return
      }
    }
    if (suggestions.length > 0 && !isSubmittingSlashCommand) {
      return
    }

    // Handle exit commands
    if (['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(input.trim())) {
      exit()
    }

    let finalInput = input
    if (pastedText) {
      const pastedPrompt = getPastedTextPrompt(pastedText)
      if (finalInput.includes(pastedPrompt)) {
        finalInput = finalInput.replace(pastedPrompt, pastedText)
      }
    }
    // Don't clear input yet for slash commands that open a panel; clear only when sending messages
    onModeChange('prompt')
    clearSuggestions()
    setPastedImage(null)
    setPastedText(null)
    onSubmitCountChange(_ => _ + 1)
    setIsLoading(true)

    const trimmed = finalInput.trim()
    if (/^\/undo(\s|$)/i.test(trimmed) && onNexusUndo) {
      await onNexusUndo()
      onInputChange('')
      setIsLoading(false)
      addToHistory(trimmed)
      return
    }
    if (/^\/compact(\s|$)/i.test(trimmed) && onNexusCompact) {
      await onNexusCompact()
      onInputChange('')
      setIsLoading(false)
      addToHistory(trimmed)
      return
    }

    // Handle Nexus virtual commands
    const virtualCmdMatch = trimmed.match(/^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/i)
    if (virtualCmdMatch) {
      const vcName = virtualCmdMatch[1]!.toLowerCase()
      const vcArg = (virtualCmdMatch[2] ?? '').trim()
      const VALID_MODES = ['agent', 'plan', 'ask', 'debug', 'review']

      switch (vcName) {
        case 'mode': {
          if (vcArg && VALID_MODES.includes(vcArg.toLowerCase())) {
            onSetNexusMode?.(vcArg.toLowerCase())
          } else {
            onCycleNexusMode?.()
          }
          onInputChange('')
          setIsLoading(false)
          addToHistory(trimmed)
          resetHistory()
          return
        }
        case 'diff': {
          onToggleSessionDiffPanel?.()
          onInputChange('')
          setIsLoading(false)
          addToHistory(trimmed)
          resetHistory()
          return
        }
        // skills/mcp/sessions/index/embeddings/model → redirect to real CLI commands
        case 'skills':
          finalInput = '/skills'
          break
        case 'mcp':
          finalInput = '/mcp'
          break
        case 'sessions':
          finalInput = '/sessions'
          break
        case 'create-skill': {
          if (!vcArg) {
            onInputChange('/create-skill ')
            setIsLoading(false)
            return
          }
          // Show scope selection panel
          setPendingCreate({ description: vcArg, isSkill: true, scopeIndex: 0 })
          onInputChange('')
          setIsLoading(false)
          return
        }
        case 'create-rule': {
          if (!vcArg) {
            onInputChange('/create-rule ')
            setIsLoading(false)
            return
          }
          // Show scope selection panel
          setPendingCreate({ description: vcArg, isSkill: false, scopeIndex: 0 })
          onInputChange('')
          setIsLoading(false)
          return
        }
      }
    }

    const abortController = new AbortController()
    setAbortController(abortController)
    const model = await getSlowAndCapableModel()
    const messages = await processUserInput(
      finalInput,
      mode,
      setToolJSX,
      {
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          slowAndCapableModel: model,
          maxThinkingTokens: 0,
        },
        messageId: undefined,
        abortController,
        readFileTimestamps,
        setForkConvoWithMessagesOnTheNextRender,
        onNexusConfigSaved,
      },
      pastedImage ?? null,
    )

    if (messages.length) {
      onInputChange('')
      onQuery(messages, abortController)
    } else {
      // Local JSX commands (e.g. /model panel): close without adding messages.
      // Clear loading state and input so the spinner stops and the slash command
      // text is not left in the input (avoid accidental submit on next Enter).
      setIsLoading(false)
      onInputChange('')
      addToHistory(input)
      resetHistory()
      return
    }

    for (const message of messages) {
      if (message.type === 'user') {
        const inputToAdd = mode === 'bash' ? `!${input}` : input
        addToHistory(inputToAdd)
        resetHistory()
      }
    }
  }

  function onImagePaste(image: string) {
    onModeChange('prompt')
    setPastedImage(image)
  }

  function onTextPaste(rawText: string) {
    // Replace any \r with \n first to match useTextInput's conversion behavior
    const text = rawText.replace(/\r/g, '\n')

    // Get prompt with newline count
    const pastedPrompt = getPastedTextPrompt(text)

    // Use ref so we have the cursor position when paste started (before 100ms callback)
    const offset = cursorOffsetRef.current
    const currentInput = input
    const newInput =
      currentInput.slice(0, offset) + pastedPrompt + currentInput.slice(offset)
    onInputChange(newInput)

    setCursorOffsetAndRef(offset + pastedPrompt.length)

    setPastedText(text)
  }

  // Handle pending create-skill/rule scope selection
  useInput((inputChar, key) => {
    if (!pendingCreate) return
    if (key.escape || inputChar === 'c' || inputChar === 'C') {
      setPendingCreate(null)
      return
    }
    if (key.upArrow) {
      setPendingCreate(prev => prev ? { ...prev, scopeIndex: Math.max(0, prev.scopeIndex - 1) } : null)
      return
    }
    if (key.downArrow) {
      setPendingCreate(prev => prev ? { ...prev, scopeIndex: Math.min(2, prev.scopeIndex + 1) } : null)
      return
    }
    if (key.return) {
      const { description, isSkill, scopeIndex } = pendingCreate
      if (scopeIndex === 2) {
        // Cancel
        setPendingCreate(null)
        return
      }
      const scope = scopeIndex === 0 ? 'global' : 'local'
      const globalPath = scope === 'global'
        ? '~/.nexus/' + (isSkill ? 'skills/' : 'rules/')
        : '.nexus/' + (isSkill ? 'skills/' : 'rules/')
      const pathNote = scope === 'global'
        ? 'in the global directory ~/.nexus/' + (isSkill ? 'skills/' : 'rules/')
        : 'in the local directory .nexus/' + (isSkill ? 'skills/' : 'rules/')
      const agentPrompt = isSkill
        ? `Please create a new Nexus skill ${pathNote}. Skill description: "${description}".

Create a SKILL.md file with a descriptive name. The SKILL.md should follow this format:
---
name: <skill-name>
description: <brief description>
when_to_use: <trigger conditions>
---
# <Skill Name>
<detailed instructions for Claude to follow when this skill is active>

Create the skill ${pathNote}. Confirm the created file path.`
        : `Please create a new Nexus rule file ${pathNote}. Rule description: "${description}".

Create a .md rule file with a descriptive name. The rule file should define clear, actionable instructions. Create the file ${pathNote}. Confirm the created file path.`
      setPendingCreate(null)
      onInputChange('')
      // Submit the agent prompt
      setIsLoading(true)
      const abortController = new AbortController()
      setAbortController(abortController)
      getSlowAndCapableModel().then(async (model: string) => {
        const msgs = await processUserInput(agentPrompt, 'prompt', setToolJSX, {
          options: { commands, forkNumber, messageLogName, tools, verbose, slowAndCapableModel: model, maxThinkingTokens: 0 },
          messageId: undefined,
          abortController,
          readFileTimestamps,
          setForkConvoWithMessagesOnTheNextRender,
          onNexusConfigSaved,
        }, null)
        if (msgs.length) {
          addToHistory(agentPrompt)
          resetHistory()
          onQuery(msgs, abortController)
        } else {
          setIsLoading(false)
        }
      })
    }
  })

  useInput((inputChar, key) => {
    if (input === '' && (key.escape || key.backspace || key.delete)) {
      onModeChange('prompt')
    }
    if (
      key.ctrl &&
      (inputChar === 'o' || inputChar === 'O' || inputChar === '\x0f') &&
      (onToggleToolDetails || onToggleToolOutputs)
    ) {
      onToggleToolDetails?.()
      onToggleToolOutputs?.()
      return
    }
    if (
      key.ctrl &&
      (inputChar === 'i' || inputChar === 'I' || inputChar === '\t') &&
      onToggleSessionDiffPanel
    ) {
      onToggleSessionDiffPanel()
      return
    }
    if (
      key.ctrl &&
      (inputChar === 'k' || inputChar === 'K' || inputChar === '\x0b')
    ) {
      onModeChange(mode === 'bash' ? 'prompt' : 'bash')
      return
    }
    // esc is a little overloaded:
    // - when we're loading a response, it's used to cancel the request
    // - otherwise, it's used to show the message selector
    // - when double pressed, it's used to clear the input
    if (key.escape && messages.length > 0 && !input && !isLoading) {
      onShowMessageSelector()
    }
  })

  const textInputColumns = useTerminalSize().columns - 6
  const tokenUsage = useMemo(() => countTokens(messages), [messages])
  const theme = getTheme()

  const createScopeOptions = ['Create global (~/.nexus/)', 'Create local (.nexus/)', 'Cancel']

  return (
    <Box flexDirection="column">
      <Box
        alignItems="flex-start"
        justifyContent="flex-start"
        borderColor={mode === 'bash' ? theme.bashBorder : theme.secondaryBorder}
        borderDimColor
        borderStyle="round"
        marginTop={1}
        width="100%"
      >
        <Box
          alignItems="flex-start"
          alignSelf="flex-start"
          flexWrap="nowrap"
          justifyContent="flex-start"
          width={3}
        >
          {mode === 'bash' ? (
            <Text color={theme.bashBorder}>&nbsp;!&nbsp;</Text>
          ) : (
            <Text color={isLoading ? theme.secondaryText : undefined}>
              &nbsp;&gt;&nbsp;
            </Text>
          )}
        </Box>
        <Box paddingRight={1}>
          <TextInput
            multiline
            onSubmit={onSubmit}
            onChange={onChange}
            value={input}
            onHistoryUp={handleHistoryUp}
            onHistoryDown={handleHistoryDown}
            onHistoryReset={() => resetHistory()}
            placeholder={submitCount > 0 ? undefined : placeholder}
            onExit={() => process.exit(0)}
            onExitMessage={(show, key) => setExitMessage({ show, key })}
            onMessage={(show, text) => setMessage({ show, text })}
            onImagePaste={onImagePaste}
            columns={textInputColumns}
            isDimmed={isDisabled || isLoading}
            disableCursorMovementForUpDownKeys={suggestions.length > 0}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffsetAndRef}
            onPaste={onTextPaste}
            onShiftTab={onCycleNexusMode}
          />
        </Box>
      </Box>
      {pendingCreate && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.secondaryBorder} paddingX={1}>
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>{pendingCreate.isSkill ? 'Create Skill' : 'Create Rule'}</Text>
            <Text dimColor>{pendingCreate.description}</Text>
          </Box>
          {createScopeOptions.map((label, i) => (
            <Box key={label} height={1}>
              <Text color={pendingCreate.scopeIndex === i ? theme.primary : undefined}>
                {pendingCreate.scopeIndex === i ? '▶' : ' '} {label}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>↑/↓ navigate · Enter confirm · Esc cancel</Text>
          </Box>
        </Box>
      )}
      {nexusMode != null && suggestions.length === 0 && (
        <Box paddingX={2} paddingY={0} width={columns} overflow="hidden">
          <Text dimColor>Mode: </Text>
          <Text bold color={getTheme().primary}>{nexusMode}</Text>
          <Text dimColor> · Shift+Tab to change mode</Text>
          <Text dimColor> · Bash: </Text>
          <Text
            bold
            color={mode === 'bash' ? getTheme().primary : undefined}
            dimColor={mode !== 'bash'}
          >
            {mode === 'bash' ? 'on' : 'off'}
          </Text>
          <Text dimColor> · Ctrl+K to toggle</Text>
        </Box>
      )}
      {nexusMode != null && suggestions.length === 0 && (
        <Box paddingX={2} paddingY={0} width={columns} overflow="hidden">
          <Text dimColor>Nexus:</Text>
          {nexusModel != null && (
            <>
              <Text dimColor> · model=</Text>
              <Text bold>{nexusModel}</Text>
            </>
          )}
          {nexusIndexEnabled != null && (
            <Text dimColor> · index={nexusIndexEnabled ? 'on' : 'off'}</Text>
          )}
          {nexusSessionId != null && (
            <>
              <Text dimColor> · session=</Text>
              <Text bold>{nexusSessionId}</Text>
            </>
          )}
        </Box>
      )}
      {suggestions.length === 0 && (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={2}
          paddingY={0}
          width={columns}
          overflow="hidden"
        >
          <Box justifyContent="flex-start" gap={1}>
            {exitMessage.show ? (
              <Text dimColor>Press {exitMessage.key} again to exit</Text>
            ) : message.show ? (
              <Text dimColor>{message.text}</Text>
            ) : (
              <>
                <Text
                  color={mode === 'bash' ? theme.bashBorder : undefined}
                  dimColor={mode !== 'bash'}
                >
                  ! for bash mode
                </Text>
                <Text dimColor>
                  · / for commands · esc to undo · Ctrl+O tools:{' '}
                  {toolDetailsExpanded ? 'expanded' : 'collapsed'} · outputs:{' '}
                  {toolOutputsVisible ? 'visible' : 'hidden'} · Ctrl+I diff:{' '}
                  {sessionDiffPanelVisible ? 'shown' : 'hidden'}
                </Text>
              </>
            )}
          </Box>
          <SentryErrorBoundary>
            <Box justifyContent="flex-end" gap={1}>
              {!autoUpdaterResult &&
                !isAutoUpdating &&
                !debug &&
                tokenUsage < WARNING_THRESHOLD && (
                  <Text dimColor>
                    {terminalSetup.isEnabled &&
                    isShiftEnterKeyBindingInstalled()
                      ? 'shift + ⏎ for newline'
                      : '\\⏎ for newline'}
                  </Text>
                )}
              {debug && (
                <Text dimColor>
                  {`${countTokens(messages)} tokens (${
                    Math.round(
                      (10000 * (countCachedTokens(messages) || 1)) /
                        (countTokens(messages) || 1),
                    ) / 100
                  }% cached)`}
                </Text>
              )}
              {tokenUsage < WARNING_THRESHOLD && (
                <Text dimColor>ctx: {Math.min(100, Math.round((tokenUsage / MAX_TOKENS) * 100))}%</Text>
              )}
              <TokenWarning tokenUsage={tokenUsage} />
              <AutoUpdater
                debug={debug}
                onAutoUpdaterResult={onAutoUpdaterResult}
                autoUpdaterResult={autoUpdaterResult}
                isUpdating={isAutoUpdating}
                onChangeIsUpdating={setIsAutoUpdating}
              />
            </Box>
          </SentryErrorBoundary>
        </Box>
      )}
      {suggestions.length > 0 && (
        <Box
          flexDirection="row"
          justifyContent="space-between"
          paddingX={2}
          paddingY={0}
        >
          <Box flexDirection="column">
            {(() => {
              const rendered: React.ReactNode[] = []
              let lastSection: string | null = null
              suggestions.forEach((suggestion: CommandSuggestion, index: number) => {
                if (suggestion.section !== lastSection) {
                  lastSection = suggestion.section
                  rendered.push(
                    <Box key={`section-${suggestion.section}`} paddingTop={rendered.length > 0 ? 0 : 0}>
                      <Text dimColor bold> {suggestion.section}</Text>
                    </Box>
                  )
                }
                const isSelected = index === selectedSuggestion
                // Find the underlying command if it's not virtual
                const command = !suggestion.isVirtual
                  ? commands.find(cmd => cmd.userFacingName() === suggestion.name)
                  : undefined
                const argHint = command?.type === 'prompt' && command.argNames?.length
                  ? ` (${command.argNames.join(', ')})`
                  : ''
                rendered.push(
                  <Box
                    key={suggestion.name}
                    flexDirection={columns < 80 ? 'column' : 'row'}
                  >
                    <Box width={columns < 80 ? undefined : commandWidth + 2}>
                      <Text
                        color={isSelected ? theme.suggestion : undefined}
                        dimColor={!isSelected}
                      >
                        {'  '}/{suggestion.name}
                        {suggestion.aliases && suggestion.aliases.length > 0 && (
                          <Text dimColor> ({suggestion.aliases.join(', ')})</Text>
                        )}
                      </Text>
                    </Box>
                    {suggestion.description && (
                      <Box
                        width={columns - (columns < 80 ? 4 : commandWidth + 6)}
                        paddingLeft={columns < 80 ? 4 : 0}
                      >
                        <Text
                          color={isSelected ? theme.suggestion : undefined}
                          dimColor={!isSelected}
                          wrap="wrap"
                        >
                          {suggestion.description}{argHint}
                        </Text>
                      </Box>
                    )}
                  </Box>
                )
              })
              return rendered
            })()}
          </Box>
          <SentryErrorBoundary>
            <Box justifyContent="flex-end" gap={1}>
              <TokenWarning tokenUsage={countTokens(messages)} />
              <AutoUpdater
                debug={debug}
                onAutoUpdaterResult={onAutoUpdaterResult}
                autoUpdaterResult={autoUpdaterResult}
                isUpdating={isAutoUpdating}
                onChangeIsUpdating={setIsAutoUpdating}
              />
            </Box>
          </SentryErrorBoundary>
        </Box>
      )}
    </Box>
  )
}

export default memo(PromptInput)

function exit(): never {
  setTerminalTitle('')
  process.exit(0)
}
