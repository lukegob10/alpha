# File-change projection performance, 2026-10-20

This bounded frontend performance pass removes repeated legacy-preview searches from the file-change projection used by
`ChatView` and `FileChangesPanel`. It preserves rendered records, matching rules, and transcript order. It does not change
task lifecycle, tool execution, approvals, saved transcripts, or Settings edit buffers.

## Finding and owning layer

`fileChangesFromMessages` previously scanned every earlier candidate for each completed edit to find one matching,
answered approval preview. Current completed-only transcripts have no such previews, but still performed a quadratic
search. `ChatView` derives file-change turns again when streamed messages change, so this historical work repeats during
streaming. The function is a presentation adapter, not authoritative runtime state.

The replacement builds an index of prior, unmatched preview indices by the existing normalized path. Completions inspect
only their path's bucket, from newest to oldest, and consume at most one compatible preview. Empty buckets are removed.
The index exists only for that function call, with no retained cache or cross-chat invalidation contract.

Nearest compatible selection, case-sensitive paths, slash and leading `./` aliases, command execution identity,
original-content compatibility, replacement-content fallback, batch entry order, and incomplete/cancelled filtering stay
unchanged. A later preview never replaces an earlier completion. Distinct edits to the same path remain distinct.

## Codex reference

Inspected current Codex CLI source at commit `18795fc12571a3530d3e4ac18366e41cd2f57448`, retrieved 2026-10-20:

- [`history_projection.rs`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/chatwidget/tests/history_projection.rs):
  `snapshot_formatter_completed_patch_needs_no_started_notification`,
  `snapshot_formatter_live_and_buffered_patch_notifications_render_once`, and
  `snapshot_formatter_empty_success_and_failed_patch_keep_their_outcomes`.
- [`tool_lifecycle.rs`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/chatwidget/tool_lifecycle.rs):
  `on_patch_apply_begin` and `handle_file_change_completed_now`.

These protect completed-only patch rendering and single rendering of a start/completion pair, while preserving failure
outcomes. Alpha retains its native file-review presentation and backward-compatible answered approval records. This
optimization addresses a measured Alpha path; it does not claim to reproduce Codex's indexing algorithm.

## Deterministic evidence

Node `24.21.0`, one benchmark process, no provider or network requests. The workload contains 1,000 completed edit records;
the legacy workloads add 1,000 answered previews, either before all completions or interleaved. The measurement executes
the actual TypeScript function after transpilation, instruments only candidate-array index reads, and compares its full
serialized output against the saved pre-change implementation. Counts include the output traversal.

| Workload                                         | Before reads/projection | After reads/projection | Output    |
| ------------------------------------------------ | ----------------------: | ---------------------: | --------- |
| Completed-only history                           |                 501,500 |                  2,000 | Identical |
| All previews, then completions on distinct paths |               1,004,000 |                  5,000 | Identical |
| Interleaved preview/completion pairs             |                   5,000 |                  5,000 | Identical |

The bounded operation-count assertion allowed at most 6,000 reads for the first two workloads. It failed before the
optimization with 501,500 reads and passed after the change. Results and the reproduction script are retained locally in
the ignored `artifacts/testing-2026-10-20/perf-ui/` directory as `file-change-projection.baseline.log`,
`file-change-projection.after.log`, and `measure-file-change-projection.log`. These reports contain JSON. The baseline
source hash is `68bf9112c7dcb72be23e865120fa85b7b71191d07bb6c7d2347c1dbc876df777`.

The durable developer guard is `scripts/benchmarks/file-change-projection.mjs`, following the existing task-history
benchmark pattern. It reads a verified Git baseline commit and the current source, runs each workload once in isolated
VMs, compares full output, and enforces the same 6,000-read threshold. It instruments only the local candidate-array
allocation and fails explicitly if that allocation changes. It uses no global spies or timing loops. The pinned Git
baseline below is identical to the retained worktree baseline after normalizing line endings; its raw source hash is
`220452b05e90ba0f41aaf834873d5fad8fed8625e08c76f9ce7651f65694d300`. The tracked guard reproduced all three rows above.

```sh
node scripts/benchmarks/file-change-projection.mjs d73c497436be147731e6e26b86d4713c3633842d
pnpm --dir webview-ui test src/__tests__/fileChangesFromMessages.spec.ts src/__tests__/FileChangesPanel.spec.tsx --maxWorkers=2
pnpm --dir webview-ui check-types
```

Six additional characterization cases cover nearest compatible previews, identity/content mismatches, future previews,
case distinctions, batch pairing, and replacing a record in a 1,000-edit completed-only history. The focused projection
suite passed all 31 cases both before and after the optimization.

The affected-surface check passed 110 tests across the projection, rendered file-review panel, row render isolation,
Worker group cards, and Worker dock. `pnpm --dir webview-ui check-types` passed. Exact-host and live validation are owned
by the parent test run; this focused pass does not substitute for those gates.

## Practical limits

These are deterministic operation counts, not measured end-to-end latency or React commit counts. Timing loops were
stopped while other full suites were using the machine; no wall-time speedup is claimed. Many incompatible previews for
the same normalized path can still require repeated compatibility comparisons within that path bucket. This patch
removes completed-only and unrelated-path scanning without adding broader indexing or changing matching semantics.
