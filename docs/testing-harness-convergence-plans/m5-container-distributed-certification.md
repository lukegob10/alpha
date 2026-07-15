# M5 implementation plan — container and distributed-system certification

## Production boundaries

- Introduce a structured Docker adapter whose executable and arguments are always separate, whose resources are labeled by run/trial/attempt, and whose cleanup filters by exact ownership labels.
- Replace `sh -c` in the production task-container launch with a direct `pnpm --filter @alpha-code/evals cli --taskId ...` argv contract.
- Pass secrets through the Docker client process environment by variable name; reject secret values in recorded argv and manifests.
- Capture immutable image ID/digest, architecture, OS, Docker runtime, CPU/memory/PID limits, network mode, permissions, and concurrency in an infrastructure manifest attached to valid evidence.

## Reconciliation and teardown

- Add a restart reconciler that compares open database attempts, Redis runner leases/heartbeats, and labeled Docker containers.
- Classify expired leases and absent containers as orphaned infrastructure attempts without overwriting prior attempt evidence.
- Add a leak detector and run-scoped cleanup API; teardown fails if labeled containers remain and must never remove another run's resources.
- Preserve the M4 ordering invariant: collect and validate evidence before container removal.

## Real-infrastructure contract topology

- Use uniquely labeled, disposable containers and networks with the M2 fake runtime; no provider keys or model calls.
- Exercise serial and concurrent containers against real Docker, Redis, and PostgreSQL.
- Cover fresh workspaces, run-scoped writable mounts, network/resource constraints, direct argv, secret-free process listings, timeout/process-tree termination, controller/runner disappearance, Redis/PostgreSQL connection loss, concurrent finalization, artifact-before-removal, and hidden-state invisibility.
- Inspect Docker after every test and fail on leaks; use unique campaign labels so tests cannot affect unrelated containers.

## Files and tests

- Add `src/infrastructure/` contracts, Docker CLI adapter, manifest collector, reconciliation service, and leak detector.
- Add deterministic unit tests with the M2 process/runtime fakes and opt-in real-Docker contracts under `src/infrastructure/__contracts__/`.
- Extend `processTaskInContainer`, Redis lease helpers, and lifecycle persistence only through the new typed boundaries.
- Add `test:infrastructure` and include the keyless real-service contract in the M5 campaign gate.

## Validation

1. `pnpm --filter @alpha-code/evals test:unit`
2. `pnpm --filter @alpha-code/evals test:contract`
3. `pnpm --filter @alpha-code/evals test:infrastructure`
4. `pnpm --filter @alpha-code/evals test:integration`
5. `pnpm --filter @alpha-code/evals test:coverage`
6. `pnpm --filter @alpha-code/evals check-types`
7. `pnpm --filter @alpha-code/evals lint`

## Decisions and non-goals

- The certification image may be a small pinned local image; building or invoking the model-capable runner is not required to test distributed-system semantics.
- Docker is required for the explicit M5 contract command, but ordinary unit tests remain Docker-free.
- Real-model quality, statistical promotion, and the capability task bank remain M6–M7 work.
