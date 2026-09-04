# Stage 1 core harness implementation

## Scope and execution model

Implement NOR-30, NOR-27, and NOR-28 in parallel, then integrate and validate their combined behavior.
This is a bounded performance-optimization pass, not a full-harness rewrite.

- Baseline: `0de6860f6d9b7b9d64c3b377c57ebecc016e46a3` from `main-v2`.
- Integration branch: `codex/stage-one-core-harness`.
- Orchestrator task: `01a06a5a-4b89-7692-9084-2cae8d6719ea`.
- Task owners use **Sol Max** for planning, investigation, ambiguous decisions, and review.
- Bounded implementation/test sub-agents may use **Luna Max**; uncertainty defaults to Sol Max.
- Each implementation has an independent worktree and reviewable local commits. No remote push or release is included.
- Preserve the user's uncommitted root `AGENTS.md`; do not include it in implementation commits.

The app's default worktree base differed from the reviewed checkout. Each task must confirm the baseline above before
editing. The orchestrator coordinates host tests and owns integration and final Linear status.

Active task identities (all created with `gpt-5.6-sol`, reasoning `max`):

- NOR-30: `01a06a8f-171b-7890-b037-b106d3ddc47f`, branch `codex/nor-30-preview-only`.
- NOR-27: `01a06a91-f923-7171-b3fc-e310adf05758`, branch `codex/nor-27-environment-context`.
- NOR-28: `01a06a92-1f61-7f71-8cb3-ecdd6fd6a8c9`, branch `codex/nor-28-tool-catalog`.

## Ownership and implementation sequence

| Ticket                                                                                                                 | Owned responsibility                                                                    | Integration boundary                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [NOR-30](https://linear.app/norval/issue/NOR-30/remove-legacy-tool-execution-from-assistant-message-presentation)      | Preview-only presentation; retire dormant dispatch and migrate its behavioral tests     | Preview invocation, obsolete single-tool flags, and necessary barrier/isolation wiring |
| [NOR-27](https://linear.app/norval/issue/NOR-27/make-environment-context-incremental-and-preflight-cancellation-aware) | Task-scoped environment snapshots/deltas and cancellation-safe preflight                | Environment capture, context commit/receipt, and reset on start/reload/compaction      |
| [NOR-28](https://linear.app/norval/issue/NOR-28/reduce-and-stabilize-tool-catalogs-with-deferred-discovery)            | Stable effective schemas, bounded invalidation, and policy-safe optional-tool discovery | Canonical tool surface construction and provider-facing schema capture                 |

Each owner first reports a file-level plan, proposed interface changes, baseline evidence, and acceptance coverage.
Implementation proceeds independently within those boundaries. Changes to shared contracts are coordinated before they
spread across consumers. Prefer merging the bounded NOR-30 cleanup first; NOR-27 and NOR-28 may arrive in either order.
Do not broaden the cleanup merely to make this order happen.

The task owners must keep separate implementation/evidence notes:

- `docs/nor-30-implementation.md`
- `docs/nor-27-implementation.md`
- `docs/nor-28-implementation.md`

## Shared contracts

1. `AgentTurnEngine` remains the single sequencing kernel. `ToolScheduler` remains the effect boundary.
2. Schema visibility, executable descriptors, and permission come from the same immutable `TaskToolSurface`/step capture.
   Tool discovery must not widen policy or alter scheduling/approval capabilities.
3. Previewing a tool block never executes it. Preserve preview text/reasoning ordering, epochs, locks, and cancellation.
4. Environment deltas require an explicit full-baseline/reset contract. Unread terminal output must not be lost on a
   failed or cancelled context commit, or duplicated on retry.
5. Existing before-effect persistence fences, complete tool transactions, provider state, and ordinary-text completion
   remain intact. New caches/buffers must be bounded and correctly invalidated.
6. VS Code 1.122.1, provider neutrality, scoped workspace policy, and backward-compatible task recovery are mandatory.

## Agreed interface decisions

- NOR-30 owns a registry-derived batch-isolation query shared by scheduler preflight and the necessary early Task check.
  There is no approval/capability/concurrency change in this work.
- NOR-27 owns bounded environment capture with explicit commit/release receipts. A full baseline and transient terminal/
  file-change events have different delivery needs; successful summaries must not accidentally cause duplicate delivery.
- NOR-28 may add the ordinary native `discover_tools` function for sufficiently large permitted MCP catalogs. Lookup is
  local and bounded; selected schemas become callable only through a newly sealed surface on the next real step. Native
  core tools remain eager. Gemini/Vertex retain history-compatible schemas and callable restrictions; VS Code LM retains
  its eager ordinary-schema fallback. Generic MCP-call bypass remains unavailable.
- The orchestrator owns a narrowly scoped retry-wire consistency fix: the actual retry request must match its captured
  logical request. `StepContext` contains sanitized metadata, so it must not be dispatched directly as raw provider input.
  Preserve legitimate opaque/provider data in a bounded process-local request projection; never log it. Refresh only
  justified attempt-local identities, signal, and deadline. Context recovery must establish an explicit new boundary.

The independent Sol Max audit additionally calls for actual-wire retry tests, failed environment-delivery receipt tests,
preflight cancellation tests, discovery/alias/generic policy-negative cases, context-reset and historical-schema cases,
and cross-task mode/cache isolation. These are affected-contract integration checks, not authorization for later stages.

## Explicitly out of scope

- NOR-26 selective parallel execution, NOR-24 compaction-policy redesign, NOR-25 primary verification/progress redesign,
  and NOR-29 persistence-format optimization.
- CLI and VS Code shim changes; unrelated UI, release versions, changelogs, dependency upgrades, or generated artifacts.
- New competing kernels, registries, persistence authorities, or approval mechanisms.

## Validation and integration

Owners run focused regressions, affected-package typechecks/lint, and deterministic before/after fixtures for claimed
performance improvements. Measure actual effective payloads, not a raw unfiltered catalog. Do not infer generalized
quality or latency gains from a single live-model run or noisy concurrent timing.

The orchestrator inspects each commit for scope and integration risks, then reruns combined coverage. Required scenarios
include preview plus native/MCP calls, captured policy/schema agreement, environment reset after compaction, cancellation
and retry around unread output, and reload with preserved tool transactions.

Baseline command:

```sh
pnpm --dir src exec vitest run core/assistant-message/__tests__/spawn-agent-native-pipeline.spec.ts core/environment/__tests__/getEnvironmentDetails.spec.ts core/tools/__tests__/ToolRegistry.spec.ts core/tools/__tests__/TaskToolSurface.spec.ts core/task/__tests__/native-tools-filtering.spec.ts core/agent/__tests__/ToolScheduler.spec.ts core/task/__tests__/Task.spec.ts --maxWorkers=3
```

Baseline result: **7 files, 204 tests passed**, Node 20.19.2 and pnpm 10.8.1, before any Stage 1 implementation edits.
The reported run duration was 11.60 seconds; this is correctness baseline evidence, not a performance benchmark.

Additional pre-change baseline: `pnpm --dir src check-types` and `pnpm --dir src lint` passed. The complete
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` gate passed on exact VS Code 1.122.1: 2 extension, 2 mode, and 4
VS Code LM contract tests. These are baseline results and must be rerun on integrated changes.

Integration gates:

```sh
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Widen to affected shared-package/provider tests and typechecks when an implementation changes those contracts. Run only
one exact-host suite at a time. A gate that cannot run must be reported as unavailable with its cause and closest lower-level
coverage; it must not be reported as passed.

## Closure ledger

- In progress: three implementation tasks with agreed interface plans, plus the orchestrator-owned retry consistency fix.
- Verified: combined pre-change focused, lint, typecheck, and exact-host baselines above; independent integration-risk audit.
- Pending: implementation commits, code review, performance evidence, combined regression/lint/typecheck, exact-host gate.
- Out of scope: later-stage tickets and protected CLI/shim surfaces.

Tickets remain In Progress until their acceptance criteria and integration evidence are reviewed. Finishing a child task
does not by itself complete Stage 1.
