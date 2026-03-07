/**
 * Build-time / runtime macro values (in reference these are often --define injected).
 */
export const MACRO = {
  VERSION: '0.1.0',
  PACKAGE_URL: 'https://github.com/nexuscode/cli',
  README_URL: 'https://github.com/nexuscode/cli#readme',
  ISSUES_EXPLAINER: 'open an issue on GitHub',
} as const

declare global {
  const MACRO: typeof import('./macro.js').MACRO
}

;(globalThis as unknown as { MACRO: typeof MACRO }).MACRO = MACRO
