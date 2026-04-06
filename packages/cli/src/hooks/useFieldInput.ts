/**
 * Single-line field input with cursor, selection, and clipboard.
 * Use in forms (e.g. NexusModelPanel) for consistent navigation and copy/paste across platforms.
 */
import { useState, useCallback, useEffect } from 'react'
import type { Key } from 'ink'
import { Cursor } from '../utils/Cursor.js'
import { getClipboardText, setClipboardText } from '../utils/clipboard.js'
import { asExtendedKey } from '../utils/ink.js'

const FIELD_COLUMNS = 120

function stripBracketedPaste(input: string): string {
  if (input.includes('\x1b[200~')) {
    return input.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
  }
  return input
}

export function useFieldInput(
  value: string,
  setValue: (v: string | ((prev: string) => string)) => void,
  invert: (text: string) => string,
  options?: { maskChar?: string },
) {
  const maskChar = options?.maskChar ?? ''
  const [offset, setOffset] = useState(value.length)
  const [selectionAnchor, setSelectionAnchor] = useState(value.length)

  useEffect(() => {
    const max = value.length
    setOffset((o) => Math.min(o, max))
    setSelectionAnchor((s) => Math.min(s, max))
  }, [value.length])

  const cursor = Cursor.fromText(value, FIELD_COLUMNS, offset, selectionAnchor)
  const displayCursor = maskChar
    ? Cursor.fromText(maskChar.repeat(value.length), FIELD_COLUMNS, offset, selectionAnchor)
    : cursor

  const applyCursor = useCallback((next: Cursor) => {
    setOffset(next.offset)
    if (cursor.text !== next.text) setValue(next.text)
    setSelectionAnchor(next.selection)
  }, [cursor.text, setValue])

  const handleInput = useCallback(
    (input: string, key: Key): boolean => {
      const extendedKey = asExtendedKey(key)
      if (extendedKey.escape || extendedKey.tab || extendedKey.backtab) return false

      if (extendedKey.backspace || input === '\x7f' || input === '\b') {
        applyCursor(cursor.backspace())
        return true
      }
      if (extendedKey.delete || input === '\x1b[3~') {
        applyCursor(cursor.del())
        return true
      }
      if (extendedKey.leftArrow) {
        applyCursor(extendedKey.shift ? cursor.left().withAnchor(cursor.hasSelection() ? cursor.selection : cursor.offset) : cursor.left().collapseSelection())
        return true
      }
      if (extendedKey.rightArrow) {
        applyCursor(extendedKey.shift ? cursor.right().withAnchor(cursor.hasSelection() ? cursor.selection : cursor.offset) : cursor.right().collapseSelection())
        return true
      }
      if (extendedKey.home) {
        applyCursor(extendedKey.shift ? cursor.startOfLine().withAnchor(cursor.hasSelection() ? cursor.selection : cursor.offset) : cursor.startOfLine().collapseSelection())
        return true
      }
      if (extendedKey.end) {
        applyCursor(extendedKey.shift ? cursor.endOfLine().withAnchor(cursor.hasSelection() ? cursor.selection : cursor.offset) : cursor.endOfLine().collapseSelection())
        return true
      }
      if (extendedKey.ctrl) {
        const c = (input ?? '').toLowerCase()
        if (c === 'a') {
          applyCursor(cursor.startOfLine().withAnchor(cursor.endOfLine().offset))
          return true
        }
        if (c === 'c' && cursor.hasSelection()) {
          setClipboardText(cursor.getSelectedText())
          return true
        }
        if (c === 'x' && cursor.hasSelection()) {
          setClipboardText(cursor.getSelectedText())
          applyCursor(cursor.replaceSelected(''))
          return true
        }
        if (c === 'v') {
          const pasted = getClipboardText()
          if (pasted) applyCursor(cursor.replaceSelected(pasted))
          return true
        }
        if (c === 'u') {
          applyCursor(cursor.deleteToLineStart())
          return true
        }
        if (c === 'k') {
          applyCursor(cursor.deleteToLineEnd())
          return true
        }
        if (c === 'w') {
          applyCursor(cursor.deleteWordBefore())
          return true
        }
      }
      if (extendedKey.meta) {
        const m = (input ?? '').toLowerCase()
        if (m === 'b') {
          applyCursor(cursor.prevWord().collapseSelection())
          return true
        }
        if (m === 'f') {
          applyCursor(cursor.nextWord().collapseSelection())
          return true
        }
        if (m === 'd') {
          applyCursor(cursor.deleteWordAfter())
          return true
        }
      }
      if (input != null && input !== '' && input !== '\r' && input !== '\n') {
        const raw = stripBracketedPaste(input)
        const safe = raw.replace(/\r\n?/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x1f\x7f]/g, '')
        if (safe.length > 0) applyCursor(cursor.replaceSelected(safe))
        return true
      }
      return false
    },
    [cursor, applyCursor],
  )

  const renderedValue = displayCursor.render('|', '', invert)

  return { offset, selectionAnchor, handleInput, renderedValue }
}
