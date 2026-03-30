import { useInput } from 'ink'
import { useMemo, useRef, type MutableRefObject } from 'react'
import { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { logEvent } from '../services/statsig.js'
import { BinaryFeedbackContext } from '../screens/REPL.js'
import type { SetToolJSXFn } from '../Tool.js'

/** Escape-to-cancel consults refs inside these getters so Ink input handlers stay fresh. */
export type NexusCancelRequestScope = {
  isCancellable: () => boolean
  getAbortController: () => AbortController | null
}

export function useCancelRequest(
  setToolJSX: SetToolJSXFn,
  setToolUseConfirm: (toolUseConfirm: ToolUseConfirm | null) => void,
  setBinaryFeedbackContext: (bfContext: BinaryFeedbackContext | null) => void,
  onCancel: () => void,
  isMessageSelectorVisibleRef: MutableRefObject<boolean>,
  cancelScope: NexusCancelRequestScope,
) {
  const scopeRef = useRef(cancelScope)
  scopeRef.current = cancelScope
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  const stableScope = useMemo<NexusCancelRequestScope>(
    () => ({
      isCancellable: () => scopeRef.current.isCancellable(),
      getAbortController: () => scopeRef.current.getAbortController(),
    }),
    [],
  )

  useInput((_, key) => {
    if (!key.escape) {
      return
    }
    if (isMessageSelectorVisibleRef.current) {
      return
    }
    const scope = stableScope
    if (!scope.isCancellable()) {
      return
    }
    const ac = scope.getAbortController()
    if (ac?.signal.aborted) {
      return
    }
    // Active run (main loop and/or sub-agents): Escape must abort even if a tool JSX shell is open.
    logEvent('tengu_cancel', {})
    setToolJSX(null)
    setToolUseConfirm(null)
    setBinaryFeedbackContext(null)
    onCancelRef.current()
  })
}
