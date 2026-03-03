/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // VS Code-aligned dark theme palette (Claude Code-like)
        bg: {
          primary: "var(--vscode-sideBar-background, #1a1a1a)",
          secondary: "var(--vscode-editor-background, #1e1e1e)",
          hover: "var(--vscode-list-hoverBackground, #2a2a2a)",
          active: "var(--vscode-list-activeSelectionBackground, #094771)",
        },
        border: {
          DEFAULT: "var(--vscode-panel-border, #3d3d3d)",
        },
        text: {
          primary: "var(--vscode-foreground, #cccccc)",
          secondary: "var(--vscode-descriptionForeground, #888888)",
          accent: "var(--vscode-textLink-foreground, #4ec9b0)",
        },
        accent: {
          DEFAULT: "var(--vscode-button-background, #0e639c)",
          hover: "var(--vscode-button-hoverBackground, #1177bb)",
          foreground: "var(--vscode-button-foreground, #ffffff)",
        },
        tool: {
          approved: "#4ec9b0",
          rejected: "#f48771",
          pending: "#e5c07b",
        },
      },
      fontFamily: {
        mono: ["var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace)"],
        sans: ["var(--vscode-font-family, -apple-system, sans-serif)"],
      },
      fontSize: {
        xs: ["11px", "16px"],
        sm: ["12px", "18px"],
        base: ["13px", "20px"],
        lg: ["14px", "22px"],
      },
    },
  },
  plugins: [],
}
