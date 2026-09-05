# VS Code LM long requests and incomplete tasks

Investigation date: 2026-09-04. Baseline: `3db2023916621cd74f55ac614499c98e63b2764a` plus the existing, uncommitted audit remediation. Reference host: VS Code **1.122.1**. The initial diagnostic pass changed no production behavior; the follow-up remediation described below is implemented in the isolated worktree.

Three baseline gaps can plausibly produce the reported symptoms. Deterministic probes reproduced and now cover them as regressions, but the original timeout incident has not been identified. The selected model, reasoning setting, installed extension revision, request duration, and exact error for that incident remain unknown. A bounded examination of error/status fields in 100 recent local Alpha task directories and recent extension logs did not locate a match. No conversation contents or credentials are copied into this report.

**Later evidence from the user:** two screenshots show extension 2.1.22 with VS Code LM using GPT-5.6 Sol and GPT-5.6 Luna. One reports that command mutations could not be fully observed; the other rejects completion because a primary change set affecting two files lacks a supported scoped verification check. These are confirmed verification-gate messages, distinct from the synthetic stagnation finding below. The [remediation plan](vscode-lm-long-thread-remediation-plan-2026-09-04.md) records their exact timestamps, model selectors, code paths, and required follow-up. The separate API timeout incident remains unconfirmed.

## Remediation results

| Area                      | Implemented contract                                                                                                                                                                                                                                                                                                                                          | Deterministic result                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context preparation       | One `TokenCountContext` owns a single absolute remote-tokenizer allowance of at most 5,000 ms, cancellation, conservative local fallback, and a bounded model/content-identity cache. The same context is reused across selection, summarization, truncation, and final measurement.                                                                          | The stalled 120-message fixture fell from **121 provider calls / 605,000 ms** to **1 provider call / 5,000 ms**. A 480-message fixture remains **1 call / 5,000 ms**. A caller-owned 100 ms deadline completes the same fallback boundary in **100 ms**, with no further provider calls or live timers.                                                                                  |
| VS Code LM deadlines      | One caller deadline now covers model selection, request admission, the first response chunk, and the remaining stream. The adapter preserves phase-specific deadline errors, cancels its request token, closes abandoned iterators, and evicts an abandoned model-selection promise.                                                                          | A result scheduled for 1,000 ms is rejected at a 100 ms deadline. Periodic chunks cannot extend the total deadline, late model-selection results are ignored, and a healthy follow-up request succeeds.                                                                                                                                                                                  |
| Retry ownership           | The existing configurable first-attempt timeout remains compatible with slow reasoning models. A policy-approved automatic retry receives the remaining absolute portion of the 90-second default retry sequence; preflight, provider pacing, admission, and stream reads cannot expand it. A user-authorized manual retry starts a fresh configured attempt. | A first failure after the retry allowance is terminal instead of being replayed. Short failures pass only their remaining budget to context recovery and the provider, while semantic output and completed effects remain non-replayable.                                                                                                                                                |
| Shell exploration         | Only the host's successful `execute_command` boundary can issue trusted progress metadata. The classifier accepts a conservative `rg --files` subset and supported read-only Git inspections, canonicalizes semantics and scope, and never treats arbitrary output as identity or verification.                                                               | **40 distinct** supported inspections continue through the real Task detector path. Repeated semantic inspections, failed/no-op commands, unsafe shell syntax, timestamp output, and forged non-command metadata remain bounded or receive no progress credit.                                                                                                                           |
| Command mutation receipts | An admitted physical execution token is settled atomically with either an exact changed-file receipt, an explicit unknown-scope receipt, or a proven no-op release. Observation, receipt-persistence, lifecycle, and output-bookkeeping failures retain separate typed causes. Unknown scope remains durable blocking debt after reload.                      | Exact changed receipts are never released as no-ops; mismatched and concurrent tokens are rejected without partial settlement. Capture/compare failure records unknown debt under the same token. A two-file Markdown change set remains blocked without evidence, accepts a current targeted Prettier check bound to its exact change-set ID, and rejects stale or mismatched evidence. |

The remediation does not turn exploration into validation: a shell inspection can justify another planning step but cannot satisfy an applied-change obligation. Completion still rejects running commands, unresolved mutation receipts, stale file versions, missing scoped evidence, and explicit blocked outcomes.

No authenticated live-model reproduction was available. In VS Code 1.122.1, `selectChatModels` itself has no per-call cancellation token; an expired caller therefore detaches from and evicts the shared pending selection, and any late fulfillment is absorbed rather than committed. Provider-side latency beyond that host boundary remains a residual live-environment uncertainty.

## Findings and evidence

| Finding                                           | Reproduction against current code                                                                                                                                                                                                                                        | Implication                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Aggregate token-counting delay is not bounded     | A 120-message history plus prompt overhead made **121 sequential tokenizer calls**. With every VS Code tokenizer call stalling until its existing five-second fallback, the standalone count pass took **605 seconds of simulated time**, without calling `sendRequest`. | Long history can spend minutes preparing context. An outer request timeout can expire before preparation finishes. |
| VS Code LM ignores the supplied absolute deadline | `createMessage` received a deadline 100 ms away; a mocked response arriving at 1,000 ms was accepted.                                                                                                                                                                    | Individual wait timeouts do not enforce the caller's total request budget.                                         |
| Shell exploration is counted as stagnation        | The real `Task.recordToolCallForStopping` stopped after **12 distinct successful `rg --files` inspections**, with unchanged workspace state and no validation debt. A control sequence of **40 distinct `read_file` calls** did not stop.                                | The tool used to inspect the repository can determine whether useful exploration is stopped.                       |

Two additional probes confirmed that counting continued after caller cancellation, and that the default 600-second request timeout already exceeds the automatic retry policy's 90-second elapsed budget. These explain delayed stopping and the absence of automatic recovery after a sufficiently long first attempt; they do not establish the original incident's cause.

### 1. Token counting can consume the apparent API request

The owning code is [countHistoryTokens/countContextTokens](../src/core/condense/index.ts), the [VS Code LM tokenizer adapter](../src/api/providers/vscode-lm.ts), and [Task preflight](../src/core/task/Task.ts).

`countHistoryTokens` awaits `apiHandler.countTokens` once per message. `countContextTokens` adds a separate prompt/tool-schema count. The VS Code adapter bounds each individual count at five seconds, then estimates locally. It has no operation-wide allowance or mechanism to stop attempting the same stalled tokenizer for every remaining message.

Compaction selects and counts a recent tail, counts its resulting context, and Task remeasures after refreshing the environment. These calls can revisit the same content. Even an ordinary step counts the newest message once to decide whether to display the compaction indicator and again inside `manageContext`.

`countContextTokens` accepts metadata but does not enforce its signal/deadline or pass them into `countHistoryTokens`. The cancellation probe aborted after 100 ms; all three tokenizer calls still ran to their fallback, completing at 15 seconds. Higher-level checks can notice cancellation afterward, but that does not interrupt the count already running.

Task emits `api_req_started` before running this preflight. Therefore a long visible API request is not proof that the generation service spent all that time thinking. The **605-second measurement is a standalone count-pass reproduction**, not a live end-to-end request measurement: Task's outer 600-second wait can expire earlier.

Remediation applied:

- Give one context-preparation operation a shared cancellation signal and a short, explicit tokenizer budget. Stop work promptly on cancellation.
- After a tokenizer stall, use conservative local text estimates for the remainder of that operation. Preserve the existing conservative treatment of images and account for schemas, message envelopes, and opaque provider state.
- Reuse counts within the operation and pass the already measured newest-message count into context management. Key any longer-lived cache by model identity and immutable content, with a bounded size and explicit invalidation.
- Preserve whole tool transactions, the exact retained tail, and backward-compatible saved history. Do not solve latency by silently discarding history or undercounting media.

The fixed allowance was verified against the same 120-message workload and a 480-message scale-up. Healthy tokenizers, changed content and models, images, schemas, opaque provider state, exact tool transactions, and compaction fallback have dedicated coverage.

### 2. Request timeouts have inconsistent ownership

At the baseline, [timeout-config.ts](../src/api/providers/utils/timeout-config.ts) defaults to 600 seconds. The VS Code adapter applied this duration separately to request admission and successive stream reads. It bridged `metadata.signal` into a VS Code cancellation token but never read `metadata.deadline`.

The shared [stream helpers](../src/api/transform/stream.ts) already provide `createLinkedAbortController` and `ApiStreamDeadlineError`. Task constructs absolute deadlines for generation and compaction, so this adapter is missing an existing contract rather than needing a second timeout framework.

The [retry policy](../src/core/agent/AgentRetryPolicy.ts) allows 90 seconds of elapsed time by default. At a 600-second first-attempt failure, its decision is `elapsed-budget` and it declines automatic retry. This is a configuration/behavior interaction, not evidence of an unlimited retry loop. A response that already produced semantic output has additional replay restrictions that must remain intact.

Remediation applied:

- Enforce the supplied deadline using the shared linked controller at the VS Code adapter boundary, including model acquisition and all stream reads. Preserve the timeout cause rather than mislabeling it as a user cancellation.
- Give preflight/compaction explicit ownership of their own operation budget and cancellation. Make abandoned operations incapable of committing late results into a resumed turn.
- Distinguish total deadline, time awaiting first model output, and stream inactivity in diagnostics. Choose any new timeout defaults using recorded workloads, including slow reasoning models.
- Reconcile the automatic retry allowance with the chosen attempt policy. Permit bounded retries only when safe; do not blindly replay completed tool effects or partial semantic responses.

Regression cases should cover a stalled request, periodic stream output beyond the absolute deadline, cancellation during model selection and token counting, a summary deadline, and a healthy follow-up request after each failure. Run the exact-host gate after implementation.

### 3. Productive shell inspection can trigger the no-progress stop

[Task.recordToolCallForStopping](../src/core/task/Task.ts) treats five named inspection tools as reads. It treats every `execute_command` as a check and ignores the optional command category and scheduler result supplied to it. Its fingerprints come from the verification ledger through [ClineProvider.getVerificationProgressState](../src/core/webview/ClineProvider.ts).

[ToolRepetitionDetector](../src/core/tools/ToolRepetitionDetector.ts) accepts novel, successful, scoped reads as progress. For a command, however, a new command and useful new information are insufficient without a changed state/evidence fingerprint. With the normal limit of three, it warns after six stagnant outcomes and stops after twelve. The diagnostic used the real Task classification and detector, substituting completed command outcomes and a stable empty verification ledger; it did not execute shell commands.

Remediation applied:

- Carry trusted command-observation metadata through the existing execution/scheduler path so successful, supported repository inspection can count as exploration.
- Keep exploration progress separate from proof that edited files were validated. Learning something can justify another step without satisfying completion obligations.
- Retain bounded repeated-result detection. Changing arbitrary command text or printing a timestamp must not reset the window indefinitely. Use supported command semantics and bounded, scoped observations rather than treating every successful command as progress.
- Do not relax command approval, mutation classification, or workspace scope to obtain progress credit. Centralize the rule in the existing progress path.

Regression coverage now compares dedicated reads with shell inspection, repeated and alternating unchanged inspection, failed commands, no-op commands, real mutation/evidence changes, cancellation, and reset after user guidance.

## What “incomplete and unverified” means

There are multiple sources of similar wording:

- A no-progress stop says repeated tool outcomes produced no new state or verification evidence.
- `getCompletionGateDecision` rejects completion with running commands, unavailable durable state, or outstanding validation obligations. Three unchanged rejections can suspend the task.
- `attempt_completion` with an explicit blocked outcome also reports the task as incomplete and unverified.

Consequently this wording is not, by itself, a VS Code LM API error. A specific missing-evidence suffix can be legitimate. The shell-exploration defect is a separate way to halt useful work. Fixing either must preserve verification for actual edits and disclose precisely which condition stopped the task.

The earlier [audit remediation](extension-agent-loop-bug-audit-2026-09-04.md) repairs recovery after stopped turns and acceptance of unsuccessful summaries, among other defects. Those baseline changes improve recoverability and data integrity but did not repair the three gaps above; this follow-up remediation does.

## Implementation order used

1. Bound and cancel context preparation; remove duplicate counts. This directly addresses waiting that grows with thread length.
2. Recognize supported shell exploration in progress accounting, while retaining repetition controls and the completion verification gate.
3. Enforce VS Code LM deadlines and align retry behavior. Add phase timing and clear stop reasons through existing request/lifecycle events.

Record only bounded diagnostics: model identity, extension/host versions, request/attempt IDs, message/tool counts, estimated or reported tokens, preparation time, summary time, time to first output, last meaningful activity, timeout phase, retry category, and stop reason. Do not record raw prompts, tool output, or secrets. These measurements will distinguish remaining provider-side stalls from local preparation delays.

## Initial investigation validation

The following command passed **133 tests in four files** using Node 20.19.2 and pnpm 10.8.1:

```powershell
pnpm --dir src test -- api/providers/__tests__/vscode-lm.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/condense/__tests__/recent-tail.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts
```

Six additional temporary Vitest probes passed against the current implementation: shell inspection stop, dedicated-read control, aggregate tokenizer stall, post-cancellation counting, ignored deadline, and retry exhaustion. Timed probes used fake timers, and provider calls used offline mocks. The initial probe run exposed two fixture setup errors; after correcting those fixtures, all six reproduced the documented behavior. The temporary file was removed because its assertions describe existing defects rather than the desired regression contract.

The initial investigation changed no production code and did not run a live model or VS Code 1.122.1 smoke.

## Completed remediation validation

Validation used Node 20.19.2 and pnpm 10.8.1. Focused, overlapping regression groups passed as follows:

| Surface                                       | Result                   |
| --------------------------------------------- | ------------------------ |
| Mandatory four-file remediation gate          | 151 tests passed         |
| Context preparation and compaction            | 282 tests in 12 files    |
| Provider deadlines, retry policy, and Task    | 346 tests in 5 files     |
| Exploration, receipts, and completion         | 201 tests in 10 files    |
| Post-review cleanup rerun                     | 114 tests in 3 files     |
| Full source suite with `--maxWorkers=2`       | 7,632 passed, 42 skipped |
| Exact failed-file concurrency-control rerun   | 267 tests in 4 files     |
| VS Code 1.122.1 extension and mode smoke      | 4 tests passed           |
| VS Code 1.122.1 Language Model contract       | 4 tests passed           |
| VS Code 1.122.1 managed-agent host acceptance | 1 end-to-end test passed |

Both source and workspace-wide type checks and lint passed. The ordinary root `pnpm test` completed 10 of 11 package tasks; its source-package task produced five resource-contention failures in four files under unrestricted worker parallelism. Those four files then passed 267/267 with one worker, and the complete 507-file source suite passed with two workers: 504 files passed, 3 platform-specific files skipped, and no failures.

`pnpm certify:managed-agents:automated` completed its deterministic matrix with **26 pass / 8 integration-pending** and `PASS-DETERMINISTIC`. The wrapper then encountered a pre-test Windows launcher limitation: the pinned `@vscode/test-electron` version starts VS Code through `shell: true` without quoting extension paths, so the spaced checkout path was split at `C:\Users\Luke`. The same already-built runner was invoked through a temporary no-space junction with Node's main-module symlink preservation. On the exact downloaded VS Code 1.122.1 binary, the managed-agent host acceptance passed, followed by the three files from `test:smoke:1221` (extension, modes, and VS Code LM contract). No product or test assertion failed in those exact-host runs. The literal package wrapper remains unavailable from this spaced checkout, so this report does not claim that wrapper command itself exited successfully.

The final remediation delta contains 49 files relative to the preserved imported baseline. Its exact-path Prettier check and snapshot-aware whitespace/conflict check passed. `apps/cli/`, `packages/vscode-shim/`, package manifests, and the lockfile are unchanged. The read-only source checkout remains on `codex/fix-command-verification` at `3db2023916621cd74f55ac614499c98e63b2764a`; all 42 captured dirty/untracked paths and hashes still match the snapshot manifest, as does the saved baseline patch hash.

All 18 backend `common.json` catalogs contain the three new receipt/debt messages. The repository-wide missing-translation script still exits 1 because of pre-existing frontend/package translation debt; the source checkout produces the same 2,166-line output byte-for-byte, with 17 backend locales reporting no missing translations.

No live authenticated model was used. The VS Code LM fixture and direct boundary tests therefore establish host-contract, cancellation, recovery, and deadline behavior without making a claim about live provider latency.

## Primary reference

The [official VS Code Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model), retrieved 2026-09-04, describes caller-built prompts, cancellation tokens, and separate failures during request admission and response streaming. It supports distinguishing these phases; it does not establish the cause of this incident or prescribe Alpha's timeout defaults. No newer VS Code API is proposed here.
