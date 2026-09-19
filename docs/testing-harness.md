# Testing and evaluation workflow

The supported corporate workflow requires no Docker. Run these commands from the repository root with Node **24.14.1**, pnpm **11.24.0**, and npm **11.11.0**.
VS Code **1.122.1** is still the release contract. The [research](harness-development-research.md) explains the design;
the [implementation record](harness-implementation-progress.md) distinguishes new verification from historical results.

## Docker-free corporate setup

```sh
pnpm install --frozen-lockfile
pnpm --dir src rebuild @vscode/ripgrep
pnpm --filter @alpha-code/types build
pnpm harness doctor
pnpm harness list
```

Use your approved user-level pnpm registry/scope configuration for Artifactory. Obtain authentication through the
corporate process; never commit tokens or print the user configuration into reports. Setup inherits that configuration.
The lockfile is authoritative; do not substitute newer dependencies when a mirror lacks a package. The existing
[migration record](toolchain-migration-step-3.md) documents registry inputs and remaining corporate validation.
For an isolated automation checkout, `HUSKY=0` disables hook installation without changing shared Git configuration.
The doctor reports toolchain agreement; it does not certify Artifactory authentication or provider access.

## Choose the check by what it proves

Execution fidelity and decision source are separate axes. A scripted real-host check exercises the actual extension
but cannot measure a live model's planning ability. Deterministic graders can also grade live trials.

| Local command                                                           | Owner and fidelity                        | Decisions           | What it proves / prerequisite                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `pnpm harness run focused core/agent/__tests__/AgentTurnEngine.spec.ts` | `src`: unit and kernel seams              | Scripted            | Selected invariant; supply explicit test paths                                       |
| `pnpm --dir webview-ui test src/path/to/component.spec.tsx`             | React component                           | Scripted            | UI interaction/state, not VS Code activation                                         |
| `pnpm harness run static`                                               | Workspace lint/types                      | None                | Extension, shared dependencies, webview and runner contracts                         |
| `pnpm harness run unit`                                                 | Extension/dependencies/webview            | Scripted            | Broad regressions; includes bundle; bounded Vitest workers                           |
| `pnpm harness run tooling`                                              | Scripts and host runner                   | Scripted            | Local reporting, installation and runner mechanics; no host launch                   |
| `pnpm harness run offline`                                              | Evaluator unit/contract/certification     | Scripted            | Grading and comparison machinery; no Docker/Postgres/Redis/provider needed           |
| `pnpm harness run host`                                                 | Actual VS Code 1.122.1                    | Scripted/LM fixture | Activation, modes and LM contracts; binary download/cache and desktop support needed |
| `pnpm harness run confidence`                                           | Kernel plus actual host and certification | Scripted            | Existing core confidence gate, including fresh completion evidence                   |
| `pnpm harness run services`                                             | Full evaluator                            | Scripted            | Dedicated test Postgres/Redis; no Docker                                             |
| `pnpm --filter @alpha-code/evals benchmark:fixture-check`               | Task fixtures                             | Scripted            | Broken/reference fixture integrity; not model capability                             |
| `pnpm --filter @alpha-code/evals benchmark:author-check`                | Task authoring                            | None                | Authoring/private-bank checks; private assets may be unavailable                     |

The executable [catalog](../scripts/harness/catalog.mjs) is the command inventory; its test verifies delegation to
existing package scripts. Old commands remain valid. Pass Vitest filters directly after `test`, without a standalone
`--`. Use package tests/typechecks for changed shared packages. Run exact-host coverage for the surfaces listed in
[AGENTS.md](../AGENTS.md), even if lower-level tests pass.

Additional Docker-free storage experiments use the existing campaign runner after a successful build/host lane:

```sh
pnpm --filter @alpha-code/vscode-e2e test:campaign --shared-storage-root <new-absolute-fixture-root> --vscode-version 1.122.1 --vscode-executable <absolute-1.122.1-Code-executable>
pnpm --filter @alpha-code/vscode-e2e test:campaign --storage-recovery-root <different-new-absolute-fixture-root> --vscode-version 1.122.1 --vscode-executable <absolute-1.122.1-Code-executable>
```

Use fresh owned directories outside the repository and personal VS Code profiles. Run these serially without concurrent
builds. The [acceptance ledger](harness-acceptance-status.md) records what their real-host receipts prove and what remains
untested; neither command calls a live provider.

The command wrapper selects existing runners and records exit status. SIGINT/SIGTERM cancels through the existing
owned-process runner, awaits bounded cleanup and prevents later steps. Cancelled reports cannot pass; uncertain cleanup
preserves the workspace lease. It is not a new test engine, grader or lifecycle
store. It retains the first failure and leaves later steps `not_started`. It does not automatically retry tests.
Build-bearing `static`, `unit`, `tooling`, `offline`, `host`, `confidence` and `services` lanes take a shared workspace lease: rebuilding `src/dist` while a host
uses its bundled tools can cause missing-binary failures. Older direct package commands remain available but bypass
this wrapper lease; never run those builds concurrently with an active host. After an interrupted wrapper, inspect
`artifacts/harness/.build-host-lock/owner.json` and confirm its process and child hosts have stopped before removing
that marker and its empty directory. A stale lease is deliberately not guessed away.
CI uses the same commands; artifact upload is optional transport. No workflow requires a GitHub dashboard to read results.

## Local evidence and retention

Each wrapper invocation writes `artifacts/harness/<UTC-time>-<unique-id>/result.json` and `result.md` with scope,
source commit, dirty state, lockfile hash, toolchain, step outcomes and timestamps. A record still marked `running`
after interruption is incomplete, never a pass. Console output remains in the terminal; these reports do not copy
environment variables, conversation history or raw logs. Save a private terminal log separately when diagnosis needs it.
These small indexes have no automatic local deletion; remove old run directories deliberately after reviewing failures.
GitHub uploads retain their copies for 14 days. Local retention does not depend on that service.

Detailed evidence stays with its existing owner:

- Core confidence: `artifacts/core-confidence/<run>/`, with `hostEvidenceRoot` pointing to the owned temporary host runs.
- Managed-agent certification: `artifacts/certification/managed-agent-milestone-evidence.json`; strict pending/skip
  rejection is intentional. Follow the [acceptance procedure](certification/managed-agent-live-acceptance.md).
- Host campaigns: the explicitly initialized external `--root`, immutable `report-*.json`, task evidence and owned
  profile/retention receipts. Failure or incomplete capture remains retained by the existing owner.
- Evaluator: its existing run/trial/artifact store and portable campaign exports. Hidden graders remain outside writable
  task workspaces. Service-backed historical data is preserved.

## Bounded live comparisons

First declare the question, exact model/settings, task set, baseline/candidate builds, allowed differences, repetitions,
pairing window, resource/cache policy, request/time/spend ceilings and keep/revise/revert/inconclusive rule. A paid
provider run needs approved credentials and a budget; ordinary test validation does not require one.

```sh
pnpm test:live:core --model-id <exact-id> --effort <supported-effort> --root <new-absolute-root> --profile-dir <owned-profile> --max-requests 100 --samples 3 --dry-run
```

Review the plan before replacing `--dry-run` with `--init-root`. These arguments are examples, not a claim that 100
requests are sufficient. Use the existing [profile guide](vscode-live-test-profiles.md) and [core confidence guide](core-confidence.md).
Do not compare runs that changed the task fixture, host, grader or model unintentionally. The new host campaign identity
checks source/build stability before and after execution. Legacy installed-extension evaluator runs cannot claim the
checkout was the executed build; their missing identity remains explicit.

Export each final host report with `benchmark:export-host-campaign`, then use `benchmark:campaign-paired-report` with
the predeclared experiment manifest. See [paired implementation and example](harness-implementation-experiments.md)
for exact commands, denominators, nullable usage and conservative source-component identity limits. Source digests do
not certify a fresh rebuild; actual build digests identify the bytes. Scripted samples can validate the pipeline, while
live success differences require repeated live observations and an appropriate uncertainty analysis.

## Optional native or approved service-backed evaluator

The default corporate loop is `static`, `unit`, `tooling`, `offline`, `host` and `confidence`.
Actual VS Code host campaigns and export/paired reports also need no Docker, PostgreSQL or Redis. They retain source/build
identity, task evidence, private graders and repeatable comparison manifests using the existing host runner.

PostgreSQL stores historical evaluator runs/trials/artifacts; Redis coordinates its runners and heartbeats. They are
required only by that persistent evaluator. Use approved native services or a dedicated approved service endpoint;
do not replace persistence or point reset tests at shared application data. Check access without changing it:

```sh
pnpm --filter @alpha-code/evals services:check
pnpm harness run services
```

The readiness command is read-only and redacts connection details. Service tests exercise PostgreSQL and Redis without
container launch. Test database reset is destructive to the dedicated test database and is guarded separately from
connectivity. A successful socket connection alone is not database readiness, permission to reset, or evidence of a
completed service suite. See [Docker-free evaluator details](harness-docker-free.md).

Docker remains optional coverage outside the corporate workflow: `pnpm harness run infrastructure` checks the container
adapter; `docker:prepare`, `docker:campaign`, and `docker:stop` in `@alpha-code/evals` operate the container workflow.
The campaign can consume live provider capacity and needs its own budget authorization. The legacy `test:evals` aggregate
continues to include optional Docker checks; it is not the corporate entrypoint.

Local workspaces, child processes and hidden grader directories prevent accidental mixing and reduce grader exposure.
They are **not a security sandbox** against untrusted commands running with the user's OS permissions. Run only trusted
fixtures locally. Untrusted benchmark repositories require an approved isolated machine/VM or equivalent administrative
boundary; do not silently downgrade container isolation to a normal workstation process.

## A repeatable development loop

1. Retain the failing evidence and identify the owning boundary; record what is unknown.
2. Reproduce with a controlled fixture. Audit broken, reference, alternative-correct and negative grader controls.
3. State one bounded change and its expected observable result before editing.
4. Run the reproducer and neighboring tests, affected typechecks, then the required host gate.
5. Read the diagnosis and comparison with failures, retries and missing measurements visible.
6. Record keep/revise/revert/inconclusive and the claim's scope. Preserve unresolved incidents separately.

A green rerun does not explain the historical ticket-progress timeout. The 75 ms real-filesystem fixture incident is
separate. The [reliability investigation](harness-implementation-reliability.md) retains those distinctions and grader
audit evidence; the [diagnostics record](harness-implementation-diagnostics.md) explains the safe-export compatibility.
