# NOR-27 implementation

Mode: performance optimization. Scope: environment context and its delivery boundary, terminal/file receipts, and narrowly scoped Task lifecycle call sites. The intended end state is incremental, bounded context with no output consumption before durable delivery and prompt preflight cancellation. This is not a repository-wide audit.

## Baseline and ownership

- Worktree: `C:/Users/Luke Goblirsch/.codex/worktrees/af1d/Alpha-Code`.
- Branch: `codex/nor-27-environment-context`.
- Baseline: `0de6860f6d9b7b9d64c3b377c57ebecc016e46a3`. The app initially created an older detached checkout; source edits were paused until the orchestrator authorized a clean, non-destructive branch switch.
- Read both repository guides, including the uncommitted guide at `F:/roo-fork/Alpha-Code/AGENTS.md`; that guide is not part of this change.
- Applied clean-code-review and its change-safety, end-state, JavaScript, testing, performance, and frontend references. No frontend changes are intended.
- Re-fetched Linear NOR-27 on 2026-09-04. Review links are historical; the observations below refer to the baseline source.
- The orchestrator owns final retry dispatch consistency and the combined VS Code 1.122.1 smoke gate. This task does not change tool policy, preview, sequencing, completion, compaction policy, provider adapters, CLI, or shim.

## Verified problem

`getEnvironmentDetails` emits editor/mode/time/cost/reminder facts on every call, waits 300 ms after edits with a busy terminal, and polls hot terminals for up to 5 seconds. It drains terminal output and the modified-file set before Task decides whether the current user message will be persisted. Retry/empty delegation paths can therefore consume transient events without sending them. Foreground `state.mode` can also differ from task-local mode.

## Delivery and reset contract

1. Each Task instance owns one bounded environment baseline. Start/reload, delegation resume, and successful manual/automatic compaction or truncation establish a fresh baseline. Failed context management does not advance it.
2. Normal steps append only changed named fields; a removal is explicit. Time alone does not churn every request: refresh on baseline, date/timezone change, or an otherwise relevant update. Workspace/editor/terminal identities and settings are revalidated at each applicable boundary. Diagnostics remain owned by existing mention/tool paths; this patch does not add a diagnostics feed.
3. Capture returns `{ details, commit, release }`. Terminal and modified-file receipts do not consume until their text is durably saved into provider history. Commit/release are idempotent. A receipt for A must preserve later B, including a second modification of the same file.
4. Retried logical steps reuse the committed environment content. Skipped message paths do not capture new transient events. A context reset provides a full baseline before dispatch without changing compaction selection or policy.
5. Summary-only environment facts exclude transient output/file events, so a successful summary cannot silently consume or duplicate them. Fresh events enter the subsequent durably committed request context.
6. Remove hot-terminal/post-edit pacing. Sample complete available output at the boundary; later output stays unread for the next applicable step. Awaitable collection observes the existing step cancellation signal, disposes abort listeners, and cannot commit late after reset.
7. Preserve existing saved message formats and provider-neutral request composition. Appending smaller content does not imply invalidation of the prior conversation cache prefix.

## Implementation

`EnvironmentContext` retains SHA-256 field fingerprints, an identity digest, revisions, and one terminal/process delivery cursor per Task. It keeps no transcript copy or output backlog. Fact resets preserve the independently committed output cursor, so repeated compaction cannot starve later terminals. A full snapshot establishes current workspace roots, task-local mode/model, time, cost, reminders, editors, tabs, terminals, and a labelled baseline file listing. Normal steps emit changed fields and explicit removals. Listing freshness is explicit: use `list_files` for current contents; roots, visibility settings, and lifecycle resets force a new listing.

Fact text is capped at roughly 48,000 characters plus headings, with 16,000 per field and at most 200 paths. Essential identity/time fields precede bulk fields. Terminal metadata lists at most 32 terminals, independently of delivery: collection considers all retained terminals, skips drained processes, and rotates a committed cursor through terminal/process output. Each capture reserves at most 32 process receipts and 32,000 rendered terminal characters, including bounded CWD/command headings and separators. Each delivered chunk identifies its working directory even when its metadata descriptor is outside the cap. Recently modified files use a 200-path/16,000-character receipt. Unsent paths remain pending, including an individual path too large for that budget; they are never silently ACKed. Later fitting paths can still progress.

Terminal receipts share the existing raw output buffer and record only their bounded range. A process permits one active receipt, and generation/cursor checks invalidate stale commits after buffer reset or a legacy consuming read. Completed output without a final newline is included. File receipts record path versions, so ACKing an earlier change cannot erase a newer change to the same file.

Terminal cleanup carries only parser state and at most 32 characters of an incomplete CSI prefix. OSC payloads, including hyperlinks, are never retained in another buffer. The environment reserves that fixed carry allowance before requesting each raw chunk. Tests compare concatenated chunks against legacy cleanup, including one-character raw caps, while preserving SGR formatting. A malformed, unterminated OSC at completed-stream finalization is discarded as control data; a valid oversized OSC progresses to subsequent visible text without an unbounded buffer.

Task persistence invokes a synchronous ACK after the successful history save and before unrelated mailbox settlement. The durable flag is set before receipts commit. Failure rolls back only the staged message identity and releases its receipts. A save that finishes during cancellation still ACKs its durable content. Persistence retry waits now observe the existing interruption signal.

Successful summary/truncation saves reset the baseline and append a fresh snapshot before dispatch. Summary-only reads exclude transient events. Empty-response retries restore the exact committed `ApiMessage` and use empty retry input, preserving newly ACKed output and summary/truncation metadata. Steering after a summary keeps that boundary and adds a new user turn. Transport dispatch and immutable request ownership remain with the orchestrator's integration commit.

Environment collection has no hot-terminal or post-edit sleep. Host reads race cancellation with listener cleanup; file enumeration passes the signal through owned ripgrep execution and directory traversal. Aborting kills ripgrep, clears its timeout, preserves the abort reason across close/error races, and stops fallback scans. Git probes use cancellable `execFile` when a signal is supplied; existing callers remain compatible.

## Measurements

The fixture was run first against baseline source, then against this change with the same five-step workload: fixed 2026-09-04 clock, 50 workspace paths, one visible-editor change, a hot terminal, and a subsequent edit. Tokens use local `tiktoken/lite` with `o200k_base`; bytes are UTF-8. Preflight and request admission below are virtual elapsed time at the collection boundary, excluding real persistence, rate limits, provider admission/network, and model work.

| Scenario                             | Before bytes / tokens | After bytes / tokens | Before preflight/admission | After preflight/admission |
| ------------------------------------ | --------------------: | -------------------: | -------------------------: | ------------------------: |
| Initial snapshot                     |           1,452 / 431 |          1,686 / 492 |                   0 / 0 ms |                  0 / 0 ms |
| Unchanged step, one second later     |             403 / 120 |                0 / 0 |                   0 / 0 ms |                  0 / 0 ms |
| Visible editor changes               |             442 / 131 |             225 / 69 |                   0 / 0 ms |                  0 / 0 ms |
| Hot terminal appears                 |             572 / 163 |             288 / 84 |           5,000 / 5,000 ms |                  0 / 0 ms |
| Edit while that terminal remains hot |             572 / 163 |                0 / 0 |           5,300 / 5,300 ms |                  0 / 0 ms |
| Five-step total                      |         3,441 / 1,008 |          2,199 / 645 |                            |                           |

The explicit initial baseline is larger by 61 tokens; the five-step fixture falls by 363 tokens (36%). The unchanged step adds no environment text. Cancellation at 10 ms into a mocked 2,000 ms listing settles after 1,990 ms on baseline versus 0 ms after cancellation with this change. The measurement fixture finishes with no remaining timers; subprocess/listener ownership is verified separately in cancellation tests.

Reproduce after-change numbers with `pnpm --dir src test -- core/environment/__tests__/environment-measurements.spec.ts --no-silent`. These numbers do not claim live provider usage, token billing, cache hits, or end-to-end latency. Provider-boundary tests independently compare the actual messages passed to `api.createMessage`: ordinary empty retry preserves the exact request, and compaction retries preserve the refreshed message and hidden-history boundary. Steering preserves the existing message content prefix while adding the new instruction.

## Validation and acceptance

Node 20.19.2 and pnpm 10.8.1 were verified. `pnpm install --frozen-lockfile` completed without manifest or lockfile changes, and workspace dependency builds completed before extension checks.

- Final combined run: 38 suites passed, one existing suite skipped; 644 tests passed and 12 existing tests skipped. Coverage includes environment deltas and bounds, file/terminal receipts, glob/Git cancellation, Task persistence/empty retry/steering, delegation resume, compaction, truncation, reasoning, grounding, and sticky profile behavior.
- The new provider-boundary compaction regression reproduced six failures before the retry correction. The corrected cases cover automatic and manual retries after summary/truncation, retained tool pairs, save failure, cancellation during restoration, and steering after summary.
- Terminal receipt suites cover delayed B after captured A, release/recapture, double commit/release, concurrent reservations, completed output, stale generations, bounded continuation, and control-sequence boundaries. The final terminal/environment run passed 169 tests with 12 existing skips.
- After final formatting, `pnpm --dir src lint` and `pnpm --dir src check-types` passed. The commit hook also passed all 12 repository lint tasks. Whitespace checks passed. The required pre-commit Prettier run normalized CRLF to LF in three touched files (`FileContextTracker.ts`, `TerminalProcess.ts`, `list-files.ts`); use `git diff --ignore-space-at-eol` to review their semantic changes.

The exact VS Code host gate is `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`. The orchestrator owns its combined run after integration; it is not claimed passed for this branch here. No push, PR, merge, CLI/shim change, dependency/version change, or Linear Done transition is part of this handoff.
