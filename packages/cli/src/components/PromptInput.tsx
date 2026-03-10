import { Box, Text, useInput } from 'ink'
import { sample } from 'lodash-es'
import { getExampleCommands } from '../utils/exampleCommands.js'
import * as React from 'react'
import { type Message } from '../query.js'
import { processUserInput } from '../utils/messages.js'
import { useArrowKeyHistory } from '../hooks/useArrowKeyHistory.js'
import { useSlashCommandTypeahead } from '../hooks/useSlashCommandTypeahead.js'
import { addToHistory } from '../history.js'
import TextInput from './TextInput.js'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { countCachedTokens, countTokens } from '../utils/tokens.js'
import { SentryErrorBoundary } from './SentryErrorBoundary.js'
import { AutoUpdater } from './AutoUpdater.js'
import { AutoUpdaterResult } from '../utils/autoUpdater.js'
import type { Command } from '../commands.js'
import type { SetToolJSXFn, Tool } from '../Tool.js'
import { TokenWarning, WARNING_THRESHOLD } from './TokenWarning.js'
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
  /** When set (Nexus), show "Accept edits: on|off" and allow Ctrl+Y to toggle. */
  nexusAcceptEditsEnabled?: boolean
  onNexusToggleAcceptEdits?: () => void
  /** Called when a Nexus panel (e.g. /model) saves config so the header can refresh */
  onNexusConfigSaved?: () => void | Promise<void>
  /** When set (Nexus), /undo reverts the last message and file changes. */
  onNexusUndo?: () => Promise<void>
  /** Toggle expanded/collapsed tool input details in chat. */
  onToggleToolDetails?: () => void
  /** Current expanded/collapsed state for tool input details. */
  toolDetailsExpanded?: boolean
}

function getPastedTextPrompt(text: string): string {
  const newlineCount = (text.match(/\r\n|\r|\n/g) || []).length
  return `[Pasted text +${newlineCount} lines] `
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
  nexusAcceptEditsEnabled = true,
  onNexusToggleAcceptEdits,
  onNexusConfigSaved,
  onNexusUndo,
  onToggleToolDetails,
  toolDetailsExpanded = false,
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
    if (trimmed === '/undo' && onNexusUndo) {
      await onNexusUndo()
      onInputChange('')
      setIsLoading(false)
      addToHistory(trimmed)
      return
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

  useInput((inputChar, key) => {
    if (input === '' && (key.escape || key.backspace || key.delete)) {
      onModeChange('prompt')
    }
    if (
      key.ctrl &&
      (inputChar === 'o' || inputChar === 'O' || inputChar === '\x0f') &&
      onToggleToolDetails
    ) {
      onToggleToolDetails()
      return
    }
    if (key.ctrl && (inputChar === 'y' || inputChar === 'Y' || inputChar === '\x19') && onNexusToggleAcceptEdits) {
      onNexusToggleAcceptEdits()
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
      {nexusMode != null && (
        <Box paddingX={2} paddingY={0}>
          <Text dimColor>Mode: </Text>
          <Text bold color={getTheme().primary}>{nexusMode}</Text>
          <Text dimColor> · Shift+Tab to change mode</Text>
          {onNexusToggleAcceptEdits != null && (
            <>
              <Text dimColor> · Accept edits: </Text>
              <Text bold color={nexusAcceptEditsEnabled ? getTheme().primary : undefined} dimColor={!nexusAcceptEditsEnabled}>
                {nexusAcceptEditsEnabled ? 'on' : 'off'}
              </Text>
              <Text dimColor> · Ctrl+Y to toggle</Text>
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
                  · / for commands · esc to undo · Ctrl+O tool inputs:{' '}
                  {toolDetailsExpanded ? 'expanded' : 'collapsed'}
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
            {suggestions.map((suggestion, index) => {
              const command = commands.find(
                cmd => cmd.userFacingName() === suggestion.replace('/', ''),
              )
              return (
                <Box
                  key={suggestion}
                  flexDirection={columns < 80 ? 'column' : 'row'}
                >
                  <Box width={columns < 80 ? undefined : commandWidth}>
                    <Text
                      color={
                        index === selectedSuggestion
                          ? theme.suggestion
                          : undefined
                      }
                      dimColor={index !== selectedSuggestion}
                    >
                      /{suggestion}
                      {command?.aliases && command.aliases.length > 0 && (
                        <Text dimColor> ({command.aliases.join(', ')})</Text>
                      )}
                    </Text>
                  </Box>
                  {command && (
                    <Box
                      width={columns - (columns < 80 ? 4 : commandWidth + 4)}
                      paddingLeft={columns < 80 ? 4 : 0}
                    >
                      <Text
                        color={
                          index === selectedSuggestion
                            ? theme.suggestion
                            : undefined
                        }
                        dimColor={index !== selectedSuggestion}
                        wrap="wrap"
                      >
                        <Text dimColor={index !== selectedSuggestion}>
                          {command.description}
                          {command.type === 'prompt' && command.argNames?.length
                            ? ` (arguments: ${command.argNames.join(', ')})`
                            : null}
                        </Text>
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
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
