# Codex CLI convergence fixes — October 4, 2026

This run implements the defects recorded in [the October 3 failure register](testing-suite-failures-2026-10-03.md).
The original failures and receipts remain historical evidence. New evidence belongs to
`artifacts/core-confidence/convergence-fixes-2026-10-04/`; an earlier certificate does not close this run.

## Reference and scope

The current upstream reference is Codex commit `afb436df8b70bb5bc57b86d9a3e829968988cd21`, retrieved October 4, 2026.
The implementation follows verified behavior through Alpha's existing TypeScript kernel and VS Code adapters.
No Codex implementation, Rust runtime, prompt wholesale, or sandbox is introduced. Existing approval, workspace,
mutation, security, Code/Plan, skill, HTML preview, Tickets, and scheduled-task contracts remain in scope for regression
validation. The exact host remains VS Code **1.125.0**.

The six reproduced October 3 defects are fixed at their owning boundaries: raw patch replay, accepted legacy tool-result
identity, awaited telemetry shutdown, clean probe cancellation, cross-root nickname reservations, and Windows worktree
startup at legitimate long paths. Additional regression work covers reused call IDs after a real flush, partial prune
recovery, failed descendant cleanup, follow-up/finalizer ordering, complete command fixture ownership, and an independently
due adapter deadline (`TEST-PROBE-DEADLINE-002`). Live availability and performance acceptance remain open below.

Relevant upstream evidence:

- [Protocol tool models](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/protocol/src/models.rs)
  distinguish freeform custom input from structured function arguments and retain call identity.
- [History normalization](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/context_manager/normalize.rs)
  and [history tests](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/context_manager/history_tests.rs)
  discover actual receipts before repairing genuinely missing results.
- [Agent runtime ownership](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/agent/control/runtime.rs)
  and [control tests](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/agent/control_tests.rs)
  keep each root's registry ownership distinct and retain failed teardown as failure.
- [Client terminal handling](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/client.rs)
  accepts explicit terminal completion without waiting indefinitely for transport EOF. Cancellation before that boundary
  remains distinct from ordinary empty output.
- [Compaction resume/fork tests](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/tests/suite/compact_resume_fork.rs)
  exercise retained history and harness state through recovery.
- [Repeated-call output tests](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/core/src/tools/executed_tool_calls_direct_tests.rs#L73)
  retain distinct output metadata for successive occurrences with the same call ID. Alpha continues to require unique
  accepted call IDs within one canonical turn; a fresh turn may reuse a provider ID.

## Owning invariants and compatibility

Saved tool history is adapted as a request projection; verified transcript bytes and digest receipts are preserved.
Unambiguous canonical or legacy identities are accepted, including empty-field fallback. Conflicting nonempty aliases
fail explicitly with bounded diagnostics. Real result payloads and failure status survive ordinary reload, canonical
recovery, compaction, and provider projection. A later call occurrence that reuses an old ID cannot borrow an older result.
Freeform `apply_patch` text remains exact for custom tools; function transports receive Alpha's existing `{ patch }`
schema. Conversational child inheritance retains its existing exclusion of operational patch transactions.
The result cache belongs to one canonical turn. A resumed in-progress turn keeps its settled receipts, while a fresh
turn receives a fresh cache. An asynchronous flush retains its original cache reference so a delayed save acknowledgment
cannot reserve an ID in a newer turn. Failed saves retain pending content and reserve no settled result ID.

Telemetry shutdown owns one shared completion promise, visits every captured client, and settles only after all cleanup
attempts finish. Failure does not prevent remaining clients or extension terminal cleanup. Deactivation logs bounded
messages and tolerates an output channel that the host has already closed.

Readiness keeps one absolute 60-second budget across preparation and streaming, sends at most one tool-free request, and
preserves unknown usage. A clean abort or a cancelled provider outcome is failure, including after partial text.
Explicit completion requiring another request is incomplete. An accepted terminal completion does not depend on later
EOF. Disposal failure cannot erase an already observed cancellation. A provider-owned abort or deadline error retains
its cancellation identity even when its timer settles before the probe's own timer. The existing shared stream abort
classifier owns that interpretation; the probe does not introduce provider-specific message matching.

The optional request-phase observer records only Alpha adapter progress: `model-selection`, `request-admission`,
`first-response-chunk`, or `response-stream`. It does not expose native Copilot internals, establish availability,
authorize tools, or count a solving request. Observer failures cannot change model output. The exact-host native API
separates `sendRequest()` from `response.stream`; see the
[Microsoft language-model guide](https://code.visualstudio.com/api/extension-guides/ai/language-model), retrieved October 4.
The phase observation window closes at accepted terminal completion or probe cleanup. Late callbacks cannot alter the
returned result.

Nickname and worktree fixes must retain root ownership, limits, rollback, path scope, and recoverable cleanup evidence.
Alpha's historical same-root nickname uniqueness remains an intentional stronger naming contract; separate roots do not
share that reservation namespace. Windows validation uses the original legitimate long-storage workload and the installed
Git version, with local command adaptation rather than changing persistent Git configuration or shortening the fixture.
The Windows adapter uses owned temporary junctions only for argument-safe native Git invocation and restores physical
worktree registration before publishing startup. Persistent paths and source-relative command directories remain exact.
Cleanup unlinks only owned aliases, retains failed cleanup metadata, and retries prune after a partially completed remove,
including cold recovery when the removed checkout is already absent. An unexpected or replaced path is not removed.

Blocking and asynchronous child runs expose their existing owned completion promise to cancellation. A subtree stop
signals and joins independent owned branches, retains ancestors whose descendant cleanup failed, and propagates the
failure after the other bounded cleanup attempts. Failed cleanup remains a failed result with the original stop cause.
Follow-up admission waits for the prior group finalizer, including durable publication and worktree cleanup. These changes
extend the existing delegation manager and finalization barriers without adding an execution engine or authority.

The command-settlement fixture owns common files once per suite, clears only known owned workload files after the prior
host is disposed, and writes distinct backend receipts. Its three original host tests and actual command oracles remain.

## Validation status

The run records actual command exits and raw assertion reports under
`artifacts/core-confidence/convergence-fixes-2026-10-04/`. The generated
[closure report](../artifacts/core-confidence/convergence-fixes-2026-10-04/aggregate-closure.md) reads those named receipts;
it does not execute tests or convert historical failures into current acceptance. Focused cohorts overlap the complete
workspace inventory and each other, so their counts must not be added together.

| Affected boundary                                                                    | Focused result             | Evidence                                            |
| ------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------- |
| Provider projections, legacy identity, raw patch, compaction and child history       | 672 passed across 19 files | `replay/summary.json`                               |
| Task receipt cache, flush, reload, scheduling and identity validation                | 526 passed across 7 files  | `task-history-final.raw.json`                       |
| Managed lifecycle, root names, cancellation, admission and finalization              | 219 passed across 6 files  | `managed/verification-summary.json`                 |
| Readiness cancellation/deadline identity, terminal precedence and extension teardown | 27 passed across 3 files   | `root-probe-deadline-final.raw.json`                |
| Native VS Code LM adapter ordering, history, cancellation and optional phases        | 123 passed                 | `copilot-readiness-phases/vscode-lm-after.raw.json` |
| Awaited telemetry cleanup and error handling                                         | 7 passed                   | `lifecycle-fixtures/telemetry-after.raw.json`       |
| Settlement fixture ownership and real command oracles                                | 6 passed                   | `lifecycle-fixtures/settlement-after.result.json`   |

The repaired host-ownership fixture initializes the real root-scoped nickname registry, as its constructor would.
Its focused reproduction first failed; the complete file then passed all 16 cases without changing assertions,
capacity, or production behavior. Native Windows worktree creation, capture, and deletion also pass through the public
adapter with the original 202-character storage workload and 275/280-character Git index/lock paths, Git 2.43.0.windows.1,
and `core.longpaths=false`. Primary registration and HEAD/index remain intact, and the fresh reproduction's owned
fixture cleanup is verified. This bounded reproduction is separate from extension-host certification.

The initial default workspace attempt failed before complete results: Turbo's strict environment filtered the intended
Vitest worker bounds, causing native nested-path tests to hit their existing 30-second deadlines, followed by busy-file
cleanup failures. The rerun passes those unchanged cases with `--env-mode=loose --concurrency=2` and process-local
two-worker Vitest bounds. The completed bounded attempt retained one stale fixture failure; after its repair, the
complete workspace closure passed 12,891 cases with zero failures and 33 declared skips. Six unchanged package owners
reuse counts only when their exact Turbo test hash matches the completed receipt. Original failed receipts remain.
That passing checkpoint is retained as `final-workspace-test-before-deadline.*`; the final workspace receipt is rerun
after the additional three-case adapter-deadline regression and its correction, and passes **12,894 cases, zero failures,
and 33 skips** (12,927 total). The extension owner executes 10,343 passing and 31 skipped cases across 632 files;
the other six owners retain their matching completed task identities. No focused case is added twice to these totals.

Current static gates pass `pnpm lint:all`, `pnpm check-types:all`, and `pnpm knip`. Supplemental tooling passes 185 cases;
offline evaluators pass 408 across their unit, contract, and certification stages; the real host-runner unit suite records
549 passes and two Windows-inapplicable POSIX skips. Postgres/Redis service tests were not rerun in this change; the
October 3 owned-container results remain historical. Declared skipped cases are coverage debt, not passing assertions.

The saved live campaign executes all four deterministic prerequisites at its stable source checkpoint: runner units, exact-host
smoke, core regressions, and core hosts. The 13 smoke launches execute 42 passing assertions and the five core launches
execute nine, with zero failed or pending host assertions. Each native launch reports VS Code 1.125.0, required-test
execution, observed host exit, verified ownership, and complete capture. The outer prerequisite wrappers do not certify
complete OS process-subtree cleanup. Complete unfiltered command settlement separately executes all three original
tests successfully on the same exact host. Final package and managed-certification outcomes belong to their fresh
named receipts in the generated closure; an older bundle, VSIX, or certificate is not substituted.

After the deadline correction, the required `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` command passes again
on the final runtime source. Its independent named receipt is `exact-host-smoke-after-deadline.result.json`; the safe
summary records each native host's observed identity, counts, exit, capture, and retention. Package commands are
`pnpm bundle`, `pnpm vsix`, and `node scripts/verify-vsix-contents.mjs <fresh-vsix-path>`. Final managed validation is
`pnpm certify:managed-agents:automated`, with a fresh copied certificate and exact-host results in
`managed-certification-current.summary.json`. The strict certificate's declared integration-dependent rows do not
establish live-provider or multi-window acceptance. The final source snapshot is `final-source-identity.json`; its
verification and certificate must agree before reporting certification. These generated outcomes are written after
documentation freezes so the certificate covers the unchanged source and design notes.

The first current strict certification attempt is preserved as `managed-certification-before-skip-accounting.*`.
Its ten tracks execute 3,135 cases: 3,134 pass, none fail, and one dynamically skips. The Windows short-alias case
requires an actual alias; forcing the canonical `F:\alpha-e2e\tmp` directory correctly produces a skip and rejects
strict acceptance. Consequently, that command does not enter its native-host stage. The unchanged complete
`VerificationScope` file then passes all 40 cases, including the alias case, using the machine's existing
`C:\Users\LUKEGO~1\AppData\Local\Temp` directory. No alias, platform setting, assertion, test exclusion, or acceptance
rule is changed. The final automated rerun uses that documented environment and fresh owned scripted profiles.
The original long Windows worktree workload and the saved live profile retain their original paths.

The skipped assertion also exposes a certification diagnostic defect: Vitest reports its assertion status as `skipped`,
while the collector recognizes only `pending` and `todo` when listing skipped names. The certificate's counts and
strict failure are correct; its empty name list is incomplete. A small collector correction and an owned JSON-report
self-check cover the current and legacy statuses, failure-name separation, numeric counts, and invalid reports.
The diagnostic reproduction and validation belong to `managed/skip-diagnostic/`; the previous source snapshot is
retained as `final-source-identity-before-skip-diagnostic.json`. This tooling correction does not change the runtime
covered by the final workspace suite, exact-host smoke, or verified VSIX.

The fresh package commands all pass. The VSIX verifier checks 1,675 entries, required contents, and absence of `.env`
files. `package-current-summary.json` records the actual output identity. The smoke result establishes the exact host
and executed assertions; it does not establish a captured during-run bundle hash or complete OS subtree termination.

## Retained-state performance and live limitations

The retained-state candidate reuses a private validated baseline only after a fresh fenced read, complete envelope
checks, and deep equality. Changed records and custom persistence without isolated reads retain canonical parsing.
Opaque provider graphs remain defensive copies, failed validation keeps array error positions, and shutdown/recovery
invalidate the baseline. JSON reading, equality, serialization, and durable writes remain linear in retained state.
This extends the existing store; no fixed record-count cutoff or task-specific workload rule remains.

The comparable quiet before/after workload uses five warmups and 60 samples per writer, fresh workers, warmed filesystem
cache, the same Node 24.21.0/pnpm 11.24.0 environment, and no discarded outliers. Each report records 360 commands and
720 transactions with zero command/transaction failures.

| Retained agents / writers | Transaction-body p95 before / after | Complete-cycle p95 before / after |
| ------------------------- | ----------------------------------- | --------------------------------- |
| 1 / 1                     | 11.08 / 10.63 ms                    | 30.42 / 30.39 ms                  |
| 1 / 2                     | 9.20 / 10.49 ms                     | 60.87 / 77.20 ms                  |
| 5,000 / 1                 | 1,065.50 / 526.53 ms                | 1,857.67 / 1,017.86 ms            |
| 5,000 / 2                 | 864.32 / 544.73 ms                  | 3,452.59 / 2,109.81 ms            |

**PERF-STATE-001 remains open.** The small concurrent cycle regresses by 26.82% (+16.33 ms) and fails the unchanged
acceptance guard. Large retained-state body reductions in this paired workload do not establish a general speedup.
Both the earlier loaded failed comparison and this quiet failed comparison are retained. A provisional fixture-sized
cutoff was reverted; no acceptance threshold was changed.

**TEST-LIVE-COPILOT-001 remains open.** The saved Alpha-owned profile at `F:\alpha-e2e\profiles\1.125.0` is retained.
The campaign requests the user's `gpt-6-luna` model with `max` effort, three samples per scenario and a 300-request
solving ceiling. Discovery observes available authorization and applies the requested effort. One tool-free readiness
request produces no first text and stops after 60,008.64 ms; its receipt reports `request_failed` at Alpha's
`request-admission` phase. This locates the last observed adapter boundary without proving the native Copilot cause.
The probe's request counter records the Alpha adapter invocation; it is not a backend admission acknowledgment.

The first live cell is infrastructure-blocked before solving, and the other 26 are not run. There are zero passing or
failed solving attempts. Unknown requests/tokens/cost remain `null` in the campaign usage ledger; the separate readiness
receipt records one request with `countsAsSolving: false`. Evaluation identity, plan identity, and packaged artifacts
remain unchanged during that attempt, with complete capture and retention. No lost sign-in, model mismatch, successful
authenticated resume, live task quality, or live latency improvement is inferred.

The subsequent deterministic deadline reproduction first records two passing controls and one intended failure:
an adapter's real linked control reaches its deadline while the outer probe timer remains undispatched. The real
`ApiStreamDeadlineError` must produce `cancelled_or_deadline`. After the shared-classifier correction, all three cases,
the 17 existing probe cases, seven extension lifecycle cases, and 123 native adapter cases pass together (150 assertions).
This is a diagnostic fix following the live checkpoint. It does not relabel that historical live receipt, establish
which deadline actually fired there, or certify live availability on the corrected source.

An owned native Git triage fixture remains at `F:\alpha-e2e\git-lp-a76e81c5`: automatic approval review rejected its
recursive deletion with reason `blocked by policy`. Linked worktrees and aliases were released; no alternative deletion
route was attempted. This retained fixture is separate from the successful fresh native worktree proof.

## Authenticated live core cycle (2026-10-04)

The user granted Alpha's native Copilot permission in the dedicated, signed-in 1.125.0 profile. Actual readiness responses
and solving turns now confirm authorization for Alpha in that profile. The first fresh full-cycle launch passed its four
deterministic prerequisites, then stopped before solving with an uncaught Copilot 0.53.0 Git observer exception:
TypeError: e is not iterable in setItems. Its separate readiness request completed. The stack matches the
[upstream VS Code report](https://github.com/microsoft/vscode/issues/314122); the retained stock-host failure is evidence
of a Git integration problem in this setup, rather than evidence of missing sign-in.

A controlled run temporarily set git.enabled=false only in the dedicated test profile. Alpha's real Git command tools
and fixture repository assertions still ran. The prerequisite commands passed: runner units (549 passing, two platform
skips), exact-host smoke (42 passing), core regressions (439 passing), and exact-host core contracts (nine passing).
The live core matrix then finished all nine scenarios with three samples each on VS Code 1.125.0, gpt-6-luna, max effort.
Its original strict verdict is failed: 24 passed, three failed, zero blocked, and 281 solving requests. Source identity,
evaluation plan, built artifacts, capture, and retention verified unchanged or complete during the campaign.

Two search failures were scoring false positives. Both responses correctly reported "No case-insensitive matches," but the
absence-report checker rejected the hyphenated modifier. A focused regression first recorded 29 passes and the one
intended failure. The checker now accepts hyphenated modifier words while retaining its word bound, required absence
report, observed command exit, and unrelated-error checks. After the correction, the complete runner suite passes
551 tests with two platform skips; runner type checking and focused lint also pass. Offline regrading uses histories
whose SHA-256 hashes match the original capture. It changes exactly those two search cells to passed, producing
26 passed and one failed, with no additional live requests. The original gate verdict and receipts remain unchanged.

The remaining real quality failure is refactor sample one: the model supplied a mistyped absolute working directory
for a commit command, and exec_command correctly returned ENOENT. The other two refactor samples passed. All three
samples passed for completion/idle, provider empty/error recovery, cancellation recovery, reload continuation, and
background isolation. These observations describe this workload and model configuration; they establish no general
quality or performance improvement.

The profile settings were restored byte for byte after the final host exited. The control and full cycle used 293 solving
requests combined, plus 32 separately recorded readiness requests across the normal-profile launch, control, and full
cycle. The original infrastructure-blocked campaign retains its unknown solving-usage ledger. No extra solving budget
above the original 300 ceiling was needed. Runtime source and extension build remain unchanged by the grading fix.

TEST-LIVE-COPILOT-001 remains open for ordinary Git-enabled operation and strict all-sample acceptance. PERF-STATE-001
also remains open as recorded above. The complete follow-up, original and corrected counts, conditions, request ledger,
profile restoration, checks, and receipt integrity are recorded in live-cycle-summary.json under:

F:\alpha-e2e\campaigns\git-observer-control-2e7f045e-0e9a-40d8-a78d-63270a9d9136
