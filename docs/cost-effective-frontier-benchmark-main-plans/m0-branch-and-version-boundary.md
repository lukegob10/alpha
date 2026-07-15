# M0 Implementation Plan — Branch and Version Boundary

**Status:** complete (2026-07-13)

## Objective

Move benchmark work off the eval-generated `runs/*` branch without losing the existing dirty worktree, and make the public/private version handshake explicit.

## Current evidence

- Main repository branch: `runs/2-a425a1c6`.
- `main`, `origin/main`, and the run branch currently point to commit `745e1e2`.
- Benchmark and harness work is present as uncommitted tracked and untracked files.
- Public suite: `frontier-v1`, version 1.
- Expected private bundle: `frontier-v1-graders`, version 1.

## Changes

1. Create `codex/frontier-benchmark-expansion` at the current commit while preserving the worktree.
2. Add a public benchmark boundary document containing suite, bundle, repository, and branch identities.
3. Ensure `evals/frontier-v1.yaml` references the expected private bundle for every scored task requiring private grading.
4. Add a validation test that rejects a suite/bundle identity mismatch.

## Files

- `docs/benchmark-version-boundary.md`
- `evals/frontier-v1.yaml`
- `packages/evals/src/benchmark/loader.ts`
- `packages/evals/src/benchmark/__tests__/benchmark.spec.ts`

## Validation

- `git branch --show-current`
- `pnpm --filter @alpha-code/evals test:unit -- src/benchmark/__tests__/benchmark.spec.ts`
- `pnpm --filter @alpha-code/evals benchmark:validate -- --require-private`

## Exit evidence

- Active branch is `codex/frontier-benchmark-expansion`.
- Public suite and private bundle identities are explicit and validation-enforced.
- No user change is discarded.

## Completion evidence

- Active branch: `codex/frontier-benchmark-expansion`.
- Public dependency: `frontier-v1@1` → `frontier-v1-graders@2`.
- Bundle content digest: `sha256:0f94925970b79f1d3e0dcb65a8b15832711c014cd0e443c2c2ce36b40bd7072e`.
- Benchmark contract tests: 9/9 passed.
- Private-required validation: 2 suites, 48 tasks, and 40 private bundle references valid.
