/**
 * Theme type for CustomSelect — used with useComponentTheme('Select') from @inkjs/ui.
 */
export type Theme = {
  container: () => Record<string, unknown>
  option: (opts: { isFocused: boolean }) => Record<string, unknown>
  focusIndicator: () => Record<string, unknown>
  label: (opts: { isFocused: boolean; isSelected: boolean }) => Record<string, unknown>
  selectedIndicator: () => Record<string, unknown>
  highlightedText: () => Record<string, unknown>
}
