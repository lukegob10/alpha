# Candidate evaluation tasks

This is a separate authoring root. The released `../smoke-v1.yaml` remains the mandatory smoke gate; these candidates
are not admitted, released, or evidence of live model quality. Run the existing author checker against this directory.
The four smoke candidates exercise different observable repairs. Their names describe fixture behavior rather than
claiming production approval, recovery, or continuation coverage.

The Python report CLI is an original, synthetic, multi-module repository pilot. It exercises parsing, aggregation and
CLI integration with standard-library tests. It is not a snapshot of a production repository, a long-context task, or
proof that the local Copilot campaign executes Python. Its source and tests are complete; control certification is in
`packages/evals/src/benchmark/__tests__/corpusControls.spec.ts`. Reference and alternative patches stay outside the
agent workspace in `packages/evals/src/benchmark/corpusControls.ts`.

Each task has an untouched failure, two correct implementations, and three distinct wrong implementations. Offline
control results do not substitute for the existing model calibration, independent human quality review, or admission
requirements. A task/verifier/environment change invalidates the corresponding earlier control evidence.

All candidates are public and exposed to authoring agents on 2026-10-23. They are development inputs and must never be
reclassified as sealed holdout. There are no claimed live executions or human approvals. A later promotion requires
current evidence and a deliberate active-index/release change; no historical manifest, calibration or release lock is
rewritten by this candidate root.

For the existing offline commands, set `ALPHA_EVALS_REPO_PATH` to this directory's absolute path, then run:

```sh
pnpm --dir packages/evals benchmark:validate
pnpm --dir packages/evals benchmark:fixture-check
pnpm --dir packages/evals benchmark:author-check --output <new-ignored-artifact-directory>
pnpm --dir packages/evals test:unit src/benchmark/__tests__/corpusControls.spec.ts --maxWorkers=1
```

The control test resolves both the active and candidate roots itself; unset the root override before other evaluator
commands. The Python pilot requires `python` on PATH (verified locally with Python 3.12.2). Only offline fixture
certification is claimed here. Actual executed live breadth remains unavailable until supported run receipts establish it.
