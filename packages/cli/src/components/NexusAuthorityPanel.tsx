import { Box, Text, useInput } from "ink"
import React, { useMemo, useState } from "react"
import figures from "figures"
import type { PendingProjectAuthorityRequest } from "@nexuscode/core"

import {
  approvePendingProjectAuthorityByFingerprint,
} from "../project-authority.js"
import { getTheme } from "../utils/theme.js"

interface Props {
  cwd: string
  initialRequests: readonly PendingProjectAuthorityRequest[]
  onClose: (result?: { saved?: boolean }) => void
}

function describeRequest(request: PendingProjectAuthorityRequest): string {
  const compact = JSON.stringify(request.payload)
  return compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`
}

/** Exact identity stays internal; the operator navigates human request rows. */
export function formatAuthorityRequestLabel(
  request: { readonly kind: string },
): string {
  return request.kind
}

export function NexusAuthorityPanel({
  cwd,
  initialRequests,
  onClose,
}: Props): React.ReactNode {
  const theme = getTheme()
  const [requests, setRequests] = useState([...initialRequests])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = requests[selectedIndex]
  const rows = useMemo(
    () => requests.map((request) => ({
      request,
      detail: describeRequest(request),
    })),
    [requests],
  )

  useInput((input, key) => {
    if (saving) return
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((index) =>
        Math.min(Math.max(0, rows.length - 1), index + 1))
      return
    }
    if ((input === "a" || input === "A") && selected) {
      setSaving(true)
      setError(null)
      void approvePendingProjectAuthorityByFingerprint(
        cwd,
        selected.fingerprint,
      )
        .then(() => {
          const next = requests.filter(
            (request) => request.fingerprint !== selected.fingerprint,
          )
          setRequests(next)
          setSelectedIndex((index) =>
            Math.min(index, Math.max(0, next.length - 1)))
          setSaving(false)
          if (next.length === 0) onClose({ saved: true })
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          setSaving(false)
        })
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Project authority requests</Text>
      <Text dimColor>
        Repository endpoints, executables, and external paths stay inactive
        until this host approves the exact normalized request.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme.success}>No pending project authority requests.</Text>
        ) : rows.map(({ request, detail }, index) => (
          <Box key={request.fingerprint} flexDirection="column" marginBottom={1}>
            <Text color={index === selectedIndex ? theme.primary : undefined}>
              {index === selectedIndex ? figures.pointer : " "}{" "}
              {formatAuthorityRequestLabel(request)}
            </Text>
            <Text dimColor>  {detail}</Text>
          </Box>
        ))}
      </Box>
      {error && <Text color={theme.error}>{error}</Text>}
      {saving && <Text color={theme.warning}>Saving exact host approval…</Text>}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · A approve exact request · Esc close</Text>
      </Box>
    </Box>
  )
}
