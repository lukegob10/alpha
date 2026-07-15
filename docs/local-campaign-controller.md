# Local Campaign Controller

The local campaign controller is the deterministic execution layer between Alpha's convergence target and the agent/eval validation commands. It is deliberately keyless and model-disabled in its first version.

## Commands

Copy the example to a new id before changing its command set:

```powershell
Copy-Item .frontier-campaign/campaign.example.json .frontier-campaign/campaign.local.json
pnpm frontier-loop validate --config .frontier-campaign/campaign.local.json
pnpm frontier-loop init --config .frontier-campaign/campaign.local.json
pnpm frontier-loop run-validation --config .frontier-campaign/campaign.local.json --dry-run
pnpm frontier-loop run-validation --config .frontier-campaign/campaign.local.json
pnpm frontier-loop run-validation --config .frontier-campaign/campaign.local.json --resume
pnpm frontier-loop status --config .frontier-campaign/campaign.local.json
```

Artifacts are stored under `.frontier-campaign/campaigns/<campaign-id>/`. Each attempt records command identity, arguments, working directory, timestamps, duration, exit code, output paths, byte counts, truncation, and SHA-256 digests.

## Safety boundary

- Commands use executable/argument arrays rather than shell-composed strings.
- Every command must match an explicit token prefix.
- Working directories, targets, suites, and artifact roots must remain inside the repository.
- Campaign and command wall times, command count, and output size are hard limits.
- Configuration changes require a new campaign id after initialization.
- An unfinished running attempt blocks another attempt unless `--resume` is explicit; resume skips commands already recorded as passed.
- `model.enabled` must be `false`; provider keys and paid calls are outside this MVP.
- The controller does not run Git mutation, create worktrees, modify code, promote baselines, or publish anything.

## Terminal outcomes

- `passed`
- `validation_failed`
- `budget_exhausted`
- `infrastructure_error`
- `cancelled` (reserved for the cancellation adapter)

The controller stops on the first failed command. Infrastructure errors and budget exhaustion are not reported as agent validation failures.

## Next governed slices

1. Candidate worktree isolation and rollback.
2. Hidden grader execution outside the agent-visible workspace.
3. Provider spend/token/model-call accounting and a smoke-first trial gate.
4. Normalized trace and final workspace artifact collection.
5. Paired candidate/control comparisons and immutable local baseline promotion.
6. Autonomous candidate implementation and bounded continuation.
