# VS Code LM long requests and incomplete tasks

Investigation date: 2026-09-04. Baseline: `3db2023916621cd74f55ac614499c98e63b2764a` plus the existing, uncommitted audit remediation. Reference host: VS Code **1.122.1**. This investigation changes no production behavior.

Three current-code gaps can plausibly produce the reported symptoms. Deterministic probes reproduced them, but the original incident has not been identified. The selected model, reasoning setting, installed extension revision, request duration, and exact error remain unknown. A bounded examination of error/status fields in 100 recent local Alpha task directories and recent extension logs did not locate the matching incident. No conversation contents or credentials are copied into this report.

**Later evidence from the user:** two screenshots show extension 2.1.22 with VS Code LM using GPT-5.6 Sol and GPT-5.6 Luna. One reports that command mutations could not be fully observed; the other rejects completion because a primary change set affecting two files lacks a supported scoped verification check. These are confirmed verification-gate messages, distinct from the synthetic stagnation finding below. The [remediation plan](vscode-lm-long-thread-remediation-plan-2026-09-04.md) records their exact timestamps, model selectors, code paths, and required follow-up. The separate API timeout incident remains unconfirmed.

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

Recommended repair:

- Give one context-preparation operation a shared cancellation signal and a short, explicit tokenizer budget. Stop work promptly on cancellation.
- After a tokenizer stall, use conservative local text estimates for the remainder of that operation. Preserve the existing conservative treatment of images and account for schemas, message envelopes, and opaque provider state.
- Reuse counts within the operation and pass the already measured newest-message count into context management. Key any longer-lived cache by model identity and immutable content, with a bounded size and explicit invalidation.
- Preserve whole tool transactions, the exact retained tail, and backward-compatible saved history. Do not solve latency by silently discarding history or undercounting media.

Use the same 120-message stalled-tokenizer workload as the baseline. The acceptance criterion is a fixed aggregate remote-wait allowance, independent of history length, with prompt cancellation and conservative counts. Also verify healthy tokenizers, changed content, images, provider state, and compaction fallback. No before/after improvement is claimed yet.

### 2. Request timeouts have inconsistent ownership

[timeout-config.ts](../src/api/providers/utils/timeout-config.ts) defaults to 600 seconds. The VS Code adapter applies this duration separately to request admission and successive stream reads. It bridges `metadata.signal` into a VS Code cancellation token but never reads `metadata.deadline`.

The shared [stream helpers](../src/api/transform/stream.ts) already provide `createLinkedAbortController` and `ApiStreamDeadlineError`. Task constructs absolute deadlines for generation and compaction, so this adapter is missing an existing contract rather than needing a second timeout framework.

The [retry policy](../src/core/agent/AgentRetryPolicy.ts) allows 90 seconds of elapsed time by default. At a 600-second first-attempt failure, its decision is `elapsed-budget` and it declines automatic retry. This is a configuration/behavior interaction, not evidence of an unlimited retry loop. A response that already produced semantic output has additional replay restrictions that must remain intact.

Recommended repair:

- Enforce the supplied deadline using the shared linked controller at the VS Code adapter boundary, including model acquisition and all stream reads. Preserve the timeout cause rather than mislabeling it as a user cancellation.
- Give preflight/compaction explicit ownership of their own operation budget and cancellation. Make abandoned operations incapable of committing late results into a resumed turn.
- Distinguish total deadline, time awaiting first model output, and stream inactivity in diagnostics. Choose any new timeout defaults using recorded workloads, including slow reasoning models.
- Reconcile the automatic retry allowance with the chosen attempt policy. Permit bounded retries only when safe; do not blindly replay completed tool effects or partial semantic responses.

Regression cases should cover a stalled request, periodic stream output beyond the absolute deadline, cancellation during model selection and token counting, a summary deadline, and a healthy follow-up request after each failure. Run the exact-host gate after implementation.

### 3. Productive shell inspection can trigger the no-progress stop

[Task.recordToolCallForStopping](../src/core/task/Task.ts) treats five named inspection tools as reads. It treats every `execute_command` as a check and ignores the optional command category and scheduler result supplied to it. Its fingerprints come from the verification ledger through [ClineProvider.getVerificationProgressState](../src/core/webview/ClineProvider.ts).

[ToolRepetitionDetector](../src/core/tools/ToolRepetitionDetector.ts) accepts novel, successful, scoped reads as progress. For a command, however, a new command and useful new information are insufficient without a changed state/evidence fingerprint. With the normal limit of three, it warns after six stagnant outcomes and stops after twelve. The diagnostic used the real Task classification and detector, substituting completed command outcomes and a stable empty verification ledger; it did not execute shell commands.

Recommended repair:

- Carry trusted command-observation metadata through the existing execution/scheduler path so successful, supported repository inspection can count as exploration.
- Keep exploration progress separate from proof that edited files were validated. Learning something can justify another step without satisfying completion obligations.
- Retain bounded repeated-result detection. Changing arbitrary command text or printing a timestamp must not reset the window indefinitely. Use supported command semantics and bounded, scoped observations rather than treating every successful command as progress.
- Do not relax command approval, mutation classification, or workspace scope to obtain progress credit. Centralize the rule in the existing progress path.

Regression coverage must compare dedicated reads with shell inspection, repeated and alternating unchanged inspection, failed commands, no-op commands, real mutation/evidence changes, cancellation, and reset after user guidance.

## What “incomplete and unverified” means

There are multiple sources of similar wording:

- A no-progress stop says repeated tool outcomes produced no new state or verification evidence.
- `getCompletionGateDecision` rejects completion with running commands, unavailable durable state, or outstanding validation obligations. Three unchanged rejections can suspend the task.
- `attempt_completion` with an explicit blocked outcome also reports the task as incomplete and unverified.

Consequently this wording is not, by itself, a VS Code LM API error. A specific missing-evidence suffix can be legitimate. The shell-exploration defect is a separate way to halt useful work. Fixing either must preserve verification for actual edits and disclose precisely which condition stopped the task.

The recent [audit remediation](extension-agent-loop-bug-audit-2026-09-04.md) repairs recovery after stopped turns and acceptance of unsuccessful summaries, among other defects. Those changes improve recoverability and data integrity, but they do not repair the three gaps above. The reproduced gaps remain present with that remediation applied.

## Proposed implementation order

1. Bound and cancel context preparation; remove duplicate counts. This directly addresses waiting that grows with thread length.
2. Recognize supported shell exploration in progress accounting, while retaining repetition controls and the completion verification gate.
3. Enforce VS Code LM deadlines and align retry behavior. Add phase timing and clear stop reasons through existing request/lifecycle events.

Record only bounded diagnostics: model identity, extension/host versions, request/attempt IDs, message/tool counts, estimated or reported tokens, preparation time, summary time, time to first output, last meaningful activity, timeout phase, retry category, and stop reason. Do not record raw prompts, tool output, or secrets. These measurements will distinguish remaining provider-side stalls from local preparation delays.

## Validation performed

The following command passed **133 tests in four files** using Node 20.19.2 and pnpm 10.8.1:

```powershell
pnpm --dir src test -- api/providers/__tests__/vscode-lm.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/condense/__tests__/recent-tail.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts
```

Six additional temporary Vitest probes passed against the current implementation: shell inspection stop, dedicated-read control, aggregate tokenizer stall, post-cancellation counting, ignored deadline, and retry exhaustion. Timed probes used fake timers, and provider calls used offline mocks. The initial probe run exposed two fixture setup errors; after correcting those fixtures, all six reproduced the documented behavior. The temporary file was removed because its assertions describe existing defects rather than the desired regression contract.

No production code was changed. No live model reproduction, throughput benchmark, or VS Code 1.122.1 smoke run was performed for this investigation. Implementation will require the affected provider/transform, context, cancellation, retry, and Task tests; extension lint/typecheck; and:

```powershell
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

## Primary reference

The [official VS Code Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model), retrieved 2026-09-04, describes caller-built prompts, cancellation tokens, and separate failures during request admission and response streaming. It supports distinguishing these phases; it does not establish the cause of this incident or prescribe Alpha's timeout defaults. No newer VS Code API is proposed here.
