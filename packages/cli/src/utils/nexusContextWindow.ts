/**
 * Mirror of core agent loop context limit heuristics (for CLI footer when agent loop is idle).
 */
export function nexusContextWindowLimit(
  modelId: string,
  configuredLimit?: number,
): number {
  if (
    typeof configuredLimit === 'number' &&
    Number.isFinite(configuredLimit) &&
    configuredLimit > 0
  ) {
    return Math.floor(configuredLimit)
  }
  const lower = modelId.toLowerCase()
  if (
    lower.includes('claude-3') ||
    lower.includes('claude-4') ||
    lower.includes('claude-sonnet') ||
    lower.includes('claude-opus')
  ) {
    return 200000
  }
  if (lower.includes('gpt-4o')) return 128000
  if (lower.includes('gpt-4')) return 128000
  if (lower.includes('gpt-3.5')) return 16000
  if (lower.includes('gemini-2')) return 1000000
  if (lower.includes('gemini')) return 200000
  return 128000
}
