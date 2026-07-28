import { describe, expect, it } from 'vitest'
import { shouldRunMutableStartupEffects } from './startup-mode.js'

describe('CLI startup mode', () => {
  it('keeps administrative commands free of implicit state mutations', () => {
    expect(shouldRunMutableStartupEffects('administrative')).toBe(false)
    expect(shouldRunMutableStartupEffects('session')).toBe(true)
  })
})
