import { useState, useRef, useEffect } from 'react'
import { type Key, useStdin } from 'ink'
import { useDoublePress } from './useDoublePress.js'
import { Cursor } from '../utils/Cursor.js'
import {
  getImageFromClipboard,
  CLIPBOARD_ERROR_MESSAGE,
} from '../utils/imagePaste.js'
import { getClipboardText, setClipboardText } from '../utils/clipboard.js'

const IMAGE_PLACEHOLDER = '[Image pasted]'

type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  return function (input: string): MaybeCursor {
    const handler = new Map(input_map).get(input) ?? (() => {})
    return handler(input)
  }
}

type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onMessage?: (show: boolean, message?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (base64Image: string) => void
  disableCursorMovementForUpDownKeys?: boolean
  externalOffset: number
  onOffsetChange: (offset: number) => void
}

type UseTextInputResult = {
  renderedValue: string
  onInput: (input: string, key: Key) => void
  offset: number
  setOffset: (offset: number) => void
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  externalOffset,
  onOffsetChange,
}: UseTextInputProps): UseTextInputResult {
  const offset = externalOffset
  const setOffset = onOffsetChange
  const [selectionAnchor, setSelectionAnchor] = useState(0)

  // Refs so we always use the latest value when handling input (avoids losing
  // characters when React hasn't re-rendered yet after previous keystroke).
  const valueRef = useRef(originalValue)
  const prevOriginalRef = useRef<string | undefined>(undefined)
  const offsetRef = useRef(externalOffset)
  const selectionAnchorRef = useRef(selectionAnchor)

  // Sync from parent when they set a new value (e.g. history navigation).
  if (originalValue !== prevOriginalRef.current) {
    prevOriginalRef.current = originalValue
    valueRef.current = originalValue
    offsetRef.current = externalOffset
    selectionAnchorRef.current = externalOffset
  }
  // Build cursor from refs so display and input handling use the same source of truth.
  const cursor = Cursor.fromText(
    valueRef.current,
    columns,
    offsetRef.current,
    selectionAnchorRef.current,
  )
  // Ref used inside onInput so handlers always see the cursor built from latest refs.
  const currentCursorRef = useRef(cursor)
  currentCursorRef.current = cursor

  function applyCursor(next: Cursor): void {
    valueRef.current = next.text
    offsetRef.current = next.offset
    selectionAnchorRef.current = next.selection
    setOffset(next.offset)
    if (currentCursorRef.current.text !== next.text) onChange(next.text)
    setSelectionAnchor(next.selection)
  }
  const escapeBufferRef = useRef('')
  /** Ink maps Backspace (\x7f) to key.delete on Linux/Mac (issue #634). We detect raw single-byte backspace to treat as backspace. */
  const lastRawWasBackspaceRef = useRef(false)
  const { stdin } = useStdin()
  useEffect(() => {
    if (!stdin) return
    const onData = (data: Buffer | string) => {
      // Only treat as backspace when the entire chunk is a single backspace byte (0x7f DEL or 0x08 BS).
      // Multi-byte chunks (e.g. Alt+Backspace \x1b\x7f) must not set this flag.
      const isSingleBackspace =
        typeof data === 'string'
          ? (data.length === 1 && (data === '\x7f' || data === '\b'))
          : (data.length === 1 && (data[0] === 0x7f || data[0] === 0x08))
      lastRawWasBackspaceRef.current = isSingleBackspace
    }
    stdin.on('data', onData)
    return () => { stdin.off('data', onData) }
  }, [stdin])
  const [imagePasteErrorTimeout, setImagePasteErrorTimeout] =
    useState<NodeJS.Timeout | null>(null)

  function maybeClearImagePasteErrorTimeout() {
    if (!imagePasteErrorTimeout) {
      return
    }
    clearTimeout(imagePasteErrorTimeout)
    setImagePasteErrorTimeout(null)
    onMessage?.(false)
  }

  const handleCtrlC = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        onHistoryReset?.()
      }
    },
  )

  // Keep Escape for clearing input
  const handleEscape = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onMessage?.(!!originalValue && show, `Press Escape again to clear`)
    },
    () => {
      if (originalValue) {
        onChange('')
      }
    },
  )
  function clear() {
    return Cursor.fromText('', columns, 0)
  }

  const handleEmptyCtrlD = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-D'),
    () => onExit?.(),
  )

  function handleCtrlD(): MaybeCursor {
    maybeClearImagePasteErrorTimeout()
    if (currentCursorRef.current.text === '') {
      // When input is empty, handle double-press
      handleEmptyCtrlD()
      return currentCursorRef.current
    }
    // When input is not empty, delete forward like iPython
    return currentCursorRef.current.del()
  }

  function tryImagePaste() {
    const base64Image = getImageFromClipboard()
    if (base64Image === null) {
      if (process.platform !== 'darwin') {
        return currentCursorRef.current
      }
      onMessage?.(true, CLIPBOARD_ERROR_MESSAGE)
      maybeClearImagePasteErrorTimeout()
      setImagePasteErrorTimeout(
        // @ts-expect-error: Bun is overloading types here, but we're using the NodeJS runtime
        setTimeout(() => {
          onMessage?.(false)
        }, 4000),
      )
      return currentCursorRef.current
    }

    onImagePaste?.(base64Image)
    return currentCursorRef.current.insert(IMAGE_PLACEHOLDER)
  }

  const handleMeta = mapInput([
    ['b', () => currentCursorRef.current.prevWord()],
    ['f', () => currentCursorRef.current.nextWord()],
    ['d', () => currentCursorRef.current.deleteWordAfter()],
  ])

  function handleEnter(key: Key) {
    if (
      multiline &&
      currentCursorRef.current.offset > 0 &&
      currentCursorRef.current.text[currentCursorRef.current.offset - 1] === '\\'
    ) {
      return currentCursorRef.current.backspace().insert('\n')
    }
    if (key.meta) {
      return currentCursorRef.current.insert('\n')
    }
    onSubmit?.(valueRef.current)
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return currentCursorRef.current
    }
    const cursorUp = currentCursorRef.current.up()
    if (cursorUp.equals(currentCursorRef.current)) {
      // already at beginning
      onHistoryUp?.()
    }
    return cursorUp
  }
  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return currentCursorRef.current
    }
    const cursorDown = currentCursorRef.current.down()
    if (cursorDown.equals(currentCursorRef.current)) {
      onHistoryDown?.()
    }
    return cursorDown
  }

  const handleCtrl = (k: Key) =>
    mapInput([
      ['a', () => (k.shift ? currentCursorRef.current.startOfLine().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset) : currentCursorRef.current.startOfLine().collapseSelection())],
      ['b', () => (k.shift ? currentCursorRef.current.left().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset) : currentCursorRef.current.left().collapseSelection())],
      ['c', () => (currentCursorRef.current.hasSelection() ? (setClipboardText(currentCursorRef.current.getSelectedText()), currentCursorRef.current) : (handleCtrlC(), currentCursorRef.current))],
      ['d', handleCtrlD],
      ['e', () => (k.shift ? currentCursorRef.current.endOfLine().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset) : currentCursorRef.current.endOfLine().collapseSelection())],
      ['f', () => (k.shift ? currentCursorRef.current.right().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset) : currentCursorRef.current.right().collapseSelection())],
      ['h', () => currentCursorRef.current.backspace()],
      ['k', () => currentCursorRef.current.deleteToLineEnd()],
      ['l', () => clear()],
      ['n', () => downOrHistoryDown()],
      ['p', () => upOrHistoryUp()],
      ['u', () => currentCursorRef.current.deleteToLineStart()],
      ['v', () => { const afterImage = tryImagePaste(); if (!currentCursorRef.current.equals(afterImage)) return afterImage; const pasted = getClipboardText(); return pasted ? currentCursorRef.current.replaceSelected(pasted) : currentCursorRef.current }],
      ['w', () => currentCursorRef.current.deleteWordBefore()],
      ['x', () => (currentCursorRef.current.hasSelection() ? (setClipboardText(currentCursorRef.current.getSelectedText()), currentCursorRef.current.replaceSelected('')) : currentCursorRef.current)],
    ])

  function mapKey(key: Key): InputMapper {
    switch (true) {
      case key.escape:
        return handleEscape
      case key.leftArrow && (key.ctrl || key.meta || key.fn):
        return () => currentCursorRef.current.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || key.fn):
        return () => currentCursorRef.current.nextWord()
      case key.backspace:
        return key.meta
          ? () => currentCursorRef.current.deleteWordBefore()
          : () => currentCursorRef.current.backspace()
      case key.delete:
        return key.meta ? () => currentCursorRef.current.deleteToLineEnd() : () => currentCursorRef.current.del()
      case key.ctrl:
        return handleCtrl(key)
      case key.home:
        return () => currentCursorRef.current.startOfLine().collapseSelection()
      case key.end:
        return () => currentCursorRef.current.endOfLine().collapseSelection()
      case key.pageDown:
        return () => currentCursorRef.current.endOfLine()
      case key.pageUp:
        return () => currentCursorRef.current.startOfLine()
      case key.meta:
        return handleMeta
      case key.return:
        return () => handleEnter(key)
      case key.tab:
        return () => {}
      case key.upArrow:
        return upOrHistoryUp
      case key.downArrow:
        return downOrHistoryDown
      case key.leftArrow && key.shift:
        return () => currentCursorRef.current.left().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset)
      case key.rightArrow && key.shift:
        return () => currentCursorRef.current.right().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset)
      case key.home && key.shift:
        return () => currentCursorRef.current.startOfLine().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset)
      case key.end && key.shift:
        return () => currentCursorRef.current.endOfLine().withAnchor(currentCursorRef.current.hasSelection() ? currentCursorRef.current.selection : currentCursorRef.current.offset)
      case key.leftArrow:
        return () => currentCursorRef.current.left().collapseSelection()
      case key.rightArrow:
        return () => currentCursorRef.current.right().collapseSelection()
    }
    return function (input: string) {
      switch (true) {
        // Backspace (some terminals send character instead of key.backspace)
        case input === '\x7f' || input === '\b':
          return currentCursorRef.current.backspace()
        // Delete (many terminals send escape sequence instead of key.delete)
        case input === '\x1b[3~':
          return currentCursorRef.current.del()
        // Home key
        case input == '\x1b[H' || input == '\x1b[1~':
          return currentCursorRef.current.startOfLine()
        // End key
        case input == '\x1b[F' || input == '\x1b[4~':
          return currentCursorRef.current.endOfLine()
        default:
          return currentCursorRef.current.insert(input.replace(/\r/g, '\n'))
      }
    }
  }

  /**
   * Erasure validation (all platforms):
   *
   * BACKSPACE (erase char before cursor):
   * - Windows: 0x08 (\b) or 0x7f → key.backspace or key.delete; we handle \b/\x7f in input, and key.delete+raw via lastRawWasBackspaceRef.
   * - Linux/Mac: 0x7f → Ink sends key.delete + input '' (bug #634); we use lastRawWasBackspaceRef from raw stdin. If terminal sends \b, same as Windows.
   * - Paths: (1) input === '\x7f' || '\b' early return, (2) key.delete && input === '' && lastRawWasBackspaceRef, (3) key.backspace → mapKey.
   *
   * DELETE (erase char after cursor):
   * - All: 0x1b 5b 33 7e (\x1b[3~) in one or multiple chunks; we buffer escape and match \x1b[3~, or input === '\x1b[3~'.
   * - Paths: (1) escape buffer combined === '\x1b[3~', (2) input === '\x1b[3~', (3) key.delete (when not lastRawWasBackspace) → mapKey → cursor.del().
   *
   * CTRL+H: key.ctrl + input 'h' → handleCtrl → cursor.backspace().
   * CTRL+W: key.ctrl + input 'w' → handleCtrl → cursor.deleteWordBefore().
   * CTRL+U: key.ctrl + input 'u' → handleCtrl → cursor.deleteToLineStart().
   * CTRL+K: key.ctrl + input 'k' → handleCtrl → cursor.deleteToLineEnd().
   * META+BACKSPACE: key.backspace + key.meta → mapKey → cursor.deleteWordBefore().
   * META+DELETE: key.delete + key.meta → mapKey → cursor.deleteToLineEnd().
   */
  function onInput(input: string, key: Key): void {
    // Rebuild cursor from refs so we have the latest value when multiple keystrokes
    // are processed before React re-renders (fixes "only last character shown").
    const cursor = Cursor.fromText(
      valueRef.current,
      columns,
      offsetRef.current,
      selectionAnchorRef.current,
    )
    currentCursorRef.current = cursor

    // Escape sequence buffer: terminals may send e.g. Delete \x1b[3~ in multiple chunks
    const buf = escapeBufferRef.current
    if (buf.length > 0) {
      const combined = buf + input
      escapeBufferRef.current = ''
      if (combined === '\x1b[3~') {
        const next = cursor.del()
        if (!cursor.equals(next)) applyCursor(next)
        return
      }
      if (combined === '\x1b[H' || combined === '\x1b[1~') {
        const next = cursor.startOfLine().collapseSelection()
        if (!cursor.equals(next)) applyCursor(next)
        return
      }
      if (combined === '\x1b[F' || combined === '\x1b[4~') {
        const next = cursor.endOfLine().collapseSelection()
        if (!cursor.equals(next)) applyCursor(next)
        return
      }
      // Not a known sequence; might be partial (e.g. \x1b[3 for next chunk) or garbage
      const escapePrefixes = ['\x1b', '\x1b[', '\x1b[1', '\x1b[3', '\x1b[4']
      if (escapePrefixes.includes(combined)) {
        escapeBufferRef.current = combined
        return
      }
      // Flush buffer + input as normal insert
      const next = cursor.insert(combined.replace(/\r/g, '\n'))
      applyCursor(next)
      return
    }
    if (input === '\x1b') {
      escapeBufferRef.current = '\x1b'
      return
    }
    // Buffer other partial escape sequences (e.g. \x1b[ or \x1b[3 from one read)
    if (['\x1b[', '\x1b[1', '\x1b[3', '\x1b[4'].includes(input)) {
      escapeBufferRef.current = input
      return
    }
    // Handle backspace by character first (some terminals send \x7f/\b without key.backspace)
    if (input === '\x7f' || input === '\b') {
      const next = cursor.backspace()
      if (!cursor.equals(next)) {
        setOffset(next.offset)
        if (cursor.text !== next.text) onChange(next.text)
      }
      return
    }
    // Handle Delete by sequence when sent in one chunk (many terminals send \x1b[3~ instead of key.delete)
    if (input === '\x1b[3~') {
      const next = cursor.del()
      if (!cursor.equals(next)) {
        setOffset(next.offset)
        if (cursor.text !== next.text) onChange(next.text)
      }
      return
    }
    // Ink on Linux/Mac reports Backspace as key.delete + input '' (issue #634). Use raw stdin flag to treat as backspace.
    if (key.delete && input === '' && lastRawWasBackspaceRef.current) {
      lastRawWasBackspaceRef.current = false
      const next = cursor.backspace()
      if (!cursor.equals(next)) applyCursor(next)
      return
    }
    const nextCursor = mapKey(key)(input)
    if (nextCursor && !cursor.equals(nextCursor)) applyCursor(nextCursor)
  }

  return {
    onInput,
    renderedValue: cursor.render(cursorChar, mask, invert),
    offset,
    setOffset,
  }
}
