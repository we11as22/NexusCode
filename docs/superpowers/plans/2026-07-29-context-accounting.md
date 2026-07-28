# Accurate Context Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NexusCode's synthetic 128k context display with one provider-aware, persisted, compaction-safe occupied-context value shared by core, server, CLI, and VS Code.

**Architecture:** Parse capabilities at the model boundary, normalize usage at the provider boundary, persist the last provider-visible context as a session anchor, and let core add only the locally pending tail. Core owns the resulting snapshot; every transport and UI projects it without recalculation.

**Tech Stack:** TypeScript, AI SDK 4, Zod JSON Schema conversion, Vitest, JSONL session storage, React/Zustand, Ink, pnpm 10, Node 24.

## Global Constraints

- Use provider/catalog values before model-name guesses.
- Unknown means `0`/unavailable, never a fabricated `128000`.
- Do not make token-count API calls in the agent hot path.
- Preserve old session and wire formats through optional fields.
- Never add cumulative usage from separate model requests.
- Run every task red-green-refactor: first observe the focused test fail for the intended reason.

---

## Task 1: Preserve Kilo gateway capability metadata

**Files:**

- Modify: `packages/core/src/models/catalog.test.ts`
- Modify: `packages/core/src/models/catalog.ts`

- [ ] Add a failing catalog test with a Kilo `/models` response containing `context_length`, `top_provider.context_length`, `top_provider.max_completion_tokens`, and a gateway-only model.
- [ ] Assert `kilo-auto/free` resolves to `contextWindow: 256000`, output limit is retained, and a gateway-only model is not filtered out.
- [ ] Extend `CatalogModel` and recommended projections with `maxOutputTokens?: number`.
- [ ] Replace `getNexusGatewayModelIds()` with a validated metadata parser and merge gateway metadata into provider `nexus` with gateway precedence.
- [ ] Keep source timeout/cache behavior and models.dev fallback unchanged.
- [ ] Run:
  `pnpm --filter @nexuscode/core test -- src/models/catalog.test.ts`

## Task 2: Normalize provider usage once

**Files:**

- Modify: `packages/core/src/provider/types.ts`
- Modify: `packages/core/src/provider/base.ts`
- Modify: `packages/core/src/provider/base.test.ts`
- Modify: `packages/core/src/provider/openai-compatible.test.ts`

- [ ] Add failing tests for OpenAI cached prompt tokens and reasoning tokens, Anthropic cache creation/read tokens, absent metadata, and invalid negative/NaN values.
- [ ] Introduce:

```ts
export type NormalizedLLMUsage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens: number
  modelId?: string
}
```

- [ ] Normalize AI SDK `usage`, `providerMetadata`, and `response.modelId` at the base-provider finish boundary.
- [ ] For OpenAI, subtract cached input from prompt input; for Anthropic, add cache buckets to total; subtract reasoning from output only when explicitly separated.
- [ ] Clamp buckets to finite non-negative integers and prefer a valid provider total.
- [ ] Run the provider tests and core typecheck.

## Task 3: Persist a provider context anchor

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/session/storage.ts`
- Modify: `packages/core/src/session/storage.test.ts`
- Modify: `packages/core/src/session/index.ts`
- Modify: `packages/core/src/session/index.test.ts`

- [ ] Add failing storage/session tests for anchor round-trip, legacy session loading, user-message retention, rewind invalidation, and explicit invalidation.
- [ ] Add:

```ts
export type ProviderContextAnchor = {
  messageId: string
  usedTokens: number
  manifestTokens: number
  modelId?: string
  recordedAt: number
}
```

- [ ] Add `getProviderContextAnchor`, `recordProviderContextAnchor`, and `clearProviderContextAnchor` to `ISession`.
- [ ] Persist the optional anchor in `StoredSession`; reject malformed anchors without rejecting the session.
- [ ] Keep the anchor when a user message is appended; clear it when rewind/fork removes its message.
- [ ] Run focused session/storage tests.

## Task 4: Compute hybrid occupied context from the real manifest

**Files:**

- Modify: `packages/core/src/context/context-usage.test.ts`
- Modify: `packages/core/src/context/context-usage.ts`
- Modify: `packages/core/src/provider/tool-schema.ts`

- [ ] Add failing tests for unknown limits, exact Kilo fallback, provider-only, provider-plus-user, provider-plus-tool-result, changed manifest, and estimate-only states.
- [ ] Change unknown `getContextWindowLimit()` fallback to `0`; retain only verified static model fallbacks and set `kilo-auto/free` to `256000`.
- [ ] Extend `ContextUsageSnapshot` with `source`, `providerTokens`, and `pendingTokens`.
- [ ] Serialize each active tool's actual name, description, and `zodSchema(parameters).jsonSchema`; remove the fixed 750-token-per-tool charge.
- [ ] Calculate the pending tail after `anchor.messageId`, including tool results appended to the anchor assistant message.
- [ ] Add only a positive system/tool-manifest delta above `anchor.manifestTokens`.
- [ ] Apply a documented conservative estimate factor only to estimated content, never to provider-reported tokens.
- [ ] Run context tests and core typecheck.

## Task 5: Make agent loop and compaction own the anchor lifecycle

**Files:**

- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/__tests__/compaction-failure.test.ts`
- Modify: `packages/core/src/session/compaction.test.ts`
- Modify: `packages/core/src/context/compaction-projection.test.ts`

- [ ] Add failing tests proving finish usage records an anchor, next user/tool content becomes pending, model change clears the anchor, and compaction cannot reuse pre-compaction usage.
- [ ] Capture the exact serialized system/tool manifest estimate used for each request.
- [ ] Record the normalized provider total against the completed assistant message.
- [ ] Emit and persist the hybrid snapshot from the common context calculator.
- [ ] Separate hard limit, output/safety reserve, usable limit, and compaction threshold; disable proactive percentage compaction when hard limit is unknown.
- [ ] Clear the old anchor before compaction retry and publish an estimated compacted snapshot until the next provider finish.
- [ ] Run focused agent/compaction tests.

## Task 6: Carry the richer snapshot through every transport

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/protocol/v2.ts`
- Modify: `packages/core/src/run/event-store.test.ts`
- Modify: `packages/server/src/server-turn-runner.ts`
- Modify: `packages/server/src/server-turn-runner.test.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/vscode/src/webview-protocol-types.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.test.ts`

- [ ] Add failing round-trip tests for optional source/provider/pending fields and legacy three-number events.
- [ ] Extend `AgentEvent.context_usage`, Zod protocol, stored snapshot, server snapshots, controller shadow state, and webview state with optional diagnostic fields.
- [ ] Remove controller/webview initialization defaults that invent `128000`.
- [ ] Ensure local and remote runs converge on the same core-published values.
- [ ] Run focused core/server/CLI/VS Code store tests.

## Task 7: Display occupied context truthfully

**Files:**

- Modify: `packages/cli/src/screens/REPL.tsx`
- Modify: `packages/vscode/webview-ui/src/App.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`

- [ ] Add pure formatter tests or extract a formatter if needed.
- [ ] Render known usage as `ctx 29.3k/256k (11%)`.
- [ ] Render unknown limit as `ctx 29.3k/—` and omit a misleading percent.
- [ ] Add an accessible VS Code tooltip distinguishing provider-reported and estimated pending tokens.
- [ ] Verify narrow layout and terminal width degradation.

## Task 8: Verify the complete context pipeline

- [ ] Run focused suites for catalog, providers, context, session, compaction, protocol, server, CLI, and webview.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm package:vscode`.
- [ ] Run `nexus doctor --cwd /Users/mac/Projects/nexus/test`.
- [ ] Confirm no production path still supplies an unverified `128000` using:
  `rg -n "128_?000|128k" packages -g '*.ts' -g '*.tsx'`
- [ ] Run `git diff --check`.
