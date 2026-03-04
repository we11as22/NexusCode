# Extension and CLI performance vs KiloCode

## Summary

NexusCode extension Settings load slowly because the webview waits for **full** controller init (config + allowed-commands + project settings) before showing config. KiloCode fetches config from the CLI backend on demand and caches it, so the extension stays thin and Settings open after one HTTP round-trip.

NexusCode CLI feels slow and displays updates with visible delay because **every** non-done/error event is deferred by a fixed 16 ms batch before flush. KiloCode CLI uses the same 16 ms window only when events are dense (within 16 ms of the last flush); otherwise it flushes **immediately**, reducing perceived latency.

---

## Extension: slow Settings load

### NexusCode flow

1. User opens Nexus sidebar → `resolveWebviewView` → `setupWebview` → `ensureInitialized()` is awaited.
2. **ensureInitialized** runs in order:
   - `loadConfig(cwd)` (and fallback `loadConfig(process.cwd())`) — walks up to 20 dirs, reads global + project YAML/JSON, `.env`, merge, MCP JSON; can be slow on deep trees.
   - Read `.nexus/allowed-commands.json` via `vscode.workspace.fs.readFile`.
   - `loadProjectSettings(cwd)` (sync).
   - `applyVscodeOverrides(this.config)`.
   - Only then: `postMessageToWebview({ type: "configLoaded", config })`, `Session.create`, `postStateToWebview()`, and fire-and-forget MCP/indexer/models.
3. Settings view shows “Configuration is loading…” until **config** is set, i.e. until all of the above finishes.

So the first paint of Settings is blocked on the entire init chain. The heaviest part is `loadConfig`; the rest is relatively fast but still serial.

### KiloCode flow

- **KiloProvider** does **not** await a heavy init in `resolveWebviewView`. It sets HTML, message handler, then `initializeConnection()` (no await).
- Config is **not** read from disk in the extension; it is **fetched from the CLI backend** via HTTP (`fetchAndSendConfig()` → `httpClient.getConfig(workspaceDir)`).
- `requestConfig` is handled on demand; the backend can serve from `cachedConfigMessage` if the client isn’t ready.
- Settings see config after a single HTTP round-trip (or from cache). The extension stays thin; all heavy work is in the backend.

### Fix applied in NexusCode

- Send **first** `configLoaded` as soon as `loadConfig()` (and fallback) completes, so the Settings view can render with base config.
- Then load allowed-commands and project settings, merge into `this.config`, and send a **second** `configLoaded` so permissions and project overrides are correct. No change to Session/MCP/indexer/models (they still run after full init).

This reduces time-to-first-Settings-paint to the cost of `loadConfig` only, instead of config + allowed-commands + project settings.

---

## CLI: slow updates and visible delay

### NexusCode flow

- `EVENT_BATCH_MS = 16`. Incoming agent events are pushed to `eventQueueRef`.
- For events that are **not** `done` or `error`, a timer is set and `flush()` runs after 16 ms. So every batch of streaming events (e.g. `text_delta`) is shown only after a fixed 16 ms delay.
- For `done` and `error`, `flush()` is called immediately.
- Result: streaming output and intermediate state always lag by up to 16 ms; under many events it feels sluggish.

### KiloCode flow

- **Solid.js** and `batch()` for store updates (e.g. in `context/sync.tsx`, `context/sdk.tsx`).
- In `context/sdk.tsx`, event handling:
  - `last = Date.now()` after each flush.
  - On new event: push to queue; `elapsed = Date.now() - last`.
  - **If `elapsed >= 16`**: call `flush()` **immediately** (low latency when events are sparse).
  - **If `elapsed < 16`**: schedule `flush()` in 16 ms (batch with future events to avoid render storms).
- So the first event after a pause is shown immediately; only when events are dense do they get batched.

### Fix applied in NexusCode CLI

- Track `lastFlushTimeRef` and update it in `flush()` after processing.
- For non-immediate events: if no timer is set, **and** either we have never flushed or `Date.now() - lastFlushTimeRef >= 16`, call `flush()` immediately.
- Otherwise keep the existing 16 ms deferred flush. This matches KiloCode’s “immediate when sparse, batch when dense” behavior and reduces perceived delay.

---

## Extension: agent slow to respond after first message

### Why the first reply is delayed

When the user sends the **first** message from the sidebar:

1. **ensureInitialized is awaited**  
   The handler for `newMessage` does `await this.ensureInitialized()`. If the user sent the message soon after opening the sidebar, the background `ensureInitialized()` started in `resolveWebviewView` may still be running. The first message then waits for: `loadConfig`, `.nexus/allowed-commands.json`, `loadProjectSettings`, `Session.create`. So the whole init chain blocks the first reply.

2. **runAgent does more work before the main LLM call**  
   Before `runAgentLoop`: `loadRules`, `loadSkills`, optional `checkpoint.init`. Then inside `runAgentLoop`, before the first streaming LLM call:
   - **classifyTools** — when there are more MCP/custom tools than `config.tools.classifyThreshold` (default 15), the core runs a **full LLM round-trip** (`generateStructured`) to choose which tools to pass to the model.
   - **classifySkills** — when there are more skills than `config.skillClassifyThreshold` (default 8), another **full LLM round-trip** to select skills.
   - `resolveMentionsContext`, `getInitialProjectContext`, then the first loop iteration (build system prompt, `getProblems()` in VS Code, then the main streaming call).

So the user can see no output for a long time because up to **three** LLM round-trips can happen before the first token: init (if still running), tool classification, skill classification, then the main reply. Plus I/O (config, rules, skills, diagnostics).

### Fixes applied

- **Warmup on activate**  
  When the extension activates, it starts `ensureInitialized()` in the background (same as when the sidebar is opened). By the time the user opens the sidebar and sends the first message, init is often already done, so `await ensureInitialized()` returns quickly.

- **Parallel classification**  
  When both tool and skill classification are needed, they are run in parallel (`Promise.all`) instead of one after the other, so total time before the main call is reduced.

### Optional further improvements

- Emit a “Preparing…” or “Selecting tools…” status event before classification so the UI can show progress.
- Lower or bypass classification on the very first turn (e.g. pass all tools/skills once) and only classify on follow-up turns to reduce first-reply latency at the cost of a larger first context.

---

## References

- Extension: `packages/vscode/src/controller.ts` (`ensureInitialized`), `packages/vscode/src/provider.ts`, `packages/vscode/webview-ui/src/App.tsx` (SettingsView).
- Config: `packages/core/src/config/index.ts` (`loadConfig`, `loadProjectSettings`).
- CLI: `packages/cli/src/tui/App.tsx` (event batching, flush, `processEvents`).
- KiloCode extension: `sources/kilocode/packages/kilo-vscode/src/KiloProvider.ts` (initializeConnection, fetchAndSendConfig, requestConfig).
- KiloCode CLI: `sources/kilocode/packages/opencode/src/cli/cmd/tui/context/sdk.tsx` (handleEvent, flush, 16 ms batching with immediate flush when `elapsed >= 16`).
- First message delay: `packages/core/src/agent/loop.ts` (classifyTools, classifySkills), `packages/core/src/agent/classifier.ts`.
