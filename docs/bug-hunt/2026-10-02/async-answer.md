# Async question acknowledgment recovery — READY / EDITS FROZEN

Mode: follow-up audit during coordinator integration. Scope is the async question card and ChatRow projection;
the coordinator owns ChatView, task-scoped submission receipts, and host ACK correlation. Preserve Alpha execution,
approval, queue, history, answered-suggestion fixes, and exact VS Code 1.125.0 compatibility.

Current official Codex source inspected at `cb6da58876afed3ede0ab11084f67dd5394ecb48`:
`codex-rs/tui/src/chatwidget/questions.rs` accepts question answers only after ordinary delivery or queue admission;
`input_restore.rs` retains rejected steer source/order. Tests `rejected_synchronous_literal_prompt_keeps_questions`,
`blocked_follow_up_keeps_unanswered_questions`, `disconnected_questions_remain_editable_without_sending`, and
`retried_question_answers_keep_separate_envelopes_and_order` verify retained questions/delivery identity. Native
TypeScript presentation follows Alpha's host-owned task/request ACK protocol; no source/prompt/runtime port.

Applied the clean-code-review follow-up, change-safety, frontend, JavaScript, and testing passes. Checked root AGENTS,
git status, and integration control before editing. This ledger covers two bounded presentation defects; it does not
claim a complete chat review or a measured performance improvement.

## Findings and repairs

### ASYNC-1 — High / should-fix — rejected delivery permanently disables answers — fixed now

The card and ChatView both marked questions answered as soon as input was posted to the host.
Rejected host admission restores composer text but leaves the card permanently disabled. Card local answers are
valid drafts; accepted host admission, pending delivery, and rejected admission must remain distinct.

`AsyncUserInputCard.tsx` now takes controlled `isPending`, retains local answer inputs, and disables while pending or
answered. It renders pending status separately from accepted status and exposes `aria-busy`; direct form submission
also guards both states. `ChatRow.tsx` forwards `isAsyncUserInputPending`. The parent boolean callback remains intact;
posting an input is no longer interpreted as permanent successful admission by the component.

Controlled regressions were added before production changes: **3 failed / 5 passed in 2 files**. Rejected pending
delivery left Send disabled, and pending delivery rendered "Answers sent". The fixed card preserves selected radio
and text values; retry emits the same response. Pending and accepted submissions reject duplicate form events.

Coordinator owns ChatView/useTaskComposer request correlation. Existing queue, resume, and ask receipts retain the
async question timestamp; accepted matching task/command/request ACKs mark answered, rejected ACKs release pending.
Coordinator reported its three controlled real ACK cases passing (ask, queue, completed resume), including wrong-task
and old-receipt cases. Those integration tests were not run by this subagent; coordinator final gates own that evidence.

### ASYNC-2 — High / should-fix — another chat inherits an async answer draft — fixed now

A real ChatRow rerender from task A to task B with identical message timestamp/content retained A's selected answer
and free text. Added a controlled regression before the repair: **1 failed / 2 passed** in the row async file.
The card key now includes `currentTaskId` and `message.ts`. Rejection within the same question retains its draft;
navigating to another task resets the card rather than silently submitting the other task's draft.

## Verification

Final focused tests **14 passed in 3 files**, rerun after formatting and duplicate form-event coverage:

```powershell
pnpm --dir webview-ui test src/components/chat/__tests__/AsyncUserInputCard.spec.tsx src/components/chat/__tests__/ChatRow.async-user-input.spec.tsx src/components/chat/__tests__/ChatRow.render-isolation.spec.tsx --maxWorkers=2
```

Same first command without render-isolation file was the initial 3-failure baseline; row async alone was the separate
cross-task draft baseline. Focused ESLint for the four edited production/test files passed. `pnpm --dir webview-ui
check-types` ran twice and passed both times, including after the task key/fixture change. Scoped Prettier and
`git diff --check` passed. Final diff is four code/test files plus this ledger; no shared wire or persisted schema
change, dependency/manifest edit, generated artifact, broad formatting, or unrelated cleanup.

## Closure

- Fixed now: ASYNC-1 and ASYNC-2 presentation defects with coordinator correlation handoff implemented.
- Flagged for follow-up: no new contract question identified in this bounded scope.
- Not verified: exact-host interaction/visual gate; coordinator owns it.
- Out of scope: provider, persistence, sandbox, shared wire changes, builds, certification, live providers.

All owned edits are frozen for serialized root integration. The four files are `AsyncUserInputCard.tsx`, `ChatRow.tsx`,
`__tests__/AsyncUserInputCard.spec.tsx`, and `__tests__/ChatRow.async-user-input.spec.tsx` under
`webview-ui/src/components/chat`.
