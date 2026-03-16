import { Box, Text, useInput } from 'ink'
import React, { useMemo, useRef, useState } from 'react'
import figures from 'figures'
import { getTheme } from '../utils/theme.js'
import type { NexusConfig } from '@nexuscode/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

type CloseResult = { cancelled?: boolean; saved?: boolean }

type Props = {
  initialConfig: NexusConfig
  cwd: string
  onSave: (patch: Partial<NexusConfig>) => Promise<void>
  onClose: (result?: CloseResult) => void
}

type SkillItem = {
  path: string
  enabled: boolean
}

const VISIBLE_ROWS = 10

/** Scan .nexus/skills/ for subdirs containing SKILL.md, return their absolute paths. */
function scanSkillsDir(cwd: string): string[] {
  const skillsDir = path.join(cwd, '.nexus', 'skills')
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    const result: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillMd)) {
          result.push(path.join(skillsDir, entry.name))
        }
      }
    }
    return result
  } catch {
    return []
  }
}

/** Merge config skills with filesystem-discovered skills. */
function buildSkillList(initialConfig: NexusConfig, cwd: string): SkillItem[] {
  const configSkills: SkillItem[] = (initialConfig.skillsConfig ?? []).map((s) => ({
    path: s.path,
    enabled: s.enabled,
  }))

  const configPaths = new Set(configSkills.map((s) => s.path))
  const fsSkills = scanSkillsDir(cwd)
  for (const skillPath of fsSkills) {
    if (!configPaths.has(skillPath)) {
      configSkills.push({ path: skillPath, enabled: true })
    }
  }

  return configSkills
}

export function NexusSkillsPanel({ initialConfig, cwd, onSave, onClose }: Props): React.ReactNode {
  const theme = getTheme()

  const [skills, setSkills] = useState<SkillItem[]>(() => buildSkillList(initialConfig, cwd))
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedIndexRef = useRef(0)
  selectedIndexRef.current = selectedIndex

  const scrollStart = useMemo(
    () => Math.max(0, Math.min(selectedIndex, skills.length - VISIBLE_ROWS)),
    [selectedIndex, skills.length],
  )
  const visibleSkills = skills.slice(scrollStart, scrollStart + VISIBLE_ROWS)

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
      setSelectedIndex((i) => Math.min(skills.length - 1, i + 1))
      return
    }

    if (input === ' ' || key.return) {
      if (skills.length === 0) return
      setSkills((prev) =>
        prev.map((s, i) => (i === selectedIndexRef.current ? { ...s, enabled: !s.enabled } : s)),
      )
      setSaved(false)
      return
    }

    if (input === 's' || input === 'S') {
      setSaving(true)
      setSaved(false)
      setError(null)
      onSave({ skillsConfig: skills })
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
        <Text bold>Skills</Text>
        <Text dimColor>Toggle skills loaded into the assistant context.</Text>
      </Box>

      {skills.length === 0 ? (
        <Box flexDirection="column" minHeight={3}>
          <Text dimColor>No skills configured.</Text>
          <Text dimColor>Create skills in .nexus/skills/ (each subfolder with SKILL.md).</Text>
        </Box>
      ) : (
        <Box flexDirection="column" minHeight={Math.min(skills.length, VISIBLE_ROWS)}>
          {visibleSkills.map((skill, i) => {
            const globalIndex = scrollStart + i
            const isSelected = globalIndex === selectedIndex
            const shortPath = skill.path.replace(cwd + path.sep, '')
            const statusText = skill.enabled ? 'enabled' : 'disabled'
            const statusColor = skill.enabled ? theme.primary : theme.secondaryText ?? 'gray'
            return (
              <Box key={skill.path} height={1}>
                <Text color={isSelected ? theme.primary : undefined}>
                  {isSelected ? figures.pointer : ' '}{' '}
                </Text>
                <Text color={isSelected ? theme.primary : undefined}>{shortPath}</Text>
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
        <Text dimColor>↑/↓ navigate · Space/Enter toggle · S save · Esc close</Text>
      </Box>
    </Box>
  )
}
