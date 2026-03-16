import { Command } from '../commands.js'
import { Config } from '../components/Config.js'
import * as React from 'react'

const config = {
  type: 'local-jsx',
  name: 'displaying',
  description: 'Display settings (verbose, theme, tool outputs, notifications)',
  isEnabled: true,
  isHidden: false,
  aliases: ['config'],
  async call(onDone) {
    return <Config onClose={onDone} />
  },
  userFacingName() {
    return 'displaying'
  },
} satisfies Command

export default config
