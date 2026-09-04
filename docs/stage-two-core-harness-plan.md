# Stage 2: parallel reads and recent-context compaction

## Scope and baseline

This is a bounded performance-optimization pass for two Alpha Code extension tickets:

- [NOR-26: Audited, bounded parallel reads](https://linear.app/norval/issue/NOR-26)
- [NOR-24: Preserve recent working context during safe compaction](https://linear.app/norval/issue/NOR-24)

The integration branch is `codex/stage-two-core-harness`, based on completed Stage 1 commit
`678baf4440c9cad4a5f40aa6142ad12b98ca0b17`. The user-authored working-tree change to `AGENTS.md` is not part of
this implementation and must remain untouched. NOR-25 verification/progress and NOR-29 incremental persistence remain
later stages. CLI, VS Code shim, release/version changes, dependency upgrades, publishing, and unrelated refactors are out
of scope.

Success means these two ticket contracts work together with reproducible fixture evidence and regression coverage;
it does not mean the entire harness is optimized or that live-model quality has been measured.

## Parallel ownership and decision policy

Two separate app tasks/worktrees use Sol Max for planning, decisions, and difficult implementation. Bounded routine
implementation/test subtasks may use Luna Max; difficult or ambiguous work and independent reviews use Sol Max.
The orchestrator owns cross-ticket integration, combined validation, and final Linear closure.

| Workstream   | Primary ownership                                                                   | Shared integration boundary                                                              |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| NOR-26       | `ToolScheduler`, `ToolRegistry`, `TaskToolSurface`, audited read handlers and tests | Minimal `Task.ts` scheduler dispatch changes; captured policy and persistence fence      |
| NOR-24       | Condensation, context management, history projection/recovery and tests             | Minimal `Task.ts` compaction/recovery changes; environment reset and provider continuity |
| Orchestrator | This record, independent boundary audit, integration regressions and validation     | Effect completion before compaction; retained discovery evidence; retry/reload behavior  |

Worktree setup must be checked against the exact baseline before editing: a task created from the project's default
branch is not assumed to include Stage 1. Owners send an early plan and commit-based final handoff. Shared file edits
are coordinated by function and reviewed together before integration.

Both tasks confirmed the exact baseline before editing:

- NOR-26: `01a06c43-35f1-72e1-89f6-2faaa1ec2995`, branch `codex/nor-26-parallel-reads`.
- NOR-24: `01a06c43-35e1-7863-bbad-f159349b25c9`, branch `codex/nor-24-recent-context-compaction`.

Root uses Sol Max for the shared-boundary audit, difficult provider/retry regressions, and independent scheduler review;
Luna Max implements bounded transcript fixtures and marker/notification regression fixes under the reviewed plan.

## Implementation contracts

### NOR-26

1. Audit real read handlers, including approval, ignored/protected paths, scope overlap, shared task/UI state, terminal
   interaction, error propagation, and cancellation. Read-only filesystem access alone does not establish independence.
2. Derive eligibility from the captured tool surface and effective policy, not a metadata relabel that bypasses approval.
   Unknown or overlapping scopes and interactive paths use the conservative serial lane.
3. Enable the existing selective-parallel scheduler with a bounded concurrency/queue policy. Keep mutations, terminal
   operations, approvals, and lifecycle barriers serialized/isolated.
4. Preserve the per-call durable before-effect check and exactly one structured terminal result per accepted call in
   model-call order. Drain or safely contain cancelled workers before later lifecycle operations.
5. Record a matched serial/parallel fixture: equal work, elapsed time, peak concurrency, cancellation behavior, result
   equality, and unchanged model-round-trip count. Do not generalize fixture timing to all tasks.

### NOR-24

1. Select a token-budgeted recent tail at complete logical-step/tool-transaction boundaries; summarize the older prefix
   while retaining the selected tail verbatim. Keep original stored history available for recovery/rewind.
2. Preserve instructions/provenance, pending constraints, result status, call IDs, canonical order, and provider-required
   opaque/reasoning state. Never condense while effects are in flight.
3. Define a deterministic bounded fallback for an oversized indivisible tail. Do not hide budget failure or continually
   retry an unchanged oversized request.
4. Apply the same contract to automatic/manual/repeated compaction, truncation fallback, reload, rewind, and cancellation.
   Preserve Stage 1's full environment baseline after a successful persisted compaction.
5. Compare matched fixtures for active tokens, exact evidence retention, repeated reads, and model/tool round trips.
   A scripted information-loss fixture demonstrates that fixture, not general model solve-rate gains.

## Shared risks to verify

- A cancelled parallel batch must settle complete terminal receipts before compaction or a new step can reuse task state.
- Manual compaction must not race an active scheduler; automatic compaction runs only at a safe step boundary.
- Retained history and discovery transactions must not widen executable permissions; catalog state stays bounded and
  reflects persisted evidence under the next captured policy.
- Compaction must retain or refresh the environment baseline, never leave deltas without their base.
- Provider retry captures and raw wire inputs remain separate from sanitized diagnostics; compaction creates an explicit
  new context boundary, not an in-place change to a retained transport attempt.
- Recovery and rewind must understand new retention metadata while continuing to read older saved histories.

## Baseline and validation plan

Baseline at `678baf4` on 2026-09-04:

```sh
pnpm --dir src exec vitest run core/condense/__tests__ core/context-management/__tests__ core/agent/__tests__/ToolScheduler.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/tools/__tests__/TaskToolSurface.spec.ts --maxWorkers=3
```

Result: **11 files, 234 tests passed**, 8.45 seconds. This establishes correctness coverage, not a performance baseline.
Each owner records its workload-specific performance baseline and final measurements separately.

### Integration findings and red/green checks

Root commit `d5d29f6` addresses the context-retention integration boundary:

- A real same-instance `MessageManager` rewind removed the environment-bearing turn but left its acknowledged cache
  active. Four tests reproduced stale/missing full snapshots, including pending/failed saves. Invalidate the cache as
  soon as its in-memory history is replaced, preserving existing save-failure semantics and terminal fairness cursors.
- Appending fresh context to a retained user message changed its original object/content. The refresh now uses the
  existing persistence/receipt helper to add a separate trailing user environment record. The old message stays exact;
  provider-only consecutive-user merging remains unchanged. Its new identity regression failed before the change.
- Future-dated generated summaries/markers inserted before the original tail could become the wrong approximate rewind
  boundary. Two regressions reproduced the stale user-tail retention; ignore generated markers as fallback user anchors.
- Archived successful discovery receipts restore visibility on a fresh task catalog, but archived error/cancelled
  receipts do not. Approval metadata remains unchanged. These three cases characterize the full-stored-history contract.

Post-fix checks: 90 tests across persistence, environment, retry-error, user-message merge, and message-manager files;
56 tool-catalog tests; extension typecheck; repository lint (12 tasks). Pre-commit formatting normalized the previously
CRLF-stored, owned message-manager test file; the semantic diff is substantially smaller than raw line counts.

Two additional fixtures were deliberately red on Stage 1: scheduler transactions survive real compaction and transcript
restart (two cases), and recent OpenAI/Gemini/VS Code LM state survives real compaction and Task transport retry (three
cases). All originally failed at missing retained evidence. Integration aligns the synthetic descriptors with the new
explicit scope requirement and verifies retries do not repeat either budget or dispatch schema capture. Recent provider
state and the normal persisted transaction now pass. The cancellation/reload case exposed a real status mismatch:
the scheduler reported cancellation, but its generated provider body used the generic error formatter.

Root commit `fd41794` preserves the authoritative `denied`/`cancelled` status in generated provider receipts, including
preparation, execution, finalization, approval cancellation/supersession, and abort paths. Actual errors still use the
existing error formatter, and already-completed receipts remain unchanged. Seven focused regressions failed before the
fix; the scheduler and persisted-compaction/reload suites then passed all 39 tests. The three provider-state compaction
and retry fixtures also pass without duplicate effects or repeated schema capture.

The first broad core run exposed one obsolete delegated-resume assertion: it expected environment text to mutate a
saved child-result message. The updated test requires the original result object/content to remain exact, a separate
environment record to be persisted, and the captured environment to be acknowledged. All 135 `Task.spec.ts` tests and
the subsequent broad core rerun passed. This is an intentional history-record ownership change, not a weakened assertion.

Root commit `9a3c907` closes the manual-compaction UI completion path. Failure or abort previously omitted the response
that clears the UI busy state. The provider now posts one completion notification on success/failure/abort without
masking the original condensation error. Three pre-fix cases reproduced the missing response. Post-fix: six dedicated
cases passed, existing provider suite passed (121 tests, six skipped), extension lint/typecheck and repository lint passed.

Independent review also requires the final provider request to use the same captured handler as the compaction budget
check. Switching to an unmeasured smaller-window handler during asynchronous refresh is not an acceptable continuation.
For parallel reads, scope/cancellation checks include auxiliary ignore-file loading and cached approval settings, not
only the ripgrep subprocess. Reads with unproven legacy-output equivalence remain serial.

### Integrated owner handoffs

All owner commits merged without conflicts; unrelated user edits were preserved.

| Ticket           | Owner commit                               | Integration commit |
| ---------------- | ------------------------------------------ | ------------------ |
| NOR-26           | `b6242b46c74ab6c21c4db500ee18931aa3f922de` | `45dba05`          |
| NOR-24           | `81b1c0bdf7f050a4e7d4c02dcf8c2c898643ec9f` | `885720c`          |
| NOR-24 follow-up | `fc13af764fff86de06c9ab6dd041c425158430b2` | `292020f`          |

Workload definitions, audit exclusions, upstream source pins, and owner measurements are in
[NOR-26 implementation](nor-26-implementation.md) and [NOR-24 implementation](nor-24-implementation.md).
The initial integrated read/persistence/catalog/environment/glob run passed 12 files / 200 tests. Final combined
validation is recorded below; overlapping suites are not independent samples and their counts should not be summed.

### Performance evidence and rollout boundaries

- NOR-26 opts in only audited, non-recursive `list_files` calls for disjoint canonical child directories under a captured
  primary-task read grant. Production concurrency is capped at four. Approval metadata remains intact; mutations,
  approvals, overlapping/unknown scopes, recursive/oversized listings, ignored/protected paths, links, and unproven output
  equivalence take the serial path. The audit leaves `read_file`, `search_files`, and `codebase_search` serial.
- The equal-work six-directory benchmark uses the real scheduler/registry/handler and a controlled 30 ms listing service,
  with three paired runs and a benchmark cap of three. Median serial time was **284.66 ms**, versus **126.58 ms** parallel
  (**2.25x**, 55.5% lower); peak concurrency was one versus three. Cancellation drained three active workers to zero;
  model round trips did not change. Real-ripgrep parity coverage checks identical seven-entry output separately.
- NOR-24 retains whole recent steps/tool transactions verbatim, including user corrections and opaque provider state,
  inside a bounded input budget. Older history remains stored; oversized indivisible tails have explicit bounded fallback
  or non-retryable exhaustion. Manual/automatic compaction and final provider dispatch share captured request state.
- In the deterministic information-loss fixture, isolated Stage 1 retained 57 active tokens and required one reread/two
  continuation model rounds. The retained-tail result uses 225 active tokens and needs zero rereads/one continuation
  round, preserving three exact messages (168 tail tokens). Both perform one summary call. The additional active context
  is an explicit tradeoff, not a claim that compaction always lowers token use.
- These measurements demonstrate the named fixtures, not general live-model solve-rate, latency, or cancellation bounds.
  External filesystem edits are not atomically isolated; pending native I/O must settle before worker drain completes.

### Final integrated validation

| Check                                                                           | Result                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Broad core/task/tools/context/persistence/webview/terminal/glob regressions     | 172 files passed, one skipped; 2,551 tests passed, 23 skipped; 113.98 seconds                    |
| All provider and transform tests                                                | 66 files passed; 1,316 tests passed, one skipped                                                 |
| Complete chat component suite                                                   | 40 files / 486 tests passed                                                                      |
| Repository lint (`pnpm lint`)                                                   | 12 of 12 tasks passed; repeated by the final code commit hook                                    |
| Repository typecheck (`pnpm check-types`)                                       | 13 of 13 tasks passed on the final integrated code/tests                                         |
| Exact-host smoke (`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`)       | Passed on VS Code 1.122.1, including extension, modes, and LM continuation/cancellation/recovery |
| Managed-agent automated certification (`pnpm certify:managed-agents:automated`) | Passed: 1,275 deterministic tests, 26 contract rows, plus one managed-agent host acceptance test |

The final automated certification exited zero on 2026-09-04. Its deterministic evidence is
`artifacts/certification/managed-agent-milestone-evidence.json` (`PASS-DETERMINISTIC`, zero failed/skipped tests).
The host acceptance test passed in 20 seconds and exercised nested Apply, discard, verification, projection, and
navigation. The broader certification matrix still lists **eight pending manual/live integration scenarios**:
human authorization provenance, nested crash/reload, real-provider budgets, full Worker Apply/reload, live UI convergence,
non-cooperative process/provider cancellation, multi-window storage writers, and real global-state size. Passing the
automated host test does not declare those broader scenarios complete.

Broad core reproduction command:

```sh
pnpm --dir src exec vitest run core/agent/__tests__ core/task/__tests__ core/assistant-message/__tests__ core/tools/__tests__ core/task-persistence/__tests__ core/environment/__tests__ core/context-tracking/__tests__ core/condense/__tests__ core/context-management/__tests__ core/message-manager/index.spec.ts core/webview/__tests__ core/prompts/__tests__ integrations/terminal/__tests__ services/glob/__tests__ utils/__tests__/git.spec.ts --maxWorkers=3
```

Final committed diff checks are clean. The change set contains no CLI/shim, lockfile, release/version, generated-output,
or user `AGENTS.md` modifications. The two owner worktrees are clean; the integrated work remains local and unpublished.

## Closure ledger

- Fixed now: both ticket implementations and integration regressions covering environment refresh, generated-marker
  rewind, compaction completion notification, durable ordered receipts, and truthful cancellation/denial status.
- Flagged for follow-up: NOR-25 and NOR-29 remain outside Stage 2.
- Complete locally: NOR-26 and NOR-24 implementation, combined regression gates, measured fixtures, and automated host
  acceptance. Production code ends at `fd41794`; owner and root commit mapping is recorded above.
- Not verified: the eight broader manual/live certification scenarios, live-model quality/speed improvements, and general
  cancellation latency guarantees.
- Out of scope: CLI/shim changes, release/publish operations, broad frontend cleanup, and unrelated architecture changes.
