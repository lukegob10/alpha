# NOR-30 implementation evidence

## Contract and scope

This is a bounded **contract alignment** change for [NOR-30](https://linear.app/norval/issue/NOR-30/remove-legacy-tool-execution-from-assistant-message-presentation), retrieved from Linear on 2026-09-04. The intended end state is a preview-only assistant presenter, with execution coverage on the captured TaskToolSurface, ToolRegistry, and ToolScheduler path. No latency improvement is claimed.

Worktree: `C:/Users/Luke Goblirsch/.codex/worktrees/da53/Alpha-Code`. Branch: `codex/nor-30-preview-only`. Baseline: `0de6860f6d9b7b9d64c3b377c57ebecc016e46a3`. The initially detached project-default checkout (`745e1e2`) was clean; the orchestrator explicitly authorized creating this branch from the required baseline. No source edits preceded that correction.

Read and applied the worktree AGENTS.md and the full, user-authored `F:/roo-fork/Alpha-Code/AGENTS.md` without modifying either. Applied clean-code-review and its change-safety, end-state, JavaScript, testing, and frontend references. Review scope is presentation, its callers, execution-test migration, and the existing batch-isolation boundary; it is not a repository-wide audit.

## Baseline caller and ownership audit

- **Active runtime:** Task.scheduleStreamingPreview is the sole extension caller of presentAssistantMessage. It passes `executeTools: false` and an epoch. Task separately persists canonical responses before invoking its serial ToolScheduler with a captured TaskToolSurface and a before-effect transcript fence.
- **Active runtime:** presentation locking, queued late text updates, epoch checks, and text tag filtering. Reasoning presentation remains in Task's streaming adapter; the presenter handles text and skips native/MCP tool blocks.
- **Dormant/test-only:** the presenter's execution handlers, approval wrapper, execution error recovery, mutation/checkpoint helpers, and batchable-agent helper. The only production assignment setting didAlreadyUseTool is inside the dormant missing-ID execution branch. Its Task reset and streaming interrupt can be removed.
- **Test-only assumption:** nativeToolDispatchContract reads the dormant switch as proof of production dispatch. Replace it with captured-surface/registry assertions and scheduler integration.
- **Active safety:** Task rejects mixed new_task/attempt_completion before assistant persistence; ToolScheduler independently rejects registry barrier descriptors before any effect. Do not remove the early safety boundary. Consolidate the decision source on captured registry descriptors, extending early rejection to equivalent registered barriers and preserving scheduler preflight.

## Implemented changes and ownership

1. `presentAssistantMessage.ts` now only renders text and advances past tool blocks, including partial, unknown, custom, and MCP calls. Removed the execution option, handlers, approvals, recovery, checkpoints, execution-only imports, and hardcoded batch helpers. Preserved the export, preview epoch fencing, lock ownership, late partial/final updates, cancellation, and text tag filtering. Presentation errors remain presentation errors; they cannot synthesize an execution result.
2. `Task.ts` invokes the presenter with only its epoch. Removed the obsolete `didAlreadyUseTool` field/reset/stream interrupt and comments describing presenter execution. Task remains the streaming/reasoning adapter and persists the canonical assistant response before scheduler effects.
3. `ToolScheduler.ts` exposes one registry-derived isolation query shared with Task's pre-persistence check. All registered barriers, including aliases and disabled/malformed barrier calls, reject mixed batches before effects. No hardcoded second barrier list remains in presentation. The orchestrator approved these shared Task/scheduler changes; NOR-25 is not active.
4. Task stages deterministic mixed-barrier error receipts before persistence, then always invokes the canonical scheduler. The existing Task deduplication and lifecycle publisher retain one result per call. This preserves scheduler event recording instead of bypassing that path for rejected batches. If cancellation arrives after early staging, the invalid calls retain their error receipts and the enclosing scheduler outcome is aborted. The orchestrator explicitly approved this precedence; valid batches retain their prior cancellation behavior. No tool descriptor capabilities, schemas, policy, execution mode, completion behavior, or persistence architecture changed.
5. Replaced dormant executor and source-text dispatch assertions with captured-surface/registry/scheduler integration. Protected CLI/shim trees, dependency versions, release metadata, selective parallelism, environment collection, compaction, and completion/verification redesign remain outside this change.

Two explicitly authorized Luna Max agents handled nonoverlapping test work: the three custom/image/unknown executor specs and a new dedicated preview spec. Sol Max owns production edits, native pipeline migration, barrier integration, review, and final judgment.

## Coverage and limits

| Boundary                      | Evidence                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preview cannot execute        | Dedicated preview cases assert no effects, approval, registry lookup, result mutation, or error recovery for native/MCP/custom/unknown and partial tool blocks.                                                                                                                                                                                  |
| Streaming lifetime            | Preview tests retain the original late-microtask characterization, partial/final ordering, queued updates, serialized rendering, stale epoch and lock ownership, cancellation, and rendering failures. Existing Task tests cover reasoning and preview drain/coalescing.                                                                         |
| Native execution              | Native raw chunks are projected for preview and independently accumulated into canonical calls. Actual registry/scheduler dispatch preserves typed arguments and IDs, serial settlement, lifecycle order, superseded/denied/cancelled approvals, exactly-once output, failure status, and private-path redaction through Task's result boundary. |
| Real tool leaves              | Custom registry definitions, AskFollowupQuestionTool, and UseMcpToolTool run through the captured surface and scheduler. Provider/MCP host I/O is mocked. Coverage includes custom experiment gating, task lane mode, user/MCP images and feedback, and denial before hub calls.                                                                 |
| Isolation and durable results | Six barriers are checked in both positions with ordinary and MCP alias calls. Six actual Task stream cases verify early staging followed by scheduler events. Six persistence cases check wait/switch/follow-up rejections, cancellation, ordered assistant/user writes, flush deduplication, reload, and lifecycle replay.                      |
| Dispatch authority            | Native schema contract assertions resolve callable descriptors from the captured registry instead of reading the removed presenter switch. Existing registry, surface, scheduler, parser, engine, and completion suites remain part of the regression gate.                                                                                      |

The migration follows existing production behavior rather than reproducing dormant implementation details: the collector retains its first output and marks a later handler failure as an error, Task redacts result content, and custom usage telemetry records the actual custom tool name. Removed legacy mistake counters and appended-error behavior were not added to the scheduler.

The baseline default validator accepts `mcp__server__tool` but rejects the canonical `mcp--server--tool` spelling even though both resolve to one registry descriptor. NOR-28 owns that validation fix. NOR-30's real MCP execution/denial tests use the accepted alias without bypassing validation; both spellings retain registry-resolution coverage. Only deliberately synthetic fixture descriptors use the scheduler's `validateCall` injection: duplicate-output and custom-barrier cases in `nor30-custom-and-errors.spec.ts`, and empty-output and approval-denial cases in `nor30-images-and-permissions.spec.ts`. No production MCP validation changes are included here.

If a Task has no captured surface, its existing canonical execution guard still fails closed. This change does not manufacture a surface during execution. Filesystem persistence and provider/MCP transport remain mocked in unit/integration suites; exact extension-host smoke belongs to the combined integration gate.

## Validation ledger

- Toolchain verified: Node 20.19.2 and pnpm 10.8.1.
- Dependency installation: `pnpm install --frozen-lockfile` completed in this worktree. No dependency or lockfile changes and no shared mutable node_modules. Initial baseline collection could not resolve the unbuilt local types package; `pnpm exec turbo build --filter=@alpha-code/types --filter=@alpha-code/core --filter=@alpha-code/telemetry --log-order=grouped --output-logs=errors-only` supplied that prerequisite.
- Baseline focused tests: **9 files, 210 tests passed**, using the three old presenter execution specs, native pipeline, ToolScheduler, TaskToolSurface, native dispatch contract, Task, and isolation suites with `--maxWorkers=2 --minWorkers=1`.
- Post-change focused regressions: **4 files, 91 tests passed** (preview, native pipeline, isolation, and Task persistence). The original late-microtask characterization initially exposed early presentation-promise settlement; retaining the partial-block pending-update check fixed it. Native migration initially exposed an invalid Plan-profile fixture and an uncleared one-shot mock; tests now use the captured Work profile and reset mocks without changing policy.
- Broader regression: **12 files, 375 tests passed** with the command below.
- Final custom/MCP/image/permission/unknown migration verification: **3 files, 18 tests passed**; focused ESLint passed. Alongside the broader gate, this covers **393 tests across 15 distinct files**.
- `pnpm --dir src check-types`: passed, including final verification after test cleanup.
- `pnpm --dir src lint`: passed, including final verification after test cleanup.
- Changed-file Prettier and `git diff --check`: passed. Only owned hunks remain in Task and ToolScheduler.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`: pending orchestrator's combined host gate; not run concurrently here.

```powershell
pnpm --dir src test -- core/assistant-message/__tests__/presentAssistantMessage-preview.spec.ts core/assistant-message/__tests__/spawn-agent-native-pipeline.spec.ts core/assistant-message/__tests__/NativeToolCallParser.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/ToolScheduler.spec.ts core/tools/__tests__/ToolRegistry.spec.ts core/tools/__tests__/TaskToolSurface.spec.ts core/tools/__tests__/nativeToolDispatchContract.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/Task.persistence.spec.ts core/task/__tests__/new-task-isolation.spec.ts --maxWorkers=2 --minWorkers=1
```

## Acceptance and closure

Local implementation, migrated execution coverage, and the production-path regression gate are complete. This branch contains only NOR-30 changes and is ready for integration review. Exact-host validation and integration/release actions remain with the orchestrator. No push, PR, merge, or release action is authorized for this worktree.
