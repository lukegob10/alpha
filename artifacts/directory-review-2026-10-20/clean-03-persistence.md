# Clean-code review 03: persistence and context

Mode: full-surface review within the assigned persistence/context slice; read-only audit. Good means durable, replayable transcripts and complete tool transactions; safe compaction boundaries; task-scoped context; and bounded, owned resources. This pass identifies remaining gaps rather than claiming closure.

**Quality score: 86/100. Confidence: medium-high for the reviewed active paths; medium for the entire directory surface.** The authoritative transcript/receipt boundary, Task generation ownership, bounded transcript queues, durable rewind targets, migration preservation, and compaction admission/progress checks are substantially stronger than the context-tracker adapter. No production files or existing tests were edited.

## Verified findings

1. **Medium / should-fix — First human edit after an initially tracked Alpha write is suppressed.**

    - Location: `src/core/context-tracking/FileContextTracker.ts:74`, `:98`, `:198`.
    - Trigger: Alpha writes a file that has no tracker watcher yet. `WriteToFileTool` performs `saveDirectly`/`saveChanges` before calling `trackFileContext(..., "roo_edited")` (`src/core/tools/WriteToFileTool.ts:133`, `:177`, `:181`). The tracker sets a one-shot `recentlyEditedByAlpha` marker, then creates the watcher. Its next change can be an actual human edit, but the callback consumes the marker and skips both the modified-file receipt and metadata update.
    - Owning invariant: an external modification must remain pending until the step that includes its stale-context notice commits; an unmatched self-write marker cannot acknowledge a human edit.
    - Evidence: the executable probe calls the real tracker for a first `roo_edited` operation, invokes the newly created watcher once as a human change, and observes `captureRecentlyModifiedFiles().files === []`. Existing tracker tests exercise receipt versioning and transaction ordering, but no watcher events or self-edit suppression.
    - Smallest repair: stop inferring event authorship from an unversioned next-event flag. Prefer conservative notification, or match self-events against an owned file/version snapshot captured at the actual write boundary. At minimum, never arm a suppression marker for an edit performed before a watcher existed. Add a deterministic first-write/first-user-edit regression.
    - Limit: this proves a lost context-change notification. It does not prove the separate workspace mutation gate overwrites user changes.

2. **Medium / should-fix — Worktree and alternate-root tasks watch the editor's first workspace instead of their own files.**

    - Location: `src/core/context-tracking/FileContextTracker.ts:46`.
    - Trigger: a task executes with `task.cwd` different from `vscode.workspace.workspaceFolders[0]`, including independent worktree tasks and managed children. The tracker reconstructs its cwd from the global first workspace and receives only provider/task ID. Relative read/edit paths are consequently watched in the wrong tree. Without a workspace folder, tracking is skipped even when the task has an explicit cwd.
    - Active wiring: `Task` constructs the tracker without `this.cwd` at `src/core/task/Task.ts:2007`; task cwd returns its `workspacePath` at `:20746`. `AlphaProvider` assigns independent worktree paths at `src/core/webview/AlphaProvider.ts:5837` and managed-child workspace paths at `:12746`. `ReadFileTool` tracks paths relative to the task at `src/core/tools/ReadFileTool.ts:351`.
    - Owning invariant: task-local context and workspace scope must follow stable task identity; multiple task surfaces and private workspaces cannot share a global first-root assumption.
    - Evidence: with distinct editor-root and child-root fixtures, the real tracker creates the watcher under the editor root. This is a deterministic path calculation plus the verified production caller chain.
    - Smallest repair: inject the task's already-resolved cwd into `FileContextTracker` at construction and use that captured root for tracking and watcher creation. Add alternate-root and worktree/no-editor-root tests.

3. **Medium / should-fix — In-flight tracking recreates watchers after disposal.**

    - Location: `src/core/context-tracking/FileContextTracker.ts:98`, `:334`.
    - Trigger: `trackFileContext` awaits its queued metadata read/write; task cancellation calls `dispose`; the pending operation settles and proceeds to `setupFileWatcher`. Disposal clears current watchers but neither marks the tracker disposed nor fences later watcher creation or queued callbacks.
    - Active wiring: file tools await `trackFileContext`; watcher callbacks also invoke it. `Task.dispose` disposes this tracker at `src/core/task/Task.ts:13829`.
    - Owning invariant: every watcher needs an owner and cleanup path; disposal must prevent subsequent resource admission, including after awaits.
    - Evidence: the executable probe holds a controlled promise inside `saveTaskMetadata`, calls `dispose`, releases the promise, and observes one new undisposed watcher. No arbitrary sleep is used.
    - Smallest repair: add an idempotent disposed flag; reject/ignore new tracking and watcher creation after disposal, and recheck after metadata awaits. Ensure callbacks cannot enqueue new work after disposal. Add the controlled-promise regression.

4. **Medium / should-fix — Repeated reads of one file cause unbounded metadata growth and quadratic cumulative rewrites.**
    - Location: `src/core/context-tracking/FileContextTracker.ts:208` (also `:162` and `:169`).
    - Trigger: every read, mention, edit, or watcher event appends a row after marking earlier rows stale. Each subsequent operation reparses, scans, sorts, and rewrites the complete history. The same single file can create arbitrarily many stale rows; the serialized metadata queue is also unbounded under event bursts.
    - Owning invariant: keep task memory and output bounded and avoid repeated hot-path work; file freshness metadata should not grow with every observation when only the latest dates and source are consumed.
    - Evidence: a deterministic single-file workload using the real update method retains 64 rows after 64 reads and 128 after 128 reads, with one active row in either case. Counting JSON bytes passed to the mocked disk adapter gives 315,552 cumulative bytes for 64 reads and 1,249,600 for 128 reads (~3.96x for 2x operations). This is a serialization-volume measurement, not a wall-time benchmark or a claimed improvement. Production readers of `files_in_context` are confined to this tracker; `getFilesReadByAlpha` deduplicates paths for folded context (`:280`).
    - Smallest repair: preserve latest per-source/read/edit timestamps while folding redundant older rows, retain backward-compatible loading, and coalesce same-path pending updates or apply bounded admission. Preserve the semantics of `getFilesReadByAlpha(sinceTimestamp)` when defining the aggregate. Add a repeated-file storage-bound regression and a controlled event-burst test.

## Coverage and validation

Inspected active implementations and callers for `atomicWrite`, authoritative API history and v2 transcript receipts, validation of persisted provider shapes, Task persistence queues and generation guards, legacy migration, write-ahead rewind/recovery, `MessageManager` deletion/artifact cleanup, `TaskHistoryStore` lifecycle/reconciliation/mutations, context budgeting/recovery, compaction/tool-pair projections, token counting, folded file context, public thread-history projection, and `FileContextTracker`.

Focused commands run with Node 24.21.0 / pnpm 11.24.0:

```text
pnpm --dir src test core/context-tracking/__tests__/FileContextTracker.spec.ts core/task-persistence/__tests__/atomicWrite.spec.ts core/task-persistence/__tests__/apiMessagesMigration.spec.ts core/task-persistence/__tests__/TaskRewindStore.spec.ts --maxWorkers=1
4 files passed; 32 tests passed.

pnpm --dir src test core/task-persistence/__tests__/ProviderTranscriptStore.spec.ts core/context-management/__tests__/context-management.spec.ts core/condense/__tests__/request-isolation.spec.ts core/condense/__tests__/recent-tail.spec.ts --maxWorkers=1
4 files passed; 105 tests passed.

node artifacts/directory-review-2026-10-20/clean-03-persistence-repro.cjs
Exit 0: all four audit probes reproduced their described conditions.
```

Probe implementation: `artifacts/directory-review-2026-10-20/clean-03-persistence-repro.cjs`. It transpiles the current real tracker in memory, replaces only host/storage adapters, and creates no workspace fixtures or production writes. An initial probe bootstrap used the wrong local TypeScript package path; switching to normal workspace module resolution corrected the probe before successful validation.

Blind spots: no power-loss/fsync durability experiment, adversarial multiprocess filesystem run, live VS Code watcher scheduling run, full provider matrix, or complete tests for every auxiliary store (`TaskGoalStore`, inbox, notification, and instruction snapshot stores). The exact VS Code 1.138.0 and 1.125.0 gates were not run in this read-only slice; no integration behavior was changed. Existing user modifications to compaction/VS Code LM tests and investigation documents were left intact. The exported synthetic tool-result repair helpers have no active production callers in the inspected branch; their missing error flag was therefore not promoted into a runtime finding.

Closure ledger: fixed now — no production changes; flagged for follow-up — the four verified tracker findings; not verified — the blind spots above; out of scope — Codex CLI convergence scoring, sandbox implementation, and other reviewers' owning directories. Recommended next pass: correctness cleanup of the tracker adapter with injected task root, conservative self-event handling, disposal fencing, and a bounded metadata representation.
