# Model-Free Extension Certification

## Purpose

Provide a zero-API-cost gate before Luna evaluations. The scope is the Alpha VS Code coding agent, not a general multi-tenant execution platform.

## Commands

```powershell
pnpm evals:offline-certify
pnpm evals:offline-certify:full
```

The default command is the iteration gate. It runs agent-critical extension tests, CLI cancellation tests, Settings buffering tests, harness unit/contract/certification/infrastructure tests, visible fixture checks, and benchmark authoring checks.

The full command adds repository-wide linting, type-checking, and unit tests. Use it before a broad paid benchmark or promotion decision.

Both commands remove provider API credentials from child processes. They cannot intentionally launch a paid model campaign. When `EVALS_PRIVATE_BENCHMARK_ROOT` points to a private repository, private model-free admission runs automatically. Use `--skip-private` only for public-only development.

## Certification Areas

| Area                  | Model-free evidence                                            | Location                     |
| --------------------- | -------------------------------------------------------------- | ---------------------------- |
| Task continuity       | Resume, delegation, context truncation                         | Main repository              |
| Tool correctness      | Scheduling, policy, result IDs, pending results                | Main repository              |
| Workspace correctness | Mutation serialization and cancellation                        | Main repository              |
| Provider reliability  | Timeout and usage accounting                                   | Main repository              |
| VS Code state         | Cancellation and Settings edit buffering                       | Main repository              |
| Harness correctness   | Lifecycle, evidence, grading, retries, deterministic scenarios | `packages/evals`             |
| Benchmark integrity   | Manifests, initial failure, task diversity                     | `evals` and `packages/evals` |
| Hidden task admission | Gold, broken, mutation, determinism, isolation                 | Private repository           |

## Deliberate Exclusions

- No live model calls.
- No marketplace or release publishing.
- No broad platform penetration testing.
- No live-network VS Code E2E tests.
- No claim about agent intelligence; paid paired evaluations measure that.

## Remaining Local Milestones

1. Add a real process-tree timeout canary that proves evaluation cancellation leaves no child processes.
2. Add deterministic VS Code-host E2E tests backed by a local scripted provider.
3. Strengthen structural similarity checks so templated graders cannot pass authoring admission.

These belong in the main repository. Only task-specific hidden fixtures, graders, and calibration solutions belong in the private repository.
