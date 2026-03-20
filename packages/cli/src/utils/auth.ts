import { getGlobalConfig } from './config.js'

/**
 * Nexus CLI: do not use Anthropic OAuth — use API keys from .nexus config or env.
 * Returning false skips the OAuth step in onboarding so users go straight to the app.
 */
export function isAnthropicAuthEnabled(): boolean {
  return false
}

export function isLoggedInToAnthropic(): boolean {
  const config = getGlobalConfig()
  return !!config.primaryApiKey
}
