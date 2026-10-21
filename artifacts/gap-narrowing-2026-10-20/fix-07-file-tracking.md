# File context tracker cleanup — 2026-10-20

Mode: correctness cleanup, with a measured reduction in repeated freshness-metadata work. Scope is the auxiliary file tracker, its tests, and the task-root constructor integration coordinated with the Task owner. This closes the four verified tracker findings from `artifacts/directory-review-2026-10-20/clean-03-persistence.md`; it does not claim an authoritative persistence redesign or complete repository review.

## Owning contracts and upstream evidence

The file tools call `trackFileContext` using paths relative to `task.cwd`. `Task` owns the tracker and disposes it synchronously. The tracker stores auxiliary `task_metadata.json` freshness information; `getFilesReadByAlpha` supplies unique, most-recently-read paths to folded context. Production consumers of `files_in_context` remain inside this tracker. Canonical tool transactions and historical transcripts have separate persistence owners.

Inspected the current Codex source at commit **`c7234c1174b27d9c55199fba0d546dc27d1b0415`**, retrieved 2026-10-20 and verified with `git rev-parse HEAD` in `C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`:

- [`core/src/tools/handlers/apply_patch.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/tools/handlers/apply_patch.rs): `ApplyPatchHandler` resolves the selected turn environment and passes that environment's cwd to patch verification.
- [`apply-patch/src/invocation.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/apply-patch/src/invocation.rs): inspected `test_apply_patch_should_resolve_absolute_paths_in_cwd` and `test_apply_patch_resolves_move_path_with_effective_cwd`, which check the selected directory and alternate worktree resolution.
- [`apply-patch/src/file_update.rs`](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/apply-patch/src/file_update.rs): updates read the current file through the environment filesystem and match expected context/old lines against it. Also inspected its `file_update_tests.rs` interleaved-change test and the CLI missing-context regression in `tests/suite/tool.rs`.

These sources support task-scoped path resolution and using current file evidence when modifying files. Alpha retains its native VS Code watcher adapter, stale-context notices, and existing mutation checks. Conservatively notifying on events with unknown authorship is an intentional Alpha safety choice; this pass does not infer a Codex watcher protocol or port its implementation. Upstream Rust tests were inspected, not executed.

The locally installed official `@types/vscode` package is exactly **1.125.0**. Inspected `FileSystemWatcher`, `RelativePattern`, and `workspace.createFileSystemWatcher` in `src/node_modules/@types/vscode/index.d.ts`, including documented support for watching a base path outside the open workspace and stopping events through disposal. The patch uses those existing stable APIs and preserves the 1.125.0 minimum.

## Verified defects and exact edits

All four findings are Medium / should-fix, with deterministic regression coverage:

1. **Wrong root for alternate/worktree tasks.** `FileContextTracker` now requires its already-resolved task cwd at construction and captures it for path resolution. The global first-workspace lookup and its no-workspace early return are removed. The Task owner applied the sole production integration: `new FileContextTracker(provider, this.taskId, this.cwd)` in `src/core/task/Task.ts`.
2. **Lost first external edit after Alpha's first write.** Removed the unversioned next-event suppression set and its internal-only setter. A watcher event cannot identify its writer. Every owned change event now records a pending observation, including the first event after initial and already-watched Alpha writes. This can conservatively cause an extra reread after an Alpha write; it preserves external-change safety.
3. **Late watchers after disposal.** A permanent, idempotent disposed fence closes tracking/watcher admission, queued metadata work, and work resumed after metadata reads. Each callback checks both disposal and its watcher identity. A save already started may settle; a disposed owner cannot start another save or create another watcher afterward. The existing synchronous `Task.dispose` contract is preserved.
4. **Repeated observation growth.** Updating a path now folds redundant rows by record source in one pass, retaining the maximum known read/edit/user-edit timestamps for each source. The existing metadata shape and source tags remain readable by legacy consumers. Explicit read/mention rows remain separate from Alpha-write rows so `getFilesReadByAlpha(sinceTimestamp)` does not start treating writes as explicit reads. Legacy undated read/mention rows remain separately represented because the existing reader conservatively includes them for every timestamp. A touched path retains at most four ordinary source records plus two undated read records. Other paths and top-level metadata are retained.

Adjacent identical pending updates share one metadata transaction. An operation already executing cannot absorb a later observation, and a different path/task/source breaks coalescing, preserving observed source ordering. A controlled first-save barrier followed by 128 same-path user events requires two saves in total. Every user event increments its in-memory pending-receipt version before storage work; delayed persistence cannot rearm a receipt for an observation already captured and committed.

The auxiliary tracker is best effort. Pending modification receipts are in-memory acknowledgements for inclusion in a later step, not durable transaction receipts. Disposal permanently closes the retired owner and skips metadata work whose save has not started. This intentionally avoids retired callbacks or queued reads racing a replacement tracker. Canonical tool transaction evidence remains owned by the existing transcript persistence layer.

Compatibility: old append-only metadata loads through the same reader. Folding happens lazily for the path being updated, preserving latest per-source freshness and edit evidence, plus undated legacy read evidence; redundant older freshness snapshots for that path are folded. No schema version, public extension API, migration dependency, historical transcript, or file-content change is introduced. Same-time ties between equally recent paths continue to have no documented ordering guarantee. The existing legacy `roo_*` field/source names are retained.

Files edited by this agent:

- `src/core/context-tracking/FileContextTracker.ts`
- `src/core/context-tracking/__tests__/FileContextTracker.spec.ts`
- `artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking-benchmark.cjs`
- This evidence file.

No type/schema file changes were required. `Task.ts` integration belongs to the Task owner. Existing user/other-agent changes were preserved; no dependencies, lockfiles, release metadata, or generated trees were edited by this agent.

## Controlled before/after measurement

Runtime: Node **24.21.0**, pnpm **11.24.0**. Command:

```text
node artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking-benchmark.cjs
```

The script transpiles the real tracker in memory and substitutes only host/storage adapters. Both runs use the same task ID, `src/repeated.ts` path, fresh in-memory metadata, fixed `Date.now() = 1700000000000`, and sequential repeated `read_tool` observations. It counts rows loaded, rows saved, final compact JSON bytes, and cumulative compact JSON bytes sent to the mocked persistence adapter. Each workload was measured before and after. This is deterministic serialization/work volume, not filesystem latency, model throughput, or a live speed claim.

| Events | State  | Rows loaded in total | Rows saved in total | Final rows | Final JSON bytes | Cumulative JSON bytes |
| ------ | ------ | -------------------: | ------------------: | ---------: | ---------------: | --------------------: |
| 64     | Before |                2,016 |               2,080 |         64 |            9,687 |               315,552 |
| 64     | After  |                   63 |                  64 |          1 |              174 |                11,136 |
| 128    | Before |                8,128 |               8,256 |        128 |           19,351 |             1,249,600 |
| 128    | After  |                  127 |                 128 |          1 |              174 |                22,272 |

Doubling events previously multiplied cumulative serialized bytes by about 3.96; it now multiplies them by exactly 2 for this workload. Sequential reads still perform one persistence operation each. The improvement comes from bounded same-path metadata and removing repeated per-field filtering/sorting. Costs still grow with distinct tracked paths; mixed-path/source queue admission is not globally bounded by this patch.

## Regression and validation evidence

Before implementation:

```text
pnpm --dir src test core/context-tracking/__tests__/FileContextTracker.spec.ts --maxWorkers=1
Original coverage: 1 file passed; 7 tests passed.

node artifacts/directory-review-2026-10-20/clean-03-persistence-repro.cjs
All four audit probes reproduced their findings, including one leaked post-disposal watcher.

pnpm --dir src test core/context-tracking/__tests__/FileContextTracker.spec.ts --maxWorkers=1
After adding initial regressions, before production edits: 9 failed; 9 passed.
Failures specifically demonstrated row growth, legacy folding absence, deferred pending-event publication,
wrong root, no-workspace skip, both unmatched suppression paths, and disposal races.
```

After implementation and additional edge coverage:

```text
pnpm --dir src test core/context-tracking/__tests__/FileContextTracker.spec.ts --maxWorkers=1
1 file passed; 20 tests passed before the final replacement-owner regression was added.

pnpm --dir src test core/context-tracking/__tests__/FileContextTracker.spec.ts core/condense/__tests__/foldedFileContext.spec.ts core/context-management/__tests__/context-management.spec.ts --maxWorkers=1
3 files passed; 79 tests passed, including all 21 tracker tests.
```

Coverage includes serialized concurrent files, a 128-read bound, historical per-source dates, timestamp filtering, reload-shaped metadata, the existing metadata schema, undated legacy reads, 64 mixed observations bounded to six rows, checkpoint evidence, a 128-event controlled save burst, source ordering, alternate/no-editor roots, initial/existing Alpha writes, disposal during saves and reads, late callbacks, idempotent disposal, and a replacement-owner barrier. No arbitrary sleeps or network calls are used.

Additional focused checks passed:

```text
pnpm --dir src exec eslint core/context-tracking/FileContextTracker.ts core/context-tracking/__tests__/FileContextTracker.spec.ts
node --check artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking-benchmark.cjs
pnpm exec prettier --check src/core/context-tracking/FileContextTracker.ts src/core/context-tracking/__tests__/FileContextTracker.spec.ts artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking-benchmark.cjs artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking.md
git diff --check -- src/core/context-tracking
```

Extension typecheck and exact VS Code **1.138.0 smoke / 1.125.0 compatibility** gates are reserved for the parent integration pass under the assigned concurrency constraints. This agent did not run a broad typecheck, build, host gate, live watcher experiment, or crash/power-loss durability experiment and does not claim those passed.

Closure ledger: **fixed now** — all four verified tracker findings and duplicate receipt rearming from delayed metadata work; **flagged for follow-up** — globally bounded mixed-path/source queue admission and any stricter self-event identification that can be tied to a real write/version boundary; **not verified here** — parent type/host gates, native watcher scheduling, and cross-instance/process metadata concurrency; **out of scope** — canonical transcript storage, Task lifecycle redesign, and other reviewers' files.
