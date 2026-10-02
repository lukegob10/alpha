# Core loop and providers — READY

**READY / FROZEN.** All owned source/test edits are locally verified and frozen. Final `pnpm --dir src check-types`
passed; focused lint across all 17 touched TypeScript files passed; scoped final diff check passed. The coordinator
owns frozen-source builds, exact VS Code 1.125.0 smoke/affected-host gates, and managed certification. No cross-lane
production repair is pending from this lane. This status does not assert complete provider parity or live-model quality.

Mode: **full-surface review**. This lane preserves the extensive dirty-checkout baseline and fixes proven bounded
defects in the native TypeScript harness. READY means locally verified and frozen for coordinator integration;
it will not claim final VS Code 1.125.0, certification, packaging, or live-provider gates.

Reference: official Codex CLI commit `cb6da58876afed3ede0ab11084f67dd5394ecb48`, read through `git show` from the shared
read-only reference checkout. Review date: October 1, 2026 America/New_York / October 2 UTC. Applied the
`clean-code-review` skill and change-safety, JavaScript, testing, comprehensive audit, end-state, and performance
references. The shared baseline inventory is the audit map; individual reviewed coverage is recorded below.

## Ownership and coverage

Three collaboration subagents have exclusive source/test ownership: turn/step kernel and canonical accumulator;
provider adapters/transforms and assistant-message normalization; managed delegation/control/lifecycle modules.
The lane parent owns Task.ts, existing Task tests, and Task helpers. Tool policy/scheduling exceptions, UX,
persistence/context, packages, and shared gates remain with their named owners. No resets, staging, commits, or
baseline overwrites were performed.

| Surface                                                           | Status           | Evidence / remaining coverage                                           |
| ----------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| Task staged host, completion, retry, steering, retained lifecycle | reviewed, edited | 394 focused cases passed                                                |
| Tool-result repair and Task persistence callers                   | reviewed, edited | Two fail-before identity regressions; 44 tests across four files passed |
| Turn engine, StepContext, canonical response accumulation         | reviewed, edited | 96 focused cases passed; 47 rerun after fixture repair                  |
| Provider Responses identity and terminal normalization            | reviewed, edited | 527 focused cases passed across 14 files                                |
| Managed delegation, envelopes, admission/lifecycle                | reviewed, edited | 162 cases plus 84 additional command cases (3 overlap) passed           |
| Exact host, live providers, reload across real host restart       | not verified     | Coordinator owns serialized integration gates                           |
| Sandbox architecture, standalone runtime, manifests/packages      | out of scope     | Preserved existing Alpha protections and architecture                   |

## Findings and closure

### High / must-fix — tool-result identity overwritten by orphan repair

**Fixed now.** `validateAndFixToolResultIds` repaired an earlier orphan by position before considering a later receipt
whose ID already matched the accepted call. That could replace the current failure with stale success text, or relabel
the current result as a different call. Task history addition, pending-result flush, and legacy-parent history repair
all call this shared owner. Reserve every identified receipt before applying positional legacy repair; keep status,
content, ordering, deduplication, and missing-result error placeholders.

Fail-before: `pnpm --dir src test core/task/__tests__/core-tool-result-identity.spec.ts` produced exactly two failures
and one passing out-of-order characterization. The failure showed `Current command failed` / `is_error: true`
replaced by `Old command succeeded`. After the owner repair, the new tests plus validator, pending-result flush, and
tool-history suites passed **44 tests in four files**. Existing legacy positional matching remains an intentional
compatibility behavior when no identified receipt owns the target ID; broader removal is a separate contract decision.

Upstream `codex-rs/core/src/tools/router.rs` preserves each `ToolCall.call_id`, and `tools/context.rs`
`function_tool_response` emits that same ID. Alpha's identified receipt takes precedence for the same reason.

### High / must-fix — Task discarded a provider continuation boundary

**Fixed now.** The generic accumulator preserved `requiresContinuation`, and the outer
Task host respected it, but Task's final outcome override replaced the outcome with status/reason/retryable only.
An ordinary visible response could therefore complete prematurely. Preserve the continuation bit through that existing
canonical finalization boundary. No extra model request is added when the provider permits completion.

Fail-before: `pnpm --dir src test core/task/__tests__/Task.spec.ts -t 'retains provider continuation through canonical stream finalization'`
failed exactly once because the real sampled response lost `requiresContinuation: true`; 279 unrelated cases skipped.
The pre-existing continuation test stubbed `runAgentRequests`, hiding this adapter failure. The new case exercises
the actual request/accumulator transaction. Upstream `session/turn.rs` carries `end_turn == Some(false)` into
`needs_follow_up`, combined with pending input before completion.

The provider audit found the same bit absent at the OpenAI Responses adapter: explicit `end_turn: false` was ignored
in streaming and non-streaming results. That adapter now emits the existing completed outcome with continuation;
absent/true retains completion behavior. Six adapter/accumulator cases produced two fail-before false cases and four
passing compatibility cases. Upstream `tests/suite/current_time_reminder.rs::current_time_reminders_can_follow_only_user_or_tool_outputs`
uses exactly this no-new-user-message continuation and asserts three requests. Task's combined final suites passed
394 cases; after adding the required outcome fixture fields, its focused continuation case passed again.

### High / must-fix — successful outcomes hid malformed tool calls

**Fixed now.** `AgentResponseAccumulator.flushPendingTools` exposed only accepted calls whenever an outcome existed,
including ordinary successful completion. Calls with malformed/nonobject arguments, missing IDs/names, or normalized
ID collisions could disappear without the existing validation running, allowing visible text to complete falsely.
Successful finalization now validates every pending call; failed/incomplete outcomes still preserve only accepted calls
for receipt reconciliation. Five deterministic fail-before cases failed; 23 pre-existing cases passed. A staged-engine
integration regression asserts response commit/release once and zero effects or continuation for the invalid stream.

### Medium / should-fix — Stop during final release reported completion

**Fixed now.** The staged engine decided completion before awaiting its host-owned release. A controlled held release
allowed cancellation in that gap but returned completed. Check Stop after release before publishing a successful outcome.
The fail-before command reported one failure and 18 passes; the regression now returns aborted and releases exactly once.
Upstream turn cancellation is checked after draining in-flight work. Alpha retains joined physical tool effects.

### High / must-fix — Responses final receipts changed executable identity

**Fixed now.** A final OpenAI Responses item could change a previously advertised call ID or tool name while retaining
the advertised ID's argument stream. A changed type could emit a new complete call before a later error. Validate type,
ID, and name against the active output index before emitting executable receipt chunks. Three deterministic fail-before
cases established ID/name silent success and type premature emission. Upstream `tools/router.rs::build_tool_call` and
`session/turn.rs` preserve item identity and ordered finalized results; Alpha keeps its provider-neutral normalization.

### High / should-fix — Vertex prompt-cache fallback replayed partial output

**Fixed now.** Anthropic Vertex's prompt-cache rejection fallback retried even after output reached the host, combining
two attempts' semantic output. Reuse its existing emitted-chunk guard before fallback. Fail-before: partial text plus
cache rejection resolved through a second attempt rather than propagating failure. The regression now asserts exactly
one request and truthful first-attempt output. A companion characterization confirms cache fallback before any output
still retries once. Upstream response retry logic and stream-error next-turn tests keep semantic output recovery separate
from replaying an untouched request.

### High / should-fix — writable child omitted its parent scope ceiling

**Fixed now.** `buildInternalTaskEnvelope` validated only listed child paths; omission under a defined parent path ceiling
produced a writable child with undefined scope. Require explicit child paths when effective mutate authority is true and
the parent supplied a ceiling. Both scoped-parent fail-before cases failed. Read-only omission and explicitly empty
child scopes remain supported; Worker spawn/follow-up callsites already supply validated scopes. No saved/wire shape
changes or permission widening. Upstream agent execution/spawn guards use root-derived owned capacity and task scope;
Alpha deliberately retains its native approval, file-scoping, durable-mailbox, and workspace protections.

### Medium / should-fix — foreign runner result repeated a child

**Fixed now.** Bounded manager runBatch indexed settlement by returned task ID, so a foreign ID could leave the original
child pending and rerun it indefinitely. Validate at the existing run boundary and settle failure under the owned ID.
The fail-before bounded fixture invoked the runner twice; after fix it invokes once. Additional characterization proves
parent cancellation keeps a capacity permit until physical child settlement and preserves completed changed-file evidence.

### Medium / should-fix — inherited route/role names crossed closed dictionaries

**Fixed now.** Envelope role/route `in` checks admitted inherited names (`toString`, `constructor`, `__proto__`), causing
invalid routes or unrelated TypeErrors. Use own-property membership at the existing validation boundary. Six fail-before
cases now report explicit unknown role/route errors. Existing valid role/model contracts remain unchanged.

### Medium / should-fix — denied child reported cancellation cause

**Fixed now.** Bounded-manager default denied status mapped to cancelled stop reason. Preserve denied status with its
existing `authority_denied` reason. One deterministic fail-before regression now passes.

## Validation

Commands above are actual runs; suite counts overlap and must not be summed into a unique-test total. Focused unit
workers are capped at two after the coordinator's control update. Final package typecheck passed.
No shared-output build, E2E, certification, live provider, or packaging command was launched by this lane.

| Actual validation                                                                                                                  | Result                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Task.spec, completion-followup, retry-wire, core-tool-result-identity, validator with `--maxWorkers=2`                             | 394 passed / 5 files                                                                                                       |
| Validator, core-tool-result-identity, pending-result flush, tool-history initial command                                           | 44 passed / 4 files                                                                                                        |
| Task continuation fixture rerun after required fields repair                                                                       | 1 passed / 279 skipped                                                                                                     |
| Engine/Foundation/StepContext/Builder/Runtime/Retry/SearchLoop                                                                     | 96 passed / 7 files                                                                                                        |
| Foundation + Engine after outcome fixture type repair                                                                              | 47 passed / 2 files                                                                                                        |
| Bounded manager/result/root/stop, async run manager, envelope/authority/nested, delegation/context, control nested/recovery/wakeup | 162 passed / 13 files                                                                                                      |
| ControlStore/LockWaiter/queue diagnostics/release cleanup, lifecycle journal, result contract                                      | 84 passed / 6 files; 3 overlap prior command                                                                               |
| OpenAI/Responses/reasoning/usage/history                                                                                           | 142 passed / 5 files                                                                                                       |
| Anthropic Vertex/Vertex/transport parity                                                                                           | 88 passed / 3 files                                                                                                        |
| VS LM/contracts/format, stream, native parser, cross-task pipeline                                                                 | 297 passed / 6 files                                                                                                       |
| Focused ESLint for Task/validator/new identity/existing validator/Task tests                                                       | passed                                                                                                                     |
| Focused ESLint for four kernel files and four delegation files                                                                     | passed                                                                                                                     |
| Initial `pnpm --dir src check-types`                                                                                               | failed: new outcome fixture fields plus another lane's command-precedence fixture cast; all owned fixture errors corrected |
| Final `pnpm --dir src check-types` after all subagents froze                                                                       | passed                                                                                                                     |
| Final `pnpm --dir src exec eslint` over all 17 touched TypeScript files, `--max-warnings=0`                                        | passed                                                                                                                     |
| Final scoped `git diff --check`                                                                                                    | passed; ordinary Git LF/CRLF warnings only                                                                                 |

Exact local command groups are file filters directly after `pnpm --dir src test`, never a standalone `--`. The
coordinator should run the serialized affected-surface and host gates on frozen sources. Parent source/test changes
were inspected against the preserved preexisting patch; every new edit belongs to this lane.

## Performance evidence

No general speed, quality, or token improvement is claimed. This pass checks deterministic failure and ownership
invariants; measured workload/metric will be recorded before any performance optimization.
The malformed runner deterministic workload measured invocation amplification: before two runner calls (then a guard
error), after one failed owned call. This establishes removal of repeated admission for that exact fixture, not a general
model-speed claim. No live quality/token/cache/latency claim or throughput benchmark was performed.

## Handoffs and highest remaining gaps

1. **Coordinator exact-host follow-up (not verified):** scripted complete malformed call must produce failure and no
   effect/completion; Responses explicit false must reach a second request without synthetic user error; Stop during
   final drain must stay aborted; nested scoped Worker spawn/follow-up must reject missing scope. Include provider
   partial-output failure followed by same-task recovery and preserve full tool pairs.
2. **Resolved shared-checkout check:** initial typecheck also reported `src/services/command/__tests__/command-precedence.spec.ts:28`
   TS2352 on a reduced Dirent cast. That file belongs to context; no cross-owner edit made. The owning lane corrected
   its fixture and final package typecheck passed. There is no open typecheck handoff.
3. **Flagged for follow-up / dormant surfaces:** legacy `runStep` engine ignores returned onStepComplete phase status;
   no production legacy host caller found. AgentStepRuntime's executable registry lacks active runtime callers outside
   builder/tests; prototype/registry mutability concerns remain dormant, not asserted as active defects. Event-log full-file
   reads/write queues and incident-monitor resource growth were not benchmarked or deeply verified. Do not promote
   dormant abstractions during cleanup.

Provider families beyond the explicitly tested boundaries, live reasoning quality, full real-host reload/restart and
multisession delivery, journal corruption under external writes, and noncooperative network/process shutdown remain
**not verified** at that end-to-end level. Focused unit evidence must not imply blanket provider parity. The previous
reliability, completion, compaction deadline, and long-context/fanout reviews were read against current integration code;
their baseline fixes remain in place. Another contract-alignment pass should focus on the exact-host cases above and
provider error/reload continuity after coordinator integration.

**Flagged provider test gap:** Gemini missing `finishReason` / `MAX_TOKENS` and Anthropic missing `message_stop` /
`max_tokens` need deterministic fail-closed fixtures against their EOF-based adapters. This inspection risk was not
reproduced as a confirmed defect here, so no speculative contract change was made. Live providers and actual-host
behavior remain coordinator verification work.
