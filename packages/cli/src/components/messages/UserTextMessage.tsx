import { UserBashInputMessage } from './UserBashInputMessage.js'
import { UserCommandMessage } from './UserCommandMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '../../services/claude.js'
import type { TextBlockParam } from '../../provider/message-schema.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam & { user_message?: string }
}

export function UserTextMessage({ addMargin, param }: Props): React.ReactNode {
  const displayText = param.user_message?.trim() || param.text
  const displayParam =
    displayText === param.text ? param : { ...param, text: displayText }
  if (displayText.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  // Bash inputs!
  if (displayText.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={displayParam} />
  }

  // Slash commands/
  if (
    displayText.includes('<command-name>') ||
    displayText.includes('<command-message>')
  ) {
    return <UserCommandMessage addMargin={addMargin} param={displayParam} />
  }

  // User prompts>
  return <UserPromptMessage addMargin={addMargin} param={displayParam} />
}
