import { Command } from '../commands.js'
import { Config } from '../components/Config.js'
import * as React from 'react'

const config = {
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel (global: API key, theme; Nexus: use /nexus-config and .nexus/nexus.yaml)',
  isEnabled: true,
  isHidden: false,
  async call(onDone) {
    return <Config onClose={onDone} />
  },
  userFacingName() {
    return 'config'
  },
} satisfies Command

export default config
