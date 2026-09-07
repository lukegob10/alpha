# Transcript replacement contention in the latest local run

Date: September 5, 2026. Times below are local (America/New_York).

The primary task ended before making an edit because saving its authoritative conversation transcript failed. This
incident is distinct from the earlier trace discussed in `nor-36-local-git-trace-review-2026-09-05.md`.

## Evidence and source reachability

- Primary task `01a074b6-0ddb-745b-ae7e-60d73cdd7323` ran approximately 23:14:43–23:18:21. Its history lists child
  `b8f1dfc5-d6b8-44e0-8cf0-5bd437237693`; the child's history independently records the same parent and root IDs.
- The child stopped at its configured cumulative input-token limit (254,070 / 250,000). The primary subsequently
  continued its own inspection and commands. That budget outcome did not cause the primary's terminal failure.
- The matching logs are in session `20260902T234805`, window 3. `renderer.log` lines 84 and 104 record `EPERM` while
  renaming a completed temporary file over `api_conversation_history.json`, at 23:17:29.965 and 23:18:21.242 respectively.
  The stack identifies `atomicWriteText`, `writeApiMessages`, and the task's transcript-save path.
- The final lifecycle event records a failed turn because provider pacing metadata could not be persisted. The UI ends
  at the existing resumable boundary. No completed enhancement or successful final handoff is recorded.
- The matching Alpha output log records development extension version **2.1.24**. The extension-host stack identifies
  the development checkout's `src/dist/extension.js`, rather than the separately installed 2.1.18 extension. The inspected
  development bundle was last written at 23:13:04, before activation at 23:13:35, with SHA-256
  `80b95c07cccce5e3e7b25cb93e567650448cec31d1275d9b3d44680d2e599d93`.
- The loaded bundle's `atomicWriteText` matches the inherited baseline implementation after normalizing compilation
  syntax and bundled symbol names. The matching strict call sites and terminal error are also present in the bundle.
  This establishes reachability of this defect; it does not claim the whole checkout is identical to the loaded bundle.

The logs do not identify the process holding the file or establish how long each failed replacement remained unavailable.
The reproduction therefore injects filesystem contention at the observed boundary rather than attributing it to a
particular watcher, scanner, provider, project, or framework. Windows rename contention and bounded retries are also
documented in the [graceful-fs implementation](https://github.com/isaacs/node-graceful-fs/blob/main/polyfills.js).

## Fix and regression

Previously, strict atomic writes propagated the first rename error immediately, even when the next attempt could succeed.
`atomicWriteText` now retries only `EPERM`, `EACCES`, and `EBUSY`, with at most six rename attempts and 775 ms of total
scheduled backoff per replacement. Filesystem-operation time is additional. Each attempt uses the same fully written,
synced, closed sibling temporary file while the caller retains its transaction lock.

Strict writes never delete the previous destination. Exhausted contention and unrelated errors still propagate; temporary
files are cleaned up. Receipts are issued only after the replacement succeeds. The task's failure, cancellation,
completion, approval, and provider-pacing contracts are unchanged. Non-strict writes also benefit from retry before their
existing compatibility fallback.

Before changing production, `atomicWrite.spec.ts` reproduced transient strict-write rejection and deletion during a
transient non-strict replacement: **8 failed, 4 passed**. After the change: **12 passed**. The receipt integration regression
also verifies a transient authoritative-transcript failure recovers and its new receipt binds the durable bytes and sidecar.
Existing persistent-failure tests now inject sustained faults, retaining their previous-snapshot, cleanup, and reload-repair
assertions independently of the retry count.

Validation in the isolated worktree:

- `pnpm exec vitest run core/task-persistence/__tests__/atomicWrite.spec.ts core/task-persistence/__tests__/incrementalTranscriptReceipt.spec.ts core/task-persistence/__tests__/ProviderTranscriptStore.spec.ts core/task-persistence/__tests__/apiMessagesMigration.spec.ts`
  from `src`: **4 suites, 38 tests passed**.
- `pnpm run lint` and `pnpm run check-types` from `src`: **passed**, after installing and building the owning workspace
  dependencies. The initial attempts lacked those dependencies; no production change was needed to resolve that setup.
- Exact VS Code **1.122.1** smoke and managed-host gates were reserved for serialized integration by the parent task.
  See [the combined revalidation](extension-agent-loop-bug-revalidation-2026-09-06.md) for integrated results. This fix
  was not installed into the user's running host by the issue task.

## Remaining boundaries

Persistent permissions or contention beyond the retry allowance can still stop a save. This fix does not prove the original
incident would clear within that allowance, and it does not change the child's existing token-budget contract.

The preexisting non-strict delete-then-rename fallback remains after retries are exhausted. Its callers are
`ProviderTranscriptStore.commit`, `ProviderTranscriptStore.repairFromAuthoritativeTranscript`, and
`AgentLifecycleJournal.persistSnapshot`. If destination deletion succeeds and the fallback rename fails, the previous
non-strict file can be lost. That separate data-integrity risk needs its own reproduction and compatibility review; strict
authoritative transcript and v2 receipt writes do not use the fallback. Lifecycle snapshots additionally have journal replay.

The final UI did not expose the persistence failure alongside its resume prompt, although lifecycle telemetry retained
it. The separate recovery fix described in the combined revalidation now adds a safe localized explanation before that
boundary, without copying raw diagnostic text into chat.

Inherited evidence and blocked-handoff changes were committed separately as
`e61286a6b849e0758b9b587b6efe5038d09a2f1f` above frozen base `6a5c3a5745aa5339e9f2e27025bcc8ae42cf6c65`.
They are not part of this fix.
