# Stage 4: transcript persistence and prerelease

## Scope and intended end state

This is a bounded **performance optimization** and recovery-contract pass for
[NOR-29](https://linear.app/norval/issue/NOR-29/make-transcript-persistence-incremental-without-weakening-recovery).
Reduce repeated full-transcript processing at the existing persistence boundary without introducing a competing
authority or weakening durable tool admission, ordered transactions, cancellation, and saved-task compatibility.
The user also requested an incremented prerelease after implementation and validation.

The integration branch is `codex/stage-four-core-harness`, based on completed Stage 3 commit
`2e8659a01c47fda21653a3ca2807f6050af76c97`. The existing user-authored `AGENTS.md` modification is preserved and excluded
from commits. CLI/shim changes, dependency upgrades, lockfile churn, unrelated cleanup, Marketplace publication, and
local extension installation are excluded. VS Code 1.122.1 remains the exact compatibility gate.

## Ownership and model policy

The single requested new app task is `01a06cef-15cd-7371-95a4-931312a5886d`, titled
`NOR-29: Incremental transcript persistence`. It uses Sol Max and confirmed the exact Stage 3 base in its clean
`codex/nor-29-incremental-persistence` worktree before implementation. Sol Max owns planning, decisions, hard
implementation, and uncertain reviews. Bounded implementation and benchmark helpers may use Luna Max.

- Owner: production persistence and localized Task integration, existing store/Task tests, real-disk benchmark,
  migration/concurrency tests, and `docs/nor-29-implementation.md`.
- Orchestrator: this plan, independent real-Task transaction regressions, integration, combined gates, release metadata,
  prerelease publication, and Linear closure.
- Independent Sol Max reviewer: authority/fence/recovery audit, followed by the exclusively owned
  `src/core/task-persistence/__tests__/stageFourTranscript.integration.spec.ts`.

## Verified baseline and design boundaries

Current code, not historical design documents, establishes the starting contract:

- `api_conversation_history.json` is the runtime, export, diagnostics, and delegated-handoff authority. Task saves first
  write this legacy history and then reconcile and verify a `ProviderTranscriptStore` sidecar.
- The version 1 sidecar embeds a second complete transcript. Reads and receipt verification reread and hash it. Task's
  effect fence separately hashes current in-memory history; receipts are not cache-only trust.
- Task's persistence queue and owner generation coordinate replacement instances within one process. They do not
  provide cross-process compare-and-swap over the two-file transaction.
- Baseline effect fences do not notice an external legacy-only edit if the sidecar remains unchanged. This is an
  existing safety gap, not a guarantee to claim as already present.
- The existing writers do not promise uninterrupted destination presence across all Windows replacement failures or
  full power-loss durability. Any stronger new guarantee requires implementation and fault-injection evidence.
- Compaction, metadata changes, rewind, restoration, and completion rollback can replace history; history is not
  universally append-only. Provider-specific opaque fields and canonical response/tool metadata must survive exactly.

The candidate design is a compact version 2 receipt binding the exact legacy JSON bytes to their digest and length,
using asynchronous synced writes and fresh disk verification. It removes duplicate full-history sidecar work while
retaining legacy readers. This is subject to measured results and integration review, not a predetermined requirement
for a log/checkpoint format. Full legacy snapshots, if retained, must be stated as a residual cost rather than advertised
as append-only persistence.

Primary source inspected on 2026-09-04:

- [Codex recorder at `a7ab2d66d781b903cb060288a89e26e8d2b9a05f`](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/rollout/src/recorder.rs)
  uses a bounded writer queue and explicit flush/shutdown acknowledgments. Alpha should preserve equivalent bounded
  ownership and truthful completion, not copy vendor-specific source structure.
- [Pi session manager at `6aedd1066e540642165aa30fa7b4a1b863778aa7`](https://github.com/earendil-works/pi/blob/6aedd1066e540642165aa30fa7b4a1b863778aa7/packages/coding-agent/src/core/session-manager.ts)
  separates initial history writing from subsequent appends. Its synchronous filesystem calls are inappropriate for
  the VS Code extension host and are not an implementation template here.

## Required implementation and integration contracts

1. Before every admitted effect, the assistant call has a valid durable receipt matching actual persisted authority and
   current step history. Failed persistence, stale receipts, same-size replacement, and tampering fail closed.
2. Accepted calls retain truthful, ordered terminal results. Interrupted transactions are repaired explicitly; recovery
   neither automatically reruns historically ambiguous external effects nor invents successful results.
3. Legacy-only, version 1, mixed sidecar, corrupt/partial-write, and interrupted-migration fixtures remain readable or
   fail according to an explicit deterministic contract. Repeated recovery is idempotent.
4. Mutation of caller-owned data during awaited writes cannot change the snapshot a receipt describes. Concurrent
   commits, replacement Task generations, metadata-only edits, compaction, and rewind have explicit tested behavior.
5. Queue admission and retained snapshots are bounded; shutdown, cancellation, and flush settle accepted work and release
   resources. No new synchronous extension-host I/O or unbounded buffers.
6. Matched short/long real-disk fixtures measure serialized/read/written bytes, hash work, flush count, fence latency,
   and event-loop delay. Record samples, workload, commands, and limitations. Correctness is not traded for speed.
7. Preserve Stage 1-3 policy/catalog snapshots, parallel read rules, context retention, verification debt, completion
   gates, mutation authority, and managed-agent lifecycle contracts.

## Baseline and validation strategy

Before Stage 4 edits on 2026-09-04, the root correctness baseline passed **six files / 98 tests** in 14.83 seconds:

```sh
pnpm --dir src exec vitest run core/task-persistence/__tests__/ProviderTranscriptStore.spec.ts core/task-persistence/__tests__/apiMessages.spec.ts core/task-persistence/__tests__/stageTwoTranscript.integration.spec.ts core/task-persistence/__tests__/stageThreeVerificationRecovery.integration.spec.ts core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/Task.compaction-safety.spec.ts --maxWorkers=2
```

This establishes correctness coverage only. Matched performance measurements belong in the owner's implementation
record and benchmark artifacts. Independent regression tests use real temporary files and the real Task persistence
path, with controlled provider/I/O seams rather than arbitrary sleeps.

The independent real-Task fixture initially ran seven cases against the unchanged Stage 3 production code: four controls
passed, while three intended regressions failed. Equal-size legacy-only in-place edits and replacement files passed the
old fence, and a second serial tool executed after tampering. Passing controls cover opaque metadata/result reload,
sidecar failure after the legacy write, stale replacement instances, and termination joining late result producers.
The initial focused test took 541 ms (10.42 seconds including setup); this is regression evidence, not a speed metric.
Stricter finalization added an eighth abort-cleanup case and explicit typed flush-failure assertions. The expanded
unchanged-code run has three passing controls and five expected failures; all eight pass in the owner's v2 worktree.

The accepted real Stage 3 performance baseline uses frozen benchmark blob
`03a9d2ebb1cba9030a3cb221c496eb0c48c46f5f`, with one warmup and three measured repetitions per workload on Windows,
Node 20.19.2. Three calibration tests cover all active SHA-256 work through both import styles and Buffer/chunk updates,
instrumentation restoration, and missing-sample handling. Earlier provisional runs with incomplete counters are excluded.
The long fixture has 36 growing snapshots ending at 108 messages / 756,135 legacy bytes. Mean flush/fence latencies are
57.898448 / 11.062681 ms; serialized/read/written/hash-input bytes are 292,224,824 / 55,973,991 / 27,980,721 / 97,154,122.
These are fixture measurements, including instrumentation overhead, not a general responsiveness guarantee.

### Recovery review refinements

The final integration fixture adds exact preservation of the detected external transcript bytes after error-result
persistence, malformed/missing v2-authority reload refusal, and stale Claude fallback refusal (eleven cases total).
All eleven passed in the implementation worktree. Detected conflicts use recovery-only
`api_conversation_history.json.conflict_<digest>.json` evidence, with a four-file cap and no automatic deletion/rotation.
Preservation verifies bounded-copy bytes and file identity, syncs the evidence, and still rejects the original effect.
The review reproduced Windows `EPERM` from syncing a read-only handle; existing evidence now uses a nontruncating
writable handle when verifying durability. Failed capture blocks subsequent legacy writes, including queued work.

Fallback migration now admits only a legacy-compatible sidecar under the sidecar lock, rechecks primary-file absence
inside the legacy lock, and uses the guarded strict writer. Missing v2 authority cannot silently migrate an older
`claude_messages.json`; read/admission failure preserves both files and fails the Task's finalization boundary.
An independent review also caught two simultaneous legacy-only readers: the second now rejects with a typed reload
requirement if the first already migrated, rather than returning an obsolete empty history. A controlled rename barrier
reproduces the race. Both migration findings are resolved in the final bounded review.

An unresolved capture failure is intentionally not cleared by ordinary save retries. After safeguarding evidence,
operators may need to restore permissions/capacity or a valid legacy snapshot, restart the host, and reopen the task.
No claim is made that the current failed Task's UI guarantees automatic recapture. A crash after an external effect but
before its result is durably written remains ambiguous; recovery must not rerun it automatically or invent success.

Required gates before publication:

- Focused recovery, receipt, migration, tamper, concurrency, cancellation, and lifecycle integration regressions.
- Affected package lint/typecheck; broader core/task/persistence/context/tool and provider-transform tests.
- Repository lint/typecheck for cross-cutting changes and affected shared/webview consumers.
- Exact host: `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`.
- Managed lifecycle: `pnpm certify:managed-agents:automated` when the persistence/lifecycle contract is affected.
- Release: `pnpm bundle`, `pnpm vsix`, and `node scripts/verify-vsix-contents.mjs <exact-vsix-path>`; inspect the actual
  prerelease artifact's manifest, version, extension identity, host baseline, and checksum.
- Final diff and commit review: no user guide, protected subtree, secret, unrelated output, or dependency churn.

Run real extension-host gates sequentially. Report unavailable checks explicitly; do not count historical Stage 3
results as Stage 4 validation or describe one synthetic workload as a general live-model quality/speed gain.

## Publication plan

The established channel is the GitHub VSIX prerelease workflow on `main-v2`, not the Marketplace or stable `main`.
At initial preflight, its latest published version is **2.1.18**, tagged
`vsix-v2-preview-2.1.18-0de6860` at `0de6860f6d9b7b9d64c3b377c57ebecc016e46a3`. The expected next version is **2.1.19**;
recheck releases and remote ancestry immediately before incrementing and publishing to avoid a concurrent collision.

Update only the extension version, matching changelogs, and relevant preview release notes/workflow. The current
preview workflow now extracts the exact version's changelog section instead of hardcoding older highlights, selects
the exact versioned artifact, propagates packaging/publication failure, and refuses published-asset overwrites.
Prettier's YAML parse and three PowerShell block syntax checks passed; version-section extraction passed LF/CRLF and
missing-version checks without executing publication. Publish only the validated commit with a
fast-forward-safe operation; never force-push or overwrite an existing published artifact. Confirm the published
release is marked prerelease and its version, commit, VSIX name, and downloadable artifact match the intended build.

## Accepted benchmark outcome

The matching implementation run uses the same frozen fixture, runtime, warmup and three measured samples per workload.
Raw samples and counter calibration are retained in `docs/nor-29-benchmark-baseline.json`,
`docs/nor-29-benchmark-incremental.json`, and the full interpretation in `docs/nor-29-implementation.md`.
The final confirmation run on settled production code was recorded at 2026-09-04 15:40:29 UTC. Long-history mean save
latency decreased from 57.898 to 33.209 ms, effect fences from 11.063 to 5.634 ms, and bytes written per repetition from
27,980,721 to 13,995,626. These are approximately 43%, 49%, and 50% reductions respectively.
The implementation still writes complete legacy snapshots; only the sidecar is an incremental metadata receipt.

Short fences increased from 2.381 to 3.427 ms. The unchanged-save short control increased from 16.459 to 19.722 ms per
save and 2.604 to 3.653 ms per fence. Stronger real-authority verification and explicit legacy sync remain enabled;
there is no claim of universal speedup or meaningful event-loop p99 improvement. Logical saves are counted, not fsync
syscalls. Earlier incomplete-hash measurements are excluded from all conclusions.

## Combined validation on the integration branch

The following checks ran on September 4, 2026 after integrating NOR-29; shared types and webview consumers ran during
handoff and their inputs are unchanged by that integration. Historical Stage 3 runs are not substituted for these checks.

| Check                                                                                                                         | Actual result                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Focused persistence, Task flush/retry and delegation suite, `--maxWorkers=2`                                                  | 21 files; 197 passed, one opt-in benchmark skipped; 24.61 s                                                  |
| Core agent/task/persistence/tools/context/condense/environment/webview and history/nested-delegation suites, `--maxWorkers=2` | 167 files; 2,402 passed, 12 skipped; 164.29 s                                                                |
| `pnpm --dir src exec vitest run api/providers api/transform --maxWorkers=2`                                                   | 87 files; 1,575 passed, two skipped; 28.52 s                                                                 |
| `pnpm --dir packages/types exec vitest run`                                                                                   | 21 files; 272 passed; 2.08 s                                                                                 |
| `pnpm --dir webview-ui exec vitest run src/components/chat src/components/agents --maxWorkers=2`                              | 44 files; 507 passed; 62.93 s                                                                                |
| `pnpm check-types`                                                                                                            | 13 successful tasks, 11 cached; 21.715 s                                                                     |
| `pnpm lint`                                                                                                                   | 12 successful tasks, 11 cached; 18.062 s                                                                     |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`                                                                        | Passed: exact 1.122.1 extension, modes, and VS Code LM contract suites; all three host processes exited zero |
| Touched-file Prettier and final `git diff --check`                                                                            | Passed; Markdown line-ending formatting normalized without changing content                                  |

Expected skip counts remain explicit; the opt-in measurement was separately executed and passed. The exact-host command
also ran `pnpm bundle` and rebuilt the webview. Managed-agent certification and final packaging/publication remain pending.

## Closure ledger

- Integrated owner commit `93ef5f9e9e1a9376cbc26efcc4afe26f490acd1a` as `2e30642`, with independent root integration
  coverage and 2.1.19 release metadata. The user guide remains unchanged and excluded.
- Verified in the implementation worktree: 21 focused files / 197 tests passed, one opt-in benchmark skipped; the
  separate calibrated benchmark passed all four cases. Source typecheck passed. Root integration gates remain pending.
- Verified in the integration branch: focused and broad core/provider suites, shared/webview consumers, repository
  lint/typecheck, and the exact VS Code 1.122.1 smoke gate.
- Not yet verified: managed-agent certification, packaged prerelease metadata, and published artifact.
- Out of scope: CLI/shim, Marketplace/stable release, installation, dependency upgrades, and unrelated architecture work.
