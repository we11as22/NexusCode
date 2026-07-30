/**
 * Remove dynamic-loader injection controls before either the trusted native
 * helper or an untrusted command is launched.
 *
 * Codex applies the same hardening to its own process before main. Nexus keeps
 * the boundary local to the sandbox broker so embedding hosts do not have
 * their environment mutated.
 */
export function sanitizeSandboxEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isLoaderInjectionVariable(key)) continue
    result[key] = value
  }
  return result
}

function isLoaderInjectionVariable(key: string): boolean {
  return key.startsWith("LD_") || key.startsWith("DYLD_")
}
