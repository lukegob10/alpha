# NOR-24: exact recent context through compaction

Implementation baseline: `678baf4440c9cad4a5f40aa6142ad12b98ca0b17` (completed Stage 1).
Worktree branch: `codex/nor-24-recent-context-compaction`.
Review mode: bounded performance optimization. This record covers extension compaction and its lifecycle integration,
not a repository-wide audit or a live-model quality evaluation.

## Verified starting behavior

At the Stage 1 baseline, `summarizeConversation` summarizes every active message, tags all prior records, and appends a
user-role summary. `getEffectiveApiHistory` activates only that summary and subsequent messages. Original records stay
recoverable but precise recent tool evidence is absent from the next model request. Fractional truncation preserves
individual call/result pairs, but its active-token accounting can include older hidden summaries/history.

Manual compaction excludes another compaction, but not a running task/scheduler. Flushing the current result buffer does
not prove that a still-running tool has completed. A controlled scheduler barrier test reproduced compaction during an
unfinished tool transaction and stale summary writeback after history changed.

## Implementation contract

- The recent tail is a contiguous suffix of complete logical steps. A user prompt stays with its assistant response and
  terminal tool results; assistant continuation steps can begin after completed tool results. Multiple calls, separate
  result messages, and consecutive assistant reasoning records cannot be cut apart.
- `recentTailTokenBudget` configures the module policy. Its default is the smaller of 16,384 tokens and 25% of the input
  target. `maxContextTokens` is the full input target, including system text, tools, summary and retained messages.
  The default target is the existing 75% of usable model context after the output reservation.
  This is a conservative policy default, not a benchmark-derived optimum.
- Token estimates include opaque content blocks, top-level provider state, reasoning signatures and message role
  envelopes. Bookkeeping timestamps, summary IDs and hiding tags are excluded. Provider-native wire overhead may differ;
  the configured counters and provider error recovery remain the accounting contract.
- Only the older active prefix is sent for summarization. Its tool blocks become text in the summarization request, with
  tool selection disabled. Retained records keep their roles, contents, IDs, ordering and arbitrary provider fields.
- The new summary is inserted before the retained original tail. Summarized records remain in their original order and
  gain hiding tags; original tail objects are reused. No transcript schema or saved-task migration is introduced.
- Summary timestamps are newer than every existing record, even though physical insertion precedes the tail. Timestamp
  rewind removes the later-created summary and restores surviving originals. The orchestrator owns the coordinated
  MessageManager change that ignores generated boundaries when finding an approximate user rewind target.
- Repeated compaction summarizes the prior summary and newly superseded steps. If only the previous summary would be
  summarized again, it reports exhaustion without another summary request.
- A sole complete step that fits the tail budget stays intact: there is no older prefix to summarize.
- If the newest complete step exceeds the exact-tail budget, the entire active conversation is summarized and the
  generated summary explicitly records that the exact tail did not fit. Original tool statuses/results remain saved.
  There is no individual output clipping or superseded-output pruning.
- If the generated summary plus retained tail exceeds the input budget, the original history is returned unchanged.
  Automatic recovery makes one bounded truncation attempt: preserve the first complete step and a recent complete
  suffix, hiding older complete steps until the input target is met. An impossible minimum returns `exhausted` without
  hiding or slicing the oversized newest step. Task recovery treats exhaustion as non-retryable.
- Forced provider-overflow recovery bypasses local trigger estimates explicitly. It must produce a changed bounded
  history or exhaustion, including when the local tokenizer underestimated a provider's rejected request.
- Incomplete transactions are not compacted and do not receive synthetic successful results. Existing explicit legacy
  repair helpers retain their compatibility behavior. Cancellation propagates instead of falling through to truncation;
  candidates are constructed without mutating original histories.
- Manual admission rejects active task/engine/stream/external mutation work before its first await. Reciprocal admission
  checks keep provider/effect work out while manual compaction holds its existing controller. A transcript digest check
  rejects stale writeback. The queue hook runs after controller release.
- Successful Task compaction persists before resetting/refilling the environment baseline. The orchestrator owns the
  environment-refresh change to append a new user record and the history-rewrite invalidation change for rewind.
  Final Task accounting includes the refreshed record and rejects an over-budget request before provider admission.

## Primary-source comparison

Read on 2026-09-04, pinned upstream commit `5fe9ca967e7e0b983774fbe485bc965334f4d7f6`:

- [oh-my-pi compaction](https://github.com/can1357/oh-my-pi/blob/5fe9ca967e7e0b983774fbe485bc965334f4d7f6/packages/agent/src/compaction/compaction.ts),
  particularly `findValidCutPoints`, `findCutPoint`, and the older-prefix/recent-message separation.
- [oh-my-pi pruning](https://github.com/can1357/oh-my-pi/blob/5fe9ca967e7e0b983774fbe485bc965334f4d7f6/packages/agent/src/compaction/pruning.ts),
  particularly its compaction-boundary and warm-prefix guards.

Applied the behavioral ideas of bounded recent context and complete call/result boundaries. Alpha keeps its existing
Anthropic-shaped provider-neutral `ApiMessage` history and non-destructive hiding model. No vendor transcript format or
cache-sensitive in-place pruning was adopted.

## Matched fixture and validation

Toolchain: Node 20.19.2, pnpm 10.8.1. Dependencies installed with the frozen lockfile; the existing types build was needed
to prepare package entrypoints in the fresh worktree. No dependency/manifests/lockfile changes were made.

The initial narrow baseline passed 7 test files / 175 tests:

```powershell
pnpm --dir src test core/condense/__tests__/condense.spec.ts core/condense/__tests__/index.spec.ts core/condense/__tests__/nested-condense.spec.ts core/condense/__tests__/rewind-after-condense.spec.ts core/context-management/__tests__ --maxWorkers=2
```

`recent-tail-benchmark.spec.ts` uses the same long-task fixture, deterministic summary, token counter and scripted
continuation in both cases. The old prefix exceeds the configured 2,000-token tail budget; the recent constraint and
completed read contain the exact evidence needed for a subsequent answer. This measures targeted evidence loss, active
input estimates and repeated fixture reads. It does not establish a general live-model speed or quality improvement.

| Matched scenario                   | Active input estimate | Repeated reads | Continuation model rounds | Exact retained messages |
| ---------------------------------- | --------------------: | -------------: | ------------------------: | ----------------------: |
| Stage 1, isolated original module  |                    57 |              1 |                         2 |                       0 |
| Current explicit zero-tail control |                    95 |              1 |                         2 |                       0 |
| Current 2,000-token tail budget    |                   225 |              0 |                         1 |                       3 |

The Stage 1 source was loaded into a temporary isolated module from the exact baseline commit for the measurement;
the main implementation was not reset or overwritten. Every active-token measurement, including Stage 1's 57, was
recomputed from the returned active history using the same canonical counter; these are not a comparison of different
historical `newContextTokens` implementations. The fake provider has a 128,000-token window and 5,000-token output
reservation. The fixture's 51,712-token original input fits its available 123,000-token input budget. Summary requests
measure 53,185 tokens for Stage 1/zero-tail and 53,094 for the bounded tail, also within that provider window.
The current zero-tail control costs 38 additional estimated
tokens because it includes the explicit tail-budget fallback notice. The retained tail costs 168 estimated tokens.
Both compared runs make one summary-provider call; the table counts subsequent continuation calls and recovery reads.
The scripted continuation actually records requests, executes its read stub if evidence is missing, and takes a second
round to consume that result. These are deterministic fixture results, not estimates of production model behavior.

Reproduce the current matched controls with:

```powershell
pnpm --dir src test core/condense/__tests__/recent-tail-benchmark.spec.ts --maxWorkers=2 --no-silent
```

Final local validation:

- Combined focused regression run: **20 files / 541 tests passed** with `--maxWorkers=2`.
- Condense and context-management suites: 10 files / 206 tests, including the new complete-tail, budget,
  repeated-condensation, reload, rewind, prior-summary truncation, cancellation, sole-step and forced-recovery cases.
- Anthropic, Gemini, OpenAI, Responses and VS Code LM transform suites: 5 files / 106 tests passed.
- Task safety tests reproduce scheduler-in-flight, stale-writeback, admission, cancellation and post-refresh budget
  failures using controlled promises and actual scheduler integration: 5 files / 229 tests passed. These include
  `Task.spec`, `Task.persistence`, `Task.retry-wire`, `Task.external-mutation`, and `Task.compaction-safety`.
- `pnpm --dir src lint` passed; `pnpm --dir src check-types` passed.
- Independent Sol/Max review of the main modules found no remaining blockers after the sole-step, forced-low-estimate
  and nonfinite-token fixes. The owner reviewed the delegated Task and test changes before the combined run.

The orchestrator owns the combined exact VS Code 1.122.1 smoke gate and cross-ticket persisted scheduler/provider-wire
tests. That host gate is not claimed as passed by this individual worktree. CLI, VS Code shim, versions, changelogs,
publishing and Linear closure are outside this implementation's scope.
