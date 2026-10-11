# Additional Astra persistence/reload review — October 10, 2026

> Historical audit snapshot: the unchanged five-case reproduction now passes after the coordinated fixes.
> See [the closure report](astra-reliability-bug-hunt-2026-10-10.md) for implementation and final validation.

## Scope and method

This independent audit reviewed interrupted-turn persistence, transcript replay, input provenance, managed recovery,
history deletion, and scheduled-run recovery. It deliberately avoided ownership of the already reported queue-ACK,
input-receipt timing, Anthropic opaque-state, closed-child spend, failed follow-up admission, before-run notification,
and closed-root-limit findings. No production code or existing tests were edited. No subagents, builds, Electron runs,
dependency changes, commits, resets, or deletions were performed.

The root AGENTS.md was read; the checkout already contained active fixers' changes and the original code-search work.
Line references below describe the working source inspected at **2026-10-11 02:05 UTC** (October 10 local time).

The upstream reference is
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/commit/cc7ba33601286a751477832b01de7b6f8de0dd9c),
identified by the coordinating audit as current at 2026-10-11 01:37 UTC. Relevant files at that exact commit were fetched
again through the GitHub connector for this review; current main was not independently repinned.

## Confirmed finding 1 — P1: resume deletes committed input before its replacement is durable

**Owner/location:** `src/core/task/Task.ts:9929–9937` removes the last user message, and
`src/core/task/Task.ts:10009` persists that shortened history before `initiateTaskLoop` prepares and commits the
replacement user input. These are the non-retained reopen and managed-child-follow-up paths.

**Trigger:** An interrupted conversation ends with a committed user-role record containing a completed tool result
and human guidance. Reopen it and select Continue. While the next turn is preparing mentions or environment context,
cancel again, close the task, encounter a preparation error, or reload the extension.

**Observed failure:** The first resume write has already removed the entire previous user record. The next input write
never happens, so the saved provider transcript ends in an assistant tool call with no result and loses the prior human
guidance and its receipt metadata. This occurs after a successful original commit; it is not the known failed-ACK
duplication or input-receipt timing bug. `overwriteApiConversationHistory` can also settle consumed queue entries before
removing their transcript record, so the queue cannot be relied upon to restore it.

The deterministic reproduction exercises the real resume, overwrite, request-input preparation, and add-message
methods with a JSON-roundtripping storage boundary. A controlled promise pauses mention preparation; cancellation
then prevents the replacement commit. The assertion that the committed history still equals the original fails:
`COMMITTED_RESULT`, `COMMITTED_GUIDANCE`, and `queued_message_ids` are all absent. Filesystem atomic-write mechanics
are not being simulated as failures; the successful destructive write is the defect under test.

Canonical recovery can sometimes reconstruct a bounded tool result, but it cannot reconstruct arbitrary human
guidance that this path discarded. Starting a new lifecycle also advances beyond the interrupted turn. The retained
fast path already documents avoiding an interim unpaired tool call; the ordinary reopen path needs the same durable
invariant.

**Smallest complete fix:** Preserve the existing durable tail during preparation and cancellation. Keep its message
envelope and metadata, append only new input, and repair genuinely missing tool results without removing existing ones.
If a replacement is unavoidable, commit the repaired prefix and replacement together in one existing transcript
transaction after preparation succeeds. Do not rely only on restoring the in-memory array after failure.

**Upstream evidence:**
[Codex resume tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/resume.rs#L30)
assert that the first request after restart still contains the original user request and answer.
[Dynamic cancellation tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/dynamic_tool_cancellation.rs#L171)
check durable terminal events and subsequent context.
[History normalization](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context_manager/normalize.rs#L21)
adds outputs only for calls without an output. The requirement here is preservation of committed evidence in Alpha's
native persistence layer, not adoption of Codex's storage or sandbox architecture.

## Confirmed finding 2 — P1: resume changes the authority of historical input

**Owner/location:** `src/core/task/Task.ts:9871` special-cases summaries and agent delivery receipts but not other
input provenance. Lines `9929–9950` flatten the last user message into the new input's content, losing its envelope;
line `10019` defaults the reconstructed input to human origin. The consumer
`src/core/agent/requestWorkClass.ts:196–202` selects the first `<user_message>` in that combined content.

**Two realistic triggers and observed assertions:**

1. An initial request says `Create a separate task to investigate`. The request is persisted, but the provider fails or
   is interrupted before recording an assistant response. On reopen, the user writes
   `Do not create a separate task. Continue in this chat.` The next input commit contains both user wrappers in a single
   record. `extractUserRequestText` returns the old creation instruction; the assertion that it returns the revocation
   fails. The independent-task authorization predicate therefore remains true. The reproduction covers both reload
   and the retained-history branch of the internal resume helper.
2. A Stop hook emits `Create a separate task to run a follow-up review`; its continuation is durably stored with
   `input_origin: "agent"` and `hook_prompt`. Interrupt before its assistant response, reopen, and click Continue with
   no new text. Resume discards both provenance fields and persists the hook text as human input. The assertion that
   independent-task authorization remains false fails: it changes from false before resume to true afterward.

**Impact:** These fields feed executable policy. `src/core/task/build-tools.ts:384` uses the predicate to expose
`create_task`, and `src/core/webview/AlphaProvider.ts:5208–5213` uses the same reader and predicate to admit creation.
No real task was created during this audit; the confirmed observable is the incorrect authorization decision using the
same production helpers as that host gate. The ordinary assistant-tail follow-up control correctly preserves the new
revocation and passes.

**Smallest complete fix:** Preserve separate persisted message envelopes for old input and new human guidance,
including `input_origin`, `hook_prompt`, receipts, and summary/truncation metadata. Merge same-role messages only in
provider request projection, as the existing comment above `overwriteApiConversationHistory` already requires. Keep
tool-pair repair distinct from appending a new instruction. Do not fix this by merely choosing the last XML wrapper:
that leaves hook provenance loss and the destructive-write window unresolved.

This shares the resume-rewrite implementation with finding 1 and should be fixed in the same bounded patch, but it
violates a separate invariant and reproduces even when every write succeeds.

**Upstream evidence:**
[Codex's authorization classifier](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/contextual_user_message.rs#L51)
uses host annotations to distinguish user authorization from contextual input.
[Hook-context tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/contextual_user_message_tests.rs#L147)
preserve the hook identity and contextual classification.
[Retained authorization](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context_manager/history_user_authorization.rs#L143)
retains source identity/origin rather than deriving fresh authority from a replayed provider role.
Alpha's explicit independent-task authorization rule remains its own intentional host policy; the bug is losing the
provenance on which that existing policy depends.

## Reproduction and validation

Added only the isolated review test
[`additional-chat-reload.astra.spec.ts`](../src/core/task/__tests__/additional-chat-reload.astra.spec.ts).

```sh
pnpm --dir src test core/task/__tests__/additional-chat-reload.astra.spec.ts --maxWorkers=1
```

Result on the inspected source: **4 failed / 1 passed**, all failures at the intended observable assertions:

- Committed tail retention: failed.
- Latest human revocation, reloaded branch: failed.
- Latest human revocation, retained branch: failed.
- Hook text remains nonhuman: failed.
- Completed assistant-tail revocation control: passed.

The nearby existing contracts also passed **79 tests across 3 files**:

```sh
pnpm --dir src test core/task/__tests__/subagent-followup.spec.ts core/agent/__tests__/requestWorkClass.spec.ts core/agent/__tests__/independentTaskAuthorization.spec.ts --maxWorkers=1
```

Node was `24.21.0`; pnpm was `11.24.0`; Vitest was `3.2.4`. The first sandboxed test attempt hit `EPERM` resolving `src`;
the same focused command ran after narrow execution escalation. Formatting of the new test passed using the installed
Prettier binary. No dependency manifest or lockfile change was observed. The audit intentionally leaves failing
reproductions for a fixer and does not claim that a fix, extension typecheck, exact-host test, or full gate passed.

## Boundaries and remaining uncertainty

Managed-owner recovery was inspected: active records without a live owner become interrupted, and wait-channel claims
retain their receipt for reconciliation. Scheduled recovery deliberately marks runs owned by a dead service as failed;
automatic re-execution is not implied and was not proposed. No additional confirmed defect was established in those
paths during this pass. Known root-limit deletion and cumulative-spend work was left to its existing owners.

The new tests use an in-memory JSON persistence adapter and bypass the outer task-loop engine to stop precisely before
provider dispatch. They do not simulate a real extension-process crash, make network requests, or exercise the full UI.
Production resume, history overwrite, input persistence, and authority extraction are exercised directly. The findings
are bounded to those demonstrated contracts; this report does not claim complete coverage of background scheduling,
managed recovery, all provider replay formats, or VS Code 1.125.0 integration.
