# Tools and cancellation lane — READY

Edits frozen after local validation. READY means ready for coordinator integration; the shared extension typecheck
currently has cross-lane errors listed below, and exact-host gates have not run for this patch set.
Reviewed October 1, 2026 America/New_York (October 2 UTC). Mode: **full-surface review**.

## Scope and safety

Goal: strengthen native tool authority, truthful terminal receipts, cancellation, and resource ownership while preserving
Alpha's execution protections. This bounded pass improves the audited surfaces; it does not certify every tool path.
All pre-existing uncommitted work was retained. No staging, commits, reset, stash, dependency, manifest, packaging, shared
build, live-provider, or host command was performed. Task.ts and AlphaProvider.ts were read only.

Three exclusive subagents reviewed scheduler/registry, commands/process/checkpoints, and MCP/browser/ignore. The parent
reviewed their patches plus filesystem writes, stale-file contracts, and WorkspaceMutationGate. Applied clean-code-review
and its change-safety, JavaScript, testing, comprehensive-audit, end-state, and performance references. The skill inventory
helper ran; it includes downloaded `.vscode-test` files, so the coordinator's excluded-tree baseline inventory remains
the useful repository count. There are 219 test paths under the broad queried lane/core/task directories; this is a
coverage map, not a claim all were inspected or executed.

## Fixed findings

| Finding                                                                                            | Severity / priority | Fail-before evidence                                                                                 | Owning correction                                                                                                                                         | Closure   |
| -------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Approval-time `.alphaignore` revocation still permits file IO                                      | High / must-fix     | Two single/batch read regressions observed filesystem stat after approval changed access to false    | ReadFileTool rechecks access after approval/settings waits, before stat, binary inspection, content IO, or tracking; returns denied receipt               | fixed now |
| Preflight failure evidence is observed after later effects dispatch                                | High / must-fix     | Two scheduler tests each observed a subsequent mutation execute once despite prior stopping evidence | ToolScheduler observes prior preflight/retry-block receipts before next admission; observation fence failure follows failedOutcome                        | fixed now |
| MCP cleanup misses pending startup and startup publication failure leaks its constructed hub       | High / must-fix     | Readiness-held cleanup completed early; failed globalState publication disposed hub zero times       | McpServerManager joins initialization, serializes cleanup/acquisition, publishes only after readiness/state storage, disposes failed unpublished hub      | fixed now |
| Terminal command-start OSC marker split across chunks loses output and reports missing integration | High / must-fix     | All 14 split-position cases failed before fix for OSC 633/133 BEL markers                            | TerminalProcess retains at most seven possible marker-prefix characters while waiting for first start marker                                              | fixed now |
| Unchanged-content patch move reports success without moving                                        | Medium / should-fix | Direct and diff-view cases never asked approval and never saved destination                          | ApplyPatchTool treats a distinct move path as an effect even when content diff is empty; existing approval/source/destination checks remain authoritative | fixed now |
| Rejected alias registration retains callable descriptor and partial aliases                        | Medium / should-fix | Two descriptor/alias collision tests found rejected tool still registered and clean retry impossible | ToolRegistry validates all alias collisions before publishing descriptor/aliases                                                                          | fixed now |

Incremental production/test edits are limited to ToolScheduler and its spec, ToolRegistry and its spec, TerminalProcess
and its spec, McpServerManager and its spec, ApplyPatchTool and its spec, and ReadFileTool and its spec. Existing earlier
scheduler completion preservation and terminal closure fixes remain in the checkout and were not replaced.

## Source evidence and preserved contracts

Pinned official Codex CLI: `cb6da58876afed3ede0ab11084f67dd5394ecb48`, read with `git show` from the shared reference.

- [tools/parallel.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/parallel.rs): dispatch admission and completed lifecycle/cancellation tests. Alpha retains joined physical effects, stable call IDs, ordered receipts, and exactly-once publication.
- [tools/registry.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/tools/registry.rs): collision checks and structured failed/executed outcomes. Alias fix implements atomic registration in Alpha's current Map-based registry.
- [apply-patch/src/lib.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/apply-patch/src/lib.rs) and `tests/fixtures/scenarios/004_move_to_new_directory/patch.txt`: updates carry move effects independently of content output. Alpha preserves its stricter approval and stale-source/destination protections.
- [unified_exec/process_manager.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/unified_exec/process_manager.rs) and `tests/suite/unified_exec.rs`: output deadline, early-exit notifications, managed-command interruption/termination. Shell parsing correction is a VS Code adapter requirement.
- [mcp_refresh_cleanup.rs](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/mcp_refresh_cleanup.rs), `session/mcp_refresh.rs`, MCP handlers/exposure tests: retained manager ownership and cleanup. Implemented with Alpha's existing TypeScript singleton architecture.
- [VS Code 1.125.0 declaration](https://github.com/microsoft/vscode/blob/1.125.0/src/vscode-dts/vscode.d.ts): TerminalShellExecution.read supplies raw AsyncIterable strings with no guaranteed escape-sequence chunk boundaries. No new host API was introduced.

ReadFile ignore revalidation follows Alpha's own workspace security contract; Codex sandbox architecture is outside
alignment scope. No Rust, upstream runtime source, wholesale prompt, or competing execution engine was introduced.

## Validation actually run

Fail-before commands/results:

- `pnpm --dir src test core/tools/__tests__/ApplyPatchTool.spec.ts -t 'moves unchanged content'`: 2 expected failures, missing approval.
- `pnpm --dir src test core/tools/__tests__/readFileTool.spec.ts -t 'rechecks ignore access' --maxWorkers=2`: 2 expected failures, forbidden IO occurred.
- Scheduler controlled regression selection: 2 expected failures, later mutation executed; registry collision selection: 2 expected failures, rejected registration retained state.
- `pnpm --dir src test integrations/terminal/__tests__/TerminalProcess.spec.ts -t 'command start marker is split'`: 14 expected failures.
- `pnpm --dir src test services/mcp/__tests__/McpServerManager.spec.ts`: 2 failed, 1 passed before repair.

Final focused checks (counts overlap and must not be summed into a unique-suite claim):

```sh
pnpm --dir src test core/tools/__tests__/readFileTool.spec.ts core/tools/__tests__/readFileTool.pagination.spec.ts core/tools/__tests__/ApplyPatchTool.spec.ts core/task/__tests__/WorkspaceMutationGate.spec.ts --maxWorkers=2
```

**127 passed, four files**, repeated after touched-file formatting. Includes approval cancellation/denial, dirty/stale
source/destination moves, real direct/diff saves, file bytes, and queued/active mutation ownership.

Scheduler spec: **113 passed**. Adjacent ToolRegistry, TaskToolSurface, validateToolUse, ToolPolicy, ExecutionProfile,
CommandOutcomeContext specs: **92 passed, six files**, maxWorkers=2.

```sh
pnpm --dir src test integrations/terminal core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts core/tools/__tests__/commandTimeouts.spec.ts core/checkpoints/__tests__/checkpoint.test.ts services/checkpoints/__tests__/checkpoint-cancellation.spec.ts --maxWorkers=2
```

**218 passed, 12 existing skips; 16 passed files, one skipped.** Earlier targeted TerminalProcess spec/test and
TerminalOutputReceipt selection: 64 passed; post-format TerminalProcess spec: 40 passed. Includes real Execa process-tree
integration, closure/drain ownership, retryable taskkill, checkpoint deadlines and serialized cancellation.

```sh
pnpm --dir src test services/mcp/__tests__/McpServerManager.spec.ts services/mcp/__tests__/McpHub.spec.ts services/browser/__tests__/VSCodeBrowserTools.spec.ts core/tools/__tests__/McpResourceTools.spec.ts core/tools/__tests__/accessMcpResourceTool.spec.ts core/tools/__tests__/useMcpToolTool.spec.ts core/tools/__tests__/VSCodeBrowserTool.spec.ts core/ignore/__tests__/AlphaIgnoreController.spec.ts core/ignore/__tests__/AlphaIgnoreController.security.spec.ts --maxWorkers=2
```

**267 passed, nine files.** Four manager regressions cover readiness-held cleanup, publication failure, readiness failure,
and new acquisition during shared cleanup.

Focused ESLint passed for all twelve touched TypeScript files (subagent checks plus parent filesystem selection).
Touched-file formatting and `git -c core.whitespace=cr-at-eol diff --check` passed. No generated or unrelated artifact
edits were introduced by this lane.

`pnpm --dir src check-types` **ran and failed** on concurrent cross-lane fixtures:
AgentResponseFoundation.spec.ts:406/419, AgentTurnEngine.spec.ts:86, Task.spec.ts:4820 lack new ApiStreamOutcomeChunk
terminal/semanticOutputObserved fields; services/command/**tests**/command-precedence.spec.ts:28 has incompatible
Dirent<Buffer> fixture cast. No tools-lane diagnostic was reported. Coordinator must repair/recheck after integration.

Exact VS Code 1.125.0 smoke, whole-repo gates, managed certification, builds, packaging, and live transports are **not
verified here**, reserved for coordinator. Required integration smoke remains
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`.

## Coverage and remaining gaps

| Surface                                                  | Coverage         | Closure / remaining risk                                                                                                                                      |
| -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler/registry/policy/surface/status/ordered results | reviewed, edited | Two bounded fixes; remaining denied-vs-error status compatibility discrepancy flagged for follow-up                                                           |
| Terminal/process/commands/checkpoints                    | reviewed, edited | Marker fix; closure/drain/timeout and queue tests ran; remote/live-shell host behavior not verified                                                           |
| MCP/browser/ignore/resources                             | reviewed, edited | Manager fix; live reconnect/watchers after direct hub disposal not verified                                                                                   |
| WorkspaceMutationGate                                    | reviewed         | Existing FIFO cancellation, active-effect join, listener cleanup and Plan admission coverage passed; no edit                                                  |
| Filesystem writes/stale state/read approval              | reviewed, edited | Move and ignore revalidation fixes; full adversarial symlink replacement during IO not verified                                                               |
| Tool partial-preview singleton state                     | flagged          | Shared mutable state exists but active streaming tool reachability is not verified; presentAssistantMessage currently projects text, so no speculative repair |
| ParallelReads.ts                                         | not present      | No file to audit; current scheduler/command read abstractions inspected                                                                                       |
| Other tools/delegation/tickets/full host policy          | not verified     | Outside deep inspection in this bounded lane; tests selected above are not full tool coverage                                                                 |
| Packages/manifests/release infrastructure/Codex sandbox  | out of scope     | Coordinator ownership / explicitly excluded alignment target                                                                                                  |

Performance: no optimization or generalized speed claim. Tests establish bounded seven-character marker carry and
deterministic effect suppression/resource cleanup; no like-for-like latency/token/memory benchmark was made. Test-run
durations reflect environment/cache contention, not product performance.

## Handoffs and highest-priority follow-ups

1. **High, must-fix; AlphaProvider owner / coordinator.** `AlphaProvider.ts` near 763 starts
   `getInstance().then(hub => { this.mcpHub = hub; hub.registerClient() })` with no disposed/startup guard; dispose near
   1197 only unregisters current mcpHub. Controlled reproduction: hold hub readiness, dispose provider, release readiness;
   closed provider registers and refCount remains retained. Retain startup ownership, join/guard late publication, never
   register a disposed client, release an unused hub safely. Manager cleanup repair does not close this provider race.
2. **High risk, not verified; command operational-hardening follow-up.** Execa generic output/callback error path
   fabricates shell exit 1 and clears subprocess without confirmed physical settlement. Add a controlled reader failure
   while process stays alive, assert mutation ownership retained through actual exit, then repair at process owner.
   TerminalProcess preOutput is also unbounded before marker detection and embeds/logs full inspection on missing marker;
   bound diagnostic retention with targeted tests while preserving process ownership.
3. **Not verified; MCP operational-hardening follow-up.** Test reconnect/watchers/dispose with held transports; oversized
   MCP/browser payload preprocessing and UI publication can occur before scheduler output cap. Existing pagination caps
   pages/items, not bytes. Source-less resource approval is an ambiguity/risk only, not a demonstrated bypass: canonical
   dispatch uses selected source and global resource autoapproval currently follows alwaysAllowMcp.

Additional contract handoff: direct `resolveExecutionProfile("custom-mode")` selects Work while saved unknown modes are
required to resume Plan; normal build-tools restores unknown modes first. Characterize every direct capture caller
before narrowing that contract. Policy denials sometimes intentionally test `error`; reconcile consumers/history before
changing terminal status. Shared typecheck fixture diagnostics above need owning-lane integration repairs.

Recommend another bounded operational-hardening pass focused on provider disposal/startup ownership and physical
Execa/MCP settlement, after coordinator integration and frozen-source exact-host gates.
