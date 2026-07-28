type PromptOwningOverlay = {
  shouldHidePromptInput: boolean
} | null

export function canShowPromptInput({
  requested,
  toolOverlay,
}: {
  requested: boolean
  toolOverlay: PromptOwningOverlay
}): boolean {
  return requested && toolOverlay?.shouldHidePromptInput !== true
}

export function canShowPrimarySpinner({
  isLoading,
  input,
  hasCompetingSurface,
}: {
  isLoading: boolean
  input: string
  hasCompetingSurface: boolean
}): boolean {
  return (
    isLoading &&
    !hasCompetingSurface &&
    !input.trimStart().startsWith('/')
  )
}
