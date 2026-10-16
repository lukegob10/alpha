# Workspace command reads during provider streaming

This bounded alignment change lets an audited native `exec_command` read start before provider EOF when `workdir` names the workspace by an absolute path or a nested relative/absolute path. The owning path is `Task.isPreEofReadonlyToolCall`; execution, approval, cancellation, and result publication remain in the existing scheduler and isolated command adapter.

## Reference and scope

Codex CLI source and tests were retrieved on 2026-10-07 (America/New_York; 2026-10-08 UTC) at commit `e974aad3b1a8f144273e882c614aefe69eaef615`:

- [Tool runtime](https://github.com/openai/codex/blob/e974aad3b1a8f144273e882c614aefe69eaef615/codex-rs/core/src/tools/parallel.rs): captures the advertising step's router, uses read/write admission for eligible/serial calls, and handles cancellation during admission and execution.
- [Tool parallelism tests](https://github.com/openai/codex/blob/e974aad3b1a8f144273e882c614aefe69eaef615/codex-rs/core/tests/suite/tool_parallelism.rs): checks overlap, call-order results, and shell execution before a delayed response completes.

Alpha's isolated command executor already resolved and checked explicit working directories. Its early eligibility check instead accepted only omitted workdir or `"."`, then classified every command relative to the workspace root. Ordinary model calls with an absolute directory therefore missed stream overlap; relative ripgrep targets could also be classified against the wrong directory.

Early admission now resolves native `workdir` with the executor's semantics, checks the task workspace and captured policy, and classifies the command relative to that directory. Canonical scope and approval are checked again during preparation and immediately before process execution. Requests requiring legacy `cwd` normalization continue through the ordinary staged adapter.

Intentional divergence from Codex: Alpha's early lane remains a maximum four-call ordered prefix of audited Git/ripgrep reads, with serial preparation/execution across early dispatches. Mutations, lifecycle tools, interactive terminals, verification commands, unclassified commands, and external tools retain their established staging. Results stay deferred until the assistant transcript is durable. Expanding command concurrency or the allow-list is outside this change.

## Deferred presentation correction

The new real-host test exposed a related violation on the existing early path: `ToolScheduler.run` called read finalizers before retaining deferred results. A real command finalizer records inspection evidence and calls `task.say("command_output")`, so output appeared and was persisted in UI history while the provider response was still open. The previous Task fixture had an empty finalizer and could not detect this.

The scheduler now retains those finalizers until `commitDeferredResults`. It joins them in call order, runs each at most once across concurrent commits and publication retries, drops held presentation on discard or cancellation before commit, and updates both retained receipts and the returned outcome if finalization fails. The normal scheduler path keeps its existing finalization timing. Task regression fixtures now include an observable finalizer and require presentation after assistant persistence.

## Controlled before/after measurement

Command:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts -t "measures read overlap" --silent=false
```

The same Task stream, captured surface, isolated read fixture, and fake clock were used before and after. The provider tail takes 200 ms, the read takes 300 ms, and assistant persistence takes 100 ms. The persistence store's disk receipt is stubbed for this timing fixture; separate interaction and extension-host tests verify durable admission and call/result ordering. The fixture has one provider request, one read effect, no retries, and no cache/network/provider variation.

| Native workdir            | Before |  After | Read starts before EOF, after |
| ------------------------- | -----: | -----: | ----------------------------- |
| `"."`                     | 400 ms | 400 ms | Yes                           |
| Absolute workspace        | 600 ms | 400 ms | Yes                           |
| Nested relative directory | 600 ms | 400 ms | Yes                           |

The two affected cases remove 200 ms of serialized waiting in this fixture (33.3%). This measures scheduling overlap, not live-model speed, filesystem throughput, or overall task quality. The regression requires the read to start before EOF and the total controlled time to remain 400 ms.

## Fixture clock follow-up, 2026-10-11

A later certification reported 800 ms for the default-workdir case. The unchanged isolated case completed at 400 ms.
Controlled event timestamps then exposed a narrower fixture defect: the run completed at 400 ms, and the actual paired
result flush also finished immediately, but that later save scheduled another 100 ms callback against an already released
assistant-save gate. Draining that callback advanced the clock to 500 ms without awaiting more persistence work. A new
post-flush clock assertion failed before the fixture correction. The exact source of the certification's additional
400 ms was not captured; these probes establish no production or goal-accounting defect.

The measurement now waits for the actual read-start and provider-tail barriers while fake time remains frozen. It advances
300 ms, waits for the first assistant-save boundary, then advances its 100 ms delay and awaits the original request. Elapsed
time comes from that request's settlement timestamp. The first assistant save arms its delay once; later saves still await
the same gate and record every history snapshot. The real result flush must leave no pending timer or clock movement.
Escaping workdirs wait only for the provider tail because their read must never start. Each scenario owns and clears its
timers before restoring the real clock, then retains the existing abort, request, and termination joins. Frozen waits
retain the fixture's 4-second real-clock watchdog and diagnostic state so a failed boundary still reaches cleanup.

The provider/read/save durations remain 200/300/100 ms, the expected elapsed time remains 400 ms, and the read-before-EOF,
single effect, single request, terminal result, and persistence assertions remain in place. Storage/path checks, runtime
code, retries, and timeouts are unchanged.

Focused validation on base `ceaa4c3c7efbd3edbfc77076a1b63c0b2d974e82`:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts --maxWorkers=2 --testNamePattern "measures read overlap|withholds a read from escaping workdir" --silent=false
```

All five cases passed; each allowed workdir completed at exactly 400 ms. The final full Task file passed 315 tests,
including the frozen-origin, result-flush, and no-clock-drift assertions. Four adjacent scheduler/persistence/goal files
passed 154 tests. These commands used the same base and two-worker limit:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts --maxWorkers=2
pnpm --dir src test core/agent/__tests__/ToolScheduler.deferredResults.spec.ts core/agent/__tests__/ToolScheduler.command-batching.spec.ts core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/Task.goals.spec.ts --maxWorkers=2
```

The extension typecheck, scoped ESLint check, and Prettier check for both touched files passed. No host, live-provider, or
certification gate was rerun for this fixture-only follow-up.

## Validation

Focused tests cover each working-directory spelling, legacy argument staging, delayed assistant persistence, lifecycle barriers, provider failure/cancellation, cancellation during an active read, and repair of an omitted accepted call. Adapter tests cover relative/absolute escapes, escaping junctions, a narrower captured workspace policy, and a directory replaced by an escaping junction after approval. Scheduler regressions cover discarded presentation, cancellation before commit, finalizer failure, publication retries/concurrent commits, and rejection of the isolated early path under serial execution policy.

The exact-host scripted test runs real extension-bundled ripgrep from absolute and nested working directories while holding the provider stream open. It checks durable acceptance before each effect, deferred presentation, exactly paired results in the next model request and persisted history, and one terminal task completion.

The VS Code LM fixture contract also proves physical read completion before EOF: it waits for all 400 matching lines in the command's bounded output artifact while the provider tail is held, then requires no UI output or terminal receipt until that tail is released. After release, presentation and the paired tool result appear once. This replaces an old assertion that depended on the premature UI publication corrected here.

Validation completed on 2026-10-08 UTC:

| Check                                                                   | Result                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Ten focused runtime Vitest files (exact filters in `final-runtime.log`) | 579 passed                                             |
| Controlled overlap benchmark command above                              | 3 passed; absolute/nested cases 600 ms to 400 ms       |
| `pnpm --dir src check-types`                                            | Passed                                                 |
| `pnpm --filter @alpha-code/vscode-e2e check-types`                      | Passed                                                 |
| ESLint and Prettier for the touched code/test files                     | Passed                                                 |
| `pnpm --dir src bundle`                                                 | Passed                                                 |
| `pnpm --filter @alpha-code/vscode-e2e test:vscode-lm:1250:run`          | 7 passed on exact 1.125.0                              |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                  | 42 passed across 13 exact 1.125.0 suites; zero pending |
| Scripted `core-loop.test` via the compiled E2E runner on exact 1.125.0  | 4 passed, including the new working-directory test     |

The retained working-directory run is `alignment-workdir-20261008-04`, with scripted model `core-workdir-read-stream`, profile `F:\alpha-e2e\profiles\alignment-workdir-20261008\1.125.0\user-data`, workspace `F:\alpha-e2e\alignment-workdir-20261008`, and evidence root `F:\alpha-e2e\artifacts\alignment-workdir-20261008`. Its receipts contain two provider requests, two calls, two results, one completed turn, and no transcript/lifecycle integrity errors. All final smoke runs verified host ownership, observed host exit, and reported actual VS Code 1.125.0. These are deterministic host checks; the measured speed conclusion is limited to the controlled fixture above.

## Evidence

Investigation logs, the initial working-tree snapshot, pinned upstream source, and benchmark receipts are stored outside the checkout at `F:\alpha-e2e\artifacts\tonight-alignment-20261007`. Existing user changes and the earlier composer/indexing work remain in place.

`overlap-before-after.json`, `core-workdir-read-stream.json`, `core-host-manifest.json`, and `smoke-1250-summary.json` record the final measurements and host results. `preservation-check.json` confirms that all 67 pre-existing tracked diffs match the initial snapshot and all 15 pre-existing untracked paths remain present. This follow-up adds no dependency, release-version, persisted-schema, or wire-protocol changes.

## Terminal read receipt convergence (2026-10-15)

This follow-up deliberately changes the failed/incomplete provider-response contract. Previously, Task discarded even a fully settled approved early-read batch and wrote a withheld-output error. A collector callback or settled scheduler outcome was held work, not an existing durable terminal receipt. The adjacent failed-provider tests encoded that policy; their expectations change with this contract, while cancellation controls remain.

The reference is Codex CLI commit `bb64b894fd67158be0f874872e6d7bfe717e7368`, inspected on 2026-10-15. Its [completed tool item admission](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/stream_events_utils.rs#L346) precedes execution, and its [tool-envelope drain](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/session/turn.rs#L2565) [finishes before the sampling outcome returns](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/session/turn.rs#L3280). Alpha closes the discarded-completed-result divergence through its existing Task and deferred scheduler boundaries.

After the matching assistant/tool_use is durable, a failed or incomplete response may retain the real terminal result of a completed approved read. Admission requires matching finalized call ID, name and arguments in accepted order; captured surface, run, turn, step and transcript ownership; and evidence that the approved effect ran. It never runs another tool or replays the read. A synthetic descriptor opting into audited command preparation exercises the contract; built-in command readiness remains separately gated and is not enabled by this change.

The existing scheduler owns finalizers, archives, result publication and call ordering. Task tracks settlement start before awaiting it, preserves real staged/persisted receipts on partial publication failure and checks the finalized status after commit. It must not turn a successful preview into success after a finalizer failed, or replace already published truth with a conflicting synthetic error. Provider history still requires a successful result flush. A failed assistant/result save or settlement fault keeps the Task terminal and prevents recovery.

The response owner is captured before assistant persistence and fenced again before post-save item publication or terminal fallback, including responses with no early dispatches. Deferred commit checks that captured ownership before post-finalizer stopping observations, staging and publication; checking only a later event callback would already have allowed a stale result into replacement state. Healthy response settlement and real Task stopping-evidence awaits use the same fence, including failure continuations. Omitted-call repair also carries the original owner through result publication, lifecycle replay and nested history replacement waits, validating snapshot run/turn/step association before repair. Its optional lower-level guard leaves ordinary resume callers unchanged. Stale error repair returns before writing replacement state. These owner checks remain distinct from Stop cancellation during an already owned commit.

The guard reaches the existing result flush, physical save queue admission and later claim/receipt acknowledgements. A waiting stale save cannot start writing. An already-admitted legacy write still completes its matching sidecar transaction; the old frame then stops before local acknowledgements or further mutation of replacement state. Tests distinguish this boundary by observing actual writer admission and replacement memory before a legitimate subsequent overwrite can restore it.

The staged host and response frame bind the actual step and tool surface at capture, before lifecycle/provider waits, and retain that owner through canonical preview drain, response projection, step completion, turn finalization and cleanup. The captured immutable surface installs before notification; active request signals still install after preflight, so an owned preflight deadline remains a request failure. A lagging best-effort journal projection does not itself transfer ownership. Owned synchronous resets release only their captured old request; retained retry steps and replacement requests keep their own resources. The capture notification is process-local and adds no provider or persisted contract.

Cancellation, omitted/mismatched finalized calls and missing execution evidence retain their guarded withhold/repair behavior. Stop arriving during an already owned finalizer can preserve that in-flight completed truth; the Task outcome is cancelled and later dispatches remain withheld. No new effect or successful Task completion follows. Alpha retains its durable transcript, current-owner and cancellation fences rather than adopting Codex's rollout runtime or sandbox implementation.

Regression coverage must distinguish failed/incomplete retention from cancellation, late Stop during finalization, call/surface/step/owner mismatch, missing assistant durability, partial publication, receipt persistence and finalizer/archive failure. Earlier benchmark and host receipts above remain historical evidence for their original changes; they do not validate this follow-up or establish a performance improvement.

### Cancellation ownership follow-up

The expanded coordinator run on 2026-10-15 was not accepted: the dedicated selection passed 94 of 98 cases, deferred scheduler passed 4 of 4, and Task plus post-EOF passed 371 of 377. All 23 post-EOF cases passed. These results exposed a cancellation continuation gap and a provider-status priority regression, alongside concrete fixture lifetime/oracle issues. The earlier 155-case preserved-source pass did not validate the expanded selection.

Cancellation cleanup must retain the response, step, run, turn, surface and transcript owner captured before its first asynchronous wait. It joins the original lifecycle and carries that same cancellation-independent guard through replay, pending-result publication, receipt save admission and local acknowledgements. Repair may use only a run/turn already entered on this Task and matching its replay snapshot. A never-started replacement cannot adopt an older journal's IDs; explicit resume recovery retains that responsibility. The native effects path likewise checks the original response owner across its executing-phase wait, before scheduler admission and after scheduler settlement. A nested adapter must receive the original guard rather than capture replacement state after the await.

An actual Task lifetime Stop remains authoritative cancellation, including when an already admitted finalizer preserves its real result. A provider-only cancellation marker cannot hide a receipt persistence failure: that Task outcome is failed. Permanent persistence failures remain observable at `waitForTermination`; a test deliberately keeping storage broken must explicitly require the expected rejection instead of reporting successful cleanup.

The stream fixture now registers the real owned lifecycle before exercising Stop. Its preflight deadline oracle checks ProviderTimeout and the supported exhausted reason without inventing an error field on an exhausted outcome. A controlled executing-phase handoff case adds scheduler-admission coverage while retaining the earlier assertions. The expected dedicated inventory is now 99 cases, including 68 stream cases; these are authored counts, not a pass claim.

The V3 source correction and composed WS07 hook/UI/input adapter guards require fresh coordinator review and runtime validation, including extension types and exact VS Code 1.125.0 smoke. The UI save caller captures both its original guard and provider before awaiting; the queue must enforce that guard at actual snapshot/write admission and later acknowledgements, including an explicitly absent captured provider. The correction does not enable built-in parallel command-read readiness. All benchmark and exact-host receipts earlier in this document remain evidence for their dated changes only.

The real UI Stop entry acquires a frozen process-local receipt from the same native Task cancellation transition before any cancel, goal or command callback can run. `beginTaskCancellation` returns the original abort promise, termination promise and cancellation-independent ownership guard. Existing `abortTask` callers retain the exact abort promise and coalescing/retry behavior; retained lifecycle reset retires the old receipt. The receipt adds no persisted or provider-wire shape and no additional execution authority. Host adapters use its captured termination and guard instead of borrowing a later Task transition or constructing another owner predicate.

All captured command shutdown workers must settle before cleanup reports its first failure, with existing timeouts and listener cleanup intact. Failure presence is separate from its unknown rejection value, so undefined or null cannot become successful cleanup. Synchronous cancellation and final-usage callbacks can transfer ownership: old cancellation aborts only captured controllers, coalesces reentrant Stop, and checks the original owner before a task-ID abort event. A superseded Task instance releases its local services while preserving the replacement's approvals, terminals, command output and diff state; a new step on the same Task retains its own services.

Physical command exit and archive finalization are separate boundaries. The captured worker shutdown controls prove abort acknowledgement, process completion, error propagation and local listener/timer release. They do not certify a pending archive after a yielded command has already physically completed. The existing command/finalizer owner must join that work before shared output cleanup and final command-lifecycle acceptance; the separately composed archive correction and its owning tests remain required.

### Archive waits during Stop

The approved successor design keeps physical shutdown, archival settlement and Task producer settlement distinct.
Codex CLI at the pinned commit bounds [collector draining](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/exec.rs#L1085)
and can cancel its own collectors when inherited pipes remain open. Alpha's VS Code reader has no equivalent physical
cancellation API. A noncooperative reader or failed sink close must therefore remain an observable cleanup failure with
its original output ownership retained. Alpha must not invent EOF, replay a command or borrow a replacement Task.

The existing command-session registry binds the original Task object, physical execution identity, archive row identity
and real sink-close predicate before adapter launch callbacks. Public polling promotion remains separate. Stop captures
a frozen snapshot of those original records before callbacks, including commands that have already left the foreground
or physically exited. A physical UUID is not an archive filename ID. Unknown legacy archive identity conservatively
blocks unsafe cleanup.

Task observes the producer's passive output-finalization promise. It does not call `finalizeOutput` to make cancellation
settle. Captured physical workers run concurrently with their existing 10-second limits. After every physical result,
the captured archive waiters run concurrently with each other, each with a 15-second limit. That allowance preserves
the existing 5-second flush and 5-second failed-close windows plus reader/observer admission time. A waiter deadline
does not settle, reject or replace the underlying archive latch; a later genuine settlement remains available to an
explicit cleanup retry. Releasing a currently blocked output write uses the existing output cancellation and cannot
repeat a physical interrupt or detach a healthy finalizer.

A real command or archive cleanup failure admits one 10-second grace phase for all remaining captured original
lifecycle, manual-compaction and goal joins. Those joins cannot add separate serial grace periods or delay the initial
command-failure observation indefinitely. Successful Stop retains its full natural producer and durable receipt joins.
The 10+15+10 failure phases do not establish a whole-Stop deadline for arbitrary persistence, provider or host operations.

Failure presence remains separate from its rejection value, preserving the first relevant reason even when it is
`undefined` or `null`. If original producers remain unsettled after the failure grace, the captured receipt rejects.
Task retains and observes that unfinished work, defers destructive producer-dependent disposal and request release, and
skips incomplete receipt, input-claim and canonical-terminal reconciliation. Provider rehydration must not follow the
failed receipt. Late cleanup uses captured idempotent old handles after their actual owner settles; it cannot read or
repair replacement state.

Output cleanup uses the existing validated artifact-reference helper and `OutputInterceptor.cleanupByIds`. It captures
only original archive row candidates before asynchronous work, retains referenced output and pending or unconfirmed
close ownership, and checks original owner, exact execution and real sink safety immediately before each unlink.
A failed finalizer or `isOutputFinalized` flag alone does not prove that a writer closed. Releasing polling sessions
cannot erase that gate. An already admitted unlink cannot be retracted, so its original execution scope must never
include later replacement output. Both command-output preservation and shared-resource preservation options remain
effective; same-instance replacement services must survive.

This section records the approved source contract. The successor source, faithful fixtures and combined WS03/WS07/WS08/
Provider composition still require exact review and coordinator-run validation. Earlier physical completion tests,
historical passes and exact-host receipts do not establish this archive contract or a general speed improvement.

Owner-aware host joins use the existing `waitForTermination(guard)` and
`flushApiConversationHistoryPersistence(guard)` methods. The termination waiter captures entry-time work before its
first await. An existing native cancellation receipt remains authoritative; otherwise it joins only the captured
lifecycle and goal, preserving the first exact rejection after both settle. It cannot adopt a later lifecycle or goal.
The transcript drain checks that same original guard before each mutable queue or failure read and after every await.
An original awaited rejection still propagates; a later replacement queue or sidecar failure stays with its owner.
Callers recheck ownership after a successful return. Calls without a guard preserve their existing contracts.
