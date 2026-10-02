# Large ticket and shared scheduling review — 2026-10-01

The reported workload is four or five large application tickets followed by many managed agents. This review proves
specific preparation and cancellation failures; it does not establish that any one failure caused the reported live
incident. Provider streaming, compaction, and managed-agent budgets have separate reviews and validation.

## Current reference

The official `openai/codex` checkout was refreshed on October 1 local time / October 2 UTC, at commit
`cb6da58876afed3ede0ab11084f67dd5394ecb48` (commit time `2026-10-02T01:34:23Z`). Relevant source and tests:

- [Tool dispatch and cancellation](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/parallel.rs):
  independent tools use shared admission and exclusive tools use exclusive admission. Cancellation while waiting for
  dispatch returns without requiring the active gate owner to finish. The test
  `cancellation_before_dispatch_admission_logs_dispatch_only_timing` holds that owner throughout cancellation.
- The same file's `cancellation_after_handler_finishes_preserves_completed_lifecycle` verifies that cancellation after
  a handler finishes preserves its result and completed lifecycle.
- [Tool output metadata tests](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/registry_tests.rs):
  `post_tool_use_feedback_output_preserves_fallback_token_limit_override` keeps the output budget attached to the
  result. Alpha's existing scheduler output policy and structured result statuses remain in force.

These behaviors were translated into Alpha's existing TypeScript owners. No Rust implementation or upstream prompt was
copied, and Alpha's approval, workspace mutation, ticket storage, and sandbox choices remain intact.

## Proven failures and fixes

### Workspace mutation admission

`WorkspaceMutationGate` previously checked queued cancellation only after the current mutation completed. A cancelled
worker could therefore remain pending behind a long edit, delaying worker termination and cancellation joins. Its
callback also ran outside a promise boundary: a synchronous callback exception left `active` set forever.

The gate accepts a backward-compatible optional fifth `AbortSignal` argument. A cancelled queued request is removed by
identity and rejects with the existing `WorkspaceMutationCancelledError`. Surviving requests retain FIFO order. Listeners
are removed at admission or queued cancellation. The callback runs within the promise boundary and releases ownership
on both asynchronous and synchronous failures.

The provider routes task lifetime signals into ordinary workspace mutations, apply/discard actions, and policy/budget
admissions, combining an explicit parent signal where applicable. Stopped-task cleanup retains its existing authority.
Provider integration regressions cover cancellation behind a retained owner and synchronous callback recovery.

Active operations remain joined until physical settlement. This is an intentional adaptation of cancellation to native
TypeScript promises: returning early cannot prove that a filesystem edit stopped. Cancelling an active owner's signal
does not release the workspace lock, admit a second edit, or replace an already committed outcome.

### Ticket storage preparation

`TicketStore.forWorkspace` joins an editor-owned reference migration before opening the read-only store. Previously this
join did not accept the requesting tool or task's cancellation signal, so a cancelled inspection could remain pending
while the migration was stalled.

Store opening now accepts an optional third signal. Cancellation rejects that reader's wait with the original abort
reason and removes its listener; the editor migration and other readers retain their ownership. Pre-aborted opening
performs no filesystem work. Preparation failures propagate and also remove listeners. Ticket tools and ticket panel
maintenance pass their existing signals, and initial/follow-up attachment preparation forwards the task request signal
through the existing mention path. An aborted attachment never becomes a successful error-text attachment or emits late
ticket activity.

This does not detach active ticket writes, cancel another owner's migration, or alter atomic storage recovery.

### Repeated reference scans

Each referenced attachment previously performed a full project scan, then read its selected UUID again. Five attachments
therefore scanned the same five large records five times. `TicketStore.readMany` now shares one transient reference
index within a single attachment batch, then uses the existing authoritative per-ID read for every selection.

The batch preserves attachment order, every ticket field, and individual missing/invalid-ticket failures. Duplicate
reference and duplicate-ID checks remain enforced. Selected references that change after indexing fail closed; fresh
content is read rather than cached across batches. Pending move recovery and symlink/path protections remain read-only
inspection barriers. UUID-only batches need no project reference scan. Native mutations continue to use the existing
transaction lock and revision guards.

The existing `workOnTicket` refresh instruction remains: launching updates the status and durable task association after
creating the initial task prompt. The later read obtains that new authoritative revision before a model attempts an
update. Removing it merely as a duplicate read would weaken that contract.

## Measured workload

The deterministic attachment regression creates five actual Markdown tickets, each with all four sections at 16,000
characters. Unique storage totals 321,395 bytes. It instruments named `fs.readFile` calls only during attachment parsing
and asserts deep equality of all selected ticket records.

| Metric                        |    Before |    After |
| ----------------------------- | --------: | -------: |
| Markdown reads                |        30 |       10 |
| Bytes read                    | 1,928,370 |  642,790 |
| Local warm sample for parsing |  131.4 ms | 77.96 ms |

Read count and bytes fell 66.7% on this workload. Timing is one warm sample per implementation on the same local
Windows environment; it is supplemental evidence, not a general latency claim. The model receives the same complete
ticket content, so this change claims no input-token reduction. The regression enforces at most ten reads and preserves
full content rather than enforcing a timing threshold.

To emit the workload measurements on PowerShell:

```powershell
$env:ALPHA_TICKET_ATTACHMENT_BENCHMARK = '1'
pnpm --dir src test services/tickets/__tests__/TicketChat.spec.ts --silent=false -t 'loads five large'
Remove-Item Env:ALPHA_TICKET_ATTACHMENT_BENCHMARK
```

## Validation

- Workspace gate fail-before: 2 failed / 4 passed; repaired and adjacent ownership/listener cases: 9 passed.
- Five-ticket attachment fail-before: 1 failed / 7 passed, with the measured 30 reads and 1,928,370 bytes.
- Shared migration reader fail-before: 1 failed on a controlled promise; cancelled reader remained pending while its
  owner was held. Repaired cancellation, pre-aborted opening, and migration-failure cleanup cases pass.
- Broader affected units: 714 passed across 16 files, covering all ticket service tests, native ticket tools, both mention
  processors, workspace mutation gate, task/completion integration, scheduler, and provider mutation/managed-agent paths.
- Additional legacy-handoff integration coverage: 12 passed in one file, for 726 passed across 17 distinct affected files.
- `pnpm --dir src check-types` passed.
- Focused formatting and `git diff --check` passed for owned source and tests.

The root implementation owns the exact VS Code 1.125.0 host gates and managed-agent certification. This review's unit
results do not substitute for those gates. The shared scheduler retains its existing default concurrency of four and
hard bound of sixteen; no new ticket or agent cap was introduced. Cancellation of real filesystem operations remains
cooperative, and active effects retain serialization until their owner settles.
