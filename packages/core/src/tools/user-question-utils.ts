import type { UserQuestionAnswer, UserQuestionItem, UserQuestionOption, UserQuestionRequest } from "../types.js"

/** One row from the model before padding / id assignment (OpenClaude-style). */
export type QuestionOptionRow = { label: string; description?: string; preview?: string }

function optionKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim()
}

function pickExplicitOptionLabel(row: Record<string, unknown>): string | undefined {
  for (const k of ["label", "text", "value", "title", "name", "option", "answer"] as const) {
    const v = row[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * Coerce model-supplied options into structured rows (strings, CSV, or { label, description, preview }).
 */
export function coerceQuestionOptionRows(val: unknown): QuestionOptionRow[] {
  if (val === undefined || val === null) return []
  if (typeof val === "string") {
    const s = val.trim()
    if (!s) return []
    return splitQuestionOptionListString(s).map((label) => ({ label }))
  }
  if (typeof val === "number" || typeof val === "boolean") return [{ label: String(val) }]
  if (!Array.isArray(val)) return []
  const out: QuestionOptionRow[] = []
  for (const el of val) {
    if (typeof el === "string") {
      if (el.trim()) out.push(...splitQuestionOptionListString(el.trim()).map((label) => ({ label })))
      continue
    }
    if (typeof el === "number" || typeof el === "boolean") {
      out.push({ label: String(el) })
      continue
    }
    if (el != null && typeof el === "object") {
      const row = el as Record<string, unknown>
      const explicit = pickExplicitOptionLabel(row)
      const descField = typeof row.description === "string" && row.description.trim() ? row.description.trim() : undefined
      const contentField = typeof row.content === "string" && row.content.trim() ? row.content.trim() : undefined
      const label = explicit || descField || contentField
      if (!label) continue
      const description =
        descField && descField !== label ? descField : undefined
      const preview = typeof row.preview === "string" && row.preview.trim() ? row.preview.trim() : undefined
      out.push({ label, description, preview })
    }
  }
  return out
}

export function dedupeQuestionOptionRows(rows: QuestionOptionRow[]): QuestionOptionRow[] {
  const seen = new Set<string>()
  const out: QuestionOptionRow[] = []
  for (const r of rows) {
    const lab = r.label.trim()
    if (!lab) continue
    const key = optionKey(lab)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      label: lab,
      description: r.description?.trim() || undefined,
      preview: r.preview?.trim() || undefined,
    })
  }
  return out
}

/**
 * Split model-supplied options (one string or CSV) into separate choices.
 * - Commas/semicolons/pipes inside `()`, `[]`, `{}` do not split (fixes "API (req, err)").
 * - Multiline numbered lists (`1. …\\n2. …`) are split by line and prefixes stripped.
 * - Multiline bullet lists (`- …`, `• …`) get bullet prefixes stripped.
 */
export function splitQuestionOptionListString(s: string): string[] {
  const trimmed = s.trim()
  if (!trimmed) return []

  if (/\r?\n/.test(trimmed)) {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    const numberedRe = /^\d+[\.\)]\s/
    const numberedCount = lines.filter((l) => numberedRe.test(l)).length
    if (lines.length >= 2 && numberedCount >= Math.max(2, Math.ceil(lines.length * 0.5))) {
      return lines
        .map((l) => l.replace(/^\d+[\.\)]\s*/, "").trim())
        .filter((l) => l.length > 0)
    }
    const bulletRe = /^[-•*]\s/
    const bulletCount = lines.filter((l) => bulletRe.test(l)).length
    if (lines.length >= 2 && bulletCount >= Math.max(2, Math.ceil(lines.length * 0.5))) {
      return lines.map((l) => l.replace(/^[-•*]\s*/, "").trim()).filter((l) => l.length > 0)
    }
    if (lines.length > 1) return lines
  }

  return splitOnCommaSemicolonPipeRespectingParens(trimmed)
}

function splitOnCommaSemicolonPipeRespectingParens(s: string): string[] {
  const parts: string[] = []
  let buf = ""
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "(") depthParen++
    else if (c === ")") depthParen = Math.max(0, depthParen - 1)
    else if (c === "[") depthBracket++
    else if (c === "]") depthBracket = Math.max(0, depthBracket - 1)
    else if (c === "{") depthBrace++
    else if (c === "}") depthBrace = Math.max(0, depthBrace - 1)

    const canSplit = depthParen === 0 && depthBracket === 0 && depthBrace === 0
    if (canSplit && (c === "," || c === ";" || c === "|")) {
      const t = buf.trim()
      if (t) parts.push(t)
      buf = ""
      continue
    }
    buf += c
  }
  const last = buf.trim()
  if (last) parts.push(last)
  return parts.length > 0 ? parts : (s.trim() ? [s.trim()] : [])
}

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
  return deduped.filter((option) =>
    !labelLooksLikeReservedCustomOption(option, label),
  )
}

const MAX_CUSTOM_ANSWER_CHARACTERS = 16_384
const MAX_QUESTIONNAIRE_RESPONSE_CHARACTERS = 65_536

/**
 * Validate a host response against the exact options that core emitted.
 * Labels are rebuilt from the request so a client cannot inject forged
 * display text into the next model turn.
 */
export function validateQuestionnaireAnswers(
  request: UserQuestionRequest,
  answers: UserQuestionAnswer[],
): UserQuestionAnswer[] {
  const questionsById = new Map(
    request.questions.map((question) => [question.id, question]),
  )
  const answersById = new Map<string, UserQuestionAnswer>()

  for (const answer of answers) {
    if (answersById.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}".`)
    }
    if (!questionsById.has(answer.questionId)) {
      throw new Error(`Unknown question "${answer.questionId}".`)
    }
    answersById.set(answer.questionId, answer)
  }

  const normalized = request.questions.map((question): UserQuestionAnswer => {
    const answer = answersById.get(question.id)
    if (!answer) {
      throw new Error(`Missing answer for question "${question.id}".`)
    }

    if (answer.optionId === NEXUS_CUSTOM_OPTION_ID) {
      if (question.allowCustom !== true) {
        throw new Error(`Custom answer is not allowed for question "${question.id}".`)
      }
      if (answer.optionIds?.length) {
        throw new Error(`Custom answer cannot include concrete options for question "${question.id}".`)
      }
      const customText = answer.customText?.trim() ?? ""
      if (!customText) {
        throw new Error(`Custom answer is required for question "${question.id}".`)
      }
      if (customText.length > MAX_CUSTOM_ANSWER_CHARACTERS) {
        throw new Error(
          `Custom answer for question "${question.id}" exceeds ${MAX_CUSTOM_ANSWER_CHARACTERS} characters.`,
        )
      }
      return {
        questionId: question.id,
        optionId: NEXUS_CUSTOM_OPTION_ID,
        optionLabel: normalizeCustomOptionLabel(request.customOptionLabel),
        customText,
      }
    }

    if (question.multiSelect) {
      if (answer.optionId || answer.customText) {
        throw new Error(`Multi-select answer has an invalid shape for question "${question.id}".`)
      }
      const optionIds = answer.optionIds ?? []
      if (optionIds.length === 0) {
        throw new Error(`At least one option is required for question "${question.id}".`)
      }
      if (new Set(optionIds).size !== optionIds.length) {
        throw new Error(`Duplicate option in answer for question "${question.id}".`)
      }
      const optionsById = new Map(
        question.options.map((option) => [option.id, option]),
      )
      const optionLabels = optionIds.map((optionId) => {
        const option = optionsById.get(optionId)
        if (!option) {
          throw new Error(
            `Unknown option "${optionId}" for question "${question.id}".`,
          )
        }
        return option.label
      })
      return {
        questionId: question.id,
        optionIds: [...optionIds],
        optionLabels,
      }
    }

    if (answer.optionIds?.length || answer.customText) {
      throw new Error(`Single-select answer has an invalid shape for question "${question.id}".`)
    }
    const option = question.options.find(
      (candidate) => candidate.id === answer.optionId,
    )
    if (!option) {
      throw new Error(
        `Unknown option "${answer.optionId ?? ""}" for question "${question.id}".`,
      )
    }
    return {
      questionId: question.id,
      optionId: option.id,
      optionLabel: option.label,
    }
  })

  if (JSON.stringify(normalized).length > MAX_QUESTIONNAIRE_RESPONSE_CHARACTERS) {
    throw new Error("Questionnaire response exceeds the 64 KiB limit.")
  }

  return normalized
}

export function formatQuestionnaireAnswersForAgent(request: UserQuestionRequest, answers: UserQuestionAnswer[]): string {
  const validated = validateQuestionnaireAnswers(request, answers)
  const byId = new Map(validated.map((answer) => [answer.questionId, answer]))
  const lines = request.questions.map((question) => {
    const answer = byId.get(question.id)
    let value = "—"
    if (answer?.customText?.trim()) {
      value = answer.customText.trim()
    } else if (question.multiSelect && answer?.optionIds && answer.optionIds.length > 0) {
      const fromAnswer = answer.optionLabels?.filter((x) => x.trim())
      if (fromAnswer && fromAnswer.length > 0) {
        value = fromAnswer.join(", ")
      } else {
        const labs = answer.optionIds
          .map((id) => question.options.find((o) => o.id === id)?.label)
          .filter((x): x is string => Boolean(x?.trim()))
        value = labs.length > 0 ? labs.join(", ") : "—"
      }
    } else if (answer?.optionId) {
      value =
        answer.optionLabel?.trim() ||
        question.options.find((option) => option.id === answer.optionId)?.label ||
        "—"
    }
    return `${question.question} → ${value}`
  })
  return `${NEXUS_QUESTIONNAIRE_RESPONSE_PREFIX}${lines.join("\n")}`
}

/**
 * Build stable ids, sanitize model choices, and attach description/preview
 * metadata. Semantic validation happens before this builder; it never invents
 * answer choices.
 */
export function buildUserQuestionOptionsFromRows(
  rows: QuestionOptionRow[],
  multiSelect: boolean,
  customOptionLabel: string,
  questionIndex: number,
): UserQuestionOption[] {
  const deduped = dedupeQuestionOptionRows(rows).map((r) => ({
    ...r,
    preview: multiSelect ? undefined : r.preview,
  }))
  const labels = deduped.map((r) => r.label)
  const sanitizedLabels = sanitizeAgentQuestionOptions(labels, customOptionLabel)
  const metaByKey = new Map<string, QuestionOptionRow>()
  for (const r of deduped) {
    const k = optionKey(r.label)
    if (!metaByKey.has(k)) metaByKey.set(k, r)
  }
  return sanitizedLabels.map((lab, i) => {
    const meta = metaByKey.get(optionKey(lab))
    return {
      id: `opt_${questionIndex + 1}_${i + 1}`,
      label: lab,
      description: meta?.description,
      preview: multiSelect ? undefined : meta?.preview,
    }
  })
}

export function buildUserQuestionOptions(
  agentLabels: string[],
  customOptionLabel: string,
  questionIndex: number,
): UserQuestionOption[] {
  return buildUserQuestionOptionsFromRows(
    agentLabels.map((label) => ({ label })),
    false,
    customOptionLabel,
    questionIndex,
  )
}
