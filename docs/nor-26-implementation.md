# NOR-26: bounded parallel directory reads

Implemented on `codex/nor-26-parallel-reads` from Stage 1 commit
`678baf4440c9cad4a5f40aa6142ad12b98ca0b17`. Evidence recorded on 2026-09-04.

## Execution contract

The normal primary-task request captures an immutable read grant in its existing
`TaskToolSurface`. It requires both automatic approval and read-only approval to
be enabled. The grant, workspace root, and ignored-file visibility participate in
surface and catalog-cache identity. Catalog projections retain the grant, and
transport retries retain their captured surface. Live cached settings can revoke
the grant; enabling settings during an existing step cannot grant new authority.

`ToolScheduler` admits only explicitly scoped, independent, read-only operations
with an approval-free execution path. Production Task dispatch uses a maximum of
four calls per window. The reusable scheduler clamps overrides to 1–16, defaults
to four, and retains serial execution unless explicitly selected. Scope equality
or containment prevents overlap within a window. Unscoped tools, approval paths,
mutations, terminal work, and lifecycle barriers retain serial behavior.

Only the audited nonrecursive `list_files` path is enabled. The registry's legacy
`requiresApproval: true` metadata remains accurate: its normal handler still asks
for approval. The alternate read contract separates concurrent local work from
ordered UI and Task-state publication. It does not call `Task.ask`, mutate shared
Task state, or invoke the provider's state-refreshing `getState()` during a worker.
Cached `getValues()` checks can only narrow the captured permission.

Each physical scope preflight and each handler admission passes the persisted
assistant-response fence. Admission is serialized around that awaited fence and
rechecks cancellation afterwards. A fence failure stops queued effects, signals
active workers, and joins them before publishing terminal receipts. All workers
in a bounded window are joined before results, UI messages, and shared Task state
are finalized in model-call order. Ignoring a signal cannot release a worker slot
early. Receipts preserve call IDs and distinguish success, error, denial,
cancellation, truncation, and timeout through the existing persistence path.

The noninteractive listing uses the existing `say: "tool"` message shape.
`ChatRow` recognizes its `listFilesTopLevel` payload and renders the existing
completed-view label, path, and content. Approval rows retain their existing label.

## Admission and filesystem bounds

The admitted directory must be a canonical strict descendant of the captured
workspace, allowed by the captured policy and current workspace, ignore, and
protected-path checks. Root listings, recursive requests, aliases/junctions,
directories containing links, and directories with more than 200 entries fall
back to the serial handler. Bounded `opendir` inspection also uses `lstat` because
Windows can report a junction as a plain directory through `Dirent`.

A nonempty `RIPGREP_CONFIG_PATH` or any detected `.gitignore` above the workspace
also selects the serial handler. Ancestor inspection reads metadata only and is
capped at 64 directories. This preserves legacy inherited-ignore behavior without
reading external ignore contents in the concurrent lane. The captured ignore
controller identity/content and protected controller identity are checked again
before scanning and before publication. Revocation produces a denied receipt
without falling into the legacy scan-before-approval path.

The strict listing service disables link following and ripgrep's independent
config/ignore discovery. It loads only workspace-bounded `.gitignore` files, at
most 64 directories and 64 KiB in aggregate. Linked, hardlinked, nonregular,
changed, or oversized ignore files fail the read. File handles are checked before
reading, read in bounded chunks, and always closed before returning. No recursive
strict listing is supported. Output retains the existing 200-entry bound and
captured tool-output limit. Scan errors reject instead of becoming successful
partial output. A ten-second deadline covers strict service work; cancellation,
deadline, and output-limit termination wait for process `close`.

These are point-in-time filesystem checks, not atomic isolation from arbitrary
external filesystem mutation. Rechecks reject observed topology/policy changes;
already completed UI publication cannot be retracted. A blocked native filesystem
operation or a child that has not closed remains joined rather than being reported
as drained. Direct callers outside the strict path retain legacy behavior, apart
from propagated listing cancellation and waiting for child closure after stopping.

## Audited exclusions

| Tool              | Reason it remains serial                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`       | `ReadFileTool` calls `task.ask` directly, updates rejection state, emits direct UI messages, and tracks file context/watchers. Its filesystem, image, and document pipeline lacks joined signal propagation. `FileContextTracker` already serializes metadata updates; no lost-update claim is made. |
| `search_files`    | `SearchFilesTool` fans out up to eight queries internally without an abort signal; four outer calls could create 32 ripgrep children. The search service settles on readline closure and converts errors into a no-results response.                                                                 |
| `codebase_search` | The handler gets the index manager without its calculated workspace path, lacks cancellation and result ignore filtering, and publishes directly. Query failures also mutate shared manager status.                                                                                                  |

None has the isolated, bounded read/finalize contract required for admission.

## Measurements

Baseline validation before implementation passed 3 files / 72 tests:
`ToolScheduler.spec.ts`, `TaskToolSurface.spec.ts`, and `Task.persistence.spec.ts`.
Initial collection required building the existing types/build packages after a
frozen offline dependency install; no dependency or lockfile changes were made.

Final matched benchmark command:

```sh
pnpm --dir src test core/agent/__tests__/ParallelReads.spec.ts --maxWorkers 2 --no-silent
```

The fixture executes the real scheduler, registry, handler admission, filesystem
preflight, formatting, and publication against six temporary directories. Only
the listing scan is replaced with the same injected 30 ms latency and output in
both modes. Each serial/parallel pair asserts identical ordered call IDs, statuses,
and contents. The benchmark cap is **three**, while production's cap is **four**.
Three paired samples from the final passing run on Windows, Node 20.19.2:

| Mode               |  Sample 1 |  Sample 2 |  Sample 3 |    Median | Peak active |
| ------------------ | --------: | --------: | --------: | --------: | ----------: |
| Serial             | 278.78 ms | 284.66 ms | 285.40 ms | 284.66 ms |           1 |
| Selective parallel | 128.32 ms | 126.49 ms | 126.58 ms | 126.58 ms |           3 |

The median ratio is 2.25×, or 55.5% less elapsed time, for this controlled fixture.
It is not a live-model, production-cap-four, or end-to-end coding-task speed claim.
Earlier measurements made before the final topology/settings/ignore checks are
superseded. Cancellation coverage held three ignored-signal reads active until
their controlled gates were released: active-at-abort 3, active-at-return 0,
observed drain 0.77 ms. That observation is not a general cancellation latency bound.

## Final verification

- Affected core regression: 10 files / 270 tests passed, including scheduler,
  turn engine, immutable step context, registry/surface, ordinary Task requests,
  Task persistence, retry wire identity, and catalog policy/invalidation.
- Audited handler suite and benchmark: 1 file / 13 tests passed. Covers overlap,
  out-of-order completion, publication ordering, live revocation, retained captured
  denial, timeout/error metadata, truncation, cancellation drain, conservative
  scope exclusion, and external ancestor ignore fallback.
- Glob service: 7 files / 53 tests passed, with no skips. Real filesystem tests
  cover linked/hardlinked ignore files, aggregate budgets, workspace bounds,
  junctions, cancellation, and deadline/handle closure. A real ripgrep 15.2.0
  process produced seven identical strict/legacy entries with root and nested
  ignore files, including ordinary, hidden, and ignored file names.
- Task integration uses an actual Task, registry, and list handler with controlled
  filesystem/scan seams. It verifies ordered exactly-once persisted results,
  ignored-signal cancellation with no follow-on listing, captured-grant denial,
  and persistence-fence failure before filesystem access. Existing recovery tests
  cover resumed step identity, staged receipts, failed saves, and cancelled tools.
- ChatRow: 3 focused files / 5 tests passed, including rendered listing path/content,
  completed-view wording, absence of approval controls, and unchanged ask wording.
- Full `src` and `webview-ui` lint and typecheck passed; formatting and diff checks
  passed. No public message schema, persisted format, manifest, dependency, release,
  CLI, or compatibility-shim changes are included.

The orchestrator owns combined Stage 2 regressions, managed-agent certification,
and the exact VS Code **1.122.1** extension-host gate. Those gates are not claimed
as completed by this worktree.

## Primary source basis

Reviewed on 2026-09-04:

- [Codex shared/exclusive tool gate at pinned commit a7ab2d66d781b903cb060288a89e26e8d2b9a05f](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/core/src/tools/parallel.rs).
  The transferred principle is independent reads behind an exclusive effect
  boundary; Alpha retains its own registry, step policy, persistence, and UI model.
- [Node.js 20.19.2 child-process close event](https://nodejs.org/download/release/v20.19.2/docs/api/child_process.html#event-close)
  establishes that process termination and pipe closure must be joined.
- [ripgrep 14.1.1 flag documentation](https://github.com/BurntSushi/ripgrep/blob/14.1.1/crates/core/flags/doc/template.rg.1)
  informed no-follow and config/ignore behavior; the local process parity test
  separately verified ripgrep 15.2.0.
