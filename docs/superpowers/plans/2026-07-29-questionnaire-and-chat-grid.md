# Questionnaire and Chat Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать AskFollowupQuestion строгим, безопасным и одинаковым в core/VS Code/CLI, а ленту VS Code выровнять по единой Cursor-подобной горизонтальной сетке без накопления вложенных отступов.

**Architecture:** Core валидирует один канонический `UserQuestionRequest` и фильтрует интерактивный инструмент по host capability. Поверхности используют небольшую чистую state machine для answer/review/submit, но рендерят её нативно для React webview и Ink. Transcript задаёт три явных layout slot (`root`, `content`, `edge`) и передаёт slot дочерним карточкам вместо повторного вычисления inset.

**Tech Stack:** TypeScript 5.5, Zod 3, Vitest 3, React 18, Ink 5, VS Code webview CSS, pnpm workspace, Node.js 24.18.0.

## Global Constraints

- Runtime-тестовые изменения разрешены только в `/Users/mac/Projects/nexus/test`.
- Не запускать vector indexing, массовое сканирование репозиториев или нагрузочные тесты.
- Не добавлять новую UI-библиотеку или transport framework.
- Не хранить незавершённый questionnaire draft в durable transcript.
- Все protocol additions должны быть обратно совместимыми.
- Каждый production change следует только после наблюдаемого RED-теста.
- Один commit на один независимо проверяемый task.

## File map

- `packages/core/src/types.ts` — host capability и канонические question types.
- `packages/core/src/tools/user-question-utils.ts` — tolerant input coercion, strict semantic validation, answer formatting.
- `packages/core/src/tools/built-in/report-and-control.ts` — Zod schema, model-facing description и canonical request.
- `packages/core/src/agent/host-tool-capabilities.ts` — чистая фильтрация tool manifest по capability.
- `packages/core/src/agent/loop.ts` — применяет capability filter до построения provider-visible manifest.
- `packages/vscode/webview-ui/src/components/questionnaire/model.ts` — чистая question draft state machine.
- `packages/vscode/webview-ui/src/components/questionnaire/Questionnaire.tsx` — webview presentation.
- `packages/vscode/webview-ui/src/App.tsx` — только встраивает Questionnaire в composer.
- `packages/cli/src/components/questionnaire-model.ts` — terminal adapter к тем же переходам.
- `packages/cli/src/components/NexusQuestionPanel.tsx` — Ink presentation.
- `packages/vscode/webview-ui/src/components/CompletedWorkBlock.tsx` — content-slot ownership.
- `packages/vscode/webview-ui/src/components/MessageList.tsx` — semantic slot assignment.
- `packages/vscode/webview-ui/src/index.css` — единственный layout grid и responsive states.
- `packages/vscode/src/controller.ts` — request identity, duplicate/late response guard.
- `packages/vscode/src/webview-protocol.ts` — bounded questionnaire response validation.
- `packages/cli/src/nexus-query.ts` — interactive capability и headless fail-closed behavior.

---

### Task 1: Strict canonical question contract

**Files:**
- Create: `packages/core/src/tools/user-question-utils.test.ts`
- Create: `packages/core/src/tools/built-in/report-and-control.test.ts`
- Modify: `packages/core/src/tools/user-question-utils.ts`
- Modify: `packages/core/src/tools/built-in/report-and-control.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: existing `UserQuestionRequest`, `UserQuestionItem`, `UserQuestionAnswer`.
- Produces: `normalizeQuestionRequest(input, createRequestId): UserQuestionRequest`, `validateQuestionnaireAnswers(request, answers): UserQuestionAnswer[]`.

- [ ] **Step 1: Add a RED test proving no generic choices are invented**

```ts
it("rejects a question with fewer than two real choices", () => {
  const parsed = askFollowupTool.parameters.safeParse({
    question: "Choose the target",
    options: ["Only one"],
  })
  expect(parsed.success).toBe(false)
})

it("does not accept an agent-supplied Other row as a real choice", () => {
  const parsed = askFollowupTool.parameters.safeParse({
    question: "Choose the target",
    options: ["Workspace", "Other"],
  })
  expect(parsed.success).toBe(false)
})
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/tools/built-in/report-and-control.test.ts src/tools/user-question-utils.test.ts
```

Expected: FAIL because the current schema accepts one option and the host pads it.

- [ ] **Step 3: Make schema and normalization strict**

Implement:

```ts
const strictOptionsSchema = z
  .array(questionOptionRowSchema)
  .min(2, "Provide 2–4 real options.")
  .max(4, "Provide no more than 4 options.")

export function normalizeQuestionRequest(
  input: AskFollowupQuestionArgs,
  createRequestId = () => `question_request_${crypto.randomUUID()}`,
): UserQuestionRequest
```

Semantic validation must reject:

- zero or more than four questions;
- blank or duplicate question IDs;
- fewer than two or more than four non-reserved options;
- duplicate labels after whitespace/case normalization;
- preview on multi-select;
- `Other`, `Custom`, `Другое` and equivalent reserved labels.

Delete `DEFAULT_OPTION_PAD`, `DEFAULT_OPTION_PAD_ROTATIONS` and
`padQuestionOptionsToMinTwo`. Keep tolerant string/CSV/object coercion, but do
not invent semantics.

- [ ] **Step 4: Add answer validation RED cases**

```ts
it("rejects an unknown option id and missing custom text", () => {
  expect(() => validateQuestionnaireAnswers(request, [
    { questionId: "q1", optionId: "forged" },
  ])).toThrow(/unknown option/i)
  expect(() => validateQuestionnaireAnswers(request, [
    { questionId: "q1", optionId: NEXUS_CUSTOM_OPTION_ID, customText: " " },
  ])).toThrow(/custom answer/i)
})
```

- [ ] **Step 5: Implement bounded answer validation**

`validateQuestionnaireAnswers` returns answers in request question order,
rejects missing/duplicate question IDs, enforces single-vs-multi exclusivity,
checks every option ID, trims custom text, limits each custom answer to 16,384
characters and the whole response to 64 KiB.

- [ ] **Step 6: Verify GREEN and no focused regressions**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/tools/built-in/report-and-control.test.ts src/tools/user-question-utils.test.ts src/agent/__tests__/parallel-host.test.ts
corepack pnpm --filter @nexuscode/core typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/user-question-utils.ts packages/core/src/tools/user-question-utils.test.ts packages/core/src/tools/built-in/report-and-control.ts packages/core/src/tools/built-in/report-and-control.test.ts packages/core/src/index.ts
git commit -m "fix(core): enforce meaningful questionnaire contracts"
```

---

### Task 2: Advertise AskFollowupQuestion only to interactive hosts

**Files:**
- Create: `packages/core/src/agent/host-tool-capabilities.ts`
- Create: `packages/core/src/agent/host-tool-capabilities.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/test/fakes.ts`
- Modify: `packages/vscode/src/host.ts`
- Modify: `packages/cli/src/host.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Test: `packages/cli/src/host.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HostCapabilities {
  interactiveQuestions: boolean
}

export function filterToolsForHostCapabilities(
  tools: readonly ToolDef[],
  capabilities: HostCapabilities | undefined,
): ToolDef[]
```

- [ ] **Step 1: Add RED capability tests**

```ts
it("removes AskFollowupQuestion when interactive input is unavailable", () => {
  expect(filterToolsForHostCapabilities(
    [fakeTool("Read"), fakeTool("AskFollowupQuestion")],
    { interactiveQuestions: false },
  ).map((tool) => tool.name)).toEqual(["Read"])
})

it("fails closed when host capabilities are absent", () => {
  expect(filterToolsForHostCapabilities(
    [fakeTool("AskFollowupQuestion")],
    undefined,
  )).toEqual([])
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @nexuscode/core test -- src/agent/host-tool-capabilities.test.ts
```

Expected: FAIL because the capability filter does not exist.

- [ ] **Step 3: Implement capability filtering at the manifest boundary**

Add `readonly capabilities?: HostCapabilities` to `IHost`. Apply the filter to
mode-authorized built-ins before deferred-tool activation and provider schema
construction. Hidden legacy execution tools remain callable for transcript
compatibility, but are not advertised.

`VsCodeHost` declares `{ interactiveQuestions: true }`.
`CliHost` receives `interactiveQuestions` in its constructor options and
declares it exactly. `queryNexus` passes `true` only when `tuiApprovalRef`
exists; print/headless passes `false`.

- [ ] **Step 4: Add a RED CLI host test**

```ts
it("declares questions unsupported without the interactive TUI", () => {
  const host = new CliHost(process.cwd(), () => {})
  expect(host.capabilities.interactiveQuestions).toBe(false)
})
```

- [ ] **Step 5: Verify GREEN**

```bash
corepack pnpm --filter @nexuscode/core test -- src/agent/host-tool-capabilities.test.ts src/agent/__tests__/tool-pipeline.test.ts
corepack pnpm --filter @nexuscode/cli test -- src/host.test.ts
corepack pnpm --filter nexuscode test -- src/host-security.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent/host-tool-capabilities.ts packages/core/src/agent/host-tool-capabilities.test.ts packages/core/src/types.ts packages/core/src/agent/loop.ts packages/core/src/test/fakes.ts packages/vscode/src/host.ts packages/cli/src/host.ts packages/cli/src/nexus-query.ts packages/cli/src/host.test.ts
git commit -m "fix(runtime): gate questions on interactive host support"
```

---

### Task 3: Build a deterministic questionnaire state machine

**Files:**
- Create: `packages/vscode/webview-ui/src/components/questionnaire/model.ts`
- Create: `packages/vscode/webview-ui/src/components/questionnaire/model.test.ts`
- Create: `packages/cli/src/components/questionnaire-model.ts`
- Create: `packages/cli/src/components/questionnaire-model.test.ts`

**Interfaces:**
- Produces:

```ts
export type QuestionnairePhase = "answering" | "review"

export interface QuestionnaireDraft {
  requestId: string
  activeIndex: number
  phase: QuestionnairePhase
  answers: Record<string, UserQuestionAnswer>
  submitted: boolean
}

export function createQuestionnaireDraft(request: UserQuestionRequest): QuestionnaireDraft
export function selectQuestionOption(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): QuestionnaireDraft
export function setCustomQuestionAnswer(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  customText: string,
): QuestionnaireDraft
export function moveQuestion(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  direction: -1 | 1,
): QuestionnaireDraft
export function openQuestionnaireReview(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft
export function buildQuestionnaireSubmission(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): UserQuestionAnswer[]
export function canSubmitQuestionnaire(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): boolean
export function nextQuestionnaireStep(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft
export function editQuestionnaireAnswer(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
): QuestionnaireDraft
export function isQuestionnaireOptionSelected(
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): boolean
```

- [ ] **Step 1: Add RED transition tests**

```ts
it("uses review only for multi-question requests", () => {
  const one = selectQuestionOption(
    singleRequest,
    createQuestionnaireDraft(singleRequest),
    "q1",
    "a",
  )
  expect(nextQuestionnaireStep(singleRequest, one).phase).toBe("answering")
  expect(canSubmitQuestionnaire(singleRequest, one)).toBe(true)

  const many = selectQuestionOption(
    multiRequest,
    createQuestionnaireDraft(multiRequest),
    "q1",
    "a",
  )
  expect(nextQuestionnaireStep(multiRequest, many).activeIndex).toBe(1)
})

it("preserves answers across back, review, and edit", () => {
  const reviewed = openQuestionnaireReview(multiRequest, answeredDraft)
  const edited = editQuestionnaireAnswer(multiRequest, reviewed, "q1")
  expect(edited.phase).toBe("answering")
  expect(edited.answers.q2.optionId).toBe("b")
})
```

- [ ] **Step 2: Run RED in both packages**

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- src/components/questionnaire/model.test.ts
corepack pnpm --filter @nexuscode/cli test -- src/components/questionnaire-model.test.ts
```

- [ ] **Step 3: Implement pure immutable transitions**

Rules:

- `requestId` mismatch resets the draft;
- custom row exists only when `question.allowCustom === true`;
- single-select replaces prior selection;
- multi-select toggles concrete options and clears custom answer;
- entering custom mode clears concrete options;
- `next` is disabled until the active question is answered;
- one question submits without synthetic review;
- several questions enter review only after all are answered;
- `submitted` makes every later transition a no-op.

Use the same transition semantics in both adapters. Keep React and Ink state,
DOM, timers and callbacks out of model files.

- [ ] **Step 4: Verify GREEN and mutation isolation**

Add assertions that every transition returns a new object without mutating the
request or previous draft, then run both focused suites.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/webview-ui/src/components/questionnaire/model.ts packages/vscode/webview-ui/src/components/questionnaire/model.test.ts packages/cli/src/components/questionnaire-model.ts packages/cli/src/components/questionnaire-model.test.ts
git commit -m "feat(ui): define deterministic questionnaire flow"
```

---

### Task 4: Replace the webview questionnaire

**Files:**
- Create: `packages/vscode/webview-ui/src/components/questionnaire/Questionnaire.tsx`
- Create: `packages/vscode/webview-ui/src/components/questionnaire/Questionnaire.test.tsx`
- Modify: `packages/vscode/webview-ui/src/App.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`
- Modify: `packages/vscode/webview-ui/src/constants/questionnaire.ts`

**Interfaces:**
- Consumes: Task 3 model and `UserQuestionRequest`.
- Produces:

```tsx
<Questionnaire
  request={request}
  onDismiss={() => void}
  onSubmit={(answers) => void}
/>
```

- [ ] **Step 1: Add RED markup tests for the reported screenshot**

```tsx
it("renders one question without an empty option or pager", () => {
  const html = renderToStaticMarkup(
    <Questionnaire request={singleRequest} onDismiss={() => {}} onSubmit={() => {}} />,
  )
  expect(html).toContain("Workspace")
  expect(html).toContain("Other")
  expect(html).not.toContain("1 of 1")
  expect(html).not.toContain('class="nexus-questionnaire-card"')
  expect(html.match(/nexus-questionnaire-option/g)).toHaveLength(3)
})

it("omits Other when allowCustom is false", () => {
  const html = renderToStaticMarkup(
    <Questionnaire request={noCustomRequest} onDismiss={() => {}} onSubmit={() => {}} />,
  )
  expect(html).not.toContain(">Other<")
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- src/components/questionnaire/Questionnaire.test.tsx
```

Expected: FAIL because `Questionnaire` does not exist and the current
`QuestionnaireBar` always creates an unlabeled custom row.

- [ ] **Step 3: Implement the semantic form**

Use `fieldset`/`legend`, real radio/checkbox inputs, stable question IDs and
buttons. Hide pager for one question. For multiple questions render
`Back`, `Continue`, and a review page with `Edit` actions. Render:

```tsx
{question.allowCustom ? (
  <label className="nexus-questionnaire-option nexus-questionnaire-option-custom">
    <input
      type={isMulti ? "checkbox" : "radio"}
      checked={isQuestionnaireOptionSelected(
        draft,
        question.id,
        NEXUS_CUSTOM_OPTION_ID,
      )}
      onChange={() => setDraft(selectQuestionOption(
        request,
        draft,
        question.id,
        NEXUS_CUSTOM_OPTION_ID,
      ))}
    />
    <span>
      <strong>{request.customOptionLabel?.trim() || "Other"}</strong>
      <small>Type your own answer</small>
    </span>
  </label>
) : null}
```

Install one `keydown` listener for the active request. Its dependencies are
stable callbacks and scalar state; clean it in the effect return. Ignore
events from text inputs except `Escape` and `Cmd/Ctrl+Enter`.

- [ ] **Step 4: Remove the duplicate shell**

Delete `QuestionnaireBar` from `App.tsx`. Render `Questionnaire` directly
inside the ordinary `.chat-input-area`. Remove `.nexus-questionnaire-card`
border/radius and make questionnaire own only interior layout.

- [ ] **Step 5: Add RED narrow-layout assertions**

Test that the form contains `nexus-questionnaire-footer`, that button groups
are separate from navigation, and that no inline fixed width is emitted.
Use CSS media query `@media (max-width: 420px)` to stack footer groups and
allow option descriptions to wrap.

- [ ] **Step 6: Verify GREEN**

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- src/components/questionnaire/model.test.ts src/components/questionnaire/Questionnaire.test.tsx
corepack pnpm --filter @nexuscode/webview-ui typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/webview-ui/src/components/questionnaire packages/vscode/webview-ui/src/App.tsx packages/vscode/webview-ui/src/index.css packages/vscode/webview-ui/src/constants/questionnaire.ts
git commit -m "fix(vscode): rebuild the question composer"
```

---

### Task 5: Align CLI questionnaire behavior with OpenClaude

**Files:**
- Modify: `packages/cli/src/components/NexusQuestionPanel.tsx`
- Modify: `packages/cli/src/components/questionnaire-model.ts`
- Test: `packages/cli/src/components/questionnaire-model.test.ts`
- Test: `packages/cli/src/nexus-query-stream.test.ts`

**Interfaces:**
- Consumes: Task 1 strict request, Task 3 CLI state transitions.
- Produces: stable terminal navigation and one normalized submission.

```ts
export function questionOptions(
  question: UserQuestionItem,
  request: UserQuestionRequest,
): Array<UserQuestionOption & { isCustom: boolean }>

export function resolveQuestionCapability(interactive: boolean): {
  supported: boolean
  reason?: string
}
```

- [ ] **Step 1: Add RED CLI model tests**

```ts
it("does not add a custom row when allowCustom is false", () => {
  expect(questionOptions(noCustomRequest.questions[0], noCustomRequest))
    .toHaveLength(2)
})

it("returns an explicit unavailable error in non-interactive mode", () => {
  expect(resolveQuestionCapability(false)).toEqual({
    supported: false,
    reason: "Interactive input is unavailable in this CLI mode.",
  })
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @nexuscode/cli test -- src/components/questionnaire-model.test.ts src/nexus-query-stream.test.ts
```

- [ ] **Step 3: Refactor Ink component onto the model**

Preserve OpenClaude-like shortcuts:

- arrows or `j/k` move;
- `Space` toggles multi-select;
- `Enter` confirms current answer;
- `Esc` exits custom input first, then dismisses;
- multi-question flow ends on review;
- review supports edit and one final submit;
- `Other` label and `Type something.` placeholder are both visible.

Remove local transition logic now covered by `questionnaire-model.ts`.

- [ ] **Step 4: Ensure headless paths cannot wait**

Assert the local print tool manifest does not include
`AskFollowupQuestion`. If a restored remote event contains
`question_request`, emit one bounded diagnostic and finish that turn with a
non-interactive error instead of opening an unresolved promise.

- [ ] **Step 5: Verify GREEN**

```bash
corepack pnpm --filter @nexuscode/cli test -- src/components/questionnaire-model.test.ts src/nexus-query-stream.test.ts src/stdin-policy.test.ts
corepack pnpm --filter @nexuscode/cli typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/components/NexusQuestionPanel.tsx packages/cli/src/components/questionnaire-model.ts packages/cli/src/components/questionnaire-model.test.ts packages/cli/src/nexus-query.ts packages/cli/src/nexus-query-stream.test.ts
git commit -m "fix(cli): make questions interactive and fail closed"
```

---

### Task 6: Establish one chat-grid contract

**Files:**
- Modify: `packages/vscode/webview-ui/src/components/CompletedWorkBlock.tsx`
- Modify: `packages/vscode/webview-ui/src/components/CompletedWorkBlock.test.tsx`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/webview-ui/src/components/MessageListToolBlocks.test.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`
- Create: `packages/vscode/webview-ui/src/components/chat-grid-contract.test.tsx`

**Interfaces:**
- Produces CSS slots:

```text
nexus-chat-slot-root
nexus-chat-slot-content
nexus-chat-slot-edge
nexus-worked-item
```

- [ ] **Step 1: Add RED slot tests**

```tsx
it("assigns exactly one content slot inside completed work", () => {
  const html = renderToStaticMarkup(
    <CompletedWorkDetails>
      <div className="nexus-tool-card">tool</div>
    </CompletedWorkDetails>,
  )
  expect(html.match(/nexus-chat-slot-content/g)).toHaveLength(1)
  expect(html).not.toContain("message-list-item")
})

it("keeps final answer outside the worked details slot", () => {
  const html = renderToStaticMarkup(
    <>
      <CompletedWorkBlock durationMs={6000}>
        <div className="nexus-tool-card">tool</div>
      </CompletedWorkBlock>
      <div className="nexus-final-answer">done</div>
    </>,
  )
  expect(html.indexOf("nexus-worked-details"))
    .toBeLessThan(html.indexOf("nexus-final-answer"))
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- src/components/CompletedWorkBlock.test.tsx src/components/chat-grid-contract.test.tsx
```

- [ ] **Step 3: Move all outer positioning to slots**

Set:

```css
.message-list {
  --nexus-chat-root-gutter: 12px;
  --nexus-chat-content-inset: 12px;
  padding-inline: var(--nexus-chat-root-gutter);
}

.nexus-chat-slot-root { margin-inline: 0; width: 100%; }
.nexus-chat-slot-content {
  margin-inline-start: var(--nexus-chat-content-inset);
  width: calc(100% - var(--nexus-chat-content-inset));
}
.nexus-worked-details .nexus-chat-slot-content {
  margin-inline-start: 0;
  width: 100%;
}
```

`CompletedWorkDetails` owns the single content inset. Remove:

- child `width: calc(100% - inset * 2)`;
- `AssistantText` Tailwind `pl-[var(--nexus-content-inset)]`;
- extra left padding from `.nexus-worked-details`;
- any tool-specific external margin used only for alignment.

Keep internal card padding unchanged.

- [ ] **Step 4: Add semantic slot assignment**

- user bubble, Worked header, sticky changes, composer → root;
- final answer, live reasoning, exploration, tool cards → content;
- preview bodies inside an existing card → no outer slot;
- expanded Worked children → inherit its content slot and do not re-indent.

- [ ] **Step 5: Verify all webview projection suites**

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- src/components/CompletedWorkBlock.test.tsx src/components/MessageListToolBlocks.test.tsx src/components/chat-grid-contract.test.tsx src/transcript/renderProjection.test.ts
corepack pnpm --filter @nexuscode/webview-ui typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/vscode/webview-ui/src/components/CompletedWorkBlock.tsx packages/vscode/webview-ui/src/components/CompletedWorkBlock.test.tsx packages/vscode/webview-ui/src/components/MessageList.tsx packages/vscode/webview-ui/src/components/MessageListToolBlocks.test.tsx packages/vscode/webview-ui/src/components/chat-grid-contract.test.tsx packages/vscode/webview-ui/src/index.css
git commit -m "fix(vscode): align chat content to one grid"
```

---

### Task 7: Make question lifecycle race-safe and replay-safe

**Files:**
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/vscode/src/webview-protocol.ts`
- Modify: `packages/vscode/src/webview-protocol.test.ts`
- Create: `packages/vscode/src/question-lifecycle.ts`
- Create: `packages/vscode/src/question-lifecycle.test.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.test.ts`

**Interfaces:**
- Produces:

```ts
export interface QuestionResolution {
  accepted: boolean
  request?: UserQuestionRequest
  answers?: UserQuestionAnswer[]
}

export class PendingQuestionCoordinator {
  publish(request: UserQuestionRequest): void
  resolve(requestId: string, answers: UserQuestionAnswer[]): QuestionResolution
  dismiss(requestId: string): boolean
  clear(reason: "session-switch" | "dispose" | "new-run"): void
  snapshot(): UserQuestionRequest | null
}
```

- [ ] **Step 1: Add RED coordinator tests**

```ts
it("accepts one response and rejects duplicate and late responses", () => {
  const coordinator = new PendingQuestionCoordinator()
  coordinator.publish(request)
  expect(coordinator.resolve(request.requestId, answers).accepted).toBe(true)
  expect(coordinator.resolve(request.requestId, answers).accepted).toBe(false)
  coordinator.publish(nextRequest)
  expect(coordinator.resolve(request.requestId, answers).accepted).toBe(false)
})

it("clears pending state on session switch and disposal", () => {
  coordinator.publish(request)
  coordinator.clear("session-switch")
  expect(coordinator.snapshot()).toBeNull()
})
```

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter nexuscode test -- src/question-lifecycle.test.ts
```

- [ ] **Step 3: Implement coordinator and controller integration**

Replace direct assignments to `pendingQuestionRequest` with the coordinator.
Only an accepted resolution may call `runAgent`. Dismiss posts an immediate
authoritative state snapshot. New session, reconnect, abort and `dispose()`
clear pending state. A duplicate or stale response is ignored and logged once
without starting a turn.

- [ ] **Step 4: Harden inbound validation**

`questionnaireResponse` must contain:

- non-empty bounded `requestId`;
- 1–4 answers;
- unique bounded `questionId`;
- mutually exclusive single/multi fields;
- no unknown object keys;
- bounded labels and custom text.

Core semantic validation remains authoritative for option membership.

- [ ] **Step 5: Add store replay RED tests**

Prove:

- repeated `stateUpdate` with the same request ID preserves one panel;
- streamed `question_request` followed by matching state does not duplicate;
- suppressing a dismissed ID prevents one stale snapshot from reopening it;
- a genuinely new request ID is shown.

- [ ] **Step 6: Verify GREEN**

```bash
corepack pnpm --filter nexuscode test -- src/question-lifecycle.test.ts src/webview-protocol.test.ts
corepack pnpm --filter @nexuscode/webview-ui test -- src/stores/chat.test.ts
corepack pnpm --filter nexuscode typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/vscode/src/question-lifecycle.ts packages/vscode/src/question-lifecycle.test.ts packages/vscode/src/controller.ts packages/vscode/src/webview-protocol.ts packages/vscode/src/webview-protocol.test.ts packages/vscode/webview-ui/src/stores/chat.ts packages/vscode/webview-ui/src/stores/chat.test.ts
git commit -m "fix(vscode): make question lifecycle race safe"
```

---

### Task 8: Verify resources, production builds, and real surfaces

**Files:**
- Modify: `docs/superpowers/checkpoints/2026-07-29-questionnaire-and-chat-grid-validation.md`
- Modify only if a verified defect is found: relevant source and its RED test.

**Interfaces:**
- Produces: authoritative validation evidence and screenshots.

- [ ] **Step 1: Run focused leak/boundedness tests**

Add or extend tests that mount/unmount the questionnaire 100 times using the
available React test boundary or pure listener adapter. Assert:

- registered listeners return to zero;
- only one pending request exists;
- duplicate submit launches one callback;
- 100 sequential request states do not retain prior answer maps.

This is bounded deterministic testing, not a stress test.

- [ ] **Step 2: Run package gates**

```bash
corepack pnpm --filter @nexuscode/core test
corepack pnpm --filter @nexuscode/webview-ui test
corepack pnpm --filter nexuscode test
corepack pnpm --filter @nexuscode/cli test
corepack pnpm typecheck
```

- [ ] **Step 3: Run runtime/build gates**

```bash
corepack pnpm run test:runtime
corepack pnpm run build
corepack pnpm run package:vscode
git diff --check
```

- [ ] **Step 4: Install the freshly built VSIX**

Use the repository install script or:

```bash
code --install-extension packages/vscode/nexuscode-*.vsix --force
```

Confirm the installed extension version and reload the Extension Development
Host or normal VS Code window once.

- [ ] **Step 5: Execute safe VS Code scenarios**

In `/Users/mac/Projects/nexus/test`:

1. one single-select question;
2. one custom answer;
3. three questions with Back, Review, Edit, Submit;
4. Dismiss then a new request;
5. reload after completed request;
6. narrow/wide sidebar and 80%, 100%, 150%, 200% zoom;
7. keyboard-only operation;
8. question after reasoning/search and before final answer;
9. expand/collapse Worked containing thought, search, bash and diff;
10. verify all relevant left edges with screenshots.

No runtime action may leave files outside the test directory.

- [ ] **Step 6: Execute safe CLI scenarios**

Use an interactive CLI in `/Users/mac/Projects/nexus/test` for single,
custom, multi/review and dismiss. Run one `--print` prompt designed to tempt a
question and verify it completes with an assumption or explicit unavailable
diagnostic, never a hang.

- [ ] **Step 7: Inspect process resources**

During bounded scenarios, record VS Code extension host and Nexus CLI RSS
before and after repeated question cycles. A warm cache may grow once, but
listeners, pending requests and RSS must stabilize; continued monotonic growth
requires another RED reproduction before any fix.

- [ ] **Step 8: Record evidence and commit**

The checkpoint must list exact commands, pass counts, VSIX path, screenshots,
manual scenario outcomes, resource observations, and any unverified item.

```bash
git add -f docs/superpowers/checkpoints/2026-07-29-questionnaire-and-chat-grid-validation.md
git add packages
git commit -m "test: validate questionnaire and chat grid"
```

- [ ] **Step 9: Push only after clean-state audit**

```bash
git status --short
git log --oneline --decorate -10
git push origin main
```

Expected: clean worktree and successful push of every reviewed task commit.
