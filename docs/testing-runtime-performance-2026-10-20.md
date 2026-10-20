# Incremental chat metadata performance, 2026-10-20

This bounded performance pass removed unrelated chat projection from each incremental streamed message. It preserves
Alpha's existing lifecycle projector, per-view selection, metadata shape, transport ordering, and tools. It introduces no
cache or persistent format change.

## Finding and ownership

**PERF-RUNTIME-01 — Medium, should-fix, fixed now.** `AlphaProvider.postTaskMessageToWebview` projected every registered
runtime through `getLiveTaskMetadata()` and then selected one task ID. Every streamed update therefore read every chat's
usage, model, input ownership, and status. The compatibility projection could additionally scan unrelated transcripts.

`TaskSessionRegistry` owns the metadata projection. Its existing `getMetadata()` now shares the same private projector
with `getMetadataForTask(taskId)`. Only the incremental message caller uses the per-task method. Each call reads current
state; there is no cached metadata, invalidation path, new state store, or changed lifecycle authority.

The requesting registry still determines `isActive`, including a task owned by another view of the same host. Missing
runtime IDs return `undefined`. All-chat snapshots continue using the existing all-chat API.

## Codex comparison

The current reference was retrieved on 2026-10-20 at commit
[`18795fc12571a3530d3e4ac18366e41cd2f57448`](https://github.com/openai/codex/tree/18795fc12571a3530d3e4ac18366e41cd2f57448).
Codex's [`ThreadWatchManager`](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/app-server/src/thread_status.rs#L113)
separates a single thread's status read from selected-thread status reads; `ThreadWatchState` resolves status from facts
keyed by thread ID. Alpha keeps its native TypeScript projection and VS Code transport while avoiding unrelated reads
for an event concerning one chat. No Codex runtime code was copied, and no behavioral divergence was introduced here.

## Workload and evidence

The baseline was captured before changing production files. The local fixture imports the actual
`TaskSessionRegistry` and lifecycle implementation and extracts the actual `AlphaProvider.postTaskMessageToWebview`
method. It uses 1, 3, 10, and 50 registered chats, 5,000 fixed text messages per chat, one transport, and both canonical
and legacy status projection. It includes JSON serialization and makes no provider or disk requests during measurement.

The initial before/after runs used seven samples of 100 updates after 20 warmup updates. A second paired comparison used
nine samples of 100 updates after 100 warmup updates, alternating variant order. In that comparison, both variants use
the same final registry projector; only the incremental caller's metadata line is restored to its original all-chat
lookup for the control. Source and method hashes are recorded in the JSON artifacts.

Exact operation counts are the primary result: with 50 registered chats, each update performs **one model lookup and one
usage read**, compared with **50 of each before**. Ask-ownership reads fall from 100 to 2. The counts are the same for
canonical and legacy projection, and the target-only count stays constant as other chats are added. Each paired sample
published the same number of messages and serialized the same number of bytes.

Paired warm CPU timing, milliseconds per incremental update:

| Chats | Projection | Original all-chat lookup | Target-only lookup |
| ----- | ---------- | ------------------------ | ------------------ |
| 1     | Canonical  | 0.01453                  | 0.01351            |
| 3     | Canonical  | 0.02351                  | 0.01257            |
| 10    | Canonical  | 0.02321                  | 0.00735            |
| 50    | Canonical  | 0.04008                  | 0.00584            |
| 1     | Legacy     | 0.02038                  | 0.02188            |
| 3     | Legacy     | 0.06258                  | 0.02102            |
| 10    | Legacy     | 0.16257                  | 0.01623            |
| 50    | Legacy     | 1.91060                  | 0.01277            |

These are medians of sample means on a workstation also running other validation. They are supplemental evidence,
including the small single-chat legacy timing increase. They do not establish provider latency, extension-host first
paint, model quality, or general user-perceived speed. The intentional algorithmic change is removing projections of
unrelated tasks, whose operation count is protected by deterministic tests.

Local retained evidence is under `artifacts/testing-2026-10-20/perf-runtime/`:

- `stream-metadata-before.json`, `stream-metadata-after.json`, and `stream-metadata-paired.json` retain raw samples,
  counts, conditions, and source hashes.
- `stream-metadata-baseline.cjs` and `stream-metadata-paired.cjs` are the local reproduction fixtures.
- `regression-before.json` records the intended failure with the original caller: an unrelated chat's model metadata
  was read. `regression-after.json` and `provider-adjacent.json` retain passing regression results.

## Validation and limits

Ten new deterministic cases cover 50-task isolation, missing IDs, canonical/waiting/legacy/degraded/terminal metadata
equivalence, live queue/usage/control/revision changes, per-view focus, and the actual incremental publication path.
The intended publication regression failed before the caller changed and passed afterward.

The six focused registry/navigation test files passed **82/82** cases. The existing `AlphaProvider.spec.ts` file passed
**148** cases with **6 pre-existing skips**. `pnpm --dir src check-types`, scoped ESLint, scoped Prettier, and the scoped
whitespace check passed. Tests used at most two workers.

The broader testing pass owns the exact VS Code 1.138.0 host gate, live evaluations, and release packaging; these focused
results do not substitute for those gates. History-query caching, task hydration, persistence receipts, settings-cache
invalidation, and full-state payloads were inspected for candidate selection but were not changed or fully benchmarked
by this bounded optimization.
