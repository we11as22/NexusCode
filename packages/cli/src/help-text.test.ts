import { describe, expect, it } from 'vitest'

import { NEXUS_CLI_HELP } from './help-text.js'

describe('fast CLI help', () => {
  it('lists every runtime mode', () => {
    expect(NEXUS_CLI_HELP).toContain(
      'agent | ask | plan | debug | review',
    )
  })
})
