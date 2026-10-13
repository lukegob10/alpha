# Codex workflow bug hunt — October 10, 2026

This is a bounded contract-alignment pass requested by the user: investigate with the maximum allowed subagents on
`gpt-6.1-sol` with `max` reasoning, then launch a separate fix wave. The environment allows four active agents including
the coordinator, so each wave uses three workers. All workers share the checkout with explicit ownership boundaries.
A seventh SOL 6.1/max worker performs a fresh read-only integration review after the skill fixer finishes.

The investigation covers turn execution, cancellation and approval admission, native OpenAI response history and replay,
scheduled-task finalization, and skill settings. It preserves Alpha's sandbox and approval protections, Tickets, skills,
HTML previewer, and scheduled tasks. The existing hybrid-search changes were present before this pass and are protected
with a file-content hash baseline. This pass does not claim complete Codex parity or a comprehensive repository audit.

## Reference and evidence

Current upstream is pinned to
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/commit/cc7ba33601286a751477832b01de7b6f8de0dd9c),
committed at `2026-10-10T22:28:01Z` and retrieved on October 11 UTC (October 10 local time).

- [Parallel dispatch and cancellation admission](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/tools/parallel.rs)
  separates approval/admission from starting execution. Its cancellation-before-dispatch test asserts the handler has
  not started. Alpha retains its own permission and execution machinery.
- [Dynamic tool cancellation tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/dynamic_tool_cancellation.rs)
  preserve terminal tool results before the turn's terminal event.
- [Ordered conversation history](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context_manager/history.rs)
  retains response-item order for subsequent requests. Alpha's canonical response accumulator and persistence boundary
  must preserve the same observable contract in TypeScript.
- [Streamed and final response history tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/client.rs)
  verify ordering and deduplication when both delivery paths describe the same item.
- [Skill selection](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/skills/src/selection.rs)
  and [selection tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/skills/src/selection_tests.rs)
  support explicit skill identity and reject ambiguous plain-name selection. Alpha's mode-specific skill directories and
  Any-mode setting remain intentional extras.
- [Recovery after a stream error](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/stream_error_allows_next_turn.rs)
  verifies a failed turn releases the session so subsequent work can proceed.
- [Native command execution](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
  returns a completed process receipt with its exit code. Alpha's existing native command tests likewise distinguish a
  successful tool transaction from a process that exited unsuccessfully.

Official [subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) was also checked. Source and
tests above own the implementation comparison. No Rust or upstream prompts are copied into Alpha.

## Confirmed findings

| Severity           | Finding and user impact                                                                                                                          | Owning invariant                                                                                                  | Initial reproduction                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| High, must-fix     | A failed scheduled terminal write loses its live-task mapping, leaving a completed or aborted run stored as running.                             | Retain the original terminal intent until it is durable; saving retries must never rerun the task.                | Two failures covering completion and abort after one injected `completeRun` rejection.                               |
| High, must-fix     | Opening or changing a mode-specific skill can target another same-name skill; saving the Code variant overwrites its generic sibling.            | The UI, message handler, and manager must carry and validate the selected variant's identity.                     | Two failures using real generic and Code `SKILL.md` fixtures.                                                        |
| Medium, should-fix | Native OpenAI response reasoning is moved to a prefix when history is saved, changing its position relative to text and tool calls after reload. | Preserve ordered opaque reasoning through the adapter, canonical response, persistence, and replay.               | Two failures, streaming and nonstreaming, through the real adapter and Task persistence methods.                     |
| Medium, must-fix   | Stopping during MCP approval preflight records an effect as started even though no MCP read dispatched. Replay labels its result indeterminate.  | Approval preparation is not execution; the effect-start journal entry belongs immediately before actual dispatch. | One controlled-barrier failure with four assertions, including journal replay and provider-facing cancellation text. |
| Medium, should-fix | Selecting Any mode for a skill under a Code-specific directory leaves it unavailable in Plan after rediscovery.                                  | Explicit Any-mode intent must override the directory's default restriction.                                       | One failure with an isolated directory-scoped skill fixture.                                                         |

Investigators also ruled out two candidates after tracing production callers: OpenAI summary text is already suppressed
when encrypted reasoning is available, and the ordinary lifecycle event publisher already contains observation failures.
Neither was changed merely because a synthetic callback could throw.

## Implementation

MCP approval preparation now leaves the effect-start journal untouched. Actual dispatch still records the effect, and
cancellation before dispatch produces a cancelled result without suggesting that an operation might have run.

Scheduled-task finalization retains its first terminal outcome until the store accepts it. Concurrent terminal events
join the same write, and the existing scheduler tick retries a failed save without rerunning the task. A durable result
is independent of later UI broadcast or notification failures. Retries are held in memory: if the process shuts down
while storage continues failing, the unsaved result cannot survive that shutdown. This change introduces no persisted
format migration.

Skill settings carry the selected discovered path through Open, Save, and Delete. The manager checks that path against
its authoritative catalog and the requested name/source. Ambiguous legacy requests are rejected; unambiguous older
requests remain supported. Built-in protections remain enforced. Saving Any mode writes an explicit empty mode array,
which overrides a mode-specific directory default after rediscovery and reload.

Native OpenAI reasoning now travels through the existing canonical response items with optional opaque metadata.
Provider output positions restore order when reasoning arrives with a final response after streamed text or calls.
Matching streamed and final items reconcile once. Persistence keeps those ordered blocks, and the old getter-based
prefix remains a fallback for older adapters. Providers without source positions retain their existing arrival order.
Opaque state remains provider-history data; it is not published as UI text.
Old saved histories remain readable, but positions discarded by earlier writes cannot be reconstructed.

The final review found a retry integration issue before completion: awaiting a VS Code completion toast would hold up
the scheduler tick until the user selected an action or dismissed it. The exact `@types/vscode@1.125.0` declaration
confirms that promise contract. A controlled pending-toast regression failed before the correction and now passes.
Durable finalization now ends before advisory presentation starts. Existing shutdown admission coverage also caught and
prevented accidentally suppressing a best-effort state broadcast.

## Workflow coverage

The [workflow task catalog](../evals/agent-workflows/README.md) records ten repeatable user workflows with observable
acceptance criteria, including delegation, a review/fix/validate/follow-up thread, Tickets with skills, and HTML preview
iteration. It reuses the real extension runner and existing scenario catalogs.

New exact-host coverage in
[`core-loop-boundaries.test.ts`](../apps/vscode-e2e/src/suite/core-loop-boundaries.test.ts) exercises a failed read followed
by a corrected read and ordinary assistant completion. It inspects subsequent provider requests, saved tool history,
the lifecycle journal, and projected terminal state. Inspection uses the current native `exec_command` surface. The
missing-file process receipt must retain exit code 1 and `ENOENT`; the corrected read must retain exit code 0 and the
requested value. Each accepted call must have one terminal result. Scripted decisions provide contract coverage and
are not a live-model quality benchmark.

The first host run exposed a fixture mistake: it called retired native `read_file`, so both reads failed as unknown
tools. The fixture was corrected to use `exec_command` and assert actual filesystem evidence. This was not counted as
another extension defect. No tool authority or existing command-result contract was changed to accommodate the test.

## Validation and closure ledger

Initial extension typecheck passed using Node `24.21.0` and pnpm `11.24.0`. The existing focused turn/scheduler baseline
passed 174 tests. The new host test typechecked. Normal sandboxed pnpm execution failed at workspace `realpath` with
`EPERM`; the same authorized validation commands ran with narrowly scoped process escalation.

Final affected-surface checks:

| Check                                                          | Result                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Provider, transform, canonical history, Task persistence/retry | 399 tests passed across 15 files; the replay spec passed 10/10 after its fixture metadata correction.                         |
| Scheduler, lifecycle journal/reducer, scheduled service/store  | 299 tests passed across 14 files, including 19 new MCP and scheduled durability regressions.                                  |
| Skills service and webview handlers                            | 206 tests passed across 8 files.                                                                                              |
| Skills settings UI                                             | 27 tests passed.                                                                                                              |
| Shared types                                                   | 395 tests passed across 40 files; build and typecheck passed.                                                                 |
| Final turn engine and fault contracts                          | 48 tests passed across 2 files.                                                                                               |
| `pnpm test:core:regressions`                                   | 422 extension tests and 19 managed-worktree persistence/recovery tests passed.                                                |
| `pnpm lint` and `pnpm check-types`                             | Passed on the final production source. Two strict-type errors in new test fixtures were corrected before the final type gate. |
| `pnpm bundle`                                                  | Passed as part of the exact-host gate; final source was rebuilt after the notification correction.                            |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`         | Passed on final source: 42 tests across 13 exact-host launches, with no failures or skips.                                    |
| Exact-host `core-loop-boundaries.test`                         | Passed 4 tests, including the new missing-file recovery workflow.                                                             |
| Exact-host `scheduled-tasks.acceptance.test`                   | Passed 5 tests covering persistence, scope, permissions, duplicate runs, and failed command outcomes.                         |
| Scoped formatting and final diff checks                        | Passed; all 16 pre-existing changed files retain their original content hashes.                                               |

Unit counts describe their respective command runs and overlap; they are not a count of unique repository tests. The
exact-host smoke gate was repeated against the final scheduler correction. The 51 host cases above all executed on
VS Code 1.125.0 with `--require-all-tests`, disposable owned profiles, and scripted or VS Code LM fixture providers.

- **Fixed now:** All five findings have fixes and passing regressions. The fresh final reviewer found no remaining
  concrete defect after the scheduled notification correction. Final exact-host results are recorded above.
- **Flagged for follow-up:** Broader live-provider parity and the remaining workflow catalog tasks require separate,
  bounded runs with recorded models and fixtures.
- **Not verified:** Live Copilot/model quality, throughput, token use, and manual visual behavior are not measured by this
  scripted correctness pass.
- **Out of scope:** Replacing Alpha's sandbox, copying Codex's implementation, retiring Alpha extras, changing release
  versions, or rewriting unrelated hybrid-search work.
