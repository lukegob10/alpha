# Extension evaluation tooling

This package runs quality checks against Alpha's real VS Code extension. It is optional
for ordinary extension development. The standalone Next.js dashboard and its web
container have been retired; use the evaluator commands and their JSON reports.

## Setup

Use the repository's pinned Node.js and pnpm versions, then install from the root:

```sh
pnpm install --frozen-lockfile
pnpm bundle
```

The committed `.env.development` and `.env.test` files define local service defaults.
For live provider runs, create an ignored `.env.local` and supply only the provider
credentials needed for that run (for example, `OPENAI_API_KEY` for `openai` (OpenAI Compatible)). The old interactive machine-wide setup
script is retired; extension setup does not install global language runtimes or reset
another checkout.

## Offline checks

```sh
pnpm test:evals:offline
pnpm --filter @alpha-code/evals benchmark:validate
pnpm --filter @alpha-code/evals benchmark:fixture-check
```

The committed `evals/` corpus and database migrations are versioned test inputs.
Preserve their bytes and checksum manifests. Generic repository exercises remain because
they measure the extension's coding behavior; they are not another shipped application.
The [versioned corpus](../../evals/) includes the [Frontier](../../evals/frontier-v1.yaml),
[smoke](../../evals/smoke-v1.yaml), and [problem-solving](../../evals/problem-solving/v1.yaml) suites.
Keep historical evidence under `evals/archive/` and `evals/reports/nor36/` byte-for-byte, including original execution
identities and digests. Archived configurations may refer to retired products; they are not current run commands.
New campaign and authoring output belongs in ignored `packages/evals/artifacts/campaigns/` and
`packages/evals/artifacts/authoring/`.

Local measurement procedures remain in the [proportional-scope contract](../../evals/proportional-scope/README.md),
[request-preflight acceptance](../../evals/proportional-scope/acceptance.md), and
[lookup contract](../../evals/lookup-efficiency/measurement.md). After `pnpm bundle`, the retained scoped-read and HTML
preview probes run from the repository root with `pnpm exec tsx scripts/benchmarks/scoped-read.ts` and
`pnpm exec tsx scripts/measure-html-documents.ts`.

## Database-backed checks

Postgres and Redis are only needed for integration/infrastructure tests or persisted
benchmark runs. Configure the package's ignored development/test environment files for
isolated local services, then use:

```sh
pnpm --filter @alpha-code/evals services:up
pnpm --filter @alpha-code/evals db:test:migrate
pnpm test:evals
```

Run migrations only against the intended test database. `pnpm test:all` includes these
checks and therefore requires the services. The default root `pnpm test`, `pnpm lint`,
and `pnpm check-types` cover extension development without a running database.
Use `pnpm lint:all` and `pnpm check-types:all` for every retained workspace package.

Compose provides `db`, `redis`, and the optional `runner` profile. Ports remain
configurable through `EVALS_DB_PORT` and `EVALS_REDIS_PORT`. Persistent data stays in
`.docker/postgres` and `.docker/redis`; ordinary cleanup must not delete it.

## Authoring and running benchmarks

Use `benchmark:template`, `benchmark:author-check`, `benchmark:subset`, and `benchmark:run-model` from this package.
Run `pnpm --filter @alpha-code/evals cli --help` for persisted-run commands.

Each exercise needs instructions, an implementation stub, deterministic tests, and a task manifest. A task's `prompt.md`
takes precedence over `prompts/<language>.md`. Verify that the untouched fixture fails and correct implementations pass;
use the author checker to reject broken controls before admission. New language support also updates the
[language configuration](src/exercises/index.ts), [test runner](src/cli/runUnitTest.ts), and
[runner image](Dockerfile.runner). Change fixture bytes and checksum manifests together through the authoring workflow.

Set `ALPHA_EVALS_REPO_PATH` to an absolute path only when selecting another exercise root, such as `evals/candidates/`.
Run the same validation, fixture-check, and author-check commands against that root, then unset the override before
returning to the active corpus. Candidates were publicly exposed on 2026-10-23 and must never become sealed holdout;
offline controls do not admit them or establish live model quality.

Model campaigns retain scheduled, scoreable, excluded, and missing trial counts separately in calibration reports.
Capability calibration still requires five scoreable trials and a fresh quality review. The benchmark `record-model`
command accepts an optional `--delivery <file.json>` containing the complete delivery record; without it, the denominator
remains unknown and any replaced model arm loses its old delivery record. Historical reports remain readable.

Calibration report writers share a per-file lock and atomic publication on local filesystems. Model ingestion and keyless
sync merge against the latest destination report; review and fresh keyless grading reject stale snapshots. Keyless sync
preserves model delivery alongside its observations and clears quality approval and admission when the keyless evidence
changes.
Revoking quality approval or required review coverage also clears admission. Conflicts require a fresh read and an
explicit retry; approval decisions are never replayed automatically.

Locks use the report's `.calibration.lock` suffix and are not removed based on age. After a crashed writer, stop all writers
for that report, inspect the retained report and lock's process ID, and remove only the confirmed orphan lock before
retrying. External editors do not participate in this protocol; stop report writers before manual edits. Network
filesystems are outside this locking guarantee.

`review-sample`, `release-audit`, and `release` require `--disagreements <file.json>` with independently reviewed
grader-disagreement trial IDs. Supply an explicit empty array when there are none. The review sample must cover the
current suite's complete task and trial population; regenerate a legacy sample before a new release.

```sh
pnpm --filter @alpha-code/evals benchmark:review-sample --disagreements reviewed-disagreements.json
pnpm --filter @alpha-code/evals benchmark:release-audit --disagreements reviewed-disagreements.json
```

Subset history updates accept only measurements whose saved task identity matches the selected task's exact version.
The benchmark `gate` input requires `pairedEvidence` containing sealed control/candidate campaigns, their predeclared
experiment, the expected model identity, and the predicted capability. The improvement plan's population must be
`capability:<predictedCapability>` and cover that capability's declared tasks. Aggregate-only legacy inputs remain
readable but cannot establish a new promotion.
