import { describe, expect, it } from 'vitest'
import {
  canShowPromptInput,
  canShowPrimarySpinner,
} from './prompt-visibility.js'

describe('REPL prompt visibility', () => {
  it('routes Enter exclusively to a modal local command', () => {
    expect(
      canShowPromptInput({
        requested: true,
        toolOverlay: { shouldHidePromptInput: true },
      }),
    ).toBe(false)
    expect(
      canShowPromptInput({
        requested: true,
        toolOverlay: { shouldHidePromptInput: false },
      }),
    ).toBe(true)
  })

  it('does not flash the agent spinner while a slash panel is closing', () => {
    expect(
      canShowPrimarySpinner({
        isLoading: true,
        input: '/help',
        hasCompetingSurface: false,
      }),
    ).toBe(false)
    expect(
      canShowPrimarySpinner({
        isLoading: true,
        input: '',
        hasCompetingSurface: false,
      }),
    ).toBe(true)
    expect(
      canShowPrimarySpinner({
        isLoading: true,
        input: '',
        hasCompetingSurface: true,
      }),
    ).toBe(false)
  })
})
