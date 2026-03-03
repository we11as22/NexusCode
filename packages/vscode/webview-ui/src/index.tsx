import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { ErrorBoundary } from "./ErrorBoundary.js"
import "./index.css"

const rootEl = document.getElementById("root")
if (!rootEl) {
  document.body.innerHTML = "<span style='padding:1rem;color:#f48771'>Root element #root not found.</span>"
  throw new Error("Root element #root not found")
}

function markLoaded(): void {
  rootEl.classList.add("loaded")
}

try {
  const root = createRoot(rootEl)
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
  // Hide "Loading..." only after the first paint so content is visible (avoids black flash)
  requestAnimationFrame(() => {
    requestAnimationFrame(markLoaded)
  })
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  rootEl.classList.add("error")
  rootEl.innerHTML = `<span class="loading-msg" style="color:#f48771;padding:1rem">${msg}</span>`
}
