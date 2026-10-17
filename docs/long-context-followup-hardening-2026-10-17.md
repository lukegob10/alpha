# Long-context follow-up hardening — 2026-10-17

## Scope and evidence

This is a follow-up audit and implementation pass over long retained conversations, completed-task follow-ups,
context rejection, terminal settlement, and transcript rendering. The intended behavior is that accepted input either
reaches its owning task once or remains visibly recoverable, completion preserves its durability fences, and a new
turn does not unnecessarily repeat historical rendering or journal recovery work. It does not establish the cause of
the previously reported gray panel: no matching task trace or renderer exception was supplied.

Alpha's tools, skills, previewer, Tickets, scheduled tasks, approval boundaries, and workspace protections remain part
of the extension. Codex CLI sandbox architecture is excluded. The reference extension host remains VS Code 1.125.0.
The existing, extensively modified worktree was preserved; changes in this pass were compared with captured file
baselines rather than treating all existing changes as this pass's work.

Current official Codex CLI HEAD was inspected on 2026-10-17 at
[`ce0323f2f2d3b25e82806cd555237da3db4e1897`](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897):

- [`session/turn.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/session/turn.rs)
  completes ordinary assistant text when no continuation remains, compacts around sampling boundaries, and ends a
  generic failed turn so the user can continue. A raw context rejection generally sets context usage full and returns
  an error; same-step recovery on that rejection is specialized. Alpha's existing bounded context recovery is an
  intentional implementation difference, not a claim that Codex retries every raw context error automatically.
- [`session/turn_input.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/session/turn_input.rs)
  owns start/steer admission against current turn state.
- [`stream_error_allows_next_turn.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/tests/suite/stream_error_allows_next_turn.rs)
  requires a failed turn to release its session and accept a later prompt.

## Reevaluation decisions

Twelve sub-agents covered context-error classification, completion waits, retained rendering, journal scaling,
queued-input recovery, Codex comparison, and exact-host regression coverage. Separate reviewers checked the final
wait/retry changes, journal integrity, UI/queue admission, and host fixtures before integration. Candidates were
implemented only after the owning code and reproduction supported the proposed fix.

| Candidate                                                                       | Decision and reason                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context recovery depends on tool auto-approval                                  | Confirmed defect. A recognized first-chunk context error without `retryable: true` entered manual Retry before bounded recovery. Use the existing context retry budget independently of tool approval. Explicit `retryable: false`, partial-output protection, and exhausted-budget behavior remain enforced. |
| Final completion and follow-up admission can await a stalled dependency forever | Confirmed with controlled promises. Bound the final evidence snapshot and the follow-up admission join with cancellation and a 30-second deadline. Preserve the old lifecycle owner and fail closed on timeout. General termination joins remain durability joins.                                            |
| A retained completed-task queue entry has no working explicit delivery action   | Confirmed. Retry the existing receipt through completed-task resume, using the current runtime and terminal-state guards. Do not add automatic retry loops.                                                                                                                                                   |
| Progressive rendering must always discard all but 80 rows                       | Rejected as a direct patch: it would break native scrolling, explicit Load all, checkpoint navigation, and focused controls. The confirmed narrower defect is that global active-turn state remounted collapsed details from completed turns.                                                                 |
| Sequential journal appends reread the whole log                                 | Corrected finding: sequential appends already use a file-stamp cache. Warm Task lifecycle recovery reads explicitly forced replay, so add a cache-validated refresh there; explicit replay and cold recovery still validate durable files.                                                                    |
| Remove full transcript cloning, hashing, or receipt checks                      | Deferred. The cost grows with retained history, but those operations enforce coherent snapshots and external-edit integrity. This pass does not weaken them without a measured replacement design.                                                                                                            |
| Count every full request before every model call                                | Deferred. The earlier estimate finding is a risk rather than proof of a broken contract; upstream also has an explicit TODO around incoming-input precompaction estimates. Avoid adding token-count latency to every step without measurement.                                                                |

## Implemented behavior

The retry change keeps Alpha's existing attempt limits, recovery deadline, original user-message identity, and
post-output safeguards. A context error does not authorize a tool or change approval policy.

The final completion change bounds one evidence snapshot while holding the existing mutation gate. It does not call
the polling completion helper inside that gate, because receipt publishers need the gate to settle. Successful
verification remains the last asynchronous gate, including the transcript queue identity check. Timeout or
cancellation follows the existing rollback and incomplete-task path; a late result cannot publish completion.

The follow-up deadline releases only that admission waiter. It does not clear the prior lifecycle owner, replace its
services, overlap terminal writes, discard queued input, or declare the prior work successful. The existing durable
queue remains the recovery route. An admission guard that becomes false also releases its selected receipt. The
admission flag stays owned while that release is published, preventing a queue callback from automatically restarting
an input whose runtime or goal guard just declined it. Explicit queue delivery can retry the same saved input once the
completed primary task is eligible again. A persistently blocked storage writer still requires its own settlement before
the task can safely restart.

Collapsed completed activity stays unmounted during later active turns. Explicit expansion still mounts its details,
and current live actions retain their listeners and DOM identity. A deterministic fixture with 256 historical detail
rows went from 260 mounted mocked ChatRows during a follow-up to 4. Expansion restores all 260. This is a rendering
work proxy, not a measured wall-time or proof that it caused the reported gray panel.

Reproduce the rendering proxy with
`pnpm --dir webview-ui test src/components/chat/__tests__/ChatView.spec.tsx --maxWorkers=2`.

Warm Task lifecycle refresh uses the journal's existing file-stamp validation under its events lock. An external writer or
changed snapshot invalidates the cache; explicit replay remains forced. Persisted event/snapshot formats do not change. In a 2,100-event fixture spanning 100 turns, ten unchanged warm refreshes reduced full journal reads from 10 (3,859,700 bytes) to zero. This measures avoided recovery I/O, not overall task latency or snapshot projection cost.

Reproduce the journal proxy with
`pnpm --dir src test core/agent/lifecycle/__tests__/AgentLifecycleJournal.spec.ts --maxWorkers=2`.

The exact-host runner now removes `ELECTRON_RUN_AS_NODE` from the child environment after merging launch variables.
The current environment inherited `ELECTRON_RUN_AS_NODE=1`; this made Electron try to run the workspace as a Node module
and explains the earlier `host-preflight-missing` result. The
[official Electron environment contract](https://github.com/electron/electron/blob/main/docs/api/environment-variables.md#electron_run_as_node),
retrieved 2026-10-17, defines this variable as selecting Node mode. The launcher regression verifies removal from both
inherited and explicit test environment while preserving other fixture variables and the parent environment.

The new exact-host regression builds twelve completed turns in the same retained Task, then rejects the next prompt
with a first-chunk context error while tool approval remains in ask mode. It requires one compaction, exactly one
retry, and successful completion of another prompt, with no manual Retry/Resume ask. Assertions cover the same task
instance, all twelve prior prompt/answer markers before recovery, smaller effective provider context afterward, the
summary, a nonempty assistant suffix unchanged from the rejected request, the full stored archive, and the final
canonical Completed lifecycle. A valid compaction keeps recent tail messages; the test deliberately checks reduced
history rather than zero old answers.
This exercises the extension host and real Task persistence, not webview rendering latency.

The existing worktree also generates task titles through separate provider requests. Stateful scripted host fixtures
now answer `attemptId === "title"` before advancing task counters or invoking task gates. Their task assertions remain
intact; production title behavior was preserved. This compatibility adjustment covers the smoke and managed-agent
fixtures used by the required validation commands.

The VS Code LM fixture has no attempt metadata on its wire. It recognizes the specific two-message, tools-disabled
title request before applying task scenario counters and gates. Three fixture unit tests verify title isolation,
ordinary no-tools recovery/cancellation, and rejection of six partial lookalikes. All seven unchanged exact-host LM
contract tests pass with this adapter; production LM and title behavior remain intact.

## Validation and closure

Validation results and the final closure ledger are recorded after integration below. Focused reproductions use
controlled promises, fake timers, scripted providers, or observable mount/read counts; no live-provider result is used
as a general performance claim.

Completed integration checks:

- Sixteen affected extension suites: **1,199 passed, 6 existing skips**. Coverage includes Task retry/stream recovery,
  provider outcomes, completion/persistence, follow-up ownership and queue delivery, journal crash recovery, and
  provider/webview handlers. The final combined run is recorded in `/tmp/alpha-long-followup-final-core.log`.
- Four affected webview suites: **252 passed**; extension and webview type checks passed.
- Five additional compaction/context suites: **189 passed**.
- Host launcher unit tests: **7 passed**, including a failed-before environment reproduction.
- VS Code LM fixture unit tests: **3 passed**. The exact **1.125.0** LM contract suite then passed all **7** tests
  in run `8dcc1dca-be4f-4d49-9f4d-633c80a4f5f1`; both background-command cases passed in run
  `bd7e2d44-727b-4010-b11a-bc80d449b1f2`.
- Targeted exact VS Code **1.125.0** compaction suite: **3 passed, 0 pending**. The successful scripted-provider run ID
  is `e218ab70-8e2f-4f9b-bf9f-a7e08f56eac2`; actual host version and isolated run profile were verified by the runner.
- Touched extension/webview/E2E ESLint checks, E2E compilation, extension/webview bundle, formatting, and whitespace
  checks passed. The CommonJS LM fixture reports four existing lint warnings and no errors.

The full required `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` command passed: **43 tests across 13 suites,
zero failures and zero pending tests**, with actual VS Code **1.125.0** verified for every host. The final compaction
run is `ad2323e3-043e-44a4-a95b-47031c64a9fd`, the LM contract run is `401a97bc-acea-4e53-b7fb-858e309bbf7d`, and the
background-command run is `7548111b-d1c5-4396-9e10-9f57fcdb276b`. The run used isolated fixture profiles, scripted
providers, and the deterministic VS Code LM fixture. It does not claim live-model or manual renderer stress coverage.
The command log is `/tmp/alpha-long-followup-smoke-final.log`.

The additional required invocation is `pnpm certify:managed-agents:automated`. Its deterministic result is written by
the certification script to [generated source-bound evidence](../artifacts/certification/managed-agent-milestone-evidence.json).
The subsequent exact-host managed suites and exit status are recorded in `/tmp/alpha-long-followup-managed-certification.log`.
This report remains unchanged during and after certification so the generated evidence can identify its exact source
state. Deterministic and scripted-host checks do not replace live-provider, multi-window, or manual UI acceptance.

| Finding                                                  | Closure                                 | Evidence or limit                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context recovery blocked by tool approval                | Fixed                                   | Targeted retry tests and the exact-host retained-thread regression. Explicit nonretryable and partial-output paths remain protected.                            |
| Stalled final evidence read or prior-turn admission      | Fixed at the identified wait boundaries | Controlled timeout/cancellation regressions. Durable prepare/rollback and storage writes still have to settle; deadlines do not repair a wedged store.          |
| Queued completed-task receipt cannot be retried          | Fixed                                   | Ten host-handler integration tests; same receipt, image/text payload, runtime identity, and lifecycle guards.                                                   |
| Admission guard strands claimed input                    | Fixed                                   | Four failed-before guard cases; release remains owned until persisted, preventing an automatic wake on rejected admission.                                      |
| Historical completed details remount on follow-up        | Fixed                                   | Observable mocked mount-count regression; native scrolling, expansion, checkpoint navigation, and live controls retain their existing paths.                    |
| Repeated unchanged journal recovery reads                | Fixed                                   | Locked, file-stamp-validated refresh; external append/tamper, ordered-write, and forced replay coverage. No persisted format change.                            |
| Exact-host runner inherits Electron Node mode            | Fixed                                   | Failed-before launcher unit test and a successful real 1.125.0 launch.                                                                                          |
| Reported gray-panel incident                             | Unconfirmed                             | No matching renderer crash or production trace was available. The rendering fix removes confirmed unnecessary work, without claiming this incident is resolved. |
| Full archive cloning/hashing and incoming-token estimate | Deferred                                | Preserve integrity checks and request behavior until a measured replacement design is available.                                                                |
