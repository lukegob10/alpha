# Request user input review — 2026-10-12

Follow-up: the user selected the step-by-step design. Its implementation and validation are recorded in
[Native question stepper](request-user-input-stepper.md).

This focused correctness cleanup reviews the native question path shown in the user's screenshot. The intended result is a readable question-and-answer transcript, faithful model history, and reliable answer validation. This is not a repository-wide audit or a production UI redesign.

## Current Codex reference

Retrieved current `openai/codex` source on **2026-10-12**, at main commit **12cca49c81c8aa6a37a5cc4e39964ee3b70f9458**:

- [Native handler](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/request_user_input.rs)
- [Handler tests](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/request_user_input_tests.rs)
- [Tool schema and normalization](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/core/src/tools/handlers/request_user_input_spec.rs)

Upstream returns an answer map keyed by question ID and restricts calls to the root thread. With GuardianApproval enabled, it also retains full questions and answers, including the descriptions of selected options; its tests exercise that retained evidence. Its schema describes one to three questions and client-provided free-form Other choices. The handler normalizes Other support and rejects missing or empty options.

Alpha preserves the answer-map shape. It uses its existing blocking `Task.ask` integration in Code and Plan, while provider-gated `request_user_input_async` emits a nonblocking card and returns acceptance immediately. This patch does not change that existing architectural divergence. Alpha also deliberately applies stronger runtime validation than upstream normalization, including question bounds, stable unique IDs, and now unique trimmed option labels, because its UI and returned values identify choices by label.

## Findings and changes

| Finding                                                         | Impact and evidence                                                                                                                                                                                                                               | Resolution                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium, should-fix: feedback omits the full question            | `RequestUserInputTool` recorded only a short header for grouped replies and only the answer for a single reply. The screenshot therefore cannot be read as a complete decision record. Three focused transcript assertions failed before the fix. | Record each full prompt followed by its answer lines, with a blank line between questions. Attached images remain on the feedback record.           |
| Medium, must-fix: single-question free-form scalar replies fail | A raw composer reply of `10` is valid free-form input, for example when answering a concurrency question. Because it parses as a JSON number, the old parser rejected it as an invalid answer map. `true` and `null` failed for the same reason.  | Preserve the exact trimmed scalar text for one question. JSON object/array responses still require the existing structured contract.                |
| Medium, must-fix: duplicate labels produce ambiguous choices    | Two choices with the same label but different descriptions passed validation. The form uses the label as its React key and selected value; the tool result also returns that label. Whitespace variants become identical when submitted.          | Reject duplicate trimmed labels within a question before opening the form. Keep the original valid labels in the displayed request and tool result. |

No evidence from the reviewed ordinary model-history path shows that the answer-only bubble removes question context from the model. `Task.persistAssistantResponseBeforeEffects` saves the assistant tool call, including full prompts, options, and IDs, before executing the tool. The tool result keeps the question IDs and selected/free-form answer strings. OpenAI and VS Code LM transforms preserve those tool-call inputs and matching result content. The feedback change improves the persisted UI transcript without adding redundant prompts to the tool-result JSON. Generic compaction policy was not changed or exhaustively audited here.

## Preserved contracts

- Results remain `{ "answers": { "question_id": { "answers": ["selected label or free text"] } } }`.
- Every requested ID must appear exactly once in a structured response; missing or unknown IDs and malformed answer objects fail. Free-form fallback is limited to one question.
- Selected labels, including `(Recommended)`, remain unchanged in the wire payload and result; any decorative separation belongs to presentation.
- Cancellation retains an empty answer map with cancelled result metadata. It does not become a successful answer or record cancelled feedback.
- The first option for every question remains the complete default suggestion used by existing follow-up autoapproval. The existing off-screen `Task.ask` policy also chooses the first suggestion; this review leaves that policy unchanged.

## Coverage and validation

Edited the native tool and its nearest tests. Reviewed shared follow-up types, native schema, async tool, `Task.ask`/feedback/history/persistence boundaries, autoapproval defaults, scheduler result projection, and OpenAI/VS Code LM history transforms. No persisted schema or provider adapter changed.

- Baseline: native tool suite **10/10 passed**.
- Missing-prompt reproduction: **3 failures / 7 passes** with the old implementation.
- Scalar/duplicate reproduction after transcript fix: **5 failures / 16 passes**; malformed structured-response characterization cases passed.
- After all core fixes: native and async tool suites **24/24 passed**. This includes stable answer maps, single/grouped transcript prompts, images, free-form input, malformed structured responses, cancellation, and subagent denial.
- Provider transforms, tool-history replay, and queued ask handling: **127/127 passed** across four files.
- Assistant persistence boundary subset: **16 passed, 61 skipped** by the explicit test-name filter. This includes native barrier rejection and cancellation replay coverage.

Core focused validation commands:

```sh
pnpm --dir src test core/tools/__tests__/RequestUserInputTool.spec.ts core/tools/__tests__/RequestUserInputAsyncTool.spec.ts
pnpm --dir src test api/transform/__tests__/openai-format.spec.ts api/transform/__tests__/vscode-lm-format.spec.ts api/transform/__tests__/tool-history-replay.spec.ts core/task/__tests__/ask-queued-message-drain.spec.ts
pnpm --dir src test core/task/__tests__/Task.persistence.spec.ts -t 'assistant response persistence boundary'
```

## Integration review

Three agents independently reviewed the model-history path, webview behavior, and proposed question designs. The existing
native-tool feedback/validation fixes and form identity fixes were preserved. The integration pass added two bounded
correctness fixes:

- **High, must-fix: malformed saved question data crashed the chat row.** The follow-up parser asserted the shared
  TypeScript type without runtime validation. Valid JSON containing `requestUserInput.questions: null` or a null option
  reached the form's `.length` or `option.label` access. Two regression cases failed for those exact reasons before the
  change. `ChatRow` now validates parsed JSON with the existing `followUpDataSchema` and safely ignores malformed
  follow-up records. Valid native forms, ordinary suggestions, and existing task/ask identity behavior remain covered.
- **Medium, must-fix: async choices also allowed duplicate trimmed labels.** Async requests trimmed options before
  publishing, so `Staging` and `Staging` produced indistinguishable choices and duplicate React keys. Two new cases
  failed before the fix. `RequestUserInputAsyncTool` now rejects duplicates within each question before publishing the
  card. Identical choices in different questions remain valid, and existing trimming behavior is preserved.

No public, wire, or persisted schema changed. No production question layout was redesigned in this pass.

### History and presentation findings

Verified the same upstream commit against current `openai/codex` main during the integration review. Its
[question pane](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs)
shows one active question with navigation, while its
[completed transcript](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/history_cell/request_user_input.rs)
keeps the full prompt and answer. Alpha's stacked fieldsets and retained disabled form are presentation choices, not a
requirement of the native tool contract.

The model-history review found no question loss caused by the answer bubble. Assistant tool-call inputs are persisted
before effects. Recent-tail compaction keeps native question/result pairs together, passes complete inputs to summary
generation, and retains the exact unsummarized tail. Older exchanges remain subject to normal summarization and
truncation; this review does not claim indefinite retention of every original prompt. Async card replies already include
each full question and answer in the ordinary user message. Cancellation status continues to be enforced by the shared
Task/scheduler boundary.

The remaining UX opportunities are to pace questions, quiet the option chrome, preserve custom drafts while revisiting
choices, and collapse completed requests into readable receipts. Option descriptions currently explain a choice but
cannot collect additional details alongside it; users can use Other to provide those details. This is a question design
and interaction limitation, not evidence of answer corruption.

Three interactive mockups explore **Step by step**, **Compact outline**, and **Conversation**. Each uses the screenshot's
actual question content, supports custom answers and editing, sends the group only after final confirmation, and replaces
the completed form with full question/answer pairs. Step by step is the recommended direction for clear pacing; Compact
outline favors revisiting choices; Conversation favors fewer clicks. These are design proposals rather than implemented
extension behavior. Recommended badges are presentation only; a future implementation must preserve original option
labels in submitted payloads.

### Integration validation

- Native and async tool suites: **27/27 passed**, including three new async cases. Before the async fix: **2 failures /
  4 passes**.
- Five webview suites: **45/45 passed** across native form/row, ordinary suggestions, and async card/row. Before the
  malformed-history guard: **2 failures / 4 passes**.
- Recent-tail compaction: **32/32 passed**.
- Provider transforms, history replay, and queued ask handling: **127/127 passed** across four files after the integration
  fixes.
- Extension and webview typechecks passed after the integration fixes.
- ESLint passed for all four code/test files edited by the integration pass; diff whitespace checks passed.
- Mockup browser QA: **18 checks passed** with no browser runtime errors. All three initial layouts fit at 320px and
  736px in light/dark appearances. Each flow completed, allowed review/editing and custom answers, cancelled without
  sending, and replaced the form with all three question/answer pairs after submission. Representative layouts and
  receipts were visually inspected. This verifies the proposed mockups rather than the production webview layout.
- Three additional keyboard checks passed for native radio/arrow selection, custom-answer typing, accordion disclosure,
  conversational advancement, and focus restoration. The first keyboard pass exposed a mockup state echo that rebuilt
  focused controls; that issue was corrected before the final interaction and keyboard reruns.

Additional integration commands:

```sh
pnpm --dir webview-ui test src/components/chat/__tests__/RequestUserInputForm.spec.tsx src/components/chat/__tests__/ChatRow.request-user-input.spec.tsx src/components/chat/__tests__/FollowUpSuggest.spec.tsx src/components/chat/__tests__/ChatRow.async-user-input.spec.tsx src/components/chat/__tests__/AsyncUserInputCard.spec.tsx
pnpm --dir src test core/condense/__tests__/recent-tail.spec.ts
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

After the production fixes, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` passed: **42/42 tests across 13 host runs**,
with **zero failures and zero pending tests**. Every run recorded actual VS Code **1.125.0**, verified extension-host
ownership, and `requireAllTests: true`. The gate used scripted providers and the VS Code LM fixture, including the async
question acceptance/reload test. This is deterministic host evidence rather than a live Copilot quality evaluation.

Concurrent activity-row styling edits appeared after the host gate. They were preserved and remain outside this review.
The five question-related webview suites were rerun afterward (**45/45 passed**), as was webview typechecking (**passed**).
