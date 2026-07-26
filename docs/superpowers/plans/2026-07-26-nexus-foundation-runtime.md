# Nexus Foundation Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible, tested, session-scoped Nexus runtime with one tool execution pipeline and fail-closed CLI/server security before migrating persistence, memory, optional indexing, plugins, and orchestration depth.

**Architecture:** Keep existing public APIs alive through adapters while making `NexusRuntimeServices`, `ToolRegistry`, and `ToolExecutionPipeline` authoritative. Pin the runtime, remove the unused native SQLite addon from the critical path, remove process-global run ownership, and route every tool-call form through the same policy/hook/approval/output path.

**Tech Stack:** Node.js 20.19.2, pnpm 10.8.1, TypeScript 5.5+, Vitest 3.2.3, Zod, Hono, portable JSONL journals and atomic manifests, existing Nexus provider and host interfaces.

## Global Constraints

- Existing CLI commands, `.nexus/nexus.yaml`, session IDs, plugin manifests, MCP configuration, and persisted data remain readable.
- Internal breaking changes are allowed only behind adapters and idempotent migrations.
- Codex and OpenClaude are equal primary references; Kilo is secondary; Roo is used for selected backend, indexing, checkpoint, and VS Code patterns.
- Documentation is not evidence: every migrated feature needs an executable-path or integration test.
- No run-critical mutable process singleton may remain.
- Every privileged decision fails closed when no authenticated interactive approver or explicit policy is available.
- Every tool-call form uses one pipeline.
- New focused core files should normally stay below 500 lines; files above 800 lines require explicit review justification.
- All changes follow TDD and finish with package-level and workspace-level verification.

## Program plan boundaries

This foundation plan is the first independently testable sub-project. Follow-up plans are created and executed in this dependency order:

1. transactional repository storage, optional rebuildable projections, and legacy migration;
2. durable tasks, teams, child agents, background jobs, snapshots, resume/fork, and remote events;
3. isolated plugins, deterministic hooks, and scoped rich-content MCP;
4. unified multilingual memory and deterministic context assembly;
5. optional Roo/Kilo-derived lexical/vector index service and checkpoint hardening;
6. config/provider normalization, CLI/VS Code/server protocol convergence, evals, packaging, and documentation.

---

## File and responsibility map

### New files

- `scripts/runtime-version.mjs` — pure Node/package-manager version validation.
- `scripts/runtime-version.test.mjs` — built-in Node test coverage for version validation.
- `scripts/storage-portability.test.mjs` — prevent unused native database addons from returning to the critical runtime path.
- `packages/core/vitest.config.mts` — first-party core test configuration without Vite's deprecated CJS config loader.
- `packages/core/src/test/fakes.ts` — small fake host/session builders used by contract tests.
- `packages/core/src/agent/run-services.ts` — session-scoped dependencies passed into a run.
- `packages/core/src/agent/tool-pipeline.ts` — the only public tool execution entry point.
- `packages/core/src/tools/built-in/git-inspect.ts` — read-only Git operations for review mode.
- `packages/core/src/agent/__tests__/run-services.test.ts` — cross-run isolation.
- `packages/core/src/agent/__tests__/tool-pipeline.test.ts` — validation, hooks, approval, spill, and event ordering.
- `packages/core/src/tools/__tests__/registry.test.ts` — static, bound, dynamic, hidden, and collision registration.
- `packages/core/src/agent/__tests__/modes.test.ts` — indirect mode-policy reachability.
- `packages/server/src/security.ts` — bearer auth, origin policy, and workspace-root resolution.
- `packages/server/src/security.test.ts` — server security contract.
- `packages/server/src/app.test.ts` — authenticated route behavior.

### Existing files changed

- `package.json`, `pnpm-workspace.yaml`, `.nvmrc` — reproducible runtime and workspace scripts.
- `scripts/check-node.js` — use shared exact version validation.
- `packages/core/package.json` — Vitest and package scripts.
- `packages/core/src/types.ts` — scoped run services and richer tool metadata.
- `packages/core/src/tools/registry.ts` — explicit bound built-in registration and diagnostics.
- `packages/core/src/tools/built-in/index.ts` — add `GitInspect`.
- `packages/core/src/agent/modes.ts` — make review genuinely read-only.
- `packages/core/src/agent/loop.ts` — call the authoritative pipeline for native, parallel, and textual calls.
- `packages/core/src/agent/tool-execution.ts` — become low-level execution helpers only.
- `packages/core/src/agent/processor.ts` — delete after all behavior is in the pipeline and no import remains.
- `packages/core/src/tools/built-in/orchestration-tools.ts` — use scoped services rather than globals.
- `packages/core/src/agent/parallel.ts` — remove active-manager singleton.
- `packages/core/src/mcp/client.ts` — close tools over their owning client.
- `packages/cli/src/nexus-bootstrap.ts`, `packages/cli/src/nexus-query.ts` — construct and pass scoped services.
- `packages/cli/src/host.ts`, `packages/cli/src/entrypoints/cli.tsx` — fail-closed headless behavior.
- `packages/vscode/src/controller.ts` — construct and pass scoped services.
- `packages/server/src/run-session.ts` — construct, pass, and close scoped services.
- `packages/server/src/app.ts`, `packages/server/src/routes/session.ts`, `packages/server/src/index.ts` — security options and validated workspace roots.
- `packages/cli/src/nexus-server-client.ts` and the VS Code server client location found by `rg "class NexusServerClient"` — send bearer token.

---

### Task 1: Pin and prove the portable runtime

**Files:**
- Create: `scripts/runtime-version.mjs`
- Create: `scripts/runtime-version.test.mjs`
- Create: `scripts/storage-portability.test.mjs`
- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `scripts/check-node.js`

**Interfaces:**
- Produces: `validateRuntimeVersion(version: string): { ok: true } | { ok: false; message: string }`
- Produces: a runtime test that fails if the unused native SQLite addon returns to the core dependency or install path.
- Consumes: the root/core package manifests and pnpm workspace policy.

- [x] **Step 1: Write exact version tests**

```js
// scripts/runtime-version.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { validateRuntimeVersion } from "./runtime-version.mjs"

test("accepts the pinned Node release", () => {
  assert.deepEqual(validateRuntimeVersion("20.19.2"), { ok: true })
})

test("rejects Node 18, older Node 20, and a different major", () => {
  for (const version of ["18.20.8", "20.18.3", "21.7.3", "22.0.0", "25.8.1"]) {
    const result = validateRuntimeVersion(version)
    assert.equal(result.ok, false)
    assert.match(result.message, /Node\.js 20\.19\.2/)
  }
})
```

- [x] **Step 2: Run the test and verify it fails**

Run: `node --test scripts/runtime-version.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `runtime-version.mjs`.

- [x] **Step 3: Implement exact runtime validation**

```js
// scripts/runtime-version.mjs
const REQUIRED = "20.19.2"

export function validateRuntimeVersion(version) {
  if (version === REQUIRED) return { ok: true }
  return {
    ok: false,
    message: `NexusCode requires Node.js ${REQUIRED}; current runtime is ${version}. Run nvm use.`,
  }
}

export function assertRuntimeVersion(version = process.versions.node) {
  const result = validateRuntimeVersion(version)
  if (!result.ok) {
    console.error(result.message)
    process.exitCode = 1
  }
  return result.ok
}
```

Update `.nvmrc` to `20.19.2`. Set:

```json
"packageManager": "pnpm@10.8.1",
"engines": {
  "node": "20.19.2",
  "pnpm": "10.8.1"
}
```

Move React overrides from the ignored `package.json#pnpm.overrides` field to:

```yaml
overrides:
  react: ^18.3.1
  react-dom: ^18.3.1
```

in `pnpm-workspace.yaml`. Make `scripts/check-node.js` import and call `assertRuntimeVersion`.

- [x] **Step 4: Remove the stale native SQLite requirement**

```js
// scripts/storage-portability.test.mjs
// Assert that core dependencies, root scripts, and pnpm build policy do not
// require better-sqlite3. SQLite may return later only as an optional,
// rebuildable repository projection with its own adapter contract.
```

Add root scripts:

```json
"preinstall": "node scripts/check-node.js",
"test:runtime": "node --test scripts/runtime-version.test.mjs scripts/build-optional-context-mode.test.mjs scripts/storage-portability.test.mjs"
```

Remove the missing `sources/claude-context-mode` build from the unconditional root build. Replace it with an explicit optional script that first checks the directory and never masks a failed build when the directory exists.

- [x] **Step 5: Verify the pinned, portable runtime**

Run under Node 20.19.2:

```bash
corepack pnpm --version
pnpm test:runtime
```

Expected:

- pnpm prints `10.8.1`;
- runtime tests pass;
- no first-party install or runtime path requires a native SQLite addon.

- [x] **Step 6: Commit**

```bash
git add .nvmrc package.json packages/core/package.json packages/core/tsup.config.ts pnpm-workspace.yaml scripts/check-node.js scripts/runtime-version.mjs scripts/runtime-version.test.mjs scripts/storage-portability.test.mjs pnpm-lock.yaml
git commit -m "build: pin a portable Nexus runtime"
```

---

### Task 2: Establish first-party test infrastructure

**Files:**
- Create: `packages/core/vitest.config.mts`
- Create: `packages/core/src/test/fakes.ts`
- Create: `packages/core/src/test/smoke.test.ts`
- Modify: `package.json`
- Modify: `packages/core/package.json`

**Interfaces:**
- Produces: `createFakeHost(overrides?)`, `createFakeSession()`, and `createTestConfig(overrides?)`.
- Produces: `pnpm test`, `pnpm test:core`, and package-local `pnpm test`.
- Consumes: existing `IHost`, `ISession`, `NexusConfigSchema`, and `Session`.

- [x] **Step 1: Add a failing core smoke test**

```ts
// packages/core/src/test/smoke.test.ts
import { describe, expect, it } from "vitest"
import { NexusConfigSchema } from "../config/schema.js"
import { ToolRegistry } from "../tools/registry.js"

describe("core test harness", () => {
  it("constructs the default config and registry", () => {
    const config = NexusConfigSchema.parse({})
    const registry = new ToolRegistry()
    expect(config.model.provider).toBeTruthy()
    expect(registry.get("Read")?.name).toBe("Read")
  })
})
```

- [x] **Step 2: Install and configure Vitest**

Add `vitest: "3.2.3"` to core devDependencies and:

```ts
// packages/core/vitest.config.mts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    pool: "forks",
  },
})
```

Add package scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Add root scripts:

```json
"test": "pnpm -r --stream test",
"test:core": "pnpm --filter @nexuscode/core test"
```

Packages without tests receive `test: "node -e \"process.exit(0)\""` temporarily in the same change so recursive testing is deterministic; later plans replace these no-op scripts before acceptance.

- [x] **Step 3: Run the smoke test**

Run: `pnpm --filter @nexuscode/core test -- src/test/smoke.test.ts`

Expected: PASS with one test.

- [x] **Step 4: Add typed fakes**

Implement `createFakeHost` with in-memory files, captured approvals, captured events, and a command stub that throws unless overridden. Implement `createFakeSession` by constructing the existing `Session` with a generated test ID. Implement `createTestConfig` with `NexusConfigSchema.parse` and an explicit deep merge helper local to the test file.

The fake host default approval result is `{ approved: false }`. Tests must opt into approval.

- [x] **Step 5: Verify fakes with focused assertions**

Extend `smoke.test.ts`:

```ts
it("uses fail-closed fake host defaults", async () => {
  const host = createFakeHost()
  await expect(host.showApprovalDialog({
    type: "execute",
    tool: "Bash",
    description: "run",
  })).resolves.toEqual({ approved: false })
})
```

Run: `pnpm --filter @nexuscode/core test -- src/test/smoke.test.ts`

Expected: PASS with two tests.

- [x] **Step 6: Commit**

```bash
git add package.json packages/core/package.json packages/core/vitest.config.mts packages/core/src/test pnpm-lock.yaml packages/*/package.json packages/vscode/webview-ui/package.json
git commit -m "test: add first-party Nexus test harness"
```

---

### Task 3: Make tool registration explicit and correct

**Files:**
- Create: `packages/core/src/tools/__tests__/registry.test.ts`
- Modify: `packages/core/src/tools/registry.ts`
- Modify: `packages/cli/src/nexus-bootstrap.ts`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/server/src/run-session.ts`
- Modify: `packages/core/src/agent/parallel.ts`

**Interfaces:**
- Produces: `registerDynamic(tool: ToolDef): RegistrationResult`
- Produces: `registerBoundBuiltin(tool: ToolDef): RegistrationResult`
- Produces: `RegistrationResult = { ok: true; replaced: false } | { ok: false; reason: "reserved-name" | "duplicate" }`
- Preserves: `register(tool)` as a deprecated adapter that delegates to `registerDynamic`.

- [ ] **Step 1: Write failing bound-tool tests**

```ts
it("registers manager-bound built-ins that are declared by modes", () => {
  const registry = new ToolRegistry()
  const tool = fakeTool("TaskCreateBatch")
  expect(registry.registerBoundBuiltin(tool)).toEqual({ ok: true, replaced: false })
  expect(registry.get("TaskCreateBatch")).toBe(tool)
})

it("rejects a dynamic tool that collides with a reserved built-in", () => {
  const registry = new ToolRegistry()
  expect(registry.registerDynamic(fakeTool("Read"))).toEqual({
    ok: false,
    reason: "reserved-name",
  })
})

it("reports duplicate dynamic registration instead of silently replacing it", () => {
  const registry = new ToolRegistry()
  expect(registry.registerDynamic(fakeTool("example__tool"))).toEqual({
    ok: true,
    replaced: false,
  })
  expect(registry.registerDynamic(fakeTool("example__tool"))).toEqual({
    ok: false,
    reason: "duplicate",
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @nexuscode/core test -- src/tools/__tests__/registry.test.ts`

Expected: FAIL because `registerBoundBuiltin` and `registerDynamic` do not exist.

- [ ] **Step 3: Implement explicit registration**

Split `BUILTIN_NAMES` into:

- `STATIC_BUILTIN_NAMES`, derived from instantiated built-ins;
- `RESERVED_BUILTIN_NAMES`, derived from mode declarations.

`registerBoundBuiltin` accepts a reserved name but rejects a name already instantiated. `registerDynamic` rejects every reserved name and every duplicate. Neither method silently replaces anything.

- [ ] **Step 4: Migrate call sites**

Use `registerBoundBuiltin` for:

- `TaskCreateBatch`;
- `TaskSnapshot`;
- `TaskResume`;
- any other manager-bound tool present in mode declarations but not in `getAllBuiltinTools`.

Use `registerDynamic` for MCP and third-party tools. Check every result and emit or throw an actionable diagnostic when registration fails.

- [ ] **Step 5: Add a mode-manifest parity test**

Iterate all modes and assert that every non-compatibility name returned by `getBuiltinToolsForMode(mode)` resolves after a host registers all bound built-ins. The test must explicitly assert that `TaskCreateBatch`, `TaskSnapshot`, and `TaskResume` are present.

- [ ] **Step 6: Verify**

Run:

```bash
pnpm --filter @nexuscode/core test -- src/tools/__tests__/registry.test.ts
pnpm --filter @nexuscode/core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/registry.ts packages/core/src/tools/__tests__/registry.test.ts packages/core/src/agent/parallel.ts packages/cli/src/nexus-bootstrap.ts packages/vscode/src/controller.ts packages/server/src/run-session.ts
git commit -m "fix: register bound Nexus tools explicitly"
```

---

### Task 4: Replace process-global run ownership with scoped services

**Files:**
- Create: `packages/core/src/agent/run-services.ts`
- Create: `packages/core/src/agent/__tests__/run-services.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/parallel.ts`
- Modify: `packages/core/src/tools/built-in/orchestration-tools.ts`
- Modify: `packages/core/src/mcp/client.ts`
- Modify: `packages/cli/src/nexus-bootstrap.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/server/src/run-session.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface NexusRunServices {
  parallelAgentManager: ParallelAgentManager
  mcpClient?: McpClient
}

export function createNexusRunServices(input?: {
  parallelAgentManager?: ParallelAgentManager
  mcpClient?: McpClient
}): NexusRunServices
```

- Adds `services: NexusRunServices` to `AgentLoopOptions`.
- Adds `services: NexusRunServices` to `ToolContext`.

- [ ] **Step 1: Write a cross-run isolation test**

Create two managers and two fake MCP clients. Create two service containers and two `TaskCreate` contexts. Assert that a task invoked with context A can only reach manager A, while context B can only reach manager B.

Add an MCP test in which tools from two `McpClient` instances with the same server name call different stub clients and return distinct output.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @nexuscode/core test -- src/agent/__tests__/run-services.test.ts`

Expected: FAIL because `NexusRunServices` does not exist and MCP tools consult the global registry.

- [ ] **Step 3: Implement the service container**

Create `run-services.ts` with the exact interface above. Require `AgentLoopOptions.services`; do not create hidden defaults inside `runAgentLoop`.

Populate `toolCtx.services`.

- [ ] **Step 4: Remove parallel-agent singleton usage**

Change orchestration tools from:

```ts
const manager = getParallelAgentManager()
```

to:

```ts
const manager = ctx.services.parallelAgentManager
```

Delete `activeParallelAgentManager`, `setParallelAgentManager`, and `getParallelAgentManager` after `rg` shows no remaining consumers.

- [ ] **Step 5: Scope MCP tools to their owner**

In `McpClient.getTools()`, capture the owning instance:

```ts
const owner = this
return Array.from(this.tools.values()).map((mcpTool) => ({
  // ...
  async execute(args) {
    const client = owner.clients.get(mcpTool.serverName)
    // ...
  },
}))
```

Keep the old global setter/getter only as a deprecated compatibility adapter outside all new runtime paths. Add a removal marker to the later MCP migration plan and a test proving production hosts do not call it.

- [ ] **Step 6: Pass services from every host**

CLI, VS Code, and server construct one manager and MCP client per top-level run. Pass the same services to bound-tool factories and `runAgentLoop`.

Server wraps run execution in `try/finally`, calls `mcpClient.disconnectAll()`, stops non-detached child work, and clears all event listeners.

- [ ] **Step 7: Verify isolation**

Run:

```bash
pnpm --filter @nexuscode/core test -- src/agent/__tests__/run-services.test.ts
pnpm --filter @nexuscode/core typecheck
pnpm --filter @nexuscode/server typecheck
pnpm --filter @nexuscode/cli typecheck
pnpm --filter nexuscode typecheck
```

Expected: PASS; `rg "activeParallelAgentManager|McpClientRegistry.instance" packages` returns only the explicitly documented compatibility adapter, not a host/runtime path.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/agent/run-services.ts packages/core/src/agent/__tests__/run-services.test.ts packages/core/src/types.ts packages/core/src/agent/loop.ts packages/core/src/agent/parallel.ts packages/core/src/tools/built-in/orchestration-tools.ts packages/core/src/mcp/client.ts packages/core/src/index.ts packages/cli/src/nexus-bootstrap.ts packages/cli/src/nexus-query.ts packages/vscode/src/controller.ts packages/server/src/run-session.ts
git commit -m "refactor: scope Nexus services to each run"
```

---

### Task 5: Introduce the authoritative tool execution pipeline

**Files:**
- Create: `packages/core/src/agent/tool-pipeline.ts`
- Create: `packages/core/src/agent/__tests__/tool-pipeline.test.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/tool-execution.ts`
- Delete: `packages/core/src/agent/processor.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/plugins/runtime.ts`

**Interfaces:**
- Produces:

```ts
export interface ToolExecutionRequest {
  callId: string
  messageId: string
  partId: string
  toolName: string
  input: Record<string, unknown>
  origin: "native" | "textual" | "parallel" | "mcp" | "plugin" | "subagent"
}

export interface ToolExecutionEnvironment {
  tools: readonly ToolDef[]
  context: ToolContext
  autoApproveActions: ReadonlySet<PermissionAction>
  mode: Mode
  mcpToolNames: ReadonlySet<string>
}

export interface ToolExecutionOutcome extends ToolResult {
  toolName: string
  normalizedInput: Record<string, unknown>
  denied?: boolean
  stoppedByHook?: boolean
  outputSpillPath?: string
}

export async function executeToolPipeline(
  request: ToolExecutionRequest,
  environment: ToolExecutionEnvironment,
): Promise<ToolExecutionOutcome>
```

- Consumes low-level normalization, validation, doom-loop, approval, and execution helpers from `tool-execution.ts`.

- [ ] **Step 1: Write pipeline ordering tests**

Use a fake plugin hook recorder and fake tool. Assert exact order:

```ts
expect(order).toEqual([
  "validate",
  "before_tool",
  "approve",
  "execute",
  "spill",
  "after_tool",
])
```

Add parameterized tests for origins `native`, `textual`, and `parallel`. Add tests that:

- invalid input never runs hooks or the tool;
- a denying `before_tool` prevents approval and execution;
- a denied approval prevents execution;
- a 60 KiB output is truncated and stores a spill path;
- `formatValidationError` is used;
- `autoApproveSkillLoad: false` is respected;
- `toolExecutionMessageId` is present inside the tool.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @nexuscode/core test -- src/agent/__tests__/tool-pipeline.test.ts`

Expected: FAIL because `executeToolPipeline` does not exist.

- [ ] **Step 3: Implement the pipeline around existing proven helpers**

Move the public orchestration currently split between `loop.ts` and `tool-execution.ts` into `tool-pipeline.ts`. Keep pure helper functions in `tool-execution.ts`; do not copy them.

The pipeline:

- resolves aliases once;
- sets `partId` and `toolExecutionMessageId` on a per-call child context rather than mutating a shared context;
- runs plugin hooks for every origin;
- requests approval exactly once;
- executes the tool;
- applies generic truncation and registers the spill;
- returns normalized metadata without emitting UI events.

The loop remains responsible for persisting the returned part and emitting protocol/UI events in one helper.

- [ ] **Step 4: Route parallel reads through the pipeline**

Replace `flushPendingReads` direct calls with `executeToolPipeline` using origin `parallel`. Create a child context for each call so `partId` cannot race.

- [ ] **Step 5: Route native and textual calls through the pipeline**

Both stream `tool_call` and parsed textual fallback construct the same `ToolExecutionRequest`. Remove their local hook and approval logic.

- [ ] **Step 6: Remove duplicate executors**

Delete the local `executeToolCall` from `loop.ts`. Delete `processor.ts` only after:

```bash
rg "processStreamStep|from \"\\./processor" packages/core/src
```

returns no consumer outside the file. Move any uniquely reachable behavior into the pipeline with a focused test before deletion.

- [ ] **Step 7: Verify all origins**

Run:

```bash
pnpm --filter @nexuscode/core test -- src/agent/__tests__/tool-pipeline.test.ts
pnpm --filter @nexuscode/core test
pnpm --filter @nexuscode/core typecheck
rg "async function executeToolCall" packages/core/src/agent
```

Expected:

- all tests pass;
- typecheck passes;
- `rg` finds no private duplicate executor in `loop.ts`;
- generic spill test reports a valid persisted path.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/agent/tool-pipeline.ts packages/core/src/agent/__tests__/tool-pipeline.test.ts packages/core/src/agent/loop.ts packages/core/src/agent/tool-execution.ts packages/core/src/types.ts packages/core/src/plugins/runtime.ts
git rm packages/core/src/agent/processor.ts
git commit -m "refactor: unify Nexus tool execution"
```

---

### Task 6: Enforce real mode boundaries and fail-closed CLI behavior

**Files:**
- Create: `packages/core/src/tools/built-in/git-inspect.ts`
- Create: `packages/core/src/agent/__tests__/modes.test.ts`
- Modify: `packages/core/src/tools/built-in/index.ts`
- Modify: `packages/core/src/agent/modes.ts`
- Create: `packages/cli/vitest.config.ts`
- Modify: `packages/cli/src/host.ts`
- Modify: `packages/cli/src/entrypoints/cli.tsx`
- Create: `packages/cli/src/host.test.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**
- Produces `GitInspect` with operations `status`, `diff`, `show`, `log`, and `blame`.
- Produces `resolveNonInteractiveApproval(action, policy): PermissionResult`.
- Review mode exposes `GitInspect` but not `Bash`, `PowerShell`, `Write`, or `Edit`.

- [ ] **Step 1: Write mode reachability tests**

For every mode, resolve the complete visible tool set including dynamic aliases. Assert:

```ts
expect(names("review")).toContain("GitInspect")
expect(names("review")).not.toContain("Bash")
expect(names("review")).not.toContain("PowerShell")
expect(names("review")).not.toContain("Write")
expect(names("ask")).not.toContain("Bash")
expect(names("plan")).not.toContain("Bash")
```

Invoke `GitInspect` with an unsupported operation and assert schema validation rejects it.

- [ ] **Step 2: Implement read-only Git inspection**

Use `ctx.host.runCommand` only with commands assembled from validated enum operations and separately validated path/revision arguments. Reject revisions or paths beginning with `-`. Never accept a raw command string.

The tool requests read approval only and declares a read-only concurrency class.

- [ ] **Step 3: Write failing CLI headless tests**

Test that:

- non-TTY write/execute/MCP approvals return `{ approved: false }`;
- read remains approved only when policy permits it;
- print mode does not set `autoApprove: true`;
- `--dangerously-skip-permissions` remains the sole explicit bypass and retains its container/network validation.

Add `vitest: "3.2.3"` to CLI devDependencies, `test: "vitest run"` to CLI scripts, and:

```ts
// packages/cli/vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    pool: "forks",
  },
})
```

- [ ] **Step 4: Implement fail-closed CLI behavior**

Extract a pure approval resolver used before readline creation. Non-interactive mode denies privileged actions and emits one diagnostic explaining how to provide an explicit policy.

Change the print-mode `queryNexus` call to:

```ts
autoApprove: dangerouslySkipPermissions === true
```

Do not skip workspace trust merely because `--print` is active; use a non-interactive trust policy that denies mutation unless explicitly configured.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @nexuscode/core test -- src/agent/__tests__/modes.test.ts
pnpm --filter @nexuscode/cli test -- src/host.test.ts
pnpm --filter @nexuscode/core typecheck
pnpm --filter @nexuscode/cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/tools/built-in/git-inspect.ts packages/core/src/tools/built-in/index.ts packages/core/src/agent/modes.ts packages/core/src/agent/__tests__/modes.test.ts packages/cli/vitest.config.ts packages/cli/package.json packages/cli/src/host.ts packages/cli/src/host.test.ts packages/cli/src/entrypoints/cli.tsx pnpm-lock.yaml
git commit -m "security: enforce mode and headless CLI boundaries"
```

---

### Task 7: Authenticate and constrain the server

**Files:**
- Create: `packages/server/src/security.ts`
- Create: `packages/server/src/security.test.ts`
- Create: `packages/server/src/app.test.ts`
- Create: `packages/server/vitest.config.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/session.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/host.ts`
- Modify: `packages/cli/src/nexus-server-client.ts`
- Modify: the VS Code server client file identified by `rg -l "NexusServerClient|streamMessage" packages/vscode/src`
- Modify: `packages/server/package.json`

**Interfaces:**
- Produces:

```ts
export interface ServerSecurityOptions {
  token: string
  allowedOrigins: readonly string[]
  workspaceRoots: readonly string[]
}

export function authorizeBearer(header: string | undefined, token: string): boolean
export function resolveWorkspaceRoot(
  requested: string,
  allowedRoots: readonly string[],
): string
```

- `createApp(options: ServerSecurityOptions)` replaces the global unconfigured app.
- Clients send `Authorization: Bearer <token>`.

- [ ] **Step 1: Write pure security tests**

Cover:

- missing, malformed, and wrong bearer tokens;
- exact token success using constant-time comparison;
- requested workspace equal to or below an allowed root;
- `..`, sibling, symlink, and absolute outside-root rejection;
- empty allowlist rejection;
- allowed and denied origins.

Add `vitest: "3.2.3"` to server devDependencies, `test: "vitest run"` to server scripts, and:

```ts
// packages/server/vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    pool: "forks",
  },
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @nexuscode/server test -- src/security.test.ts`

Expected: FAIL because `security.ts` does not exist.

- [ ] **Step 3: Implement the security helpers**

Canonicalize both allowed and requested paths with `realpath` when they exist and with nearest-existing-parent resolution for a not-yet-created path. Compare path segments, not string prefixes. Use `timingSafeEqual` for equal-length bearer token buffers.

- [ ] **Step 4: Refactor app construction**

`createApp(options)` installs:

1. strict CORS for configured origins;
2. bearer auth for every `/session` route;
3. security options in Hono context;
4. public `/health` with no sensitive details.

Remove `origin || "*"`. Reject a browser origin not in the allowlist.

- [ ] **Step 5: Make workspace resolution authoritative**

Replace route-local `getCwd` with `resolveWorkspaceRoot`. A client cannot select `process.cwd()` implicitly unless it is in configured roots.

Parse server configuration from:

- `NEXUS_SERVER_TOKEN`, required unless `--generate-local-token` is used by the server CLI;
- `NEXUS_SERVER_ROOTS`, path-delimiter-separated;
- `NEXUS_SERVER_ORIGINS`, comma-separated.

Default binding remains `127.0.0.1`. Binding a non-loopback address fails unless token and origins were explicitly supplied.

- [ ] **Step 6: Remove server auto-approval**

`ServerHost.showApprovalDialog` returns denial unless the run carries an authenticated explicit capability policy. Foundation behavior denies; the later protocol plan adds remote interactive approvals.

- [ ] **Step 7: Update clients**

CLI and VS Code server clients accept `token` in constructors and attach the bearer header to every request and stream reconnect.

Read the token from the secrets store or `NEXUS_SERVER_TOKEN`; never place it in URL query parameters or logs.

- [ ] **Step 8: Run endpoint tests**

Using `app.request`, prove:

- unauthenticated session list/create/message/delete all return 401;
- wrong origin is rejected;
- outside-root directory is rejected;
- an authenticated request inside an allowed root reaches the route;
- privileged tool approval is not automatic.

- [ ] **Step 9: Verify**

Run:

```bash
pnpm --filter @nexuscode/server test
pnpm --filter @nexuscode/server typecheck
pnpm --filter @nexuscode/cli typecheck
pnpm --filter nexuscode typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/server/vitest.config.ts packages/server/src/security.ts packages/server/src/security.test.ts packages/server/src/app.test.ts packages/server/src/app.ts packages/server/src/routes/session.ts packages/server/src/index.ts packages/server/src/host.ts packages/server/package.json packages/cli/src/nexus-server-client.ts packages/vscode/src pnpm-lock.yaml
git commit -m "security: authenticate and constrain Nexus server"
```

---

### Task 8: Create the executable feature census

**Files:**
- Create: `scripts/feature-census.mjs`
- Create: `scripts/feature-census.test.mjs`
- Create: `docs/engineering/feature-census.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm census:features`.
- Produces a deterministic Markdown report with columns:
  `feature`, `declared`, `registered`, `mode-visible`, `executed-by`, `persisted-by`, `rendered-cli`, `rendered-vscode`, `rendered-server`, `tests`, `status`.

- [ ] **Step 1: Write census parser tests**

Create a temporary fixture repository containing:

- one documented and registered tool;
- one documented but missing tool;
- one registered but unrendered event;
- one VS Code setting with no source consumer.

Assert statuses `working-evidence`, `documentation-only`, `surface-gap`, and `orphan-setting`.

- [ ] **Step 2: Run and verify failure**

Run: `node --test scripts/feature-census.test.mjs`

Expected: FAIL because the census module does not exist.

- [ ] **Step 3: Implement deterministic static census**

Use Node filesystem APIs and bounded regular-expression parsing. The script must not claim a feature works from static evidence; only a linked test file can yield `working-evidence`. Static reachability yields `reachable-untested`.

Seed the feature list from:

- `getAllBuiltinTools`;
- mode tool groups;
- VS Code contributed settings and commands;
- CLI command definitions;
- server routes;
- plugin lifecycle tool names;
- MCP/resource features;
- documented headings and tool names.

- [ ] **Step 4: Generate and inspect the report**

Run:

```bash
pnpm census:features
rg "documentation-only|unreachable|surface-gap|orphan-setting" docs/engineering/feature-census.md
```

Expected: the report exposes current gaps rather than marking them complete.

- [ ] **Step 5: Add a CI guard**

Add `census:features:check` that regenerates to a temporary path and fails when the committed report differs. It does not fail merely because known gaps exist; later tasks change statuses as tests are added.

- [ ] **Step 6: Commit**

```bash
git add scripts/feature-census.mjs scripts/feature-census.test.mjs package.json
git add -f docs/engineering/feature-census.md
git commit -m "test: add executable Nexus feature census"
```

---

### Task 9: Foundation regression gate

**Files:**
- Modify only files required to fix failures found by this gate.
- Update: `docs/engineering/feature-census.md`
- Update: `docs/superpowers/plans/2026-07-26-nexus-foundation-runtime.md` checkboxes.

**Interfaces:**
- Produces a clean, reproducible foundation on Node 20.19.2.
- Provides the stable interfaces consumed by every follow-up plan.

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
git diff --check
pnpm test:runtime
pnpm census:features:check
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all first-party tests**

Run: `pnpm test`

Expected: PASS with non-zero first-party test counts in core, CLI, and server.

- [ ] **Step 3: Verify native runtime**

- [ ] **Step 4: Build every surface**

Run:

```bash
pnpm build:core
pnpm build:cli
pnpm build:server
pnpm build:vscode
```

Expected: PASS with no swallowed optional-component error.

- [ ] **Step 5: Run security smoke checks**

Start the server with a temporary token and workspace root. Verify:

```bash
curl -i http://127.0.0.1:4097/session
curl -i -H "Authorization: Bearer wrong" http://127.0.0.1:4097/session
curl -i -H "Authorization: Bearer $NEXUS_TEST_SERVER_TOKEN" "http://127.0.0.1:4097/session?directory=/outside/root"
```

Expected: 401, 401, then 403. Stop the server.

- [ ] **Step 6: Audit forbidden patterns**

Run:

```bash
rg "activeParallelAgentManager|McpClientRegistry.instance" packages
rg "auto-approving all actions|autoApprove: true" packages/cli packages/server
rg "origin: .*\\*" packages/server
rg "async function executeToolCall" packages/core/src/agent
```

Expected: no production runtime hits. Explicit compatibility tests or comments must be reviewed individually.

- [ ] **Step 7: Review feature parity**

Inspect the census and confirm:

- TaskCreateBatch, TaskSnapshot, and TaskResume are reachable and tested;
- native, textual, and parallel tools use hooks and spill;
- review has no arbitrary shell;
- CLI headless and server are fail closed;
- core, CLI, server, and VS Code build against the pinned runtime.

- [ ] **Step 8: Commit the verified foundation**

```bash
git add -A
git commit -m "test: verify the Nexus runtime foundation"
```

The commit may be empty if every preceding task commit already leaves the tree clean; in that case record the verification output in the implementation handoff rather than creating an empty commit.

---

## Foundation completion gate

Do not begin the transactional storage plan until:

- Node 20.19.2 and pnpm 10.8.1 are pinned and reproducible;
- the portable runtime has no unused native SQLite addon in its critical install or startup path;
- first-party tests execute in CI-compatible commands;
- bound task tools register;
- run-critical global managers are gone from production paths;
- every tool origin uses the same pipeline;
- review and headless CLI are fail closed;
- server requests are authenticated and workspace constrained;
- the feature census is committed and reproducible;
- all packages typecheck and all three surfaces build.
