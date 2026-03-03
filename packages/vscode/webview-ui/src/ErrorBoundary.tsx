import React from "react"

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[NexusCode] ErrorBoundary:", error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "1rem",
            color: "#f48771",
            background: "#1e1e1e",
            height: "100%",
            overflow: "auto",
            fontFamily: "var(--vscode-font-family, monospace)",
            fontSize: "12px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Something went wrong</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {this.state.error.message}
          </pre>
          {this.state.error.stack && (
            <pre style={{ marginTop: "0.5rem", opacity: 0.8, fontSize: "11px" }}>
              {this.state.error.stack}
            </pre>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
