# Alpha extension bug hunt

Started October 1, 2026 America/New_York / October 2 UTC at the user's request. Mode: **full-surface review**.

The target is a reliable, responsive native TypeScript extension whose applicable agent behavior converges on current
Codex CLI. This pass will inspect the executable extension, fix proven bounded defects, add missing behavior tests, and
record measured performance and remaining gaps. It is not a claim that every possible defect has been eliminated.
Preserve Alpha's execution/approval protections and bespoke skills, tickets, HTML previewer, and scheduled tasks.
Codex's sandbox, Rust/source ports, parallel runtimes, dependency upgrades, release changes, and publishing are outside
this pass.

## Shared reference and existing work

- Read the root and applicable nested `AGENTS.md` files. The user migrated the reference host to **VS Code 1.125.0**;
  preserve that migration and the retained test profile. Use pnpm 11.24.0 and Node 24.14.1.
- Current official `openai/codex` was fetched again for this pass: `cb6da58876afed3ede0ab11084f67dd5394ecb48`, committed
  `2026-10-02T01:34:23Z`. Read source and relevant upstream tests before deciding intended agent behavior. The local
  reference is `C:\Users\Luke Goblirsch\AppData\Local\Temp\codex-cli-agent-loop-review`. Read pinned files with `git show`;
  do not change its checkout or refs while other chats use it. Browse current primary documentation when contracts remain
  unclear, and record sources and deliberate divergences.
- The checkout already has extensive validated, uncommitted changes. Treat all of them as the starting implementation;
  do not reset, stash, stage, commit, or overwrite unrelated work. The new baseline patch, status, and surface inventory
  are in `C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-extreme-bug-hunt-baseline-20261002`.
- Read the recent `docs/codex-*-review-2026-10-01.md` investigations against actual code. Existing compaction deadlines,
  startup settlement, FIFO cancellation, complete tool history, follow-up queue fixes, and `.alpha` migration must survive.
- Apply `C:\Users\Luke Goblirsch\.codex\skills\clean-code-review\SKILL.md` and its change-safety, JavaScript, testing,
  comprehensive audit, end-state, and performance references. The UX lane also applies frontend and HTML references.
  The user authorizes three subagents per new chat. The lane parent reviews and integrates their work.

## File ownership

All four chats run in the existing local project. Reading every surface is allowed; editing follows this map. Explicit
exceptions take precedence over directory ownership. New tests belong to their owning production module. Do not edit
another lane's file because it is convenient. Record a precise reproduction and proposed correction under **Handoffs**
in your ledger; the coordinator will integrate shared-boundary repairs after owners finish. Do not send messages to
other chats without direct human authorization.

| Lane                    | Owning source and tests                                                                                                                                                                                                                                                                                                                                                                                                 | Focus                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core loop and providers | `src/core/agent/` except tool-policy/scheduling exceptions below; `src/api/`; `src/core/assistant-message/`; `src/core/task/Task.ts` and its existing Task tests; `src/core/task/` helpers except `WorkspaceMutationGate` and `build-tools`                                                                                                                                                                             | Turn ownership, completion, retries, streaming order/state, immutable steps, delegation, cancellation, problem-solving round trips               |
| Tools and cancellation  | `src/core/tools/`; `src/core/task/WorkspaceMutationGate.ts`; `src/core/task/build-tools.ts`; `src/core/agent/ToolScheduler.ts`, `ToolPolicy.ts`, `ExecutionProfile.ts`, `ParallelReads.ts`, `CommandOutcomeContext.ts`, `lookupToolCatalog.ts` and matching tests; `src/integrations/terminal/`; `src/core/checkpoints/`; `src/services/checkpoints/`; `src/services/mcp/`; `src/services/browser/`; `src/core/ignore/` | Tool visibility/authority, structured results, dispatch/order, command/process ownership, MCP/browser/error paths, workspace/approval boundaries |
| Persistence and context | `src/core/task-persistence/`; `src/core/context-management/`; `src/core/condense/`; `src/core/prompts/`; `src/core/mentions/`; `src/services/tickets/` except `TicketPanel`; `src/services/config-paths/`; `src/services/skills/`; `src/services/command/`                                                                                                                                                              | Atomic persistence, replay/reload, compaction, provider state, token accounting, instruction authority, tickets/skills/commands                  |
| UX and performance      | `webview-ui/`; `src/core/webview/`; `src/extension.ts`; `src/services/tickets/TicketPanel.ts` and its tests; `src/services/html-document/`; `src/services/scheduler/`; extension presentation/activation adapters otherwise unassigned                                                                                                                                                                                  | Follow-up/steering UX, multi-session projection, settings buffering, render/activation cost, focus/accessibility, bespoke presentation paths     |

The coordinator owns `packages/`, root manifests/lockfiles, workflows/scripts, `apps/vscode-e2e/`, this file, and
`control.json`. Each lane owns only its named ledger in this directory. For a new cross-lane Task regression, use a
lane-prefixed new test file instead of concurrently editing an existing Task test. For otherwise unassigned source,
inspect and record a handoff before editing.

## Review and repair standard

1. Launch three subagents for distinct surfaces inside your lane; give each exclusive file ownership and the shared
   constraints. Each must inspect current runtime callers and tests. Map coverage, data/state flow, error/stop/reload paths,
   and user-visible consequences before reporting correctness.
2. Prioritize real bugs, hangs, lost input/state, duplicated effects, authority drift, stale snapshots, leaked ownership,
   and dominant latency paths. Avoid style-only rewrites or superficial grep findings.
3. Reproduce suspected defects with controlled promises, fake clocks, adversarial ordered streams, or stable fixtures.
   When intent is unclear, create a characterization test and resolve the contract using source evidence. Do not weaken
   assertions, swallow errors, or silently discard mandatory context to pass tests.
4. Fix each clear bounded issue at its existing owner. Preserve saved/wire/public contracts and Alpha's protections.
   Keep logical patches small. Do not add competing engines or speculative caches. Preserve joined active writes and
   process effects; cancellation must not release their ownership before physical settlement.
5. Record performance workload and metric before optimizing. Compare like conditions and retain deterministic thresholds
   for meaningful metrics. Do not promote a single live success or uncontrolled wall-clock sample into a general claim.
6. Run focused tests directly after `test` without a standalone `--`, with `--maxWorkers=2` during this concurrent audit,
   then the lane's package typecheck and focused lint. Serialize broad test commands within each lane; individual focused
   reproductions may run concurrently inside that two-worker bound.
   Use only relevant tests; document any uncovered failure paths and propose concrete missing host tests.
7. Write your ledger with severity/priority, source references, fail-before evidence, changes, exact commands/results,
   coverage status (`reviewed`, `edited`, `flagged`, `not present`, `not verified`), closure status (`fixed now`,
   `flagged for follow-up`, `not verified`, `out of scope`), handoffs, and the highest remaining gaps. Preserve historical
   design notes and distinguish tests that ran from proposed tests.
8. Read `control.json` before each new edit batch. Once your lane is locally verified, mark **READY** at the top of your
   ledger, finish your turn with a concise report, and leave all edits frozen. A READY lane means ready for integration,
   not that the whole repository passed final gates.

## Shared validation ownership

Lane parents may run focused unit tests and no-output package typechecks. The coordinator serializes all builds, E2E
compilation/host launches, VSIX packaging, whole-repository tests, and certification. Lane parents must not run those
shared-output commands or live providers. Record proposed host/evaluation cases in your ledger instead.

After all four lanes are READY, the coordinator will review handoffs and final diffs, add required shared-boundary/host
coverage, run relevant consumer checks plus lint/types, and run exact-host smoke and affected core/managed-agent gates
with a frozen source tree. All automated hosts use the Alpha-owned **1.125.0** profile. Host runs and packaging remain
serial. Do not mutate documentation or reports during source-fingerprinted certification.

The prior baseline passed 2,683 managed-certification tests, both managed/five-agent host scenarios, all 12 exact-host smoke
scenarios, and VSIX verification. These are historical baseline results, not validation of future edits in this pass.

## Lanes and reports

- Core: `core-loop.md`
- Tools: `tools-cancellation.md`
- Context: `persistence-context.md`
- UX: `ux-performance.md`
- Coordination and final integration: this file and `integration.md` (coordinator only)

The four user-owned chats are:

| Lane    | Thread ID                              |
| ------- | -------------------------------------- |
| Core    | `01a0fa64-ac7f-7e50-bb45-2ca5255e829e` |
| Tools   | `01a0fa64-b5d3-7ff1-ba05-cfde76f2802e` |
| Context | `01a0fa64-ba8b-7903-95f3-b05675b3a8ae` |
| UX      | `01a0fa64-c332-71c3-ad97-cf34122a7ad0` |

All four lane handoffs are READY and frozen. Cross-layer fixes, shared verification, and remaining coverage are recorded
in [the integration report](integration.md). Inventory languages: 1,819 TypeScript files, 343 TSX,
155 JavaScript, 10 CSS, and 6 HTML, plus developer SQL/shell surfaces. Generated/downloaded caches, artifacts, binary
packages, and control-only directories were excluded from the inventory. The inventory is an audit map, not proof that
every counted file was reviewed. Evaluator database infrastructure is outside the executable-extension focus.
