# Local benchmark host ownership

The full testing pass found that governed local benchmarks launched `code` from `PATH`. That ignored an explicit
`VSCODE_EXECUTABLE_PATH`, used the installed extension and editor profile, and could connect to an unrelated editor before
the existing IPC version check rejected it. This prevented reliable attribution of paid benchmark results to the current
VS Code 1.138.0 candidate.

Versioned local benchmark tasks now require an absolute native executable in `VSCODE_EXECUTABLE_PATH`. They reuse the
existing VS Code test profile adapter to create fresh user data, extension, and shared data directories, then launch the
current checkout's development extension directly. No sign-in state is copied. Before sending `StartNewTask`, the
evaluator requires actual VS Code 1.138.0 IPC identity, proves that the extension host descends from this evaluator process,
and compares the installed manifest and entrypoint digests with the selected source build. The execution receipt records
the owned paths and verified identity. Governed admission also requires the validated IPC acknowledgement to advertise
`targetedTaskCancellation: true`. An absent, false, or unrecognized capability rejects the request before paid start;
same-version manifest and entrypoint digests alone cannot prove an older bundle understands targeted cancellation.
The generic IPC server opts out unless configured, Alpha advertises its implemented handler, and the client clears
capabilities on disconnect. Each isolated launch also adds a fresh IPC namespace, because fresh evaluation
databases can reuse the same numeric run/task IDs and Windows named pipes do not inherit temporary-directory isolation.
Inherited Electron/VS Code routing variables are removed from the complete child environment, with Execa environment
merging disabled so they cannot be added back implicitly.

The existing IPC `CloseTask` operation saves files and closes the owned window. A successful isolated task must observe
that subprocess close through the existing bounded reaper before returning success. Errors and cancellation still abort
and reap only the owned subprocess. Profiles are retained for inspection, including when writer shutdown is uncertain;
the launcher does not delete them or terminate unrelated editor processes.

The first root creation/start binds the runtime ID synchronously, before publication or database writes. Child lifecycle
events remain evidence and cannot replace the root metrics owner or finish its evaluation. Each runtime contributes one
high-water cumulative cost/token/cache snapshot; repeated or lower snapshots do not add spend again. Tool counters use
the existing maximum merge within each runtime and sum across distinct runtimes. Context size remains the root context,
not the sum of unrelated windows. Unknown child usage or an unsettled child at root termination fails closed.

IPC uses ordinary EventEmitter delivery, which does not await asynchronous listeners. The evaluator now owns one ordered,
caught effect chain. Accepted publication/metric writes settle before successful finalization, so an older delayed update
cannot overwrite terminal usage. Pending effects are capped at 1,024 and observed runtime identities at 256; overflow is
an explicit failure rather than a dropped successful event. The existing task deadline and abort owner bound settlement.
Failure stops new effects, retains uncertain-write evidence, releases the owned host, and prevents follow-on writes when
an already in-flight effect eventually resolves.

Local history retention is registered when the stable root identity arrives, including failure/cancel paths. After host
reaping it reads the fresh profile's `User/globalStorage/<verified-extension-id-lowercase>/tasks/<root-id>` through the
existing copy helper. The owned temporary-root marker, path components, file types, symlinks, and resolved containment are
checked before copying API/UI/canonical-turn history. Container storage defaults remain unchanged. The previous local
path copied nothing, even though the interrupted run's four profiles contained all 12 nonempty history files and valid
canonical traces; graders correctly rejected the empty exported traces. No grader was weakened.

The prelaunch audit also reproduced six governed scheduling failures: startup errors were swallowed, and missing or
invalid task costs were treated as zero before another paid task was admitted. Governed campaigns now stop on an attempt
infrastructure error, lifecycle timeout, or unavailable actual cost; the existing controller cleanup and failed-run
evidence export still run. Valid zero cost remains valid, and completed graded failures with known spend can still
contribute campaign observations. Local execution cancellation stops further admission even when grader/safety status
has precedence in the stored trial. Persisted cancellation, safety failure, grader/infrastructure errors, and
missing/nonterminal trial evidence also stop admission, including while reconstructing a resumed campaign. Governed
safety failures now halt further paid admissions for investigation, consistent with the existing holdout safety gate.
Container transport still does not expose raw execution outcome independently, but every status that can currently mask
cancellation (`grader_error` or `safety_failed`) also stops admission; there is no known masked-cancel continuation under
the current classifier. Legacy best-effort scheduling is unchanged.

Governed OpenAI requests now receive the run's explicit input/output/cache pricing through the existing custom model
metadata. Other context and capability fields are preserved. The configured provider/model must match the recorded run,
and missing, nonfinite, or negative pricing fails before launch. This closes the previous artificial-zero-cost path:
OpenAI Compatible defaults deliberately price an unconfigured model at zero, while the campaign prices existed only in
its database record.

The task reservation narrows the existing maximum-cost approval pause, preserving an already stricter limit. Observed
usage at the limit sends one cancellation with the captured root ID through the existing IPC operation; it does not approve the extension's cost
pause. Unknown usage fails rather than authorizing the next task. Per-task execution and cost receipts retain configured
pricing, the observed limit and cost, cancellation state, and subprocess-close evidence. These are configured cost
estimates and an admission budget, not a provider invoice guarantee: one in-flight response or late usage accounting can
overshoot the observed threshold. No token-price prediction engine or replacement runtime is introduced.

Legacy local exercise calls retain their installed-editor behavior. Container benchmarks retain their exact, installed
image host/profile contract. The two existing test adapters are imported through typed literal imports only in the local
benchmark branch because the retained evaluator Docker context deliberately excludes `apps/`. Missing local adapters fail
with a source-checkout requirement before spawning the editor or sending a provider request. The existing manifest and
entrypoint identity reader is already present in that Docker context. Targeted cancellation extends the existing IPC
command with optional task data and optional acknowledgement capability; legacy calls without data preserve their public
current-task semantics. No authentication, sandbox, or parallel-runtime change is introduced.

The fresh isolated profile also removes the old random five-to-ten-second launch delay for these tasks. That delay guarded
shared editor instance contention; it is unnecessary for a fresh profile. Controlled-timer regression tests establish that
the existing three-second IPC startup wait is sufficient to reach the connection seam without that extra delay. This is
an eliminated artificial delay, not a measured claim about extension activation or model latency.

This fix concerns the VS Code adapter and evidence provenance, not agent behavior. The primary external reference was the
[official VS Code command-line documentation](https://code.visualstudio.com/docs/configure/command-line) and
[extension-testing documentation](https://code.visualstudio.com/api/working-with-extensions/testing-extension), retrieved
on 2026-10-20, for native executable launch, user-data isolation, extension directories, and development hosts. Actual host
identity remains authoritative when an executable override is supplied. Alpha's exact 1.138.0 repository contract is the
release target; Codex CLI is still the agent behavior reference. For cancellation ownership, the verified current Codex
commit [`18795fc12571a3530d3e4ac18366e41cd2f57448`](https://github.com/openai/codex/commit/18795fc12571a3530d3e4ac18366e41cd2f57448)
loads the requested thread and checks the expected turn before interrupting in
[`turn_processor.rs:1622–1685`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/request_processors/turn_processor.rs#L1622).
Alpha uses its existing task-ID owner and lifecycle handling rather than introducing another runtime. The general
ordered publication and terminal-settlement comparison is recorded in
[`codex-live-testing-reference-2026-10-20.md`](codex-live-testing-reference-2026-10-20.md).

Focused validation captured eight failing launch regressions, the inherited-environment regression, and six financial
scheduling regressions before their fixes. The earlier affected-boundary run passed 162 tests across the launcher, cleanup,
governed scheduler, task lifecycle, and campaign evidence suites. These cover platform argument boundaries, unsafe
executable paths, isolated profile/source selection, foreign IPC ancestry, changed manifest/entrypoint/version, exact
host version, missing process identity, fresh-database IPC collisions, exact child environment, normal completion,
cancellation, threshold cancellation deduplication, stricter existing limits, cached and uncached price calculations,
unknown-spend admission, root/child usage routing, rejected/stuck ordered effects, bounded overflow, local history
retention after success/cancel/failure, failed-run cleanup, and legacy/container compatibility. Three focused retention
tests also fail when the prior container-only condition is restored. Evaluator typechecking and scoped ESLint
passed. Live benchmark results must be recorded separately: these deterministic checks do not establish provider
availability, live task quality, or a successful paid campaign.

The later live Copilot problem-solving campaign exposed an equivalent automatic-admission gap in
`runLiveProblemSolvingCore`: after retaining a failed attempt, it stopped for authentication/profile ownership and
infrastructure failures without a trace, but continued after a terminal provider timeout, cancellation, or infrastructure
failure with a trace. A trace proves evidence was retained; it does not repair unchanged provider/profile admission.
The existing post-write guard now stops on provider, authentication, profile ownership, infrastructure, and cancellation
failures regardless of trace presence. Explicit provider failure attribution also stops admission when a surrounding
lifecycle assertion classifies the attempt as a task failure. A terminal `grader_error` also stops admission because the
grading infrastructure failed; this preserves the existing distinction from an ordinary graded `outcome_failed`.
Ordinary task assertions, graded outcome failures, and per-task request-budget observations still continue. No runtime
retry policy, receipt classifier, or wire format changes.

At Codex commit `18795fc12571a3530d3e4ac18366e41cd2f57448`,
[`tasks/mod.rs:643–677`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/src/tasks/mod.rs#L643)
preserves errors and distinguishes aborts, and its terminal event retains the error.
[`continue_after_stream_error`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/tests/suite/stream_error_allows_next_turn.rs#L20)
then permits an explicitly submitted new turn. Alpha's automatic benchmark stop is a test-campaign admission decision,
not a rule preventing a user from starting a later turn after an error. The upstream
[`turn_error_details_preserve_usage_reset_and_compaction_outcomes`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/core/tests/suite/turn_error_details_tests.rs#L76)
test preserves an already completed answer when post-turn compaction fails; the guard consumes the existing final attempt attribution,
not arbitrary intermediate error notifications.

Six deterministic regressions at the actual live campaign boundary initially dispatched all eight selected prompt
arms/repetitions/tasks after the first failure. With the guard fixed, they dispatch once and retain the written attempt
and original trace. Three continuation controls preserve separate ordinary outcome, task assertion, and request-budget
observations. All 16 live-runner tests pass using mocked Execa/host receipts, synthetic extension bytes, and
controlled Git identity; no editor or provider is launched by these tests.

The actual `PRE-PERFORMANCE-BUILD BASELINE` used exact VS Code 1.138.0, configured OpenAI `gpt-5.6-luna`, fresh owned
profiles/services, one iteration, and concurrency one. It retained the pre-performance extension bundle SHA-256
`d78cadfff2f1d155744b35552eccd27e79abba2dbe8ffd1e9dad983265345eb4` unchanged. Four of eight tasks were admitted before
the controller was explicitly stopped; task cancellation alone had allowed later admissions, which motivated the stop
policy above. Tasks 1–3 finalized as `grader_error` and retained known configured costs totaling `$0.105494`. Task 4's
`$0.0245576` persisted observation is partial and unreconciled, not a final charge. Remaining tasks were not admitted.
This interrupted run proves actual exact-host launch and exposes framework defects; it is not a passed T1 campaign,
performance comparison, or final-candidate acceptance. The captured controller/hosts, service containers, and anonymous
volumes were verified absent; profiles, sanitized DB export, and private runtime evidence remain for investigation.

The final-candidate T1 campaign exposed a separate evaluator process-ownership defect after all eight tasks had terminal
results and the canonical exports and final CLI JSON were written. The benchmark CLI had no connection finalizer, so its
Postgres and Redis sockets kept the completed command alive. This did not represent a still-running task. The existing
CLI entry point now awaits both existing database and Redis disconnect operations in `finally`, including after command
failure. Both cleanup operations settle even if one rejects. The original command error remains reported, cleanup errors
are reported separately, and either failure preserves a nonzero exit status. No forced process exit, model retry, task
result rewrite, provider contract, extension runtime, or packaged extension change is involved.

At the same pinned Codex commit,
[`exec/src/lib.rs:1375–1408`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/exec/src/lib.rs#L1375)
awaits the owned client's shutdown after the primary turn terminates. The
[`in_process_outbound_router_shutdown_does_not_wait_for_retained_sender` and flush-budget tests](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/in_process.rs#L980)
verify explicit shutdown and awaited completion. Alpha preserves its existing final JSON/export ordering and applies the
same ownership rule before process completion through its native TypeScript database/Redis adapters.

A model-free regression runs the actual `cli.ts` entry point in a Node 24.21.0 subprocess. Test-only import hooks supply a
controlled campaign and two real loopback TCP sockets; no provider or external service is used. Before the fix, export
completed but natural process exit timed out because the sockets remained open. All seven cases pass after the fix,
covering success, command failure, either or both cleanup failures, preservation of the original error alongside cleanup
errors, and a controlled barrier proving the process awaits both disconnect operations. This is evaluator process
lifecycle evidence, not a paid-campaign retry or a broad performance claim.

A later native-host accounting check identified optional presentation requests outside the primary task usage snapshot.
Automatic titles use a separate handler whose usage is not recorded in the task counters. Reasoning synopses record usage
but can finish after the terminal snapshot. The original final-candidate T1 observation of `$0.3085571` therefore means
configured cost observed through root/child task events; auxiliary charges and actual total provider charges are unknown.
The original eight outcomes, failed CLI finalization, usage receipts, and cleanup proofs remain historical evidence and
are not rewritten or retroactively certified by the following fix.

Governed attempts now send the host-owned, false-only `presentationModelCalls: false` option outside provider settings
and prompts. Before paid dispatch, the validated IPC acknowledgement must advertise `presentationModelCallOptOut: true`
as well as targeted cancellation support. The option suppresses optional automatic title and reasoning-synopsis requests;
the runtime retains it on reload and passes suppression to descendants. Omitted options preserve interactive behavior.
This does not change model selection, tool policy, task reasoning, or the existing admission-budget/in-flight overshoot
limit. An older same-version bundle without the new capability is rejected before `StartNewTask`.

The existing execution-identity callback carries a separately typed policy record. For a governed attempt, `processTask`
validates and awaits its `extension.presentation_model_call_policy` journal write before allowing dispatch; fingerprint
identity remains unchanged. The controller's existing continuation gate requires one matching, non-late, digest-consistent
policy event for every completed attempt before another paid admission, including resumed campaigns. The existing
evidence-query layer selects only policy fields for the exact attempt/type and reads at most two rows, so missing,
duplicate, malformed, mismatched, or late evidence fails closed. A later attempt's policy cannot certify an older
attempt's auxiliary spend. Historical rows and metrics remain readable; older completed rows without this provenance
cannot authorize further governed spending. No new ledger, database migration, recovery engine, or automatic replay is
introduced. Ordinary graded failures with known configured usage and valid policy proof retain their continuation rule.

At the pinned Codex commit, the interactive TUI owns cancellable title work in
[`tui/src/app/thread_title.rs:61–119`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/app/thread_title.rs#L61);
the inspected `exec/src/lib.rs` does not start that title generator. Alpha's reasoning-synopsis suppression is its own
optional-presentation admission rule; no upstream equivalent or billing guarantee is inferred. The host option preserves
Alpha's interactive feature while giving governed, noninteractive execution an explicit boundary around optional model
requests.

Focused model-free regressions first exposed nine host identity/capability/propagation failures, eight pre-dispatch persistence
failures, and fourteen continuation/resume failures. The affected host, lifecycle, and governed scheduling suites pass
67, 51, and 57 tests respectively. Existing price, cancellation, ordering, cleanup, and ordinary-outcome controls remain
in place. Two real PostgreSQL cases were added to the existing evidence integration suite for exact attempt/type isolation
and bounded duplicate reads; they require the separately owned fresh service validation before a pass can be claimed.
No new paid campaign or VS Code host was launched for this evaluator repair.
