# Background command outcomes without another model investigation

Date: 2026-09-16. Alpha baseline: `6d31c93a91228f9341dad639f4f09b4d21b20cb1` plus the pre-existing working-tree changes.
Behavioral reference: Codex CLI `0.154.0`; no upstream implementation or prompt was copied.

## Problem and scope

When `execute_command` returned before completion, the model received a running result. Subsequent environment context
could contain output and an active/inactive terminal, but did not project the command's recorded exit status. A silent
background completion therefore left a gap between what the runtime knew and what the next model request showed.

Alpha already has proportional verification instructions, tool batching, and completion settlement outside the model
loop. This change supplies the missing process observation through those existing mechanisms. It does not introduce a
verification engine, test-runner heuristics, command-result caching, a new tool, or a stronger completion gate.

## Implementation contract

- Mark the existing task-local command record only when its invocation returns without delivering its final outcome.
  Match the physical execution identity so a late return cannot mark a replacement invocation.
- Project call ID, execution ID, status, exit code, and an optional bounded signal. Preserve running, failed, denied,
  cancelled, timed-out, and unknown-exit distinctions. Process success describes that execution, not coverage or the
  validity of later workspace content.
- Deliver the projection as a normal environment field for both primary tasks and managed workers. Existing delta
  commit/release semantics suppress unchanged fields, retain abandoned deliveries, and restore observations after a
  context reset. This does not schedule a new model request or wait for a command.
- Limit the projection to eight recently started/completed eligible records and 8 KiB of UTF-8 text, with explicit
  omission counts. Drop complete rows when necessary; do not truncate call/execution identities. This is a bounded observation summary, not
  an exhaustive command audit.
- Rank observations by completion/start time so an older running command becomes visible when it finishes. Preserve
  the delivery marker across an inspection receipt only when it belongs to the same physical execution.
- Exclude foreground-only records. Omit command text, working directories, captured file contents, and output. The
  formatter reads the existing bounded task registry without cloning its potentially large verification snapshots.
- Preserve current persistence and reload behavior. The marker and process evidence remain task-memory observations;
  a fresh/resumed task without them does not fabricate a completed command. Existing transcript/context persistence
  continues to own messages already delivered.

## Baseline and validation

The same deterministic environment fixture supplies a settled background command with no terminal output, once with
exit code 0 and once with exit code 1. Before the implementation, both assertions failed because the next environment
snapshot lacked a background-command outcome. After the implementation, both exact outcomes are present without another
tool invocation. After committing that snapshot, an unchanged capture emits zero additional context characters.

| Observation on the two fixed fixtures                 | Before         | After  |
| ----------------------------------------------------- | -------------- | ------ |
| Exit outcomes visible in the next environment capture | 0 of 2         | 2 of 2 |
| Additional tools executed by the fixture              | 0              | 0      |
| Unchanged outcome field redelivered after commit      | Not applicable | No     |

This establishes evidence delivery, not a measured reduction in live-model turns or task latency. Model savings require
matched live tasks; no percentage improvement or broad Codex parity is claimed.

Focused regressions cover silent success/failure, running-to-completed delivery, unknown exits, signals, cancellation
winning a zero exit, physical execution identity, foreground exclusion, task isolation, worker context, release/retry,
context reset, registry eviction, and bounded/escaped identifiers. Existing command execution, environment, and completion
tests guard adjacent behavior.

The final focused run passed **125 tests in six suites**. Extension type checking, lint, formatting, and the rebuilt
VS Code **1.122.1** smoke gate passed (10 host tests across activation, modes, and the LM contract). The Codex CLI review
identified observation ordering and marker preservation across matching inspection receipts; both were corrected and
covered by regressions.

Validation commands:

```sh
pnpm --dir src test -- core/agent/__tests__/CommandOutcomeContext.spec.ts core/environment/__tests__/getEnvironmentDetails.commands.spec.ts core/environment/__tests__/getEnvironmentDetails.spec.ts core/environment/__tests__/getEnvironmentDetails.verification.spec.ts core/tools/__tests__/executeCommand.spec.ts
pnpm --dir src test -- core/agent/__tests__/CommandOutcomeContext.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

## Live Copilot validation

On 2026-09-16, the modified extension passed the existing `command-settlement.test` live scenario through both command
providers on **VS Code 1.122.1**, using Copilot's **GPT-5.6 Luna** with **high** reasoning. These runs exercise Alpha's
harness with the `vscode-lm` Copilot provider; they do not evaluate Copilot Chat's own agent harness.

Each run used a fresh owned workspace, created an HTML/JavaScript counter, made two follow-up revisions, and ran the
host-owned Node oracle with a one-second tool timeout. The oracle emits large output, finishes in the background, and
checks five behaviors per revision. Both test processes exited successfully, and both owned hosts exited normally.

| Command provider | Revisions passed | Model requests by revision | Total requests | Phase elapsed times   |
| ---------------- | ---------------- | -------------------------- | -------------- | --------------------- |
| Execa            | 3 of 3           | 5 / 4 / 4                  | 13             | 245.5 / 28.9 / 23.1 s |
| VS Code terminal | 3 of 3           | 4 / 4 / 4                  | 12             | 45.5 / 25.1 / 23.8 s  |

All six verification commands ran exactly once and exited zero. There were no tool-transaction errors, failed task
turns, unresolved mutation receipts, or shell-integration fallback warnings. Persisted model history contains both
`running` and `succeeded`/exit-code-0 observations for every background command, confirming the new projection was used
on both execution paths. Each revision still included one `read_file` call for `build-receipt.json` before completion.

These are two live correctness samples, with one model and one scenario. There is no matched pre-change live baseline;
the request counts and wall times do not establish savings or a speed difference between command providers. Failure,
cancellation, and unknown-exit projection remain covered by deterministic regressions rather than these successful live
runs. Skills, MCP workflows, and a complete application lifecycle were not exercised by this focused scenario.

Local evidence root: `F:/alpha-vscode-e2e-runs/background-outcomes-20260916/`. `source-build.json` records the source and
bundle hashes. Under `artifacts/`, runs `luna-1221-execa` and `luna-1221-vscode` contain `run-result.json`,
`command-settlement.json`, host/model preflight, and evidence manifests. The root-level
`luna-1221-execa-observations.json` and `luna-1221-vscode-observations.json` contain compact tool-call and background-status
extracts from each task's persisted history.

Invocation template (run separately for each provider with a fresh workspace and run ID):

```sh
pnpm --dir apps/vscode-e2e test:copilot --vscode-version 1.122.1 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles --workspace <fresh-owned-workspace> --artifacts-dir <artifact-root> --init-profile --model-id gpt-5.6-luna --reasoning-effort high --file command-settlement.test --grep "HTML edits and Node output through <execa-or-vscode>" --run-id <unique-run-id>
```

## Reference and limits

[Official OpenAI verification guidance](https://developers.openai.com/api/docs/guides/latest-model) and
[Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli), retrieved 2026-09-16, informed the behavioral goal:
provide sufficient evidence efficiently and finish once applicable checks are satisfied.

The locally installed CLI `0.144.6` rejected the configured model. A temporary `0.154.0` invocation retained the user's
configuration without upgrading the installation. Its Windows package lacked the code-mode host, so CLI review used
supplied source and patch text rather than shell-based repository inspection.

This intentionally leaves semantic check summaries, blocking output waits, diagnostic coalescing, and automatic evidence
reuse for separately measured work. It provides an Alpha-native correction to one demonstrated information gap without
changing the agent's authority or its general workflow.
