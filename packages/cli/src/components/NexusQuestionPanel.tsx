import { Box, Text, useInput } from 'ink'
import React, { useMemo, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getTheme } from '../utils/theme.js'
import { NEXUS_CUSTOM_OPTION_ID, type UserQuestionRequest, type UserQuestionAnswer } from '@nexuscode/core'

type AnswerState = {
  optionId?: string
  optionIds?: string[]
  optionLabel?: string
  optionLabels?: string[]
  customText?: string
}

function questionAnswered(
  item: UserQuestionRequest['questions'][number],
  answer?: AnswerState,
): boolean {
  if (!answer) return false
  if (answer.optionId === NEXUS_CUSTOM_OPTION_ID) return Boolean(answer.customText?.trim())
  if (item.multiSelect) return Array.isArray(answer.optionIds) && answer.optionIds.length > 0
  return Boolean(answer.optionId)
}

type Props = {
  request: UserQuestionRequest
  onDismiss: () => void
  onSubmit: (answers: UserQuestionAnswer[]) => void | Promise<void>
}

const SEPARATOR_CHAR = '─'

function stepLabel(
  item: UserQuestionRequest['questions'][number],
  index: number,
): string {
  const rawId = item.id?.trim() ?? ''
  if (
    rawId &&
    !/^question_\d+$/i.test(rawId) &&
    !/^parallel_question_\d+$/i.test(rawId)
  ) {
    return rawId
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .slice(0, 18)
  }
  const q = item.question.trim().replace(/[?.!]+$/, '')
  if (!q) return `Question ${index + 1}`
  return q.split(/\s+/).slice(0, 3).join(' ').slice(0, 18)
}

function displayCustomOptionLabel(customOptionLabel?: string): string {
  const label = customOptionLabel?.trim()
  if (!label) return 'Type something.'
  if (/^other$/i.test(label)) return 'Type something.'
  return label
}

export function NexusQuestionPanel({ request, onDismiss, onSubmit }: Props): React.ReactNode {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const reviewPageIndex = request.questions.length
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({})

  const question = questionIndex < request.questions.length ? request.questions[questionIndex] : undefined
  const options = useMemo(() => {
    if (!question) return []
    const base = question.options.map((option) => ({ ...option, isCustom: false }))
    base.push({
      id: NEXUS_CUSTOM_OPTION_ID,
      label: displayCustomOptionLabel(request.customOptionLabel),
      isCustom: true,
    })
    return base
  }, [question, request.customOptionLabel])
  const stepLabels = useMemo(
    () => request.questions.map((item, index) => stepLabel(item, index)),
    [request.questions],
  )

  const answeredCount = request.questions.filter((item) => questionAnswered(item, answers[item.id])).length
  const allAnswered = answeredCount === request.questions.length && request.questions.length > 0
  const activeAnswer = question ? answers[question.id] : undefined
  const customMode =
    question != null && activeAnswer?.optionId === NEXUS_CUSTOM_OPTION_ID
  const isMulti = Boolean(question?.multiSelect)

  React.useEffect(() => {
    if (!question) return
    const current = answers[question.id]
    let idx = -1
    if (question.multiSelect && current?.optionIds && current.optionIds.length > 0) {
      idx = options.findIndex((option) => option.id === current.optionIds![0])
    } else if (current?.optionId) {
      idx = options.findIndex((option) => option.id === current.optionId)
    }
    setSelectedIndex(idx >= 0 ? idx : 0)
  }, [answers, options, question])

  const goToQuestion = (index: number) => {
    const nextIndex = Math.max(0, Math.min(reviewPageIndex, index))
    setQuestionIndex(nextIndex)
    if (nextIndex >= request.questions.length) setSelectedIndex(0)
  }

  const advanceAfterAnswer = () => {
    if (questionIndex >= request.questions.length - 1) {
      setQuestionIndex(reviewPageIndex)
      setSelectedIndex(0)
      return
    }
    setQuestionIndex((prev) => prev + 1)
    setSelectedIndex(0)
  }

  const submitAllAnswers = () =>
    onSubmit(
      request.questions.map((item) => {
        const a = answers[item.id]
        if (item.multiSelect) {
          if (a?.optionId === NEXUS_CUSTOM_OPTION_ID) {
            return {
              questionId: item.id,
              optionId: a.optionId,
              optionLabel: a.optionLabel,
              customText: a.customText,
            }
          }
          const ids = a?.optionIds ?? []
          const labels = ids
            .map((id) => item.options.find((o) => o.id === id)?.label)
            .filter((x): x is string => Boolean(x?.trim()))
          return { questionId: item.id, optionIds: ids, optionLabels: labels }
        }
        return {
          questionId: item.id,
          optionId: a?.optionId,
          optionLabel: a?.optionLabel,
          customText: a?.customText,
        }
      }),
    )

  useInput((input, key) => {
    if (questionIndex >= reviewPageIndex) {
      if (key.escape) {
        onDismiss()
        return
      }
      if (key.leftArrow || input === 'h') {
        setQuestionIndex(Math.max(0, reviewPageIndex - 1))
        setSelectedIndex(0)
        return
      }
      if (key.upArrow || input === 'k') {
        setSelectedIndex((i) => (i - 1 + 2) % 2)
        return
      }
      if (key.downArrow || input === 'j') {
        setSelectedIndex((i) => (i + 1) % 2)
        return
      }
      if (input === '1') {
        if (allAnswered) void submitAllAnswers()
        return
      }
      if (input === '2') {
        onDismiss()
        return
      }
      if (key.return) {
        if (selectedIndex === 0 && allAnswered) {
          void submitAllAnswers()
        } else if (selectedIndex === 1) {
          onDismiss()
        }
        return
      }
      return
    }

    if (!question) return

    if (customMode) {
      if (key.escape) {
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            optionId: undefined,
            optionLabel: undefined,
            optionIds: undefined,
            optionLabels: undefined,
            customText: '',
          },
        }))
        return
      }
      if (key.return) {
        if (!(answers[question.id]?.customText ?? '').trim()) return
        advanceAfterAnswer()
        return
      }
      if (key.backspace || input === '\x7f' || key.delete) {
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            ...(prev[question.id] ?? {}),
            optionId: NEXUS_CUSTOM_OPTION_ID,
            optionLabel: request.customOptionLabel ?? 'Other',
            customText: (prev[question.id]?.customText ?? '').slice(0, -1),
          },
        }))
        return
      }
      if (input != null && input !== '' && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            ...(prev[question.id] ?? {}),
            optionId: NEXUS_CUSTOM_OPTION_ID,
            optionLabel: request.customOptionLabel ?? 'Other',
            customText: (prev[question.id]?.customText ?? '') + input.replace(/\r\n?/g, ' ').replace(/\r/g, ' '),
          },
        }))
      }
      return
    }

    if (key.escape) {
      onDismiss()
      return
    }
    if (key.leftArrow || input === 'h') {
      goToQuestion(questionIndex - 1)
      return
    }
    // Do not require an answer: ←/→ only move between questions (matches footer hint).
    if (key.rightArrow || input === 'l') {
      goToQuestion(questionIndex + 1)
      return
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((i) => (i - 1 + options.length) % options.length)
      return
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((i) => (i + 1) % options.length)
      return
    }
    if (isMulti && (input === ' ' || key.return)) {
      const selected = options[selectedIndex]
      if (!selected) return
      if (selected.isCustom) {
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            optionId: NEXUS_CUSTOM_OPTION_ID,
            optionLabel: request.customOptionLabel ?? 'Other',
            customText: prev[question.id]?.customText ?? '',
            optionIds: undefined,
            optionLabels: undefined,
          },
        }))
        return
      }
      setAnswers((prev) => {
        const cur = prev[question.id] ?? {}
        const ids = new Set(cur.optionIds ?? [])
        if (ids.has(selected.id)) ids.delete(selected.id)
        else ids.add(selected.id)
        return {
          ...prev,
          [question.id]: {
            optionIds: [...ids],
            optionId: undefined,
            optionLabel: undefined,
            optionLabels: undefined,
            customText: undefined,
          },
        }
      })
      return
    }
    if (input >= '1' && input <= '9') {
      const idx = Number(input) - 1
      if (idx >= 0 && idx < options.length) {
        setSelectedIndex(idx)
        if (isMulti) return
        const selected = options[idx]!
        setAnswers((prev) => ({
          ...prev,
          [question.id]: {
            optionId: selected.id,
            optionLabel: selected.label,
            customText: selected.isCustom ? (prev[question.id]?.customText ?? '') : undefined,
          },
        }))
        if (!selected.isCustom) advanceAfterAnswer()
      }
      return
    }
    if (!isMulti && key.return) {
      const selected = options[selectedIndex]
      if (!selected) return
      setAnswers((prev) => ({
        ...prev,
        [question.id]: {
          optionId: selected.id,
          optionLabel: selected.label,
          customText: selected.isCustom ? (prev[question.id]?.customText ?? '') : undefined,
        },
      }))
      if (!selected.isCustom) {
        advanceAfterAnswer()
      }
    }
  })

  const separator = SEPARATOR_CHAR.repeat(Math.max(8, columns))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.secondaryBorder}>{separator}</Text>
      <Box>
        <Text>
          ←{' '}
          {stepLabels.map((label, index) => {
            const qItem = request.questions[index]
            const answered = qItem ? questionAnswered(qItem, answers[qItem.id]) : false
            const active = questionIndex === index
            const marker = active ? '▣' : answered ? '☒' : '☐'
            const color = active ? theme.primary : undefined
            return (
              <Text key={request.questions[index]!.id} color={color}>
                {index > 0 ? '  ' : ''}
                {marker} {label}
              </Text>
            )
          })}
          {'  '}
          <Text color={questionIndex === reviewPageIndex ? theme.primary : undefined}>
            {questionIndex === reviewPageIndex ? '✔' : '☐'} Submit
          </Text>{' '}
          →
        </Text>
      </Box>
      {question ? (
        <>
          <Box marginTop={1} flexDirection="column">
            {question.header?.trim() ? (
              <Text dimColor bold>
                [{question.header.trim()}]
              </Text>
            ) : null}
            <Text bold>{question.question}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {options.map((option, index) => {
              const isSelected = isMulti
                ? Boolean(activeAnswer?.optionIds?.includes(option.id))
                : activeAnswer?.optionId === option.id
              const isFocused = index === selectedIndex
              return (
                <Box key={option.id} flexDirection="column" marginBottom={0}>
                  <Text color={isFocused || isSelected ? theme.primary : undefined}>
                    {isFocused ? '› ' : '  '}
                    {isMulti && !option.isCustom ? (isSelected ? '☑ ' : '☐ ') : ''}
                    {index + 1}. {option.label}
                  </Text>
                  {!option.isCustom && option.description?.trim() ? (
                    <Text dimColor>
                      {'    '}
                      {option.description.trim()}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>
          {!isMulti &&
          options[selectedIndex] &&
          !options[selectedIndex]!.isCustom &&
          options[selectedIndex]!.preview?.trim() ? (
            <Box
              marginTop={1}
              flexDirection="column"
              borderStyle="single"
              borderColor={theme.secondaryBorder}
              paddingX={1}
            >
              <Text dimColor>Preview</Text>
              <Text>{options[selectedIndex]!.preview!.trim()}</Text>
            </Box>
          ) : null}
          {customMode ? (
            <Box marginTop={1} borderStyle="single" borderColor={theme.secondaryBorder} paddingX={1}>
              <Text>{activeAnswer?.customText || ' '}</Text>
            </Box>
          ) : null}
          <Box marginTop={1} justifyContent="space-between">
            <Text dimColor>
              {isMulti
                ? '←/→ questions · ↑/↓ focus · Space/Enter toggle'
                : '←/→ switch question · ↑/↓ choose · Enter select'}
            </Text>
            <Text dimColor>
              {answeredCount}/{request.questions.length} answered
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              {customMode
                ? 'Type custom answer · Enter save and continue · Esc cancel custom'
                : 'Enter saves answer and moves to the next question · Esc dismiss'}
            </Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text bold>Review your answers</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {request.questions.map((item) => {
              const answer = answers[item.id]
              let value = '—'
              if (answer?.customText?.trim()) {
                value = answer.customText.trim()
              } else if (item.multiSelect && answer?.optionIds && answer.optionIds.length > 0) {
                const from = answer.optionLabels?.filter((x) => x.trim()).join(', ')
                value =
                  from ||
                  answer.optionIds
                    .map((id) => item.options.find((o) => o.id === id)?.label)
                    .filter((x): x is string => Boolean(x?.trim()))
                    .join(', ') ||
                  '—'
              } else {
                value = answer?.optionLabel?.trim() || '—'
              }
              return (
                <Box key={item.id} flexDirection="column" marginBottom={1}>
                  <Text>● {item.question}</Text>
                  <Text dimColor>  → {value}</Text>
                </Box>
              )
            })}
          </Box>
          <Box marginTop={1}>
            <Text>Ready to submit your answers?</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={selectedIndex === 0 ? theme.primary : undefined}>
              {selectedIndex === 0 ? '❯ ' : '  '}1. Submit answers
            </Text>
            <Text color={selectedIndex === 1 ? theme.primary : undefined}>
              {selectedIndex === 1 ? '❯ ' : '  '}2. Cancel
            </Text>
          </Box>
        </>
      )}
      <Text color={theme.secondaryBorder}>{separator}</Text>
    </Box>
  )
}
