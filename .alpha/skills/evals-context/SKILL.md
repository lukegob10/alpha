---
name: evals-context
description: Provides context for Alpha's retained evaluation infrastructure and extension quality suites. Use when a task mentions evals, evaluation runs, eval exercises, benchmark campaigns, or VS Code extension certification.
---

# Evals Codebase Context

Use this skill for work on the evaluation infrastructure that exercises the Alpha VS Code extension. The repository keeps
the evaluator package, the exact-host VS Code runner, extension-specific suites, and the campaign definitions needed to
reproduce benchmark work. The former standalone eval dashboard and nightly packaging variant are retired.

## When to use this skill

Use it when a task involves:

- `packages/evals/` controller, runner, database, evidence, grading, or benchmark code
- `apps/vscode-e2e/` host-contract and live evaluation runners
- extension-specific suites under `evals/`
- reproducible benchmark campaign definitions under `.frontier-campaign/`
- adding or reviewing exercises in the external [Alpha-Evals](https://github.com/AlphaInc/Alpha-Evals) repository

Do not use it for ordinary extension or webview changes unless the task also changes an evaluation contract.

## Repository boundaries

| Component              | Path                                                   | Purpose                                                                                                                  |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Evaluation package     | `packages/evals/`                                      | Optional controller, runner, database, evidence, grading, and benchmark tooling that executes the real VS Code extension |
| VS Code runner         | `apps/vscode-e2e/`                                     | Exact VS Code 1.122.1 contract tests, scripted providers, and live host harnesses                                        |
| Local extension suites | `evals/`                                               | Deterministic extension and safety suites that are part of Alpha's quality checks                                        |
| Campaign definitions   | `.frontier-campaign/`                                  | Tracked campaign configuration and templates; generated attempt output is disposable and ignored                         |
| Exercise repository    | [Alpha-Evals](https://github.com/AlphaInc/Alpha-Evals) | External language exercises and their tests                                                                              |

The evaluator launches the real extension through VS Code. It is not a second Alpha runtime. Keep extension policy,
tool availability, persisted task behavior, and provider contracts in the extension packages that own them.

## Package layout

The package layout can evolve with the evaluator; these are the current active areas:

```text
packages/evals/
├── src/benchmark/       # benchmark commands
├── src/campaign/        # reproducible campaign definitions and runs
├── src/certification/   # certification workflows
├── src/cli/             # evaluator orchestration and VS Code task execution
├── src/db/              # run, task, and evidence persistence
├── src/evidence/        # manifests, journals, reconstruction, and integrity checks
├── src/experiments/     # governed comparison and reporting helpers
├── src/exercises/       # exercise loading and task metadata
├── src/grading/         # result aggregation and grading plugins
├── src/infrastructure/  # Docker and runner lifecycle adapters
├── src/lifecycle/       # run state transitions
├── src/orchestration/   # run scheduling and coordination
└── src/testing/         # evaluator test helpers and contracts
```

Treat `packages/evals/src/**/__fixtures__` and contract fixtures as immutable test inputs unless a contract change
explicitly requires updating them. Historical `.frontier-campaign/campaigns/*/attempts/` output is evidence, not a source
fixture; new runs should write it outside Git or under the ignored attempts path.

## Common commands

Run the default repository checks from the root for the extension, webview, and VS Code E2E dependency graph:

```sh
pnpm lint
pnpm check-types
pnpm test
```

Use the exact release-host gate when a change affects extension activation, VS Code APIs, task lifecycle, or packaging:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The default root checks intentionally exclude optional evaluator work. Run all retained workspace checks explicitly when
that surface is in scope:

```sh
pnpm lint:all
pnpm check-types:all
pnpm test:all
```

For evaluator-only validation, prefer the package scripts so each suite's environment is explicit:

```sh
pnpm test:evals
pnpm test:evals:offline
pnpm --filter @alpha-code/evals test:unit
pnpm --filter @alpha-code/evals test:contract
pnpm --filter @alpha-code/evals test:certification
```

Live evaluator runs require the configured provider credentials, a working VS Code installation, and any services named
by the selected package command. Do not treat an offline or fixture run as evidence for live provider quality.

## Adding or changing exercises

Exercises live in the external [Alpha-Evals](https://github.com/AlphaInc/Alpha-Evals) repository. Follow
[`packages/evals/ADDING-EVALS.md`](../../../packages/evals/ADDING-EVALS.md) for the exercise contract and keep the evaluator's
language adapters, Docker image, and tests in sync. A new exercise should include its instructions, implementation stub,
language-specific test, and deterministic success criteria.

Changes to evaluator behavior should include focused package tests and, when the behavior crosses the extension boundary,
an exact-host or contract test. Preserve historical run records and result values; migrations and compatibility readers
must remain able to load older records.

## Campaigns and evidence

Tracked files under `.frontier-campaign/` are definitions, templates, and reproducibility metadata. Generated attempt
outputs belong in the ignored `campaigns/*/attempts/` paths or in the external evidence roots documented by the run. Do
not delete campaign definitions or immutable evaluator fixtures because no current source file imports them: the campaign
runner resolves them by path at execution time.

When reporting benchmark results, identify the campaign/configuration, evaluator version, VS Code host, model and effort,
fixture or exercise revision, and evidence root. Separate deterministic offline checks from live-model observations.
