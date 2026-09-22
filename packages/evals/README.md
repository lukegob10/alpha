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

Use `benchmark:template`, `benchmark:author-check`, `benchmark:subset`, and
`benchmark:run-model` from this package. Run `pnpm --filter @alpha-code/evals cli --help`
for persisted-run commands. See [ADDING-EVALS.md](ADDING-EVALS.md) for exercise structure
and [../../evals](../../evals) for the versioned extension evaluation corpus. The curated
problem-solving set is [../../evals/problem-solving/v1.yaml](../../evals/problem-solving/v1.yaml).
