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

## Closure ledger

- In progress: NOR-29 production implementation, independent integration tests, measured optimization, and release gates.
- Not yet verified: post-change performance, full combined tests, exact-host compatibility, and published artifact.
- Out of scope: CLI/shim, Marketplace/stable release, installation, dependency upgrades, and unrelated architecture work.
