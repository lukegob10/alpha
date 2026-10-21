# Clean-code review 08: managed agents and shared runtime packages

Mode: **full-surface review, limited to this assigned slice; read-only implementation audit**.

Reviewed on 2026-10-20 against local HEAD `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`, preserving the pre-existing user changes. No production or test files were changed. The desired end state is scoped, cancellable, recoverable managed execution with validated persisted/wire boundaries and no workspace-to-workspace tool leakage.

**Quality assessment: 80/100, approximately +/-8 points.** This is a judgment of the inspected slice, not a measured defect percentage or a repository-wide score. Managed lifecycle ownership, cloning, immutable context capture, transaction fencing, typed stop reasons, recovery tests, and bounded tree projections are substantial strengths. Artifact validation, process cancellation, and custom-tool ownership/freshness prevent calling this slice uniformly clean. No Codex CLI convergence score is asserted here; that is the separate review track.

## Findings

### 1. High / should-fix: proposal discard trusts a persisted path outside its artifact

Owner: [managed-subagent-worktree.ts:660](F:/roo-fork/Alpha-Code/packages/core/src/worktree/managed-subagent-worktree.ts:660) and deletion sink [line 1460](F:/roo-fork/Alpha-Code/packages/core/src/worktree/managed-subagent-worktree.ts:1460).

`load()` casts parsed JSON to `ManagedWorkerArtifact`. Ownership checks execute only when `privateGitDir` is present, so an ordinary Git-backed proposal gets no runtime shape, identity, or artifact-file-path validation. `discard()` then joins the persisted `patchFile` to its artifact directory and removes it. `../../../outside-proposal-canary.txt` escapes the entire storage root.

**Proven:** the attached diagnostic creates a real Git repository, generates and captures a legitimate proposal, changes only `patchFile` in its metadata, calls `discard()`, and verifies that a canary outside proposal storage has been deleted. All filesystem effects are confined to an owned temporary directory.

**Reachability and limits:** the active UI path is [SubagentGroupCard.tsx:312](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/SubagentGroupCard.tsx:312) -> [webviewMessageHandler.ts:1616](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:1616) -> [AlphaProvider.ts:13626](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:13626) -> the mutation gate and service call at [line 13669](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:13669). The provider requires a known proposal in the live parent transcript (`getWorkerChangeSetTarget`, line 13335). Metadata is host-generated under `globalStorageUri/subagent-change-sets/<id>/metadata.json`; no inspected workspace/provider/import API directly accepts it. Therefore this is a **proven unsafe persisted-data boundary after local metadata tampering**, not a demonstrated remote/provider exploit. Exploitability beyond a local writer is unverified.

**Minimal fix:** validate ordinary and private artifacts in `load()`, require the stored identity to match the requested artifact, and constrain `patchFile`, `beforeFile`, and `afterFile` to owned artifact filenames with canonical containment checks before filesystem operations. Retain explicit backward-compatible defaults for old metadata. Existing persistence tests cover contention and interrupted discard, not malformed paths. Add a generated-proposal regression that changes only each file-reference field and verifies an external canary survives; cover both separator styles and linked artifact directories.

### 2. High / should-fix: the custom-tool singleton leaks project-local tools across task workspaces

Owner: additive registration at [custom-tool-registry.ts:82](F:/roo-fork/Alpha-Code/packages/core/src/custom-tools/custom-tool-registry.ts:82), singleton at [line 437](F:/roo-fork/Alpha-Code/packages/core/src/custom-tools/custom-tool-registry.ts:437), consumer at [build-tools.ts:409](F:/roo-fork/Alpha-Code/src/core/task/build-tools.ts:409).

`build-tools` loads the current cwd's configuration directories but then captures **every** definition retained by the process-global registry. Directory loads only add/overwrite entries; they never scope the result to the requested directories. In a multi-root window or concurrent task surfaces with different cwd values, loading workspace A followed by workspace B leaves A's local tool in B's catalog. The resulting descriptor captures its executable function in [ToolRegistry.ts:1175](F:/roo-fork/Alpha-Code/src/core/tools/ToolRegistry.ts:1175), so this affects execution as well as display.

**Proven:** the diagnostic loads one tool from directory A, builds a fresh directory-B load, and successfully executes A's retained tool. The custom-tools experiment and Code mode must be enabled on the active consumer path. The normal custom-tool approval remains in place; an approval bypass is not claimed.

**Minimal fix:** cache definitions per canonical source directory and return an owned merged catalog for the requested directory set, with existing precedence preserved. Capture that catalog for each task/step. Do not clear and refill the global map between workspaces; concurrent tasks would still race. Add an A -> B -> A test, a same-name override test, and concurrent workspace catalog capture coverage. The current registry tests validate additive multi-directory precedence but do not test workspace isolation.

### 3. High / should-fix: worker cancellation cannot interrupt worktree preparation subprocesses

Owner: [AlphaProvider.ts:12635](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:12635), [managed-subagent-worktree.ts:394](F:/roo-fork/Alpha-Code/packages/core/src/worktree/managed-subagent-worktree.ts:394), and [worktree-include.ts:314](F:/roo-fork/Alpha-Code/packages/core/src/worktree/worktree-include.ts:314).

The bounded manager aborts its signal on parent/user cancellation or the role timeout, but `executeSubagentEnvelope` awaits `create()` before wiring the child's cancellation settlement. Worktree `create()`/Git helpers accept no signal, Git `execFile` has neither a signal nor a timeout, and the `robocopy`/`cp` include process also has no cancellation owner. A hung clean/smudge filter, locked/remote dependency copy, or stalled Git subprocess therefore keeps startup, the owned completion, and its root capacity slot alive after cancellation. The same Git helper is used during final capture/cleanup.

**Evidence:** source inspection proves no signal reaches those subprocesses. A controlled copy barrier in the diagnostic invokes the same `create()` boundary through `BoundedDelegationManager`; after cancellation the runner signal is aborted and completion remains pending until the copy barrier is released. This is a boundary-level reproduction, not a real hung-subprocess or full VS Code host test.

**Minimal fix:** pass the run signal through worktree preparation and include copying, stop and join owned process trees on abort, check abort between preparation phases, and preserve an independently bounded cleanup path so cancelled startup cannot orphan a registered worktree. Add controlled in-flight Git/copy cancellation tests asserting prompt process settlement, capacity release, and retained recoverable artifact ownership. Existing manager stop-reason/residency coverage passes but does not exercise this uncancellable native startup boundary.

### 4. Medium / should-fix: custom-tool refresh retains edited or deleted executable definitions

Owner: [custom-tool-registry.ts:100](F:/roo-fork/Alpha-Code/packages/core/src/custom-tools/custom-tool-registry.ts:100), JavaScript import cache at [line 284](F:/roo-fork/Alpha-Code/packages/core/src/custom-tools/custom-tool-registry.ts:284), and additive load at [line 58](F:/roo-fork/Alpha-Code/packages/core/src/custom-tools/custom-tool-registry.ts:58).

Staleness uses the directory mtime, so an existing file's content change need not trigger a reload. Explicit refresh still imports JavaScript under the same URL, retaining Node's previous module instance. Removing or renaming a tool file never removes its old entry from `tools`. Consequently later model steps can continue to advertise and run a definition the user has edited or deleted, including after the UI's `refreshCustomTools` operation at [webviewMessageHandler.ts:2182](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:2182).

**Proven:** the diagnostic holds directory mtime fixed while changing a tool file, verifies the previous definition after ordinary load, verifies it again after explicit refresh, then deletes the file and confirms explicit refresh leaves the executable registered.

**Minimal fix:** use a bounded per-directory file manifest/fingerprint, publish a replacement source snapshot that removes missing exports/files, and version JavaScript module URLs by the file fingerprint. Preserve last-good state only with an explicit load failure result, rather than silently reporting stale executables as current. Add in-place edit, JavaScript explicit-refresh, deletion, rename, and failed-reload cases; current freshness tests only cover unchanged and newly loaded directories.

## Validation actually run

Windows; Node `24.21.0`; pnpm `11.24.0`. All Vitest commands used `--maxWorkers=1`.

- `pnpm --filter @alpha-code/ipc test --maxWorkers=1 src/__tests__/ipc-server.spec.ts src/__tests__/ipc-roundtrip.spec.ts src/__tests__/ipc-client.spec.ts`: **37 tests passed / 3 files**.
- `pnpm --dir src test --maxWorkers=1 core/agent/__tests__/BoundedDelegationManager.stop-reasons.spec.ts core/agent/__tests__/AsyncSubagentRunManager.residency.spec.ts core/agent/__tests__/InternalTaskEnvelope.authority-contract.spec.ts`: **23 tests passed / 3 files**.
- `pnpm --filter @alpha-code/core test --maxWorkers=1 src/worktree/__tests__/managed-subagent-worktree.persistence.spec.ts src/custom-tools/__tests__/custom-tool-registry.spec.ts`: **41 tests passed / 2 files**.
- `pnpm --filter @alpha-code/types test --maxWorkers=1 src/__tests__/agent-control-managed-tree.test.ts src/__tests__/subagent-orchestration.test.ts src/__tests__/subagent-lifecycle.test.ts`: **50 tests passed / 3 files**.
- `node --import tsx artifacts/directory-review-2026-10-20/clean-08-repro.mjs`: **exit 0; assertions for all six characterized cases passed**, including a full generated/captured proposal with only its `patchFile` tampered. This records the defective behavior and is not a production regression test asserting the desired fix.

Total existing automated tests: **151 passed across 11 files**. No broad typecheck, managed-agent certification, live-model run, or exact-host E2E gate was run by this reviewer; the coordinating agent owns broad validation.

## Inspected coverage and limitations

Inspected active managed delegation normalization and policy ceilings; `InternalTaskEnvelope`; `BoundedDelegationManager`; `AsyncSubagentRunManager`; retained runtime unload/event ownership tests; selected `AgentControlStore` initialization, transaction/owner fencing, lifecycle/event admission, snapshots, descendant traversal, and shutdown code; provider worker startup, budget enforcement, cancellation settlement, capture, and apply/discard integration; managed worktree create/load/capture/apply/discard/recovery/delete paths and native copy ownership; custom-tool registry/import/cache and active task catalog consumers; IPC client/server, shared IPC schemas, real socket round-trip tests, and extension API dispatch; telemetry service/base client; and shared agent-control/orchestration/tree schemas.

The telemetry singleton is currently created with no clients and no production registration was found, so hypothetical failing-client behavior was not promoted to an active defect. Shared schemas generally centralize contracts well, and IPC validates inbound message variants and bounds validation diagnostics. These observations are limited to inspected paths.

Not fully verified: every transaction-lock failure interleaving, all sibling/parent tool authorization routes, recursive nested-worker behavior, symlink races across all artifact operations, the complete shared types export surface, all `packages/core` message/history utilities, native copy failure behavior on macOS/Linux, exact VS Code 1.138.0 and 1.125.0 hosts, and production exploitability of modified global-storage metadata. No findings were inferred solely from old design documents.

## Closure ledger

- **Fixed now:** no runtime/test fixes; review report and owned-temp diagnostic only.
- **Flagged for follow-up:** the four findings above, each with a bounded fix and regression target.
- **Not verified:** blind spots and host/certification checks listed above.
- **Out of scope:** Codex sandbox alignment, CLI convergence grading, broad repository formatting/refactoring, dependency upgrades, and user-authored changes.

Highest-leverage follow-up: validate persisted proposal references; scope custom-tool source catalogs; then make native worker preparation/capture processes cancellable. Rerun a focused correctness review over those boundaries after fixes, followed by managed-agent certification and the exact host gate when the lifecycle contract changes.
