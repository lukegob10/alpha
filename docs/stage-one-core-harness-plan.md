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

Review refinements:

- An invalid mixed-barrier batch is staged before assistant persistence, but still reaches the canonical scheduler after
  durability so structured results are published exactly once. Cancellation retains those already-staged per-call error
  receipts while the enclosing outcome is aborted. Valid batches keep normal cancellation precedence.
- Environment acknowledgement occurs at successful history persistence, before unrelated wait-result claim settlement.
  A later settlement failure must not cause already-durable terminal output to be delivered again. Failed-save rollback
  targets only the exact newly staged message, preserving unrelated messages.
- Deferred discovery promotes schemas only from a successful, validated paired call/result transaction at a subsequent
  step. Canonical MCP names and underscore aliases must pass the same captured policy. Connection/schema changes are
  checked again before execution and after approval.
- Retained retry response metadata, not just its request, must come from the captured provider handler/protocol. Provider
  continuity includes reasoning signatures/details, encrypted reasoning, response IDs, and VS Code opaque state.
- Empty-response retry after context recovery must restore the complete committed message, including summary/truncation
  metadata and newly acknowledged events. Steering must not strip that metadata or reveal previously hidden history.
- Bounded terminal receipts must make fair progress across processes and preserve terminal-marker cleanup at chunk
  boundaries. Captured file-change receipts may acknowledge only paths actually represented in the outgoing context.
- MCP dispatch retains host-owned original target/source metadata and checks it after all approval/UI waits. Switching to
  an eager provider must preserve historical discovery declarations without making discovery callable there.

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

Intermediate retry validation: the original code failed deterministic cases for a changed live handler/prompt/history on
transport/rate-limit retry and for compaction during a retained retry. Five additional provider-persistence cases wrote the
replacement provider's response ID instead of the captured provider's ID. The targeted fixes pass 15 dedicated tests;
four subsequent direct-caller regressions close an unbounded empty compatibility-response loop and preserve the latest
failure on loop exit, bringing the dedicated suite to 19 tests. The orchestrator also ran 179 adjacent retry,
step-context, and persistence tests successfully. These are intermediate results, not evidence that all Stage 1 changes
have passed integration.

Final retry-only validation passed 176 tests across the dedicated suite plus Task, Task persistence, and graceful retry
coverage, as well as `src` lint/typecheck and touched-file formatting. Typecheck first exposed a private-method test
assertion; the fixture was corrected without changing production behavior and the check reran successfully.

Pre-existing follow-up outside this bounded patch: some outer-loop model/cost accounting still reads live provider
settings. A mid-retry provider switch can therefore label accounting differently from the now-stable actual request.
No live cost/cache or generalized speed claim relies on that accounting in this stage's fixture evidence.

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

- Integrated: retry consistency `787fa8c`; NOR-30 `cee6d5c` from reviewed source commit
  `d49f38f075b80b0709b553fde23bcc47209d7745`; NOR-28 `f633e11` from source commit
  `8193e55489b7c49e921dd40bc7dfee0840c6599c`; NOR-27 `bd43a7c` from source commit
  `3b58d1fe5aae9162078b8f13dd66953d3633d0a3`.
- NOR-27 integration required combining additive imports in two Task test files. Production Task changes auto-merged;
  captured retry inputs/provider metadata, environment durability acknowledgements, and catalog capture remain intact.
- Independent Sol Max review cleared all three exact source commits; no material findings remain from those reviews.
- Verified: combined pre-change baselines above; exact NOR-30 commit cleared by independent Sol Max review; 251 combined
  retry/presenter/scheduler/Task/persistence tests and extension typecheck passed after integration. The persistence
  fixture now captures a real step rather than fabricating an incomplete `{ stepId }` object.
- Broader intermediate validation on `f127686`: 98 files, 1,287 passing tests and 5 skipped across Task, agent,
  assistant-message, tools, and task-persistence suites (`pnpm --dir src exec vitest run core/task/__tests__
core/agent/__tests__ core/assistant-message/__tests__ core/tools/__tests__ core/task-persistence/__tests__ --maxWorkers=3`).
  These results precede NOR-27/NOR-28 integration and do not replace the final combined gates.
- NOR-28 integration: 99 retry/catalog/parser/canonical-MCP tests passed across 5 files, plus all 272 shared-type tests
  across 21 files. Two new real-registry/scheduler canonical-name cases failed before NOR-28 and pass after integration;
  their existing underscore-alias controls still pass. No validator bypass was added.
- Combined validation on `bd43a7c` plus the canonical-MCP test parameterization: 190 files passed / 1 skipped;
  2,948 tests passed / 18 skipped (75.03 seconds). Coverage includes all Task, agent, assistant-message, tools,
  task-persistence, environment, context-tracking, terminal, glob, Git, provider, and provider-transform suites.
  Integrated repository-wide typecheck passed all 13 tasks; lint passed all 12 tasks.
- Pending: managed-agent certification and exact-host gate. Per-ticket deterministic performance evidence is recorded
  in the implementation documents; the combined regression run includes both measurement fixtures.
- First combined managed-agent certification: all 1,230 deterministic tests and 26 matrix rows passed, with the eight
  expected live/manual rows still pending. The subsequent 1.122.1 managed-agent host case failed before its first child
  spawn. A diagnostic rerun confirmed `DataCloneError` from the scripted provider's runtime-only `fakeAi.removeFromCache`
  callback entering `StepContext.provider.options`; this source path also exists at the baseline. The integration fix
  excludes the executable fixture object from diagnostic options without changing the captured handler or raw wire
  request. The real FakeAI handler regression reproduced the failure before the fix; the retry-wire/provider suites
  then passed all 23 tests, alongside extension typecheck, touched-file lint, and formatting.
- After the FakeAI boundary fix, the entire combined core/provider command above passed again: 190 files passed /
  1 skipped; 2,949 tests passed / 18 skipped (70.81 seconds). Host-test diagnostics also passed the E2E package's lint
  and typecheck. These checks do not substitute for the pending final host gates.
- The next managed-agent host run completed child execution, nested Apply, discard, outer Apply, and tree projection,
  then stalled while answering the root follow-up. A diagnostic rerun confirmed an active `followup`, no answer, and a
  nonempty message queue with the webview ready. `ChatView` automatically queued all input during an active turn while
  `Task.ask` intentionally reserves queued input for the next turn. This routing also predates Stage 1. A bounded UI
  correction must prioritize the current complete, unanswered follow-up without draining next-turn messages or bypassing
  the host/API path. Host timeouts and acceptance assertions remain unchanged.
- Out of scope: later-stage tickets and protected CLI/shim surfaces.

Tickets remain In Progress until their acceptance criteria and integration evidence are reviewed. Finishing a child task
does not by itself complete Stage 1.
