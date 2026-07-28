# NexusCode First-Run and Product Audit Implementation Plan

> Execute in small verified slices. Do not perform real provider calls or
> destructive tests.

**Goal:** Fix clean-install startup, audit complete CLI/VS Code workflows, repair
confirmed high-impact defects, and publish a source-backed comparison matrix.

**Architecture:** Keep the shared `@nexuscode/core` runtime authoritative. CLI
and VS Code are host adapters and projections. Presentation state is separate
from canonical config and secrets. Durable writes use the existing core storage
primitives instead of ad-hoc filesystem calls.

---

## Task 1: Reproduce clean-home CLI startup failure

**Files:**
- Modify: `packages/cli/src/config-persistence.test.ts`
- Inspect: `packages/cli/src/utils/config.ts`
- Inspect: `packages/core/src/storage/durable-fs.ts`

1. Add a regression test using a temporary `NEXUS_CONFIG_DIR`.
2. Assert the first state mutation creates the directory and a readable file.
3. Assert directory/file modes are owner-only on POSIX.
4. Run the focused test and confirm it fails for the reported `ENOENT`.

## Task 2: Harden CLI presentation-state persistence

**Files:**
- Modify: `packages/cli/src/utils/config.ts`
- Modify: `packages/cli/src/utils/env.ts`
- Modify: focused tests as needed

1. Reuse the durable storage primitive or implement an equivalent synchronous
   adapter where startup call sites cannot be asynchronous.
2. Create parents safely, reject symlinks, serialize writes, and atomically
   replace the state file.
3. Strip legacy plaintext credentials from every write.
4. Preserve compatible non-secret state and malformed-file error behavior.
5. Run CLI tests and typecheck.

## Task 3: Validate installation and packaged first launch

**Files:**
- Modify: `scripts/install-nexus-cli.sh`
- Modify: `scripts/runtime-version.test.mjs`
- Modify: `README.md`
- Modify: `DOCS.md`

1. Add an isolated install/startup smoke path with a temporary home.
2. Validate the exact Node/pnpm contract and shell startup guidance.
3. Remove stale Node 20 instructions.
4. Confirm wrapper path resolution and clean-home launch do not depend on the
   repository working directory.

## Task 4: Audit surface-to-core workflows

**Files:**
- Inspect/modify: `packages/core/src/**`
- Inspect/modify: `packages/cli/src/**`
- Inspect/modify: `packages/vscode/src/**`
- Inspect/modify: `packages/vscode/webview-ui/src/**`

For every workflow in the design:

1. Trace the request from user surface to the core and back.
2. Compare with exact source implementations.
3. Add a failing regression test for each confirmed P0/P1 defect.
4. Make the smallest architectural fix in the owning layer.
5. Verify both surfaces when a shared event/config/tool contract changes.

## Task 5: Audit agent subsystems

Cover:

- prompts, modes, provider boundaries, compaction, cancellation, recovery;
- code tools, permissions, output storage, MCP, skills, plugins;
- memory retrieval/writeback;
- subagent lifecycle and approval coordination;
- diff/change-set/accept/reject/revert and Git status;
- transport schemas, replay/cursors, rendering, disposal;
- configuration, secrets, sessions, checkpoints, and concurrent state.

Record each finding in the comparison matrix and fix verified P0/P1 defects
with focused tests.

## Task 6: Publish comparison matrix

**Files:**
- Create: `docs/SOURCE_AGENT_COMPARISON.md`

Include Codex, OpenClaude, Kilo Code, Roo Code, Kimi Code, Kimi CLI, MiMo Code,
Qwen Code, Cline, OpenCode, and Claw Code. Compare every requested layer, cite
repository paths and pinned commits, and distinguish adopted, adapted, rejected,
and deferred mechanisms.

## Task 7: Full safe verification

Run:

1. focused regression suites;
2. workspace typecheck;
3. complete unit/integration test suite;
4. production builds;
5. runtime/storage/feature-census checks;
6. MCP/skills workflow validation;
7. VSIX packaging;
8. isolated CLI first-launch smoke;
9. clean worktree and diff review.

Commit intentionally and push `main` only after all required checks pass.
