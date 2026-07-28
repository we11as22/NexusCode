export type CliStartupMode = 'session' | 'administrative'

/**
 * Administrative commands may perform their explicitly requested mutation,
 * but startup itself must remain side-effect free. In particular, diagnostics,
 * config reads, and log viewers must not rewrite the global CLI config merely
 * because they were invoked.
 */
export function shouldRunMutableStartupEffects(
  mode: CliStartupMode,
): boolean {
  return mode === 'session'
}
