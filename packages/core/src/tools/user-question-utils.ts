import type { UserQuestionAnswer, UserQuestionItem, UserQuestionOption, UserQuestionRequest } from "../types.js"

/** Synthetic option id for the host-added “Other / custom” row (never send from the model). */
export const NEXUS_CUSTOM_OPTION_ID = "__nexus_other__"

/** First line of user messages created after submitting a questionnaire (hosts may use for compact UI). */
export const NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX = "[nexus:questionnaire-response]\n"

const RESERVED_CUSTOM_REGEXES: RegExp[] = [
  /^other$/i,
  /^custom$/i,
  /^else$/i,
  /^другое$/i,
  /^иное$/i,
  /^другой$/i,
  /^другая$/i,
  /^другие$/i,
  /^вручную$/i,
  /^указать\.?$/i,
  /^укажите/i,
  /^specify\.?$/i,
  /^something else$/i,
  /^none of the above$/i,
  /^\.\.\.$/,
  /^…$/,
  /^other\s+\(/i,
  /^custom\s+\(/i,
  /^иначе$/i,
  /^сво(?:й|я|ё) вариант/i,
]

function stripTrailingParenHint(label: string): string {
  return label.replace(/\s*\([^)]{0,80}\)\s*$/g, "").trim()
}

export function normalizeCustomOptionLabel(input?: string): string {
  const t = input?.trim()
  return t && t.length > 0 ? t : "Other"
}

/**
 * True when the agent tried to supply its own “Other/custom” option; we drop these so the host adds exactly one.
 */
export function labelLooksLikeReservedCustomOption(label: string, resolvedCustomLabel: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return true
  const core = stripTrailingParenHint(trimmed)
  const lower = core.toLowerCase().replace(/\s+/g, " ").trim()
  const customLower = normalizeCustomOptionLabel(resolvedCustomLabel).toLowerCase().replace(/\s+/g, " ")
  if (customLower.length > 0 && lower === customLower) return true
  if (customLower.length > 0 && lower.startsWith(customLower + " ") && lower.length <= customLower.length + 24) return true
  for (const re of RESERVED_CUSTOM_REGEXES) {
    if (re.test(lower)) return true
  }
  return false
}

export function dedupeOptionsPreservingOrder(labels: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of labels) {
    const t = raw.trim()
    if (!t) continue
    const key = t.toLowerCase().replace(/\s+/g, " ")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * Remove agent-supplied “Other” duplicates and normalize; ensures real choices remain when possible.
 */
export function sanitizeAgentQuestionOptions(raw: string[], customOptionLabel: string): string[] {
  const label = normalizeCustomOptionLabel(customOptionLabel)
  const deduped = dedupeOptionsPreservingOrder(raw.map((s) => s.trim()).filter(Boolean))
  let filtered = deduped.filter((l) => !labelLooksLikeReservedCustomOption(l, label))
  if (filtered.length < 2) {
    filtered = deduped.filter((l) => l.toLowerCase().replace(/\s+/g, " ") !== label.toLowerCase())
  }
  if (filtered.length < 2) {
    filtered = deduped
  }
  return filtered
}

export function formatQuestionnaireAnswersForAgent(request: UserQuestionRequest, answers: UserQuestionAnswer[]): string {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]))
  const lines = request.questions.map((question) => {
    const answer = byId.get(question.id)
    const value =
      answer?.customText?.trim() ||
      answer?.optionLabel?.trim() ||
      question.options.find((option) => option.id === answer?.optionId)?.label ||
      "—"
    return `${question.question} → ${value}`
  })
  return `${NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX}${lines.join("\n")}`
}

/** Generic choices when the model omits options; UI still adds custom/Other. */
const DEFAULT_OPTION_PAD = ["Brief answer", "Detailed answer"]

/**
 * When the model leaves questions under-specified, we pad to two choices. Rotate pairs by
 * question index so a multi-question batch does not show identical labels on every step.
 */
const DEFAULT_OPTION_PAD_ROTATIONS: string[][] = [
  ["Brief answer", "Detailed answer"],
  ["Short reply", "Longer explanation"],
  ["Summary style", "Step-by-step"],
  ["Quick take", "Expanded take"],
  ["Concise", "Comprehensive"],
  ["Simple option", "Detailed option"],
]

function optionKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Ensure at least two concrete choices after sanitization (Zod no longer hard-fails on <2).
 */
export function padQuestionOptionsToMinTwo(
  labels: string[],
  customOptionLabel: string,
  questionIndex = 0,
): string[] {
  let cleaned = sanitizeAgentQuestionOptions(labels, customOptionLabel)
  if (cleaned.length >= 2) return cleaned
  const out = [...cleaned]
  const seen = new Set(out.map((x) => optionKey(x)).filter(Boolean))
  const tryPush = (label: string) => {
    const key = optionKey(label)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(label)
  }
  const rotation =
    DEFAULT_OPTION_PAD_ROTATIONS[questionIndex % DEFAULT_OPTION_PAD_ROTATIONS.length] ??
    DEFAULT_OPTION_PAD
  for (const d of rotation) {
    if (out.length >= 2) break
    tryPush(d)
  }
  for (const d of DEFAULT_OPTION_PAD) {
    if (out.length >= 2) break
    tryPush(d)
  }
  return out
}

export function buildUserQuestionOptions(
  agentLabels: string[],
  customOptionLabel: string,
  questionIndex: number,
): UserQuestionOption[] {
  const cleaned = padQuestionOptionsToMinTwo(agentLabels, customOptionLabel, questionIndex)
  return cleaned.map((lab, i) => ({
    id: `opt_${questionIndex + 1}_${i + 1}`,
    label: lab,
  }))
}
