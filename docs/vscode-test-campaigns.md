# Bounded VS Code test campaigns

For the ready-made smoke/development/soak presets and the live-run → trace review → fix → rerun workflow, see
[live development acceptance](live-development-suite.md). Presets use this controller; they do not add another runner.

The external campaign controller in `apps/vscode-e2e/src/runCampaign.ts` coordinates the existing extension-host runner,
workflow scenarios, and evidence collector. It does not run a second production task engine. Start in report-only mode;
the default does not modify extension source, reset task storage, or repair locks.

## Setup and a report-only campaign

Build the extension and E2E TypeScript through the existing package workflow. Prepare dedicated Copilot profiles with
the live runner's documented interactive setup flow. Do not point campaigns at a normal VS Code user-data directory or
copy authentication credentials between profiles. A manually opened setup host must be closed before a campaign uses
that profile.

Create a local configuration file, for example:

```json
{
	"id": "live-workflows-20260906-01",
	"hosts": [{ "version": "1.122.1" }, { "version": "1.136.1" }],
	"scenarioIds": ["review-edit-test-commit-followup", "cancel-resume", "reload-continuation", "long-thread"],
	"samples": 2,
	"provider": { "mode": "live-copilot", "modelId": "EXACT-DISCOVERED-MODEL-ID", "effort": "max" },
	"budgets": { "maxIterations": 24, "maxRequests": 300, "maxDurationMs": 3600000, "attemptTimeoutMs": 600000 },
	"maxReproductions": 2
}
```

The model ID is a placeholder: use the actual discovered Copilot model ID, not its display name. Unsupported effort or
an unavailable model is a blocker, not permission to substitute. Each host may specify an absolute `executable` path;
the host still verifies its actual version. The matrix executes 1.122.1 first regardless of configuration order.

From `apps/vscode-e2e`, after compiling `src` to `out`:

```powershell
pnpm exec node out/runCampaign.js --config C:/alpha-tests/campaign.json --root C:/alpha-tests/runs --profile-dir C:/alpha-tests/copilot-profiles --init-root
```

`--init-root` may initialize only an empty dedicated directory. Subsequent campaigns reuse that marked root but require
a new `id`: a repeated run ID cannot overwrite earlier evidence. Pass the same absolute `--profile-dir` used during
the live runner's interactive setup (here `C:/alpha-tests/copilot-profiles`) to reuse its authenticated, test-owned
profiles. Do not initialize authenticated profiles inside an unmarked campaign root: it would no longer be empty.
Without `--profile-dir`, the default remains `runs/profiles`. Existing ownership/normal-user-profile safeguards still
apply; this option does not copy credentials or adopt arbitrary profiles and is rejected in storage-recovery mode.
Every attempt gets a fresh disposable repository under its unique campaign directory. Reload prepare/continue phases reuse that
attempt's workspace and profile, and checkpointed output is not a completed scenario.

Use `provider.mode: "scripted"` to exercise the same controller without live-model charges. Scripted results are not
live Copilot evidence. The test fixtures prohibit pushes and production migrations; this controller does not grant
additional tool approvals.

## Budgets and result meaning

The controller is sequential to avoid overlapping persistent-profile ownership, source mutations, and heavy builds.
`maxIterations` counts all scenario attempts, including reproductions and verification. `samples` controls matrix samples,
not unbounded retries. Each host receives a request limit of at most 200 and no more than the remaining campaign budget;
reload continuation receives the remainder after prepare. The scenario's predispatch guard must count actual provider
requests, including retries. Unknown usage stops the campaign; it is never treated as zero. Tokens and cost remain null
when the host does not expose them.

Timeout/cancellation signals reach the owned subprocess runner. Its completion must await cleanup before the controller
captures evidence or starts another host. Ownership is not inferred from a profile marker or a list of arbitrary Code
PIDs. A normal child exit is not, by itself, authority to perform offline storage repair.

Every attempt preserves evidence before reproduction, continuation, or source mutation. Capture failures stop the
campaign and retain the private source files. Report checkpoints are immutable, numbered JSON files in the campaign
directory. They contain the configuration identity, individual attempts, actual host/model metadata where verified,
counts, nullable usage, repair receipts, and an explicit stop reason. They do not contain raw prompts or console errors.

Workflow producers and the campaign consumer share the resource limits in `scenarios/contracts.ts`: at most 1,024 checks,
128 characters per check name, and a 1 MiB result-file read limit. These are resource budgets, not counts derived from
today's fixture assertions. The driver reserves one check for the suite's cleanup receipt. Overflow returns a bounded
failed result with `workflow_check_limit_exceeded`; it never truncates checks into a passing result. The supported
long-thread range is 4–12 turns. A Node regression runs the maximum-length driver with real repository verification
through the campaign projector, alongside exact-limit, over-limit, malformed-field, and oversized-file cases.

A validated, matching workflow receipt's request count remains known if the runner later reports capture or exit
failure. Such failures still block the attempt; incomplete evidence stops the campaign with `evidence_failed` before
another launch or repair. Missing, oversized, malformed, or mismatched receipts never provide trusted usage and are
reported as unknown rather than zero. This does not turn incomplete capture into a successful workflow.

Evidence uses bounded projections and hashes plus retained local source locations, not a complete immutable copy of an
authenticated profile. Subsequent runs can change shared aggregate profile metadata; exact whole-profile replay is not
claimed. Failed fixture workspaces and prior tasks are never reset or deleted by the controller. Cleanup and evidence
finalization may outlast the work budget; expiry forbids new model work, not the preservation needed to stop safely.

Exit codes:

- `0`: matrix completed with no failed or blocked attempts.
- `1`: matrix completed but failures were observed, including failures later repaired. Inspect the report.
- `2`: campaign stopped early or setup/report persistence failed.

`stopReason: "completed"` means the matrix finished, not that every task passed. Authentication, usage limits, unknown
usage, time/iteration/request budgets, unsafe repair, incomplete evidence, and repeated non-reproduction are explicit stops.
A single successful run is not a general reliability claim.

## Retained storage and evidence retention

Before every host launch (including reload continuation), reviewed source patch, and build, the campaign performs a
bounded metadata-only scan of the marked campaign root and the test-owned profile root. This includes prior campaigns,
raw workspaces, logs, evidence, and profile storage. Overlapping canonical roots are counted once. Authentication/file
contents are not read by this scan, and no raw profile or workspace is deleted.

The default admission limits are 10 GiB, 100,000 entries, and depth 32. Override them in configuration with
`storageBudget: { "maxBytes": 10737418240, "maxEntries": 100000, "maxDepth": 32 }`; hard maxima are 100 GiB, one million
entries, and depth 32. A missing default profile below the marked campaign root can be initialized by the existing
runner. An external profile must already be initialized and test-owned; unknown external storage is not counted as zero.

Over-budget scans stop with `storage_budget`; unreadable, changing, linked, timed-out, or otherwise incomplete scans stop
with `scan_incomplete`. The scan has a 30-second monotonic deadline; `reason: "timeout"` is distinct from permission or
readability failures. Immutable admission receipts retain the measured bytes/counts and completeness. Incomplete
measurements are diagnostic observations, not a claim about current total disk usage. These are pre-launch admission
limits, not an OS disk quota: an in-flight phase may exceed the threshold, after which no further work is admitted.

New campaigns keep evidence in `<campaign-root>/<campaign-id>/host-evidence`, alongside their immutable reports. Existing
shared-root and per-attempt references are not migrated. A held phase writes an explicit `maintenance: "campaign-owned"`
receipt: it does not prune other attempts or apply standalone age/count targets. Older successful hold receipts remain
readable, but incomplete, contradictory and unknown maintenance receipts fail closed.

After the terminal report is durable, the campaign repeats aggregate storage admission. Only then can recorded, passed,
complete, verified phases become eligible for separately requested maintenance. Acceptance does not automatically prune
them or older campaigns. This keeps reports and their evidence together and supports matrices exceeding 20 host launches;
iteration/request limits bound the run, and byte/entry/depth limits bound retained storage. When storage is full or cannot
be measured safely, admission/acceptance blocks rather than silently dropping evidence. Keep future runs on the same
campaign root so prior storage remains counted. Explicit maintenance must preserve evidence required for acceptance.

The standalone pruner still defaults to 20 runs, 100 MiB, and seven days, but those defaults do not govern held campaign
phases. Failed, incomplete and active evidence stays protected. The storage-restart fixture leaves both phases held,
including its expected-fault phase. Per-run and terminal retention receipts remain durable; a secondary retention failure
still produces a nonzero exit without erasing the primary host/provider failure. No background garbage collector is added.

## Dedicated offline storage-restart fixture

This is a separate, explicitly requested two-launch test, not a recovery policy for live-model campaigns. It always
uses the shell-free scripted storage scenario and requires an installed VS Code executable so no download happens
inside the recovery sequence. The reference host defaults to 1.122.1; repeat with a new fixture root for 1.136.1.

```powershell
pnpm exec node out/runCampaign.js --storage-recovery-root C:/alpha-tests/storage-restart-1221-01 --vscode-version 1.122.1 --vscode-executable C:/alpha-tests/vscode-1221/Code.exe
```

The root must be new or empty. The test seeds a zero-byte owner file in the exact transaction-lock directory, starts an
actual Alpha task, and verifies the expected pre-provider failure. The existing runner then closes Code and finalizes
evidence. While its exclusive profile lease is still held, the controller verifies the actual extension-host identity,
complete evidence, and absence of every registered storage-writer PID. Unknown ownership/liveness blocks recovery.

Only that fixture's exact transaction-lock directory is moved to its recoverable `.offline-quarantine` sibling.
Before and after hashes must match for `agent_control.json` and all bounded task-history files; missing control data is
recorded explicitly. Oversized or unsafe snapshots block the sequence. The same profile then starts a healthy task in
a new host, which must produce persisted provider history and exactly one completed terminal state. Neither fixture
storage nor quarantine is deleted. Immutable `storage-restart-*.json` checkpoints retain the outcomes and hashes.

Cancellation is forwarded to the existing direct host launcher and still waits for actual close/evidence handling. A
cancelled or uncertain phase never authorizes quarantine or the healthy launch. This narrow proof does not establish
quiescence for arbitrary processes, normal user profiles, escaped descendants, or live tasks with shell tools.

## Reviewed source patches (opt-in)

This release supports executing a pre-reviewed, bounded patch plan. It does **not** contain an autonomous model that
diagnoses arbitrary bugs and generates patches. A separate authorized engineering agent or human must supply the
diagnosis, regression scenario, exact expected source hashes, replacements, and narrow allowed paths.

Both `--enable-reviewed-patches` and `repair.enabled: true` are required. A repair entry has this shape:

```json
{
	"enabled": true,
	"sourceRoot": "C:/work/Alpha-Code",
	"allowedPaths": ["src/core/example.ts"],
	"plans": [
		{
			"scenarioId": "review-edit-test-commit-followup",
			"regressionScenarioId": "review-edit-test-commit-followup",
			"neighborScenarioIds": ["cancel-resume"],
			"diagnosisId": "reviewed-receipt-fix",
			"patch": {
				"id": "receipt-fix-01",
				"edits": [
					{
						"path": "src/core/example.ts",
						"expectedSha256": "REPLACE-WITH-64-HEX-HASH",
						"replacement": "FULL-REVIEWED-FILE-CONTENTS"
					}
				]
			}
		}
	]
}
```

The source root must be the checkout containing the tested extension, separate from disposable fixture workspaces.
The patch writer checks allowed paths and expected hashes, rejects protected/generated/configuration files and symlink
escapes, and records changed-file hashes. It does not execute model-provided shell text, commit, push, or erase failures.

Source publication is an offline operation: a target can be briefly absent while the writer claims its current bytes
and publishes an exclusive replacement. Multi-file changes are not one atomic filesystem transaction. Conflicting
external edits must be retained. Claimed originals remain in `.alpha-patch-*` recovery directories even on success;
receipts record their relative locations. Cancellation/failure retains partial mutation receipts. Recovery artifacts
require deliberate offline review and cleanup; the campaign never deletes possibly externally edited originals.

The enforced sequence is: failed scenario → same failure reproduced → regression fails an independent assertion →
reviewed patch → fixed repository build command → regression and original scenario pass → neighboring scenarios pass.
A regression that already passes does not authorize a patch. Build or verification failure retains the change/evidence
for review and stops the campaign. It does not reset the source tree. Run through `pnpm exec node` so the opted-in build
can invoke the existing pnpm CLI through Node without a shell-concatenated command.

## Validation boundary

Deterministic campaign tests are Node tests named `*.spec.ts` outside the Mocha extension suite. Compile them and run
Node 20 on Windows does not expand command-line globs; pass each `out/campaign/__tests__/*.spec.js` filename explicitly
to `node --test`, or expand the file list in your shell. Run owning-package lint/typecheck afterward. Real-host/live campaign
evidence must be recorded separately. NOR-40/41/42 supply the real runner, scenario, and capture integration. Do not call
this complete merely because injected controller operations passed.
