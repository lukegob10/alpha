# Extreme bug hunt: integration evidence

Reviewed October 1–2, 2026 America/New_York (October 2 UTC). This is a bounded full-surface audit and repair pass,
using four user-owned chats with three subagents each, followed by three coordinator integration audits.
The four primary lanes reproduced and fixed 33 findings. Coordinator repairs below close additional cross-layer
failures. This report does not claim exhaustive bug freedom, complete Codex parity, or a general speed improvement.

## Handoff status

Stopped at the user's request on 2026-10-02. The reproduced findings and integration repairs are implemented.
The recorded unit, smoke/core host, and package gates passed before separate concurrent edits in this checkout.
The latest strict certification passed all 2,875 tests and all 26 deterministic evidence rows, but failed its
source-stability requirement because the checkout changed during the run. Final certification, its additional
managed/fanout hosts, and refreshed packaging remain pending until that work settles. Checks below are receipts
for the tested revision, not validation of the subsequently changing tree.

## Reference and preserved scope

The behavioral reference is official Codex CLI commit
[`cb6da58876afed3ede0ab11084f67dd5394ecb48`](https://github.com/openai/codex/tree/cb6da58876afed3ede0ab11084f67dd5394ecb48),
retrieved 2026-10-02. Each lane records the particular upstream implementation and tests it inspected. Alpha implements
the verified invariants in its existing TypeScript kernel, provider adapters, task integration, and VS Code surfaces.
No Rust runtime, upstream implementation, copied prompt, or parallel agent engine was introduced.

Alpha's existing execution, approval, workspace, and process protections remain the execution architecture. Its skills,
HTML previewer, native tickets, and scheduled tasks remain integrated extension capabilities. The user-authorized exact
host is **VS Code 1.125.0**, including all automated hosts and the Alpha-owned profile. Earlier 1.122.1 references in
historical design work describe the former baseline.

All preexisting changes were retained. The coordinator captured the starting diff, status, filtered surface inventory,
and developer-script inventory under
`C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-extreme-bug-hunt-baseline-20261002`.
No reset, stash, staging, commit, release-version edit, or dependency upgrade was performed for this audit.
The lockfile changes predate this pass and belong to the requested 1.125.0 types migration.

The requested old 1.122.1 and 1.136.1 downloaded caches remain under the root and E2E `.vscode-test` directories.
Their resolved literal paths and absence of running cached processes were checked, but automatic approval review
rejected their deletion with `blocked by policy`. No alternate deletion mechanism was used. Runners select 1.125.0.

## Primary lanes

| Lane                    | Fixed findings | Principal repaired behavior                                                                                                                                                                                                        | Detailed evidence                        |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Core loop and providers | 10             | Continuation reaches Task, malformed tool calls cannot disappear behind successful text, final receipts preserve executable identity, child authority and results stay owned                                                       | [Core ledger](core-loop.md)              |
| Tools and cancellation  | 6              | Approval revocation fences reads, failed preflight fences later effects, pending MCP startup is joined, split terminal markers retain output, moves and tool registration are atomic                                               | [Tools ledger](tools-cancellation.md)    |
| Persistence and context | 10             | Completion saves survive refresh races, discovery publishes complete generations, recovery retains readable sources, compaction checks ordered unique transactions, captured prompt settings stay frozen                           | [Context ledger](persistence-context.md) |
| UX and performance      | 7              | Chat identity and drafts stay together, broadcasts retain order across views, saved schedules preserve authority and hidden constraints, historical suggestions cannot answer a new question, failed HTML refresh preserves images | [UX ledger](ux-performance.md)           |

Lane ledgers are frozen historical handoffs. Their intermediate typecheck blockers and coordinator-owned flags must be
read with the integration results below; a lane's READY status was never a whole-repository validation claim.

## Additional integration repairs

### Worker capture failure retains the only recoverable edits

**Critical / must-fix — fixed now.** Worker capture formerly removed its physical worktree in `finally` even when reading the
Git index, writing the patch, or first publishing metadata failed. Three real-Git regressions failed before the repair
because both edited and newly created worker files were gone. Capture now removes the worktree only after its changes
are durably published. Temporary index cleanup remains owned. Reload captures the retained orphan once and preserves
the parent working tree and index. The persisted representation is unchanged.

Owning implementation: `packages/core/src/worktree/managed-subagent-worktree.ts`. Regression:
`managed-subagent-worktree.capture-recovery.spec.ts`. Focused three-file command: **25 passed**. Core typecheck and
scoped lint passed. Certification now includes all capture/persistence tests and requires failure-recovery evidence.

### MCP disposal accounts for pending view acquisition

**High / must-fix — fixed now.** A disposed view could register a client after its pending MCP startup completed.
Conversely, one view's zero client count could dispose a hub while another view still owned pending acquisition.
AlphaProvider now joins its initialization and releases its lease exactly once. McpServerManager owns shared-hub cleanup
using provider leases, including pending views; McpHub preserves its public default disposal behavior for other callers.
Unpublished initialization failures retain the tools lane's cleanup correction.

Four controlled regressions failed before the repair. The full affected provider/manager/hub checks produced
**225 passed / 6 existing skips**. Runtime and wire formats are unchanged.

### Approved plans remain complete model-visible evidence

**High / must-fix — fixed now.** The context lane demonstrated that the stored full approved plan was silently clipped
at 24,000 characters, or 4,096 for a small model. Its synthetic provenance path had no tool retrieval route. Default
handoff attachment now includes the complete approved plan. Explicit bounded previews remain available to callers.
Task measures the complete prepared request against mandatory-context admission before sending it; oversized input
fails explicitly without discarding the approved plan or mutating history. Retry reuses its admitted step snapshot.

Four regressions failed before the repair, including a tail-only final requirement, reload, a small-model request, and
oversized first-request admission. Handoff/compaction/retry checks: **160 passed**. Extension types and scoped lint passed.
This intentionally increases input where the previous request omitted requirements; no token-saving claim is made.

### Async answers track host admission and retain retry state

**High / must-fix — fixed now.** Locally posting answers formerly marked the card permanently answered before the host
accepted them. Rejection left the card disabled, and an equal timestamp in another chat could retain the previous chat's
draft. Cards now render pending admission separately from accepted answers. The host receipt must match task, command,
and request ID; rejection releases pending state and retains answers. Old or foreign receipts cannot accept a retry.
The existing task draft records carry correlation, and the synchronous draft owner prevents duplicate admission before
React commits. Card identity includes task ID and message timestamp.

The coordinator reproduced all three affected ask/queue/completed-resume paths; the card audit separately reproduced
rejection and cross-chat draft leakage. Final expanded UI checks: **258 passed across 6 files**. Webview types and
scoped lint passed. Existing shared receipt and persisted formats remain unchanged.
See [async-answer evidence](async-answer.md).

### Native provider EOF is distinct from successful completion

**High / must-fix — fixed now.** Gemini and Anthropic Vertex did not emit canonical lifecycle outcomes, allowing partial
text, missing terminal markers, token exhaustion, and unfinished calls to look complete. Adapters now report protocol
completion, incomplete output, and continuation through the existing canonical outcome contract. Retry after partial
semantic output remains fenced. Protocol-invalid custom gateways now fail explicitly rather than succeeding at EOF.

Ten initial regressions failed before the repair; the expanded outcome file has **30 passing cases**. Provider/transport
checks: **118 passed**; transform/kernel consumers: **75 passed**. Certification now selects both active Vertex adapters
and these outcome tests alongside OpenAI and VS Code LM. See [provider EOF evidence](provider-eof.md).

### Output failure retains physical command ownership

**High / must-fix — fixed now.** Execa output failure could manufacture exit 1 and release a still-running command.
A real callback failure also hung while Execa closed an iterator that itself awaited process exit. The output owner
now initiates Alpha's existing tree termination before iterator closure and observes actual subprocess settlement
before releasing ownership. Failed termination remains observable and Stop remains retryable.

The follow-up also reproduced ignored asynchronous line rejection, finalization failures becoming success, a held
user question being returned as output work, and two stale cleanup writes against a replacement command. The owner
joins returned output and completion promises, backpressures at 16 pending output observers, preserves the original
failure, and leaves a replacement's busy/running/process/stream untouched. Only the command controller's already-caught
user-question continuation is detached; it cannot hold output finalization.

Final terminal plus command-consumer checks: **263 passed / 12 existing skips / 18 files**, including **52 Execa** cases
(16 controlled settlement probes and four real-process cases) and **75 command-consumer** cases. Extension types, scoped
lint, formatting, and diff checks passed. See [process settlement evidence](process-settlement.md). Code and all three
integration audit ledgers are now frozen.

### Repetition stops survive their own terminal receipts

**High / must-fix — fixed now.** The first combined unit run caught a feedback loop introduced by observing all
preflight receipts: the scheduler's own repetition-stop receipts became fresh detector evidence and reopened admission.
The unchanged serial regression observed 18 effects where the bound was 12; the parallel regression admitted four
additional calls after its initial three-call window. Internally generated repetition skips now retain provenance and
do not become new observations, including through deferred result copies. Genuine preflight errors remain observed;
real handler output with the same text remains evidence. Every skipped call still receives its terminal receipt.

Both original regressions failed before the correction. Five additional probes cover both stopping gates, deferred
copies, and lookalike handler text. **50 progress cases** and **176 scheduler/command/deferred-result cases across five
files** passed, as did extension types, scoped lint, formatting, and diff checks. The offline core-confidence regression
command now explicitly selects the progress file. This preserves Alpha's existing repetition policy; the upstream
admission/handler distinction was verified in the pinned Codex parallel-tool implementation and tests.

### Partial test fixtures preserve real runtime ownership

The same combined run exposed seven failures across three partial fixtures. Real Task owns its message buffer and
lifetime cancellation controller; real AlphaProvider implements queue publication. Fixtures now supply those required
owners. The controlled mention barrier observes early request rejection immediately, so an unexpected error produces
its actual diagnostic rather than a timeout and unhandled assertion rejection. Existing receipt, consumption, stable
retry, and provider-boundary assertions remain intact. New assertions also hold acceptance until queue publication and
keep noninteractive cards from advancing the input boundary.

These are fixture corrections, with no production fallback or weakened assertion. Focused ask/card/handler checks:
**131 passed**; queue/steering/completion checks: **92 passed**, including all 17 queue-receipt cases. Types, scoped lint,
formatting, and diff checks passed. The first whole-suite failure is retained in
`artifacts/bug-hunt/20261002/unit-all.log`; the final combined run after all repairs passed as recorded below.

### Published recovery asks project their owned input boundary

**High / must-fix — fixed now.** The first response-boundary host exposed a two-second disagreement: a terminal turn
had published an owned `resume_task` question, but the registry still projected the task as running until Task's delayed
attention timer fired. Real `Task.ask` calls under a controlled clock reproduced the gap for both failed and interrupted
turns. `TaskSessionRegistry` now resolves only the current runtime-owned, published ask timestamp and uses the existing
ask projection for its input boundary. It does not infer authority from an arbitrary historical question or change the
canonical terminal journal. Explicit terminal task state keeps precedence. Background sessions use the same registry.

The existing 2,000 ms attention timer remains; the controlled regression requires Waiting/Resumable metadata before it
fires. Answered, superseded, cancelled, and new-turn boundaries receive adjacent coverage. Two initial regressions and
four stale/cancelled-owner guards failed before correction. **375 tests across seven affected files** passed, including
the full Task and provider host-ownership consumers. The final registry rerun passed **38 tests** after using the existing
shared array helper compatible with the extension's TypeScript library target. Types, scoped lint, formatting, and diff
checks passed. This is a deterministic removal of the observed projection delay, not a claim about general model or
rendering latency. Certification selects the new published-ask regression file.

## Shared gate coverage

New real-extension tests in `apps/vscode-e2e/src/suite/core-loop-boundaries.test.ts` check continued visible text,
malformed tool-call arguments, and incomplete provider output. They require canonical runtime state, exactly-once
completion, failure, or interruption, no accidental tool effects, and complete durable tool transactions to agree.
Malformed calls end as `failed`; Alpha's existing canonical incomplete outcome ends as `interrupted`, with a durable
error and an owned `resume_task` boundary. Recovery waits for explicit human input. The first host attempt exposed an
incorrect fixture assertion expecting `failed` for both outcomes; the corrected test asserts each exact contract,
including terminal payload, current ask identity, and resumable task metadata. The original failed receipt is retained.

This status label is an intentional existing divergence: pinned Codex classifies exhausted SSE EOF as a stream error
(`codex-api/src/sse/responses.rs`, `core/src/session/turn.rs`), applies bounded transport retry, and preserves conversation
recovery after the terminal error (`core/src/tasks/mod.rs`, `core/src/agent/status.rs`). Both forbid false completion;
Alpha's canonical `incomplete` fixture explicitly requests no retry. This test does not imply literal upstream status
label parity or require a persisted-format migration.

`test:core:1250:run` includes these tests plus existing core-loop, completion-idle/follow-up, managed-agent, and
long-context fanout hosts. `runCoreConfidence` now includes the same new boundary and fanout scenarios, so the CI
confidence command cannot omit them. Two focused runner tests failed before that registration; all seven pass after
the change, including fail-fast verdicts for either added scenario. The managed-agent matrix includes failed Worker
capture, Execa physical settlement, published recovery ownership, and active Vertex protocol coverage.
Matrix self-check passed with ten tracks, 26 deterministic requirements,
and eight explicitly pending live integration requirements.

All host runs use `F:\alpha-e2e\profiles\1.125.0\user-data` with the exact downloaded 1.125.0 binary. Fixtures use
fresh Alpha-owned workspaces, and artifacts are under `F:\alpha-e2e\artifacts`. Scripted/VS Code LM fixtures exercise
the real extension without paid live model requests. A fixture pass does not establish live-provider quality or speed.

## Final validation and retained evidence

The audit lanes froze their changes before these gates. Builds, broad tests, host launches, and packaging ran serially;
independent lint and type checks ran together. Separate concurrent edits subsequently changed the production tree.
Logs and summarized receipts are under `artifacts/bug-hunt/20261002/`.

| Command                                                                                  | Observed result                                                                            | Evidence                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `pnpm lint`                                                                              | PASS, 8 tasks                                                                              | `lint-freeze.log`                                             |
| `pnpm check-types`                                                                       | PASS, 9 tasks                                                                              | `types-freeze.log`                                            |
| `pnpm test --concurrency=2 -- --maxWorkers=2`                                            | PASS, 12,296 tests / 44 existing skips / no failures or unhandled errors                   | `unit-all-freeze.log`                                         |
| `pnpm test:core:regressions`                                                             | PASS, 432 selected tests; these files also passed in the final whole suite                 | `core-regressions-final.log`                                  |
| `pnpm --dir apps/vscode-e2e test:unit`                                                   | PASS, 471 tests / 2 existing skips                                                         | `e2e-runner-unit.log`                                         |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                                   | PASS, 34 assertions / 12 exact hosts                                                       | `host-smoke-freeze.log`, `host-smoke-summary.json`            |
| `pnpm --filter @alpha-code/vscode-e2e test:core:1250:run`                                | PASS, 9 assertions / 5 exact hosts                                                         | `host-core-freeze.log`, `host-core-summary.json`              |
| `pnpm bundle`, `pnpm vsix`, `node scripts/verify-vsix-contents.mjs bin/alpha-3.1.3.vsix` | PASS; 1,675 entries verified; required files present; no `.env` packaged                   | `bundle-final.log`, `vsix-final.log`, `vsix-verify-final.log` |
| `pnpm certify:managed-agents:self-check`, `pnpm certify:managed-agents:list`             | PASS; 10 tracks / 26 deterministic rows / 8 pending live rows; published-ask file selected | `matrix-self-check-final.log`, `matrix-list-final.log`        |

The final whole-suite extension run passed 9,793 tests with 42 existing skips. Valid cached results from unchanged
packages contribute webview 1,958 passed / 2 skipped, types 369, core 172, IPC 3, and build 1. Focused counts overlap the
whole-suite and certification selections and must not be summed as unique tests. The core regression command ran before
the final registry repair; every selected file also passed in the final whole-suite run. Initial failing combined/host
logs remain retained; a historical baseline pass is not presented as validation of these repairs.

All 17 final smoke/core receipts report actual host 1.125.0, the Alpha-owned profile, verified process ownership,
complete capture, and observed host exit. Smoke receipts are under
`F:\alpha-e2e\artifacts\bug-hunt-20261002-smoke-final`; core receipts are under
`F:\alpha-e2e\artifacts\bug-hunt-20261002-core`. Core run IDs, in command order:

- `f1ea95f1-40cb-4a7f-85b1-df18b3aa5e3f`: ordinary visible-text completion, three samples.
- `71ae8877-c372-4e31-831e-8d6cf91f742f`: continuation, malformed call, and incomplete output boundaries.
- `ab02ac77-0481-4046-8ab4-18604d2fcf46`: implementation, 35,027 ms completed-idle window, and same-task follow-up.
- `04397512-e4f0-4f78-9b3f-006f098b11ca`: nested Worker Apply/discard, verification, cancellation, and projection.
- `454d1198-93b4-40db-8362-16d94296db32`: five concurrent ticket-review agents with a 302,941-byte prompt.

The idle window held model requests at 20 before/after, with Completed/Idle metadata and no pending input. The explicit
follow-up advanced to 23 total requests, six completed turns, and 17 matching tool call/result pairs with no errors.
Fanout required all five children to enter before any could finish; each child used one model request, the parent used
three, all six tasks completed once, and all six tool transactions were paired. These are scripted contract workloads,
not measurements of live-model problem-solving quality or a general latency improvement.

The first source-bound certification passed all **2,875 tests** and retained stable source, but rejected one evidence
probe whose literal asynchronous test name predated its expansion into four parameterized finalization failures.
The corrected matcher requires that exact four-case declaration and its adjacent test title. The callback/result
assertions and all production code are unchanged. The rejected attempt and original generated receipt remain in
`managed-automated-probe-failure.log` and `managed-agent-probe-failure-evidence.json` under the audit artifact directory.

The subsequent source-bound `pnpm certify:managed-agents:automated` used the new `completion-idle.json` as
`ALPHA_COMPLETION_IDLE_EVIDENCE`. All **2,875 tests** and **26 deterministic evidence rows** passed, but the command
exited unsuccessfully because separate concurrent edits violated source stability. The generated
`artifacts/certification/managed-agent-milestone-evidence.json` therefore remains a failed certification receipt,
with eight live rows pending; `artifacts/bug-hunt/20261002/managed-automated-final.log` records the attempt.
Its additional managed/fanout host stages did not run. The prepared fresh workspace is
`F:\alpha-e2e\bug-hunt-certification-workspace-20261002`, with the intended receipt bucket at
`F:\alpha-e2e\artifacts\bug-hunt-20261002-managed`. A fresh run against stable source is required when work resumes.

## Coverage and remaining priorities

| Surface                                                                   | Coverage status               | Closure and remaining limit                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent kernel, Task integration, delegation, provider normalization        | reviewed / edited             | Reproduced findings fixed; smoke/core exact-host gates passed; full live provider interruption and quality not verified                                                                                     |
| Filesystem/tool policy, scheduler, command process ownership, MCP startup | reviewed / edited             | Reproduced findings fixed; noncooperative remote transport shutdown, reconnect/watchers, and preprocessing byte caps not verified                                                                           |
| Persistence/replay, compaction, prompts, ticket recovery, skills/commands | reviewed / edited             | Reproduced findings fixed; compatibility-aware malformed UI history and cross-instance metadata merge remain flagged                                                                                        |
| Chat, settings buffer, history, schedule presentation, HTML viewer        | reviewed / edited             | Reproduced findings fixed; actual narrow-sidebar/theme/high-contrast/focus visual review not verified                                                                                                       |
| Performance                                                               | reviewed / measured narrowly  | Foreign child result no longer reruns the owned child; HTML ready replay baseline is retained. Streaming render counts, activation, live latency/tokens/cache and problem-solving quality remain unmeasured |
| Developer scripts and retained packages                                   | inventoried / selected checks | Script inventory is heuristic, not proven dead code; no speculative deletions. Root scripts, E2E registration and certification were edited where owned                                                     |
| Retired standalone runtime, evaluator DB infrastructure, Codex sandbox    | out of scope / not present    | No new standalone runtime, database integration, or sandbox replacement                                                                                                                                     |

Highest follow-ups are malformed historical UI records/graphs with compatibility-aware readers; recurring schedule
timezone/DST and physical child shutdown contracts; stalled read-only preparation and noncooperative MCP transport
cancellation; and measured streaming/activation plus live multi-ticket fanout quality. Legacy `moveSkill` reconstructs
an Alpha source path for portable `.agents` skills, but the current settings UI uses `updateSkillModes`; characterize
that retained wire operation before changing migration semantics. Shared `.agents` skills are deliberately preserved
by the earlier project-configuration contract; project MCP and Alpha-owned configuration use `.alpha`.

No remaining item is represented as a proven, repaired defect merely because it appeared in a search or ledger.
Future performance claims require matched workloads and provider/cache conditions, not unit-suite wall time.
