# VS Code LM long-thread remediation plan

## Description

Fix the confirmed extension defects that allow context preparation to take minutes, stop productive repository inspection as stagnant, and apply inconsistent request deadlines/retry limits. Also investigate and fix the command-mutation observation and verification failures documented in the user's screenshots, preserving legitimate validation gates. Implement and verify the complete change with subagents. The coordinating thread must run **GPT-5.6 Sol (`gpt-5.6-sol`) with `max` reasoning**; subagents should inherit its model and reasoning unless a concrete need requires a user-authorized alternative.

The intended result is an extension that handles long search/read/command sequences with bounded preparation time, prompt cancellation, accurate progress accounting, and a clear, resumable failure boundary. Preserve verification requirements for actual edits, all approval and workspace controls, and exact **VS Code 1.122.1** compatibility.

## Context

The user reported that VS Code LM searches and reads many files, then appears to spend an excessive time in an API request before timing out and failing. Longer search/command sequences also produce an incomplete/unverifiable error. These incidents predate the recent audit remediation.

Read [the investigation](vscode-lm-long-thread-investigation-2026-09-04.md) and [the audit remediation report](extension-agent-loop-bug-audit-2026-09-04.md). Verify their claims against the current implementation. The screenshots below establish two real verification failure messages and their models; the separate long API timeout still lacks an exact incident record. Do not claim that a synthetic reproduction conclusively diagnoses every reported incident.

The investigated baseline is commit `3db2023916621cd74f55ac614499c98e63b2764a` on `codex/fix-command-verification`, plus the uncommitted audit fixes and root `AGENTS.md`. A separate baseline snapshot accompanies the launch so the implementation can run in an isolated worktree without losing those fixes or editing the original checkout.

Six temporary offline probes established:

1. `countContextTokens` over 120 messages plus prompt overhead makes 121 sequential provider tokenizer calls. With the existing five-second timeout on every stalled VS Code count, this standalone operation takes 605 seconds of simulated time before any generation request. The outer Task timeout can expire first.
2. Context counting continues after its supplied caller signal is cancelled.
3. The VS Code adapter accepts a result after `metadata.deadline`; it currently applies independent admission/read timeouts without enforcing that absolute deadline.
4. Twelve distinct successful shell inspections stop through the real `Task.recordToolCallForStopping` and `ToolRepetitionDetector`, when workspace state is unchanged and no validation evidence exists.
5. Forty distinct successful `read_file` calls continue under the same policy.
6. A first 600-second failure already exceeds `AgentRetryPolicy`'s default 90-second elapsed allowance.

The existing provider, repetition, recent-tail, and retry tests passed: 133 tests across four files. The temporary probes were removed because they asserted the defective behavior. Recreate them as regressions that fail before the relevant fix and assert the intended contract afterward.

The current audit changes improve stopped-turn recovery and reject unsuccessful summaries. They do not resolve these additional gaps. The `incomplete and unverified` wording can also arise from legitimate missing validation or an explicit blocked outcome; preserve those distinctions.

### User-provided screenshot evidence

Both screenshots show extension **2.1.22**, provider **vscode-lm**, during long terminal work planning an implementation:

| Screenshot timestamp (UTC) | Model selector                                   | Error                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-04T22:14:53.516Z   | `copilot/gpt-5.6-sol/gpt-5.6-sol/gpt-5.6-sol`    | `Task remains incomplete and unverified because command mutations could not be fully observed.`                                                                                                                          |
| 2026-09-04T20:51:46.839Z   | `copilot/gpt-5.6-luna/gpt-5.6-luna/gpt-5.6-luna` | Completion rejected because one applied primary change set covering **two files** awaits parent verification and needs a supported check covering the changed files. The message requests `verification.change_set_ids`. |

The second screenshot identifies change set `primary-change:01a06e1e-9364-7445-aac7-cf826a735463`. Use it only to correlate relevant local evidence, if available; the screenshot does not identify the two changed paths, commands, or why the check was missing.

The first exact error comes from the catch around the terminal-exit mutation receipt in `ExecuteCommandTool.ts`. That catch covers post-command snapshot capture, comparison, ledger recording/release, and completion bookkeeping, so it does not prove that the command itself mutated files or that snapshot capture alone failed. Identify the actual failing phase and preserve its cause. Trace `captureWorkspaceMutationState`/`compareWorkspaceMutationState` in `VerificationScope.ts`, the primary ledger, and command lifecycle ordering. Cover large/dirty repositories, long-running commands, concurrent external changes, changed/deleted paths, observation limits, and receipt persistence failures as relevant.

The second error is a primary-task verification obligation, not proof that a subagent was involved. Investigate which files/versions created the debt, supported checks for those file kinds (including plan/prose files), command-to-change-set binding, and whether genuinely successful checks are being rejected or never attempted. Repair false debt or lost evidence when demonstrated; retain a clear, recoverable blocked outcome for actual missing or unknowable validation. These screenshot cases are distinct from the synthetic stagnation reproduction.

## Scope and constraints

- Read the snapshot's root `AGENTS.md` and applicable nested instructions before implementation. Preserve all baseline changes and unrelated work.
- Use the existing execution kernel, context-management flow, tool scheduler, repetition detector, cancellation helpers, and lifecycle events. Do not introduce a parallel task engine or bypass policy with prompt instructions.
- Keep `apps/cli/` and `packages/vscode-shim/` unchanged. Report any protected-consumer incompatibility rather than modifying them.
- Maintain backward-compatible API/persistence readers and provider-neutral execution policy. Prefer additive, optional internal controls where interfaces must evolve.
- Preserve tool call/result pairs, call IDs, terminal statuses, reasoning/provider state, conservative media accounting, original transcript records, and exact retained recent history.
- Keep work in the implementation worktree. The source checkout is read-only to that thread. Do not deploy, install a VSIX into the user's editor, push, or merge as part of this request.
- Use pnpm 10.8.1 and Node 20.19.2. Avoid dependency/version/lockfile churn. Format only touched files. Localize any new visible strings and verify their consumers.

## Execution plan and subagent assignments

### 1. Establish the baseline and common contracts

The coordinating agent imports and verifies the supplied source snapshot in its clean isolated worktree. Verify the recorded commit, patch, and file hashes, then retain a baseline manifest/diff so inherited audit work is distinguished from this remediation. Do not reset or overwrite another thread's work.

Reproduce the six scenarios with deterministic fixtures. Record the pre-change counts and simulated timings before optimizing. Inspect the common API token-count interface, Task preflight, compaction, command receipts, progress fingerprints, and VS Code adapter cancellation.

Agree narrow contracts for operation-scoped token-count controls and trusted exploration observations before agents edit shared call sites. The coordinator owns `src/core/task/Task.ts`, shared interface changes, and final integration. Allocate files explicitly and resolve overlap before writing.

### 2. Delegate three bounded implementation workstreams

Use the multi-agent tools to spawn subagents; do not create more user-owned Codex threads. Run independent work concurrently within available limits. All agents must return their changes, tests, and residual concerns for coordinator review.

| Subagent             | Description and owned surface                                                                                                                                                                     | Required outcomes                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context preparation  | Context-counting/compaction helpers and focused tests in `src/core/condense/` and `src/core/context-management/`. Coordinate API/provider changes with the coordinator and provider agent.        | One aggregate tokenizer-wait allowance; cancellation/deadline propagation; conservative fallback after a stall; reuse immutable counts; remove duplicate newest-message counts; preserve compaction safety. |
| Exploration progress | Existing progress observation/classification, repetition detector, command evidence adapters, and focused tool/scheduler tests. Coordinator integrates changes in `Task.ts`.                      | Supported successful shell inspection earns exploration credit; repeated/no-op/failed outcomes remain bounded; inspection credit never becomes verification credit or wider command authority.              |
| Provider deadlines   | `src/api/providers/vscode-lm.ts`, shared stream/timeout helpers where necessary, retry-policy tests, and provider regressions. Own provider-side token-count hooks agreed with the context agent. | Honor caller deadlines during admission/streaming/model acquisition; preserve cancellation causes; release resources; enforce coherent bounded retry behavior; healthy follow-up requests after failures.   |

The coordinator continues useful integration work while agents run, reviews every result, resolves conflicts, and owns end-to-end validation. After integration, assign an available agent a bounded independent review of cancellation, stale writes, transcript integrity, and false progress/verification credit; address actionable findings before completion.

The coordinator initially owns the screenshot-driven mutation-observation and verification-debt investigation alongside integration. Coordinate `ExecuteCommandTool.ts` ownership with the exploration agent. As a subagent slot becomes available, delegate the bounded receipt/debt repair or its independent verification so the screenshots are fully addressed without overfilling concurrency or colliding on shared files.

### 3. Bound context preparation

Reuse one operation context across threshold estimation, compaction selection, resulting-context measurement, and environment refresh when they belong to the same preparation. Use a shared maximum remote tokenizer-wait allowance, initially no greater than the existing five-second individual count cap. Once exhausted, continue text budgeting with conservative local estimates rather than repeatedly contacting a stalled tokenizer. Local work may scale with input size; remote waiting must not scale with message count.

Cancellation is terminal for the operation and must not be converted into a successful estimate. Remove listeners/timers, avoid late commits after timeout/resume, and preserve image/opaque-state accounting. Reuse counts with correct content/model identity and bounded retention. Do not introduce unbounded parallel tokenizer requests.

### 4. Correct exploration accounting

Pass trusted observations through the existing command execution and scheduler boundaries. Recognize supported repository inspection independently of the tool name used to perform it. Keep command approval, read/mutation classification, and verification debt authoritative at their existing boundaries.

A genuinely new supported inspection can sustain progress. Merely changing command spelling, printing fresh timestamps, or repeating unchanged evidence must not evade the bounded detector. Existing failed checks, repeated edits returning to prior states, polling, and explicit user-guidance resets retain their intended behavior.

### 5. Unify deadlines, retries, and diagnosis

Use the existing linked-abort helpers to enforce `metadata.deadline` throughout the VS Code request. Coordinate Task/compaction ownership so a timeout cancels the intended operation, retains an actionable timeout cause, and cannot cancel a newer request. Distinguish time spent preparing context, summarizing, waiting for first output, and waiting during streaming.

Make retry semantics deliberate: a permitted safe retry must have a defined remaining budget, while exhausted or semantically non-replayable requests suspend/fail with a usable recovery boundary. Do not solve this by indiscriminately increasing timeout limits or replaying accepted tool effects. Document any deliberate timeout/retry compatibility change and test it.

Add bounded timing/phase/stop-reason evidence through existing event contracts. Record counts and identifiers instead of prompts, command output, or credentials. Any UI adaptation must project canonical state and be localized.

## Success criteria

The screenshot cases are mandatory acceptance scenarios: supported inspection during planning must not invent mutation debt or report an observation error for an unrelated bookkeeping failure; genuine observation failure must retain its cause and safe recovery. A real two-file primary change set can complete after a supported current scoped check, including relevant non-code file types, and remains blocked when that evidence is actually missing. Cover receipt finalization, verification-ID binding, failure diagnostics, retries/resume, and concurrent external edits with deterministic tests. No fix may simply erase unresolved scope or mark unknown mutations verified.

| Area                      | Acceptance criteria                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preparation latency       | The 120-message stalled-tokenizer fixture no longer waits 605 seconds. Aggregate remote tokenizer waiting stays within one explicit allowance of at most 5,000 ms; test larger histories to prove the wait does not grow per message. Record the same-workload before/after token-call count, simulated time, and retained-context result. |
| Cancellation              | Cancelling during counting, recent-tail selection, summary generation, model selection, or streaming settles the owning operation without waiting for its configured long timeout. Fake-timer/control-promise tests prove no further provider calls or late context commits and no leaked owned timers/listeners.                          |
| Counting correctness      | Healthy provider counts remain usable; fallback is conservative and nonzero where appropriate. Images, schemas, changed model/content, opaque state, summaries, and reused counts cannot cause unsafe undercounting or stale cache hits.                                                                                                   |
| Productive exploration    | At least 40 distinct supported successful shell inspections continue, matching the dedicated-read control, without requiring workspace edits or validation debt. Scope and fresh evidence are tested rather than trusting arbitrary command output.                                                                                        |
| Bounded stagnation        | Repeated and alternating unchanged inspections, failed checks, no-op commands, timestamp-only output, and previously observed edit states still trigger a bounded strategy change/stop. Real progress and explicit user guidance reset only the intended counters.                                                                         |
| Verification integrity    | Exploration credit cannot satisfy applied-change verification, erase failed checks, or complete tasks with running commands, unresolved mutation receipts, or missing evidence. Both text and explicit completion paths remain consistent.                                                                                                 |
| Deadline/retry behavior   | A 100 ms absolute deadline rejects the mocked 1,000 ms result. Periodic chunks cannot extend it. Disabled/default timeout semantics are explicit and covered; timeout causes remain distinguishable from user cancellation; retries remain bounded and avoid replaying semantic output/effects.                                            |
| Recovery and persistence  | Foreground/background tasks resume correctly after timeout, cancellation, and legitimate unverified suspension. Exactly one terminal tool result is persisted per accepted call; old requests cannot corrupt resumed/newer turns. Audit recovery regressions still pass.                                                                   |
| Compatibility and quality | Required focused tests, affected package lint/typechecks, and the exact VS Code 1.122.1 smoke gate pass. If a required gate is genuinely unavailable, document the blocker and closest lower-level results; do not claim full certification.                                                                                               |
| Reviewable delivery       | Final diff is limited to the remediation relative to the imported baseline. No protected-tree edits, unrelated/generated artifacts, secrets, or incidental lockfile changes. Update the investigation with measured results, implementation decisions, commands run, and remaining live-provider uncertainty.                              |

## Validation and delivery

Begin with the existing focused suites and expand to the changed behaviors:

```powershell
pnpm --dir src test -- api/providers/__tests__/vscode-lm.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/condense/__tests__/recent-tail.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Also run affected provider-transform, Task preflight/retry/compaction-safety, completion, persistence, scheduler, and context-management tests. Typecheck/test affected shared packages and consumers if interfaces change. Run webview tests/typecheck/lint and `node scripts/find-missing-translations.js` if visible UI or localization changes. Run managed-agent certification if its lifecycle/delegation contract changes. Follow the repository validation matrix for any broader change.

Use fake timers and controlled promises rather than arbitrary sleeps. Keep live-model observations supplemental and report the selected model/settings/sample count if available. An authenticated live model is not required to fix and verify the deterministic defects.

Finish with the implemented behavior, the measured before/after result, regression coverage, exact-host result, and any remaining risks. Complete the implementation and validation; do not stop after restating this plan.
