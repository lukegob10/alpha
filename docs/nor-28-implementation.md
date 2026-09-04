# NOR-28 implementation and evidence

## Scope and baseline

Performance optimization of the effective provider tool catalog. The intended end state is a deterministic cached core
surface, bounded discovery of permitted large MCP catalogs, and execution through the existing registry and scheduler.
This is a focused Stage 1 change; scheduling, approval policy, preview dispatch, environment collection, compaction policy,
persistence formats, completion, CLI/shim, versions, and dependencies are outside its ownership.

- Worktree: `C:/Users/Luke Goblirsch/.codex/worktrees/e3f1/Alpha-Code`
- Branch: `codex/nor-28-tool-catalog`
- Baseline: `0de6860f6d9b7b9d64c3b377c57ebecc016e46a3`, verified ancestor before edits.
- The app initially created an obsolete detached checkout. The orchestrator authorized a clean, non-destructive switch
  to the baseline and ticket branch. No changes were discarded.
- Current Linear NOR-28 was retrieved on 2026-09-04 and matches the assigned description and acceptance criteria.
- Read both worktree AGENTS.md and the uncommitted repository guide at `F:/roo-fork/Alpha-Code/AGENTS.md`; neither is edited.
- Applied clean-code-review in performance optimization mode. Read its change safety, end-state, JavaScript, testing,
  performance, and frontend references. No frontend redesign is in scope.

## Revalidated source and design

`build-tools.ts` reconstructs native schemas, dynamic MCP schemas, registry descriptors, policies and frozen surfaces on
each invocation. Its compatibility wrapper returns the pre-capture array rather than the final policy-filtered schemas.
`TaskToolSurface` already seals the canonical registry and freezes schemas. `ToolScheduler` checks captured policy before
dispatch; discovery must preserve that path. The generic `use_mcp_tool` fallback is absent from production native schemas
and will remain unavailable. Its legacy handler is not a per-tool policy boundary.

The pinned [Codex tool-search implementation](https://github.com/openai/codex/blob/a7ab2d66d781b903cb060288a89e26e8d2b9a05f/codex-rs/core/src/tools/handlers/tool_search.rs)
was inspected on 2026-09-04. It derives discovery entries from the registry and invalidates its handler cache when source
metadata changes. Alpha will use the existing ordinary-function provider contract and its own captured policy ceiling.

The orchestrator approved the following bounded contract:

1. Add ordinary `discover_tools({query, limit?})`, with bounded validated arguments/results, only for large permitted MCP
   catalogs. The stable native core stays eager. Discovery is local and uses the existing ToolRegistry/ToolScheduler.
2. Search the sealed permitted catalog captured for the step. Return a bounded versioned result containing full function
   schemas and name/schema-digest references. Lookup never mutates authority or queues pending selections. Derive at most
   32 selections from successful paired persisted calls/results at the next real model step. Direct, alias and generic
   bypass attempts in the current response remain unavailable.
3. Intersect selections with current mode, policy, child allow-list, connection and schema at every new step. Preserve
   immutable in-flight surfaces and existing transport/rate-limit retry reuse.
4. Keep one full and one projected capture per Task. Key reuse on effective filtering/policy/profile, native schema
   version, MCP connection identity/status/capabilities/schema, custom executable/schema, and provider transformation.
5. Keep eager ordinary schemas for VS Code LM and eager historical superset plus callable names for Gemini/Vertex.
   Their superset retains the ordinary `discover_tools` declaration for provider-switch history compatibility, while
   excluding it from callable names. The historical-only descriptor fails closed even if invoked directly.
6. Restore bounded discovery selections from successful paired canonical tool transactions in existing task history.
   Scan at most 512 messages with at most 128 blocks each. Results are capped at 24,000 characters, each search returns
   at most five tools (three by default), and query length is 1–256 trimmed characters. Arbitrary result-like text cannot
   restore selections. Still-valid selections survive context resets; reload uses existing history with no format change.
7. Preserve original MCP server/tool names and source as host-owned execution metadata. Use the existing approval and
   shared MCP handler, rechecking original target/source, current client/connection and normalized schema after approval
   and after UI/status waits, immediately before synchronous client dispatch. The model gains no source override.
8. Cancel the catalog caller promptly while observing shared custom-loader completion or failure. A cancelled build
   never publishes a cache entry, and the shared loader remains available to other tasks.

Owned files are native/MCP schema construction, build-tools, TaskToolSurface/ToolRegistry integration, bounded catalog
helpers, required tool enum/parser consumers, and focused tests. Task.ts changes are restricted to a cache field and the
actual request catalog build near baseline line 9383, including its existing interruption signal. The orchestrator reserves captureAgentStep and final request-wire
projection for retry consistency. No concurrency/capability changes are planned.

## Measurement and validation plan

Capture raw native catalog size separately from effective provider schema bytes. Use the real build/filter/capture path
with no-MCP, small-MCP, large-MCP, mode-restricted, disabled, child and disconnected fixtures. Measure transformed ordinary,
Anthropic and Gemini/Vertex schemas. Label local tokenization separately from actual billed model input usage.

Matched scripted core-only and optional-tool workflows must report initial/cumulative schema bytes, local token counts,
discovery/model round trips, lookup/build wall time and outcome. Include the extra discovery turn rather than treating
prompt savings as an automatic latency improvement.

Focused regressions will cover determinism/cache reuse; policy/connection/schema invalidation; immutable in-flight
contracts; successful next-step execution; failed/empty/cancelled discovery; forbidden direct/alias/generic calls; Plan
mode and child bounds; reload/task isolation; and provider fallback. Run touched-package lint/typecheck and focused tests.
The orchestrator owns the combined exact VS Code 1.122.1 host gate; this worktree does not claim that gate passed locally.

## Evidence ledger

- Baseline source and toolchain inspected: Node 20.19.2, pnpm 10.8.1.
- `pnpm install --frozen-lockfile`: passed, without shared mutable node_modules. Built workspace types with the existing
  Turbo build task; the first test attempt correctly identified missing generated type entrypoints before that build.
- Baseline focused regressions: 5 files / 30 tests passed (TaskToolSurface, ToolRegistry, native-tools-filtering,
  mcp_server and build-tools-spawn-agent).
- Added characterization: `tool-catalog-policy.spec.ts` failed for canonical `mcp--...` validation and the pre-capture
  schema return mismatch; the underscore alias control passed. These assertions will remain regression coverage.
- Initial effective baseline command: `pnpm --dir src test -- core/task/__tests__/tool-catalog-measurement.spec.ts -t 'records no-MCP' --silent=false`.
  The 48-tool synthetic MCP catalog uses real filtering, schema normalization and policy/registry capture. No live model
  was called. Native MCP ordering was already normalized; this changes order, not payload schema size.

| Baseline fixture       | Raw native bytes | Effective ordinary bytes | Effective local token estimate | Anthropic bytes | Gemini/Vertex projection bytes | Build cold/warm ms |
| ---------------------- | ---------------: | -----------------------: | -----------------------------: | --------------: | -----------------------------: | -----------------: |
| Core only (23 schemas) |           60,190 |                   37,810 |                         12,356 |          36,863 |                         50,846 |     13.236 / 9.111 |
| Core + 48 MCP schemas  |           60,190 |                  221,182 |                         69,566 |         218,843 |                        234,814 |  326.500 / 452.139 |

Token estimates use the repository's `o200k_base` tokenizer with its 1.5 adjustment on serialized JSON, excluding actual
provider framing/billing. The raw native catalog estimate is 19,355. Initial wall times are single samples, not a speed
claim. Matched repeated before/after workflow measurements remain required. The conservative deferral threshold is at
least 8 individually discoverable MCP schemas and 16,000 effective schema bytes; small catalogs avoid the discovery RTT.

## Characterized correctness fixes

- The baseline accepted `mcp__...` at runtime but rejected the model-visible canonical `mcp--...` spelling. Both now pass
  the existing mode validation, while Plan still rejects MCP. The provider-facing array now equals the captured surface.
- An explicitly empty schema projection previously fell back to the full registry. It now remains empty and uncallable.
  Registry descriptors are frozen as well as their schemas and capability metadata.
- Controlled post-approval UI waits reproduced five stale MCP effects and one effect after cancellation. The final
  synchronous dispatch guard prevents them and preserves scheduler `cancelled` status when cancellation wins.
- With both `lookup-one` and `lookup_one` present, the legacy first fuzzy match invoked policy-disabled `lookup-one`
  through the allowed `lookup_one` descriptor. Exact names now win. Captured original target/source metadata also fixes
  project/global validation and dispatch mismatches and preserves the deterministic winner of sanitized-name collisions.
  Tests execute the real MCP handler and `McpHub.callTool`, mocking only client transport requests. Connected schemas
  win over disconnected historical schemas when sanitized names collide.
- The custom load cancellation regression timed out after 20 seconds before the fix. Both late resolution and late
  rejection now leave the cancelled caller closed with all abort listeners removed and no cache publication.
- Invalid discovery arguments throw into the existing scheduler error path: result status is `error` with `is_error:true`.
  Empty valid searches succeed; cancellation is `cancelled`; failed, truncated, unpaired and malformed history cannot
  activate tools. No scheduler implementation or concurrency/capability classification was changed.
- Independent integration review reproduced a history/declaration mismatch when switching after a successful discovery
  to Gemini or Vertex. Both retain the historical discovery declaration now, without making discovery callable. This is
  outgoing catalog/history contract evidence, not an observed remote-provider rejection.

## Matched local workflow measurements

The committed fixture uses the real catalog builder, surface, registry and scheduler, with a synthetic MCP response.
The same selected MCP function, arguments, approval path and returned text/status are compared. The deferred cold path
includes discovery, the persisted call/result pair, the next model catalog, and execution. The warm path reuses the
already-promoted surface. Counts below describe serialized ordinary function schemas and separately serialized results;
they exclude provider message framing, unrelated prompt/history text, network latency and live model generation.

| Large catalog workflow | Schema requests | Cumulative schema bytes | Schema token estimate | Extra discovery result bytes / estimate | Extra model rounds | Local end-to-end ms |
| ---------------------- | --------------: | ----------------------: | --------------------: | --------------------------------------: | -----------------: | ------------------: |
| Eager cold             |               1 |                 221,182 |                69,566 |                                   0 / 0 |                  0 |             214.947 |
| Deferred cold          |               2 |                  80,734 |                26,315 |                           4,475 / 1,472 |                  1 |             251.308 |
| Eager warm             |               1 |                 221,182 |                69,566 |                                   0 / 0 |                  0 |             234.382 |
| Deferred warm          |               1 |                  42,281 |                13,757 |                                   0 / 0 |                  0 |              11.619 |

The initial deferred request is 38,453 bytes (82.6% smaller). Including both deferred schema requests and its discovery
result gives 85,209 bytes versus 221,182 eager schema bytes, a 61.5% reduction before common result/framing costs. The
corresponding local token estimate falls 60.1%. These are deterministic scripted payload comparisons, not model quality
or billed-input measurements. Wall times are individual local samples and remain sensitive to machine load and JIT;
the extra model round can dominate cold-path latency on a real provider. No live latency improvement is claimed.
This final local sample also shows higher cold-path preparation cost for deferral; the payload and warm-cache gains
must be assessed alongside that cost rather than treated as a universal speedup.

The denied initial direct call produced scheduler `error` and no synthetic effect. Gemini's eager fallback retained
235,372 effective schema bytes with historical discovery declared but unavailable and permitted direct execution succeeding. Gemini/Vertex
projection measurements mirror the existing `parametersJsonSchema` and callable-name adapter shape in the fixture;
ordinary/Anthropic measurements use captured schemas and the production Anthropic converter.

Core-only matched workflows retain the identical 23 schemas (37,810 bytes; 12,356 local token estimate), one logical
tool round, no discovery and equivalent successful read results (35 result bytes; 14 local token estimate). Individual
local eager cold/warm samples were 4.346 / 3.902 ms; cached cold/warm samples were 8.261 / 1.017 ms. The cold sample includes
the cache's initial capture cost. Only the native read handler's effect was synthetic, with builder/registry/scheduler
unchanged; these samples carry the same live-latency limitations as the MCP workflow.

## Final local validation

- Frozen-lockfile dependency installation and types build: passed.
- Full extension and types lint: passed; later changed MCP/cache/parser files also pass focused ESLint.
- Extension, types and webview typechecks: passed.
- Focused parser, surface, policy, registry, MCP handler, scheduler and catalog regressions: 12 files / 232 tests passed,
  including provider-switch additions from independent review.
- Effective-catalog and matched core/MCP workflow fixture: 4 tests passed.
- Shared discovery schemas: 14 tests passed.
- `git diff --check`: clean.
- Exact VS Code 1.122.1 host gate: owned by the orchestrator after combined integration; not run or claimed in this worktree.
- No push, PR, merge, dependency/version change, or primary-checkout AGENTS.md edit is part of this handoff.

Reproduce the matched measurement record with
`pnpm --dir src test -- core/task/__tests__/tool-catalog-measurement.spec.ts --no-silent`.
The final recorded sample ran on 2026-09-04 at 00:33 local time with all four assertions passing. The broad regression
run used the cache, policy, invalidation, TaskToolSurface, ToolRegistry, useMcpToolTool, ToolScheduler, NativeToolCallParser,
tool-discovery-parser, native-tools-filtering, build-tools-spawn-agent and mcp_server spec files. Shared schemas use
`pnpm --dir packages/types test -- src/__tests__/tool-discovery.test.ts`.
