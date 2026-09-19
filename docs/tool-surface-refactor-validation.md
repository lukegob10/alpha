# Tool surface refactor implementation record

Governing design: [native tool-surface refactor](tool-surface-refactor.md).
Base commit: `0dc21021`; target branch: `codex/tool-surface-refactor`.

## Reconciled inventory

- `packages/types/src/tool.ts` retains historical names and usage records. `src/shared/tools.ts` owns executable groups,
  aliases, and parsed argument types. New schemas use canonical names while persisted calls preserve their original name.
- `getNativeTools`, mode filtering, `build-tools`, `ToolRegistry`, and the captured `TaskToolSurface` jointly own the
  advertised and executable boundary. Compatibility aliases must not reintroduce retired advertised names.
- `ExecuteCommandTool`, `ToolScheduler`, `ParallelCommandRead`, Plan validation, and Task command evidence own command
  safety and lifecycle. The public rename must preserve these paths, approval decisions, mutation receipts, and cancellation.
- Artifact reads move behind `manage_command`; the historical alias requires argument adaptation as well as name resolution.
- `edit` keeps its existing payload. Historical diff and whitespace-tolerant editors retain their parsers and executors;
  their distinct payload semantics must not be silently coerced into exact replacement.
- Provider tool preferences choose one surgical preference; portable `edit` remains available alongside GPT-family
  `apply_patch`. Model identity controls schema preference only and cannot widen execution policy.
- MCP discovery candidates remain restricted to `mcp--*`. Native tickets, agents, browser tools, and editors remain eager
  under their existing host/mode predicates.
- UI messages and persisted tool rows remain compatible. Host scenarios and evaluator trace normalization must recognize
  both canonical `shell` and historical `execute_command` when reading evidence.

## Validation baseline

- `pnpm install --frozen-lockfile`: passed; no dependency or lockfile changes requested.
- `pnpm --filter @alpha-code/types build`: passed.
- `pnpm harness doctor`: Node 24.14.1 and pnpm 11.24.0 match the repository contract.
- `pnpm harness run focused core/tools/__tests__/nativeToolDispatchContract.spec.ts core/task/__tests__/native-tools-filtering.spec.ts`:
  passed, 2 files / 5 tests before implementation.

Phase-specific and final validation results are recorded below as they run. No live provider quality or performance
improvement is claimed by this catalog refactor.

## Phase 0 and 1

The new catalog contract first failed on the absent canonical command name/alias and the old advertised catalog.
Phase 1 adds `shell` to the type catalog, preserves historical names, changes groups to the locked target, and adds the
command alias. The artifact-read alias is deferred until its argument adapter exists.

- Types build: passed.
- `pnpm --dir packages/types test src/__tests__/mode-retirement.test.ts`: 10 passed.
- `pnpm --dir src test core/tools/__tests__/nativeToolSurfaceRefactor.spec.ts -t "phase 1"`: 3 passed.
- `pnpm --dir src check-types`: passed.

Shared-mode tests now verify portable edit file restrictions and reject retired editor opt-ins: 49 passed.
The complete types package suite passed (28 files / 292 tests), as did its package typecheck.

## Phase 2

The canonical `shell` descriptor delegates to the existing command host, including partial-call presentation. Aliases
share capability metadata, command policy, scheduler admission, and repetition budgets. The schema requires only
`command`; legacy `execute_command` parsing retains `verification` and the original transcript name.

- Command executor, parallel command reads (unit/integration), Plan command classifier, native parser: 5 files / 256 passed.
- Execution profile, registry, command-outcome integration: 3 files / 48 passed.
- Command repetition and progress: 2 files / 46 passed, including alternating canonical/historical names.
- `pnpm --dir src check-types`: passed.

## Phase 3

`manage_command` delegates artifact reads to the existing bounded reader. Historical calls receive `action: "read"`
in both parsing and scheduler dispatch. Read actions and command controls retain distinct progress identities, while
canonical and historical artifact reads share retry budgets.

- Manage/read executors, parser, and Task progress baseline: 4 files / 203 passed.
- Phase-specific schema, registry, parser, reader, and scheduler checks: 6 files / 187 passed.
- Command repetition and progress: 2 files / 47 passed. The new alias retry regression failed before normalization.
- `pnpm --dir src check-types`: passed.
- Scheduler, command batching, and command approval: 3 files / 107 passed.
- Turn engine and Task wait-progress: 2 files / 44 passed.
- Transcript/verification recovery integrations and legacy command executor: 4 files / 38 passed.
- Final alias regression batch: 190 focused tests and 56 repetition/progress tests passed; typecheck passed.
  Forged command-control fields in historical artifact reads cannot change the action. Cancellation and invalid null
  read fields are covered.
- E2E-runner unit baseline before scenario migration: 427 passed, 2 skipped, no failures.
- Transport regression: the OpenAI-compatible converter previously restored strict required-null fields despite the
  thin native schemas. Both command schemas now explicitly opt out of strict conversion. The red-first converter
  regression failed with the old behavior; converter/schema/management tests now pass (33 tests).

## Phase 4

Editor requirement tests now exercise portable `edit`, while retired editor opt-ins remain denied. Historical diff
executor regressions supply their retired schema explicitly rather than restoring it to new model catalogs.

- Mode validator: 37 passed after replacing stale default-editor expectations.
- Portable and historical editor executors: 4 files / 119 passed, including diff write, denial, and partial-failure receipts.
- Vertex OpenAI-compatible and VS Code LM providers: 118 passed, including opaque route IDs, conflicting identities,
  and resolved-client identity overriding stale configured selectors.
- Router preference and catalog-cache focused tests: 91 passed.
- `pnpm --dir src check-types`: passed before starting phase 5.

## Phase 5

New managed-child grants contain canonical current tools. Saved equivalent command/edit aliases retain their grant,
while a saved artifact-read grant cannot authorize command control. Historical editor aliases still receive Worker
path-scope checks; retired progress/control tools are no longer automatically granted.

- Managed-child authority and context: 22 passed. The new grant regressions failed before implementation.
- Primary lifecycle exposure and child authority: 22 passed. Primary catalogs no longer hide lifecycle tools when the
  durable store has no children; managed children remain constrained by frozen grants.
- Complete native-surface and dispatch contracts: 15 passed, including the exact Code set, Plan restrictions, eager
  tickets/browser predicates, historical names, and MCP-only discovery.
- Catalog, lifecycle, admission, and historical-registry checks: 9 files / 113 passed; extension typecheck passed.

## Phase 6

Evaluator trace readers recognize both `shell` and historical `execute_command`, retaining the original name in
evidence. The proportional-scope reporter categorizes current editors and managed-agent tools, and counts command
launches separately from command management. Both new regressions failed before implementation.

- Evaluator lifecycle and persisted-trace tests: 24 passed.
- Proportional-scope reporter tests: 24 passed.
- Evaluator typecheck and retained live-playbook preflight: passed.
- Prompt subtree: 307 passed, 2 skipped; managed-child prompt/delegation tests: 33 passed; extension typecheck passed.
- E2E runner: 33 focused tests and the complete 429-test unit suite passed (2 skipped); compile/typecheck passed.
  Its closed fixture policies retain equivalent aliases so disabled historical names cannot inadvertently disable
  canonical commands. Current callers use `shell`; trace readers accept both spellings.
- Internal scoped-verification metadata remains accepted by the command parser for both names, without returning it
  to the public schema. A red-first parser regression and the thin-schema checks pass (94 tests). Scripted managed-agent
  acceptance injects that internal metadata explicitly; command-host verification semantics remain unchanged.

## Broader validation

- `pnpm harness run offline`: passed, covering 265 evaluator unit tests, 19 contract tests, and 5 certification tests.
  Evidence: `artifacts/harness/2026-09-19T22-31-28-284Z-e23371a6/result.json`.
- `pnpm harness run static`: passed (8 lint tasks and 9 type/build tasks).
  Final evidence: `artifacts/harness/2026-09-19T22-51-19-699Z-3c9db72f/result.json`.
- The first broad unit run exposed stale catalog expectations and two complete module mocks missing the new model
  identity helper. The mocks now preserve the real helper: 121 compaction/retry tests passed. Catalog invalidation
  now checks portable `edit` plus the identity-gated patch transition: 10 passed. Historical lifecycle/barrier tests
  retain explicit retired schemas rather than returning those schemas to production catalogs.
- Final historical pipeline/barrier fixtures: 247 passed; only the explicit historical cancellation fixture exempts
  its retired name from mode validation. Current names retain production validation.
- `pnpm harness run unit`: passed, including the bundle prerequisite, 8,133 extension tests (40 skipped),
  1,715 webview tests (3 skipped), and shared-package suites. Vitest concurrency was bounded to four workers.
  Evidence: `artifacts/harness/2026-09-19T22-54-17-066Z-14e931de/result.json`.
- Independent catalog/policy review found no additional production regressions; completion integration: 47 passed.
- `pnpm harness run tooling`: passed, including all script tests and 429 E2E-runner unit tests (2 skipped).
  Evidence: `artifacts/harness/2026-09-19T22-45-01-039Z-5cb2c78c/result.json`.
- `pnpm harness run host`: passed on actual VS Code **1.122.1**, covering activation, modes, and LM host contracts.
  Evidence: `artifacts/harness/2026-09-19T22-47-05-270Z-a82e6ece/result.json`.

The final commit is the source boundary for `pnpm certify:managed-agents:automated`. Its deterministic certification
result is recorded in the generated `artifacts/certification/managed-agent-milestone-evidence.json`; the subsequent
scripted host acceptance result is reported with the completed task. This paragraph identifies the evidence location,
not a claim that the post-commit command has already passed.

## Compatibility boundaries

Provider history supersets retain their established declaration behavior. Plan's effective allow-list remains
read-only, and ordinary Plan catalogs exclude write tools and command management. GPT-family `apply_patch` gating
occurs before constructing a provider history superset, so a non-GPT model cannot acquire it through that path.

Historical editor schemas and executors remain available to explicit compatibility fixtures; they are not new catalog
entries or interchangeable edit-payload aliases. The retained live managed-agent playbook contains historical lifecycle
calls and is marked as requiring adaptation before live execution. This refactor does not claim live-provider quality
or performance improvements.
