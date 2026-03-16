import { Box, Text, useInput } from 'ink'
import React, { useRef, useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig, McpServerConfig } from '@nexuscode/core'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const VISIBLE_ROWS = 10

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  initialConfig: NexusConfig
  cwd: string
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: (result?: CloseResult) => void
}

export function NexusMcpPanel({ initialConfig, onSave, onClose }: Props): React.ReactNode {
  const theme = getTheme()

  const [servers, setServers] = useState<McpServerConfig[]>(
    () => initialConfig.mcp?.servers ?? [],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedIndexRef = useRef(0)
  selectedIndexRef.current = selectedIndex

  const scrollStart = Math.max(0, Math.min(selectedIndex, servers.length - VISIBLE_ROWS))
  const visibleServers = servers.slice(scrollStart, scrollStart + VISIBLE_ROWS)

  useInput((input, key) => {
    if (key.escape) {
      onClose({ cancelled: true })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(servers.length - 1, i + 1))
      return
    }

    if (input === ' ' || key.return) {
      if (servers.length === 0) return
      setServers((prev) =>
        prev.map((s, i) =>
          i === selectedIndexRef.current
            ? { ...s, enabled: !(s.enabled ?? true) }
            : s,
        ),
      )
      setSaved(false)
      return
    }

    if (input === 'g' || input === 'G') {
      // Open global MCP config in editor
      const globalMcpPath = path.join(os.homedir(), '.nexus', 'mcp-servers.json')
      try {
        fs.mkdirSync(path.dirname(globalMcpPath), { recursive: true })
        if (!fs.existsSync(globalMcpPath)) {
          fs.writeFileSync(globalMcpPath, JSON.stringify({ servers: [] }, null, 2), 'utf8')
        }
        const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'nano'
        spawnSync(editor, [globalMcpPath], { stdio: 'inherit' })
      } catch { /* ignore */ }
      return
    }

    if (input === 's' || input === 'S') {
      setSaving(true)
      setSaved(false)
      setError(null)
      onSave({ mcp: { servers } })
        .then(() => {
          setSaving(false)
          setSaved(true)
        })
        .catch((e) => {
          setError(String(e))
          setSaving(false)
        })
      return
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      marginTop={1}
    >
      <Box flexDirection="column" minHeight={2} marginBottom={1}>
        <Text bold>MCP Servers</Text>
        <Text dimColor>Toggle Model Context Protocol servers on or off.</Text>
      </Box>

      {servers.length === 0 ? (
        <Box flexDirection="column" minHeight={3}>
          <Text dimColor>No MCP servers configured.</Text>
          <Text dimColor>Add servers in .nexus/mcp-servers.json.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" minHeight={Math.min(servers.length, VISIBLE_ROWS)}>
          {visibleServers.map((server, i) => {
            const globalIndex = scrollStart + i
            const isSelected = globalIndex === selectedIndex
            const isEnabled = server.enabled ?? true
            const statusText = isEnabled ? 'enabled' : 'disabled'
            const statusColor = isEnabled ? theme.primary : theme.secondaryText ?? 'gray'
            const detail = server.url ?? server.command ?? server.bundle ?? ''
            return (
              <Box key={server.name + String(globalIndex)} height={1}>
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? figures.pointer : ' '}{' '}
                </Text>
                <Text color={isSelected ? theme.primary : undefined}>{server.name}</Text>
                {detail ? (
                  <>
                    <Text dimColor>  </Text>
                    <Text dimColor>{detail}</Text>
                  </>
                ) : null}
                <Text dimColor>  </Text>
                <Text color={statusColor}>{statusText}</Text>
              </Box>
            )
          })}
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      )}
      {saving && (
        <Box marginTop={1}>
          <Text dimColor>Saving…</Text>
        </Box>
      )}
      {saved && !saving && (
        <Box marginTop={1}>
          <Text color={theme.primary}>Saved.</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Space/Enter toggle · S save · G global config · Esc close</Text>
      </Box>
    </Box>
  )
}
