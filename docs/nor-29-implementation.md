# NOR-29 — incremental transcript receipts

## Scope and decision

Implementation base: Stage 3 `2e8659a01c47fda21653a3ca2807f6050af76c97`, on
`codex/nor-29-incremental-persistence`. The user-authored primary-checkout engineering guide was read, not edited.
This is a bounded performance-optimization pass using `clean-code-review`, not an append-log implementation or a
repository-wide audit. Release integration and the exact VS Code 1.122.1 host gate belong to the originating task.

The legacy `api_conversation_history.json` remains the only runtime/export transcript authority. Stage 3 wrote that
complete history and another complete provider sidecar, repeatedly parsing, canonicalizing, hashing and cloning the
sidecar on saves and effect fences. NOR-29 makes the sidecar an incremental **metadata receipt**. Full legacy snapshot
writes and the mutable-memory digest check remain intentionally conservative. A WAL and checkpoint migration would
introduce another recovery protocol without removing the existing legacy readers or mutable-history contract.

## Format and commit contract

V1 embedded-message envelopes remain readable; `commit(messages)` retains the standalone v1 API. Active Task saves use:

1. Capture the intended snapshot before queue admission yields to asynchronous work.
2. `saveApiMessages` canonicalizes JSON before its first await. Object keys use the existing `localeCompare` ordering;
   array order and unknown provider fields are preserved. The exact UTF-8 legacy file has **no trailing newline**.
3. Under the existing legacy advisory lock, write a sibling temporary file, asynchronously `sync()` it, close it, and
   rename it to the legacy path. Strict replacement preserves the old destination when rename fails; it never uses
   the generic helper's delete-destination fallback. Only then return `{ taskId, filePath, digest, byteLength, commitId }`.
4. `commitAuthoritativeTranscript` validates the receipt's task/path, verifies actual legacy bytes, then serializes a
   compact v2 sidecar under its existing advisory lock. The sidecar is also synced and strictly renamed before acknowledgement.
5. Task calls the lean `assertCommitReceipt` after commit and immediately before each effect. It also compares the receipt
   digest with the current mutable in-memory history. A save failure or queue rejection clears the usable effect receipt.

The v2 on-disk sidecar has exactly these fields:

```text
version: 2
taskId: string
revision: positive safe integer
digest: SHA-256 of exact canonical legacy bytes
writtenAt: finite nonnegative timestamp
byteLength: nonnegative safe integer
commitId: UUID
```

It contains no messages, alternate transcript path, journal, or checkpoint. SHA-256 covers all canonical/provider data,
including ordered response items, reasoning signatures, encrypted state, terminal results, and compaction/rewind tags.
The digest is identical to `digestProviderTranscript(messages)`, not a separately defined raw-content identity.

`read()` and `verifyCommitReceipt()` preserve their hydrated `.messages` contract for both versions. V2 load validates
raw bytes **and** their canonical digest. The hot `assertCommitReceipt()` reads current sidecar metadata and hashes the
actual legacy file in 64 KiB asynchronous chunks without parsing or cloning messages. It does not trust a stat cache.
Length limits stop unexpected growth, and before/after handle/path identity checks detect replacement or in-place edits
during verification, including a same-size replacement with restored modification time. Handles and advisory locks
are closed/released in `finally` blocks.

## Recovery, compatibility, and rollback

| Boundary/state                                    | Outcome                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure before strict legacy rename               | No receipt; old legacy file remains intact.                                                                                                                                                                                 |
| Legacy rename succeeds, sidecar sync/rename fails | Legacy contains the new snapshot; old sidecar cannot acknowledge it. Effects fail closed.                                                                                                                                   |
| Receipt committed but caller interrupted          | Current `commitId` replay is idempotent; no effects are replayed by the store.                                                                                                                                              |
| Missing/corrupt/stale sidecar with valid legacy   | Explicit reconciliation/repair uses the legacy snapshot; corrupt metadata is quarantined.                                                                                                                                   |
| Corrupt metadata repaired at revision one         | A fresh metadata `commitId` prevents an old same-digest/same-clock receipt from becoming valid again.                                                                                                                       |
| Missing/corrupt legacy with a v2 sidecar          | V2 verification and Task cold load reject; neither stale sidecar messages nor an older Claude fallback become authority.                                                                                                    |
| Tolerant legacy reader returns `[]`               | Task validates the v2 authority before accepting empty history, returning the verified v2 messages if a concurrent save landed. Read failures propagate and poison finalization. Legacy-only empty tasks remain compatible. |
| Detected external legacy edit                     | The original effect/read fence rejects. Exact observed bytes are preserved as bounded, verified recovery-only evidence before later saves may replace active history.                                                       |
| Conflict preservation or capacity failure         | Typed `repair_failed`; the shared in-process path guard blocks all replacement attempts inside the legacy lock, including already queued saves.                                                                             |
| Compaction, rewind, replacement, cancellation     | Whole canonical legacy snapshot remains the boundary; no append-prefix assumption or tool replay is introduced.                                                                                                             |

Legacy-only tasks and `claude_messages.json` migration remain readable. Fallback migration holds sidecar then legacy
locks, refuses an existing v2/unreadable receipt, rechecks primary-file absence inside the legacy lock, and uses the
same guarded/synced strict writer before removing the fallback. A reader/admission conflict never returns an obsolete
fallback prefix. V1/mixed sidecars retain their explicit repair
path; a subsequent real save writes v2. Older releases can read the unchanged legacy JSON and can quarantine/rebuild an
unknown v2 sidecar from that authority. Rollback therefore needs no transcript conversion, but naturally returns to the
older release's weaker legacy-only external-change detection. Do not restore an old sidecar over a newer legacy file.

### External-conflict evidence and operator recovery

Lean verification and hydrated v2 reads preserve a detected mismatch from the original open handle, under the existing
sidecar-to-legacy lock order. They use fixed 64 KiB buffers and the original observed extent; check source handle/path
identity before and after; independently hash the copy; and sync and close it before clearing the replacement guard.
The evidence name is `api_conversation_history.json.conflict_<observed-sha256>.json`. It is never a reader authority.
Existing evidence must be a regular file with matching exact bytes/length and named-path identity; it is opened `r+`
without truncation because Windows rejects syncing a read-only handle. Identical conflicts reuse verified evidence.

There are at most **four** prefix-matching conflict files per task directory. Reaching capacity fails closed; there is
no rotation or automatic deletion. Failed/partial copies also occupy capacity and cannot authorize a replacement until
full verification succeeds. Complete evidence remains retained even if the source changes after copying. The count is
bounded, not aggregate transcript byte size; copying never follows an indefinitely growing source.

Ordinary `retrySaveApiConversationHistory` does **not** clear a preservation failure. A validated v2 read/assertion can
retry capture after the cause is resolved, but the currently failed Task's UI lifecycle does not guarantee that route.
Conservative operator recovery is to safeguard all evidence, resolve permissions/capacity, restore a valid authoritative
legacy snapshot if needed, then restart the host and reopen from that snapshot. Do not remove evidence to hide a failure
or automatically replay possibly completed external tools. Unpersisted in-memory results are reported as failure, not
as durable success. Fresh noncooperating edits after the verified snapshot remain outside an atomic cross-process CAS.

## Ordering, cancellation, and bounds

The existing per-task-key FIFO and Task-owner generation check remain in place. Admission now permits at most eight
accepted operations/snapshots per task key, rejecting excess saves **before** cloning history. This is an operation bound,
not a byte-size cap or a cross-process writer authority. Protected assistant/result snapshots are not coalesced or dropped.
Pending-count and queue entries are removed after settlement. The store retains only a scalar receipt, not a second
cached message history or a cache of every revision.

Rejected admission and failed saves invalidate the effect receipt and poison finalization until a subsequently admitted
save succeeds. An older queued success cannot erase a later failure. `flushApiConversationHistoryPersistence()` joins
accepted operations and reports unresolved failure. Abort captures that error, drains accepted writes and previews,
stops workers and disposes resources before reporting failure. Completion drains before the final Stage 3 verification
decision, then synchronously rejects a new pending save/failure; there is no new await after that verification decision.

Sidecar writes use advisory-lock serialization and optional expected-revision CAS. Replaying the current commit ID is
idempotent. A stale receipt for different authoritative bytes is rejected; rebinding identical bytes can advance metadata
but never executes effects. An explicitly failed save can be retried; accepted terminal results still drain on cancellation.

## Upstream source inspection

Retrieved and inspected September 4, 2026 (helper full-source retrieval: 15:01:48 UTC), not inferred from documentation:

- [Codex recorder, `a7ab2d66d781b903cb060288a89e26e8d2b9a05f`](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/rollout/src/recorder.rs):
  bounded 256-command channel, owned writer, and explicit Persist/Flush/Shutdown acknowledgements. Enqueue acceptance
  is not durable acknowledgement. Its write/flush does not call `sync_all`/`sync_data`; Alpha does not borrow an fsync
  guarantee from it. Its malformed-line tolerance is unsuitable for silently losing tool-result evidence.
- [Pi session manager, `6aedd1066e540642165aa30fa7b4a1b863778aa7`](https://github.com/earendil-works/pi/blob/6aedd1066e540642165aa30fa7b4a1b863778aa7/packages/coding-agent/src/core/session-manager.ts):
  package `0.84.4`, session format 3. Explicit entry identity and projection are useful precedents, but its synchronous
  open/write/append/rewrite, deferred initial durability and malformed-line skipping are not copied into the VS Code host.

## Measurements and validation

The same benchmark fixture blob `03a9d2ebb1cba9030a3cb221c496eb0c48c46f5f` ran against actual Stage 3 production in the
primary checkout and this implementation, on Windows with Node `20.19.2` and pnpm `10.8.1`. Each workload has one warmup
and three measured repetitions. The final after confirmation was recorded at 15:40:29 UTC. Baseline and after raw reports preserve every sample:
[baseline](nor-29-benchmark-baseline.json), [incremental](nor-29-benchmark-incremental.json).

From the respective checkout, PowerShell commands were:

```powershell
$env:NOR29_BENCHMARK='1'
$env:NOR29_BENCHMARK_MODE='baseline' # 'incremental' in this worktree
pnpm --dir src exec vitest run core/task-persistence/__tests__/nor-29-benchmark.spec.ts --reporter=verbose
```

The short workload has six turns and 192-byte payloads; short-control adds three unchanged saves. Long has 36 turns,
4,096-byte payloads, 108 final messages, and a 756,135-byte final legacy file. Each fixture turn adds ordered
user/assistant-tool/reasoning/result data and persists that complete snapshot. This isolates real persistence boundaries;
it is not an end-to-end provider, UI, or host benchmark. Capturing the immutable snapshot is included in flush latency.
Reloads compare deep message semantics. Cleanup is excluded from elapsed time.

| Workload      | Flush mean, baseline → after (ms) | Effect fence mean, baseline → after (ms) |
| ------------- | --------------------------------: | ---------------------------------------: |
| Short         |                   19.396 → 17.869 |                            2.381 → 3.427 |
| Short-control |                   16.459 → 19.722 |                            2.604 → 3.653 |
| Long          |                   57.898 → 33.209 |                           11.063 → 5.634 |

| Long workload metric, per repetition          |     Baseline |        After |
| --------------------------------------------- | -----------: | -----------: |
| Bytes serialized                              |  292,224,824 |   28,738,904 |
| Bytes read                                    |   55,973,991 |   43,499,148 |
| Bytes written                                 |   27,980,721 |   13,995,626 |
| All active SHA-256 bytes                      |   97,154,122 |   71,448,165 |
| SHA-256 instances / update calls              |    253 / 253 |    182 / 767 |
| Logical saves / legacy writes / effect fences | 36 / 36 / 36 | 36 / 36 / 36 |
| Final sidecar bytes                           |      756,312 |          235 |
| Mean of sample event-loop p99 (ms)            |       14.298 |       13.902 |

Long-history flush latency decreased about **43%**, effect fences about **49%**, and written bytes about **50%**.
This is not universal latency improvement: short fences increased about 1.05 ms; short-control flushes increased
3.26 ms and fences 1.05 ms. Those controls retain real-authority reads, two locks and explicit legacy sync, and do not
coalesce unchanged snapshots. Their safeguards are not removed to improve the benchmark. Three repetitions do not
establish a meaningful event-loop p99 improvement or broad hardware confidence interval.

The historical `fullHistoryHash*` raw field names now measure **all active SHA-256** work, including every streamed
Buffer update, not only string payloads. Independent calibration verifies both default/named crypto imports, instance
counts and exact string/Buffer byte counts; missing latency samples remain absent, not zero. Serialization interception
is scoped/restored and is inactive on normal skipped benchmark runs. Provisional zero/incomplete-hash runs were rejected.
The raw `flushCount` is a logical save count, **not an fsync counter**. Source inspection shows Stage 3 syncs its changed
v1 sidecar while the legacy streaming writer does not explicitly sync; v2 syncs legacy and sidecar for every real save.
Thus stronger durability work is included in measured timing; a separate syscall-level sync count was not collected.

Final validation (September 4, 2026):

- `pnpm --dir src exec vitest run core/task-persistence core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/flushPendingToolResultsToHistory.spec.ts core/task/__tests__/grace-retry-errors.spec.ts __tests__/history-resume-delegation.spec.ts --reporter=dot`: **21 files, 197 passed, one opt-in benchmark skipped**. Includes 17 v2 crash/receipt tests, eight conflict tests and the originating task's 11 real-Task Stage 4 integration cases.
- Opt-in benchmark: **four passed**, including three counter calibrations and the full nine measured samples.
- `pnpm --dir src check-types`: passed.
- `pnpm --dir src lint`: passed; touched-file formatting and `git diff --check` checked before handoff.

Coverage includes strict legacy and sidecar sync/rename failures, retained previous bytes, retry/reload, immutable capture,
CAS and ABA identity, fixed-clock corruption repair, same-size/restored-mtime edits, evidence reuse/capacity/sync/source
races, an already-queued blocked writer, terminal-result ordering/dedup, cancellation drain/cleanup, queue saturation,
no-result completion failure, replacement ownership, missing/corrupt-v2/fallback refusal, and the controlled two-reader
migration race (one reader pauses at rename while the second observes absence and waits for admission). The originating task owns
the Stage 4 integration fixture and commits it separately; this worktree used its exact copied fixture only for validation.

## Residual limits

- Full legacy serialization/write and full mutable-history digest work remain; receipts are incremental, history is not.
- There is no atomic two-file cross-process snapshot CAS. The Task generation/FIFO is same-process ownership; independent
  legacy writers retain the existing last-writer contract. The sidecar CAS does not authorize replaying an external effect.
- A crash after a real effect but before its result receipt remains historically ambiguous. Recovery must not automatically
  repeat it or claim exactly-once external execution. Existing canonical terminal-result/recovery behavior remains authoritative.
- File `sync()` and rename improve the process-crash boundary but do not promise universal power-loss/device durability;
  directory entries are not explicitly synced. Generic unrelated v1 stores retain their prior Windows replacement fallback.
- No new synchronous filesystem work, dependencies, CLI/shim changes, UI changes, release metadata, installs, pushes, or
  publication are included. Exact-host smoke, combined integration, packaging and prerelease validation remain root-owned.
