# Ownerless shared-storage lock after reload

## Confirmed failure

The September 6, 2026 09:36 local run, task `01a076ee-e305-773b-bfee-2751e861ad07`, failed before a provider request.
Its lifecycle journal records the agent-control ownership error as the terminal cause. The matching Alpha output is in
VS Code log session `20260906T004023`, window 2, output directory `output_logging_20260906T093526`.

The canonical `agent_control.json.transaction.lock` directory in Alpha's global storage contains an empty `owner.json`
(zero bytes), last modified at 00:20:44 that morning. Reloading retained this directory. The preceding 00:52 run also
reported the ownership error. This is not the earlier authoritative-transcript replacement contention incident.

The metadata cannot establish a PID or transaction token. Its age alone does not prove that reclaiming it is safe.
The evidence does not establish which process interrupted or damaged publication. The current implementation reserves
the directory before writing metadata; process termination between those operations can leave an ownerless lock.
Do not remove the ownership safeguard or add age-based reclamation to disguise this condition.

## Code change

The primary recovery boundary now recognizes typed `ELOCKOWNER` and `ELOCKLEGACY` failures and persists localized
offline-repair instructions instead of the generic suggestion that Resume or new guidance can solve the failure.
The mapping uses the closed error codes, not arbitrary exception text. Other errors retain their existing handling.
No locking, approval, provider, transcript, CLI, or shim behavior changes.

Regression coverage exercises both codes through the primary loop and checks that private diagnostic text is not
published. A real-filesystem contention case covers the observed empty metadata and verifies that no operation starts
and no unknown lock or unrelated file is removed. The two recovery tests failed with the generic message before the fix.

## Operational repair boundary

Close all VS Code windows and Alpha extension test hosts sharing this storage before repair. Back up or quarantine only
the exact `agent_control.json.transaction.lock` directory, preserving task histories, `agent_control.json`, owner leases,
and other files. Reopen with the rebuilt development extension and rerun the task. Never remove the unknown lock while
an extension host is running. The code change alone does not repair an already damaged lock.

Live Copilot Chat logs exist in the affected development host. Isolated fixture-host results and the default CLI's
extension listing do not establish whether Copilot is available or authenticated in that development profile.

## Validation and remaining work

- Focused Task and filesystem contention suites: 183 tests passed.
- Extension typecheck and lint: passed. Scoped `git diff --check`: passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`: passed (8 tests), including a rebuilt extension bundle.
- Installed VS Code 1.136.1 scripted task test: passed (1 test). Neither host result is a live Copilot run.
- Translation audit: backend locales complete, including the new message in all 18 locales. The repository-wide
  translation command exits nonzero for unrelated missing frontend and manifest translations; these were not changed.
- Live repair and real-provider rerun remain unverified: VS Code hosts are still running, so the damaged lock has not
  been moved or deleted. The user was asked to close VS Code before the narrowly scoped, recoverable repair.

## Offline repair completed: 2026-09-07T00:36:14.6018900Z

The user closed all VS Code windows and test hosts for repair. Process checks before quarantine and after verification
found no running VS Code hosts or extension-test launchers. The remaining repository-associated Node processes were
Codex computer-use runtime workers, not Alpha extension hosts.

The exact normal-profile lock still contained only the zero-byte `owner.json` last modified at
2026-09-06T04:20:44.5197373Z. After validating absolute paths, rejecting reparse-point ancestors, checking the metadata
again, and refusing any existing backup destination, the lock directory was moved without deletion to:

`C:/Users/Luke Goblirsch/AppData/Roaming/Code/User/globalStorage/alphainc.alpha/agent_control.json.transaction.lock.quarantine-20260907-offline-repair`

Post-repair checks confirmed:

- The canonical `agent_control.json.transaction.lock` path is absent; its original empty owner file is in quarantine.
- `agent_control.json` has the same SHA-256 before and after:
  `C25BD9BAF62C0128D3693D31AC5D9536509C0E1AA6E0C6FAFC7BEE95B7B71AE7`.
- All 58,616 task-file paths, lengths, and modification timestamps are unchanged (255,490,127 total bytes).
  This is an inventory comparison, not a content hash of every task file.
- Owner leases, candidate/reap/release directories, settings, task histories, and all other storage were left untouched.

The stale-lock repair is complete and recoverable. It supersedes the earlier pending-repair status above, but does not
establish that the user's reopened F5 workflow passes or prevent recurrence of ownerless lock publication. Those remain
separate verification and engineering work. Never restore or remove the quarantined lock while an Alpha host is running.
