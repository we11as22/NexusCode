import { useInput } from 'ink'
import { useState, useCallback } from 'react'
import { Command, getCommand } from '../commands.js'

export type CommandSuggestion = {
  name: string
  description?: string
  section: 'NEXUS' | 'CREATE' | 'COMMANDS'
  isVirtual?: boolean
  aliases?: string[]
  /** When true: selecting inserts the command text into input but does NOT auto-submit */
  waitForInput?: boolean
}

type Props = {
  commands: Command[]
  onInputChange: (value: string) => void
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void
  setCursorOffset: (offset: number) => void
  /** When true (Nexus is active), show Nexus-specific commands */
  isNexus?: boolean
}

const NEXUS_VIRTUAL_COMMANDS: CommandSuggestion[] = [
  { name: 'undo', description: 'Revert chat & files (last turn or checkpoint)', section: 'NEXUS', isVirtual: true },
  { name: 'mode', description: 'Select agent mode (agent/plan/ask/debug/review)', section: 'NEXUS', isVirtual: true },
  { name: 'diff', description: 'Show session file changes (lines added/removed)', section: 'NEXUS', isVirtual: true },
  { name: 'compact', description: 'Compress conversation context summary', section: 'NEXUS', isVirtual: true },
  { name: 'skills', description: 'Manage skills (enable/disable)', section: 'NEXUS', isVirtual: true },
  { name: 'mcp', description: 'Manage MCP servers', section: 'NEXUS', isVirtual: true },
  { name: 'sessions', description: 'Browse and switch sessions', section: 'NEXUS', isVirtual: true },
  { name: 'index', description: 'Indexer status and controls', section: 'NEXUS', isVirtual: true },
  { name: 'embeddings', description: 'Embeddings model settings', section: 'NEXUS', isVirtual: true },
]

const CREATE_COMMANDS: CommandSuggestion[] = [
  { name: 'create-skill', description: 'Create a new skill (describe it)', section: 'CREATE', isVirtual: true, waitForInput: true },
  { name: 'create-rule', description: 'Create a new rule (describe it)', section: 'CREATE', isVirtual: true, waitForInput: true },
]

function matchesQuery(suggestion: CommandSuggestion, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (suggestion.name.toLowerCase().includes(q)) return true
  if (suggestion.description?.toLowerCase().includes(q)) return true
  if (suggestion.aliases?.some(a => a.toLowerCase().includes(q))) return true
  return false
}

export function useSlashCommandTypeahead({
  commands,
  onInputChange,
  onSubmit,
  setCursorOffset,
  isNexus = false,
}: Props): {
  suggestions: CommandSuggestion[]
  selectedSuggestion: number
  updateSuggestions: (value: string) => void
  clearSuggestions: () => void
} {
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([])
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)

  function buildAllSuggestions(query: string): CommandSuggestion[] {
    const result: CommandSuggestion[] = []

    // Section: NEXUS (only when nexus is active)
    if (isNexus) {
      const nexusFiltered = NEXUS_VIRTUAL_COMMANDS.filter(s => matchesQuery(s, query))
      result.push(...nexusFiltered)
    }

    // Section: CREATE
    const createFiltered = CREATE_COMMANDS.filter(s => matchesQuery(s, query))
    result.push(...createFiltered)

    // Section: COMMANDS (standard CLI commands) — exclude names already shown in NEXUS/CREATE
    const alreadyShown = new Set(result.map(s => s.name))
    const cmdSuggestions: CommandSuggestion[] = commands
      .filter(cmd => !cmd.isHidden)
      .filter(cmd => !alreadyShown.has(cmd.userFacingName()))
      .filter(cmd => {
        const names = [cmd.userFacingName(), ...(cmd.aliases ?? [])]
        const nameMatch = names.some(name => name.toLowerCase().includes(query.toLowerCase()))
        const descMatch = cmd.description?.toLowerCase().includes(query.toLowerCase())
        return nameMatch || descMatch
      })
      .map(cmd => ({
        name: cmd.userFacingName(),
        description: cmd.description,
        section: 'COMMANDS' as const,
        aliases: cmd.aliases,
      }))

    result.push(...cmdSuggestions)
    return result
  }

  function updateSuggestions(value: string) {
    if (value.startsWith('/')) {
      const query = value.slice(1)

      const filtered = buildAllSuggestions(query)
      setSuggestions(filtered)

      // Try to preserve the selected suggestion
      const prevName = selectedSuggestion > -1 ? suggestions[selectedSuggestion]?.name : undefined
      const newIndex = prevName ? filtered.findIndex(s => s.name === prevName) : 0
      setSelectedSuggestion(newIndex >= 0 ? newIndex : 0)
    } else {
      setSuggestions([])
      setSelectedSuggestion(-1)
    }
  }

  useInput((_, key) => {
    if (suggestions.length > 0) {
      // Handle suggestion navigation (up/down arrows)
      if (key.downArrow) {
        setSelectedSuggestion(prev =>
          Math.min(suggestions.length - 1, prev + 1),
        )
        return true
      } else if (key.upArrow) {
        setSelectedSuggestion(prev => Math.max(0, prev - 1))
        return true
      }

      // Handle selection completion via tab or return
      else if (key.tab || (key.return && selectedSuggestion >= 0)) {
        // Ensure a suggestion is selected
        if (selectedSuggestion === -1 && key.tab) {
          setSelectedSuggestion(0)
        }

        const suggestionIndex = selectedSuggestion >= 0 ? selectedSuggestion : 0
        const suggestion = suggestions[suggestionIndex]
        if (!suggestion) return true

        const input = '/' + suggestion.name + ' '
        onInputChange(input)
        // Manually move cursor to end
        setCursorOffset(input.length)
        setSuggestions([])
        setSelectedSuggestion(-1)

        // If return was pressed and command doesn't take arguments, just run it
        if (key.return) {
          if (suggestion.waitForInput) {
            // Insert command into input and wait for user to type description
            // (don't submit yet)
            return true
          }
          if (suggestion.isVirtual) {
            // Virtual commands are submitted as-is for processing
            onSubmit(input, /* isSubmittingSlashCommand */ true)
          } else {
            const command = getCommand(suggestion.name, commands)
            if (
              command.type !== 'prompt' ||
              (command.argNames ?? []).length === 0
            ) {
              onSubmit(input, /* isSubmittingSlashCommand */ true)
            }
          }
        }

        return true
      }
    }
  })

  const clearSuggestions = useCallback(() => {
    setSuggestions([])
    setSelectedSuggestion(-1)
  }, [])

  return {
    suggestions,
    selectedSuggestion,
    updateSuggestions,
    clearSuggestions,
  }
}
