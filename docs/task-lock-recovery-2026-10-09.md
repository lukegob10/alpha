# Task-storage lock crash recovery

Alpha's task-storage lock can prevent an agent turn from reaching any provider. The defect reproduced here belongs to
`FileAgentControlPersistence`, before model invocation; the report from the other machine was not inspected directly.

## Root cause

The old transaction protocol created `agent_control.json.transaction.lock/` and then wrote `owner.json`. A process could
die between those operations, or during metadata writing, leaving an empty or unreadable directory. Admission correctly
refused to steal an unknown owner's lock, but subsequent activations could only time out and request offline repair.

A second failure occurred when Windows denied release renames and release-marker writes. The completed transaction's PID
could remain alive, or later be reused, so another persistence instance could interpret the leftover metadata as a live
writer indefinitely. Restarting a task or changing providers did not repair that storage condition.

## Reference behavior

Current Codex CLI source and tests were retrieved on **2026-10-09**:

- [Rollout writer locking](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock.rs) holds an OS file
  lock while a writer owns the resource. Filename existence alone does not establish ownership.
- [Writer-lock tests](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock_tests.rs) cover rejecting
  competing writers and treating unlocked leftover files as idle.

Alpha implements this ownership behavior in its existing TypeScript persistence layer. Node does not expose the same
portable file-lock API. Its bundled [SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) supplies the
cross-platform [OS locking semantics](https://www.sqlite.org/lockingv3.html) without adding a native dependency.

## Ownership and compatibility

Every transaction first acquires `BEGIN EXCLUSIVE` on `agent_control.json.coordination.sqlite`, with a zero SQLite busy
timeout. Contention remains in Alpha's asynchronous watcher/polling loop, using the existing cancellation, FIFO queue,
backpressure, and combined queue/acquisition deadline. This file contains **no task data or schema**; `agent_control.json`
remains authoritative. Closing the connection or terminating the process releases the OS ownership automatically.

The coordination file must retain its identity. Do not delete or replace it while a host may be running: deleting a lock
filename does not close another process's OS handle. Its persistent presence is expected and does not mean a task is stuck.

New transaction metadata is written and closed in a unique sibling candidate before a
[no-replace hard link](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath) publishes it at
the existing canonical `.transaction.lock` path. A crash before publication leaves an unused candidate; a crash after
publication leaves complete metadata. Candidate cleanup failures cannot abandon an admitted transaction or mask its
original cancellation/error.

The canonical path is now a regular file. Old hosts still cannot acquire it with `mkdir`; new hosts cannot publish over an
old directory. Filesystem shape, rather than an untrusted metadata flag, identifies the protocol. Once the OS guard is
acquired, leftover regular-file ownership is known to be finished, even when its recorded PID is still alive. Token
comparison and the existing synchronous fence/atomic JSON replacement continue to protect commits and escaped callbacks.
After release moves the canonical marker, the OS guard closes before token-specific Windows cleanup completes, so cleanup
cannot delay a successor unnecessarily.

Cleanup failure is diagnostic once OS ownership has closed. It cannot reject a successfully fenced read-only operation
or initialization, just as it cannot reject a committed write. Operation failures, lost ownership, and save failures still
propagate. This closes the remaining activation failure when a host cannot rename its completed lock metadata.

Legacy directories remain readable. Valid legacy process ownership and permanent reaper tombstones keep their existing
semantics. An ownerless or malformed legacy directory is automatically quarantined only when the current persistence
instance holds an activation lease and **every foreign activation record proves its process is dead**. Production stores
acquire those leases before starting any transaction. Foreign leases with live, missing, malformed, oversized, or unsafe
metadata remain protected. Lease inspection is bounded, validates IDs, and rejects symbolic links. Direct persistence
callers without an activation lease retain conservative offline recovery for unknown old directories.

Automatic quarantine preserves the original metadata and leaves `agent_control.json` and task history intact. No age-based
lock stealing, unconditional directory deletion, transaction replay, or storage reset is introduced.

Task recovery now names storage contention explicitly and offers Resume. An unverifiable legacy owner explains automatic
recovery after other hosts stop, with offline repair retained for ownership that still cannot be established. Structural
E2E evidence and fixture-only offline repair accept both directory and regular-file metadata. The offline restart safety
campaign now seeds a controlled foreign activation record, because an isolated empty legacy lock alone automatically
recovers.

## Host and validation

The exact Windows VS Code **1.125.0** executable was probed with `ELECTRON_RUN_AS_NODE=1`. Its Node **24.15.0** / Electron
**42.2.0** runtime supports the builtin SQLite connection, exclusive transaction, rollback, and close used here. The
builtin loads lazily when persistence runs. No extension manifest, persisted agent-state schema, provider contract, or
production dependency changes are required.

Regression coverage includes:

- Publication barriers and cancellation before admission; candidate cleanup failure and no-overwrite admission.
- Real process termination during preparation, after publication, after a committed state update, and after release.
- A fresh instance recovering when release and release-marker writes both fail while the old PID stays alive.
- Successful activation/read-only work despite metadata cleanup failure, with operation errors still preserved.
- Automatic activation recovery of missing, empty, and malformed legacy metadata without resetting retained state.
- Preservation of foreign activation leases whose ownership remains live or uncertain.
- Existing process contention, cancellation, Windows cleanup, stale-context fences, and task-recovery behavior.
- Exact-host bundled-persistence recovery, retained history, and a real task API reaching a scripted model and completing
  after an injected interrupted legacy publication.

Focused validation passed 543 extension tests across the agent-control, task-recovery, history, and profile suites, plus
33 evidence/offline-recovery unit tests. Extension and E2E type checks and touched-source lint passed. Exact-host storage
recovery executes four tests, including the task-to-model regression; the 1.125.0 smoke gate also covers the full task
surface. The final change reruns the host gates after the read-only cleanup correction.

Reproduction/validation commands:

```sh
pnpm --dir src test core/agent/__tests__/AgentControlStore core/agent/__tests__/AgentControlLockWaiter.spec.ts core/task/__tests__/Task.spec.ts core/webview/__tests__/AlphaProvider.taskHistory.spec.ts core/webview/__tests__/AlphaProvider.sticky-profile.spec.ts --maxWorkers=2
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
pnpm --dir apps/vscode-e2e compile
node apps/vscode-e2e/out/runTest.js --vscode-version 1.125.0 --provider scripted --require-all-tests --file storage-recovery.test
pnpm certify:managed-agents:automated
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-3.1.10.vsix --check-source
```

Managed certification writes source-bound results to `artifacts/certification/managed-agent-milestone-evidence.json`.
Its deterministic gate and exact-host managed-agent suites can also run as the two constituent package scripts after
independent smoke checks finish, to avoid racing the E2E compiler's output directory. No live Copilot request is required
for these deterministic storage regressions.
