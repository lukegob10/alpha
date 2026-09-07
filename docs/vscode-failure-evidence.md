# VS Code failure evidence and storage-recovery checks

This test-only module belongs to `apps/vscode-e2e/src/evidence/`. It does not modify Alpha's production lock protocol,
task engine, approval policy, CLI, or VS Code shim. VS Code **1.122.1** remains the reference host; **1.136.1** is the
forward-compatibility host. Live Copilot results must remain distinguishable from scripted/fixture results.

## Runner and controller contract

Call `prepareEvidenceRun({ artifactsRoot, runId })` before launching the test host. It returns `artifactDirectory` and
`manifestPath`. The artifact root must be new/empty or have the recognized evidence-root marker; a run directory is
created exclusively. The runner may write its own separate metadata and scenario-result files there. Do not independently
adopt an arbitrary non-empty directory as an evidence root.

After the scenario, await `captureRunEvidence(options)` **before** considering cleanup or another launch. It returns the
artifact and manifest paths, a closed failure classification, and `captureComplete`. Capture failure never authorizes
source cleanup. Each prepared run permits one capture attempt; partial attempts remain inspectable and cannot be overwritten.

Required options are `artifactsRoot`, `runId`, and `metadata`:

- `scenarioId`, actual `hostVersion`, `provider`, optional `modelId` and `reasoningEffort`, and `taskIds`.
- `startedAt`, `finishedAt`, and `outcome`: `passed`, `failed`, `cancelled`, `blocked`, or `timed_out`.
- Actual `hostVersion` is `null` when launch failed before it could be observed. `requestedHostVersion` is separate.
  Never substitute the requested version for observed evidence. A checkpointed scenario is not a passed scenario.

Optional inputs are `bundlePath`, `workspacePath`, `storagePath` (Alpha's global-storage directory), `logsPath`,
`repositoryBefore`, `failure: { phase, code }`, and bounded limit overrides. Call `captureRepositoryEvidence(workspace)`
before the scenario for the content-free before snapshot, then supply it as `repositoryBefore`.

Whenever a source path is supplied, `assertSourceOwned(canonicalPath)` is required. The default runner must use its
marked test-profile/workspace validator here, closing over the prepared campaign roots. Capture rejects a missing or
rejecting validator, independently checks symlink components, and rejects source/artifact overlap. This dependency is a
trusted runner integration seam, not a model-controlled option or a permission bypass.

## What is retained

The version-1 manifest records the requested public metadata, actual bundle SHA-256 when available, artifact hashes and
sizes, capture warnings, and local-only references to retained source directories. Artifacts contain:

- Before/after repository file paths, sizes and hashes, plus the Git HEAD when present. Credential-like files and generated
  dependency/build trees are omitted; source contents, patches, commit messages and remote URLs are not copied.
- Bounded lifecycle/turn-event projections: known event/status values, sequencing, numeric usage/exit metadata, and hashed
  tool call IDs. Prompts, tool inputs/outputs, arbitrary reasons, exception messages and provider payloads are omitted.
- API transcript tool call/result pairing facts and error flags, without message contents.
- Agent-control snapshot hash and collection counts, and structural lock evidence including a zero-byte `owner.json`.
- A content-free index of log files. Raw logs remain in the dedicated source directory and are not exported by this module.

Missing lifecycle journals explicitly make capture incomplete. A missing API transcript is recorded as absent because a
pre-provider failure can legitimately have no transcript yet. Oversize, truncated, malformed, unstable, or unreadable
sources are not silently presented as complete evidence. Failure summaries use closed categories/codes, never raw errors.

Default limits are 1,000 scanned entries, 256 KiB per repository/log file, 8 MiB per repository/log snapshot or generated
artifact set, 20 task IDs, and 2,000 nonempty records per journal (including unknown event types). Task journals, conversation
history, and agent-control state have a separate `maxTaskSourceBytes` budget: 4 MiB per source, with a 64 MiB hard ceiling.
JSONL journals stream in 64 KiB chunks, with a separate `maxJournalLineBytes` bound of 256 KiB per record (hard ceiling
4 MiB). The journal's aggregate raw size need not fit the repository-file limit. Non-JSONL task/control JSON parsing still
requires a whole source and remains allocation-bounded by the explicit task-source budget. Neither limit raises the
generated artifact allowance. These optional settings preserve existing callers and version-1 artifact shapes.

Journal capture hashes every source byte, retains the final unterminated valid record, and checks descriptor/path identity,
size, and timestamps before and after reading. Identity checks use bigint filesystem metadata to avoid rounding Windows
file identifiers. Source-byte, line-byte, event-count, invalid-UTF-8/JSON, or observed-mutation failures reject the projection;
they never label a prefix as complete. Closed warnings distinguish `TASK_SOURCE_LIMIT`, `JOURNAL_LINE_LIMIT`,
`JOURNAL_EVENT_LIMIT`, `JOURNAL_MALFORMED`, and `TASK_SOURCE_CHANGED` alongside the existing incomplete-source warning.
Original files remain in place. These are bounded diagnostic projections, not unlimited long-thread archives.

All overrides have hard ceilings. Bundle hashing streams up to 512 MiB.
Files/directories use restrictive POSIX modes; Windows inherits the owning directory's ACL. Keep the artifact root private
to the local test account. This is not encrypted storage or an automatic upload mechanism.

The runner must preserve failed fixture workspaces, profile storage, and logs. These source references are **not** an
immutable full-profile backup. Reusing a persistent profile can change shared aggregate metadata; later projections do not
prove exact replay of an earlier whole-profile snapshot. Do not copy authentication databases or reset a profile to obtain
a passing rerun. Raw source retention and evidence retention are separate policies.

## Bounded retention

`pruneRunEvidence({ artifactsRoot, maxRuns?, maxBytes?, maxAgeMs?, keepRunIds?, now? })` defaults to 20 retained runs,
100 MiB, and seven days. Automatic removal requires a direct marked run, a complete finalized **passed** capture, and an
exact `.retention-eligible.json` inactivity receipt. Failed, blocked, cancelled, partial, legacy, malformed, active, and
campaign-held runs remain protected. It never removes raw profiles, workspaces, or logs, even when their artifacts expire.

`markRunRetentionEligible({ artifactsRoot, runId })` validates the successful runner receipt and actual owned host close.
The runner calls it only after all callbacks, final result writes, profile-lease release, and its durable retention result.
This is the **last producer write**. A fully written candidate is hard-linked into place without replacement; its small
candidate sibling remains until artifact pruning so no fallible cleanup follows publication. Measured bytes are logical
file sizes, conservatively counting hard-linked names twice, not allocated disk blocks.

Standalone runs automatically invoke the canonical pruner while their own run remains protected. Campaign runs use
`--retain-evidence-for-campaign`: a held receipt explicitly transfers maintenance to the campaign without deleting other
evidence or asserting standalone quota compliance. Campaign evidence lives beside its immutable reports. After the
terminal report is durable, the controller audits aggregate storage again and can release recorded successful phases
for separately requested maintenance; it does not automatically prune campaigns. Its final receipt points to that
read-only storage audit. Legacy complete held receipts are still accepted; missing or contradictory evidence is not.

Standalone retention receipts record removed/kept/protected IDs, observed bytes/counts, skipped entries, `complete`, and
`overBudget`. Protected runs can exceed any standalone target, including age alone. Those targets are configurable through
the runner API's `evidenceRetention` (`maxRuns`, `maxBytes`, `maxAgeMs`); ordinary standalone CLI runs use the defaults.
Campaigns instead use their iteration/request and aggregate storage limits, so a 22-launch two-host matrix is not blocked
by a standalone 20-run target. Secondary retention/storage failures still prevent overall acceptance and never erase a
primary provider/host failure. These are admission/retention policies, not an OS disk quota.

Pruning first moves one verified run to a unique quarantine path, then removes only its enumerated regular files and empty
directories. Unexpected changes fail closed; a partial pruning quarantine remains local for inspection.

### Raw-storage admission budget

Raw data is retained locally without automatic deletion. Before every campaign host launch (including reload continuation)
and before a source patch or build, `auditRetainedStorage` checks the canonical owned campaign root **including previous
campaigns**, plus any separate profile root. Overlapping roots are deduplicated. It uses bounded directory iteration and
filesystem metadata only: it does not read authentication databases, prompts, source contents, or log contents.

The default allowance is 10 GiB of logical file sizes, 100,000 entries, and depth 32. Campaign `storageBudget` can configure
`maxBytes`, `maxEntries`, and `maxDepth`, within hard ceilings of 100 GiB, 1,000,000 entries, and depth 32. Missing initial
profile paths count as zero only when explicitly allowed under a validated owned path. Symlinks/reparse points, observed
mutation, unreadable metadata, scan limits, or cancellation produce an explicit incomplete/unknown result and block work.
Admission receipts are durable even when no host launched.

An admitted operation or external writer can exceed the allowance before the next check: this is **not an OS-enforced
disk quota**, deletion policy, or immutable backup. Over-budget/unknown measurements stop further work and require operator
archival, cleanup, or an explicit budget adjustment. Incomplete measurements are diagnostic observations; concurrent
mutation can invalidate them, so they must not be presented as an exact current total or a guaranteed lower bound.

## Storage-recovery boundary

`storageRecovery.ts` supplies a deliberately restricted fixture lifecycle gate and exact-lock quarantine helper.
Only a newly owned, marked storage-recovery fixture is eligible. A marker alone is not proof that a restarted controller
knows every possible owner, so adopting an existing fixture without its live controller capability is rejected.

The gate tracks launched host PIDs, blocks overlapping launches, seals before repair, and probes retained PIDs and any
recorded lock-owner PID. A caller's `exited` flag, a lock's age, or an unknown PID probe is never proof of quiescence.
The helper preserves the exact lock directory in a sibling quarantine without deleting it; task history, `agent_control.json`,
owner leases, and unrelated files are untouched. A new lifecycle epoch is allowed only after verified offline recovery;
the previous seal becomes invalid. This helper is not a repair command for the user's normal profile.

`storage-recovery.test.ts` runs inside the actual extension host and obtains the production persistence constructor already
bundled into Alpha. It verifies empty-owner rejection across fresh persistence instances, preserved failure evidence,
controlled fixture quarantine, a healthy new persistence transaction, and rejection of a real live owner. This is not,
by itself, proof of a complete VS Code process restart.

Full restarted-host acceptance needs an external sequence: seed the dedicated fixture before launch, observe the actual
failed task, preserve evidence, close all campaign-owned storage writers, verify process identity/quiescence, quarantine,
and relaunch the same profile to a healthy task. A runner subprocess closing does not alone prove every descendant exited.
When that proof is unavailable, the controller must report a blocker rather than perform offline repair.

The bounded two-launch adapter uses `storage-restart.test.ts` with `ALPHA_E2E_STORAGE_RESTART_PHASE=fault|healthy`,
`scenarioId: "storage-restart"`, and `providerMode: "scripted"`. It exercises the actual Alpha task API and the activated
extension's actual profile storage. The fault phase requires zero model requests, one durable failed terminal event,
and an `ELOCKOWNER` probe against the same production persistence object. The healthy phase requires one model request,
one durable completed terminal event, and persisted task history. The production lock timeout is not shortened. No tools,
arbitrary commands, live model, or additional workspace sessions are admitted in this dedicated scenario.

`storageRestart.ts` validates the bounded `storage-restart-phase.json` receipt against the exact run, phase, host version,
storage root, and task. `assertStorageRestartQuiescence(runResult, receipt)` is called only from the existing runner's
`afterRun` callback **while its exclusive profile lease is held**. It requires actual extension-host execution, an observed
direct Code child close, the startup ancestry-verified extension-host identity, a complete finalized capture with bundle
hash and matching task metadata, and dead-process proof for every recorded Code/extension-host/parent PID. A live PID,
including a reused PID, unknown probe, missing receipt, test seam, or incomplete capture blocks recovery. A runner's
ordinary exit flag never substitutes for these checks. This is a narrow shell-free test contract, not a general proof for
arbitrary descendant processes or a production repair authority.

The phase receipt distinguishes an expected-failure **test assertion passing** from the underlying task's **failed**
status. A successful fault assertion is not a successful user task. Both launch receipts and original failure sources
must survive the healthy rerun. A fresh controller cannot adopt an interrupted campaign and infer forgotten owners.

## Validation commands

From the repository root, with owning workspace dependencies installed and `@alpha-code/types` built:

```sh
pnpm --filter @alpha-code/vscode-e2e exec tsc -p tsconfig.json
node --test apps/vscode-e2e/out/evidence/capture.spec.js apps/vscode-e2e/out/evidence/journalProjection.spec.js apps/vscode-e2e/out/evidence/retention.spec.js apps/vscode-e2e/out/evidence/retainedStorageBudget.spec.js apps/vscode-e2e/out/evidence/storageRecovery.spec.js apps/vscode-e2e/out/evidence/storageRestart.spec.js
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Run the `storage-recovery.test` host suite through the existing runner on both versions after the common extension build.
Node unit tests use `.spec.ts` so the extension-host Mocha `.test.js` discovery does not accidentally load `node:test` suites.
The orchestrator owns serialized host-test slots, final integration, and the acceptance-results ledger.
