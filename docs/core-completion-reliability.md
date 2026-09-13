# Core completion reliability (NOR-47, NOR-48, NOR-51)

## Priority and research, September 11, 2026

The user's priority is fewer failed tasks and better resolution of medium and hard work. Continue NOR-56's productive
progress repair, then NOR-51's child completion, NOR-49's Copilot-only actual-model edit tools, and NOR-38's recovery guidance. NOR-48
measures the interventions. Manual reasoning controls (NOR-44/45) and optional work levels (NOR-39) are deferred from this
increment. Keep independent interventions attributable; do not treat fewer calls as correct completion.

Inspected the public Codex CLI source at commit `4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042`:

- [Turn sequencing](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/core/src/session/turn.rs)
  derives continuation from model/tool follow-up and pending input. Stop hooks can supply a concrete continuation.
- [Child status](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/core/src/agent/status.rs)
  derives successful completion from the turn event and preserves its final assistant message; error and interruption
  remain separate statuses.
- [Mailbox waits](https://github.com/openai/codex/blob/4dcce4f0c47e0183e4b05ffcbb38b4fffb8b8042/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)
  use a deadline and distinguish mailbox activity, steering, and timeout. A successful wait need not mean work finished.

[Cursor's headless CLI documentation](https://cursor.com/docs/cli/headless), retrieved September 11, 2026, exposes final
answers separately from streamed assistant text and tool start/completion events. This is a useful public contract for
observation, not evidence of Cursor's private internal stopping algorithm or comparative solve rate.

Application to Alpha: use concrete pending work and canonical completion gates, preserve final answers as results, and
avoid demanding a tool solely to produce a terminal format. This is an adaptation to Alpha's existing architecture, not
a copied engine or a claim that upstream designs alone improve live model capability.

## NOR-51 implementation

Baseline Alpha commit: `2f8eb34a5cd4092676dc79a11b06430cb37d5288`; the working branch also contains NOR-56's first repair.
The new streamed-child regression failed before the NOR-51 edits: a valid answer triggered a second provider request.
The candidate completes that same fixture in one request, emits one completion event, and preserves the final report.

`Task` now admits primary and managed-child text as completion candidates. Both use the existing completion gate,
presentation, persistence barrier, finalizer, and lifecycle event. Managed children skip the primary review ask because
their parent owns review. `ClineProvider` retains its existing result publication, Worker quarantine, mailbox, and parent
verification machinery. No synthetic completion tool call, new wire item, or alternate publication engine is introduced.

Queued content and steering take precedence. Required verification, active descendants, outstanding results, enabled todo
policy, and cancellation retain their existing gates. Empty or failed responses cannot become successful text completion.
An explicit `attempt_completion` remains available, including its structured blocked outcome. Ordinary final text denotes
a completion candidate; models should use the explicit blocked outcome for unresolved constraints. Child prompt sections
and the frozen delegation instructions now agree with that contract.

Focused tests cover the streamed request boundary, recoverable rejection, pending guidance, late queued input, cancellation,
persistence failure/retry, and primary/child gate equivalence. The existing managed-agent host acceptance now emits ordinary
text for its three Workers and retains explicit root completion. Its nested Apply, parent verification, discard, mailbox
consumption, and history navigation assertions exercise the real result consumers.

## NOR-48 baseline preparation

Selection: [core-completion-v1.json](../evals/subsets/core-completion-v1.json). These are existing visible fixtures and
graders from `evals/frontier-v1.yaml`, selected before measuring a candidate:

| Task                         | Catalog difficulty | Purpose                                                      |
| ---------------------------- | ------------------ | ------------------------------------------------------------ |
| repo-cache-invalidation      | challenging        | Dependency reasoning while preserving unrelated cached state |
| repo-stream-backpressure     | frontier           | Async control flow, concurrency bounds, cancellation         |
| repo-workspace-package-order | challenging        | Dependency ordering and explicit cycle resolution            |
| repo-concurrent-file-lock    | challenging        | Ownership-aware recovery and safe release                    |
| repo-transaction-outbox      | challenging        | Atomic changes and crash recovery semantics                  |

Use three scored attempts per task per fixed provider/model configuration: 15 attempts for each baseline/candidate role.
The existing targeted campaign accepts this task-ID list and an explicit iteration count. Do not change the complete
suite's repetitions or grader identity for a subset run. Catalog difficulty/topology labels are selection metadata, not
proof these compact fixtures represent full production repositories or all medium/hard work.

The existing command can validate selection and calculate a reservation without running a model:

```sh
pnpm --filter @alpha-code/evals benchmark:estimate --tier t4 --tasks-file ../../evals/subsets/core-completion-v1.json --iterations 3
```

This is preparation only. `packages/evals/src/benchmark/modelCampaign.ts` hardcodes CLI execution and supports only
`openai-native` and `openrouter`; the campaign also hardcodes requested High reasoning. It cannot supply the requested
Copilot VS Code LM / Vertex extension comparison. The VS Code E2E campaign has scripted/live-Copilot scenarios, but no
Vertex provider or frontier task-list adapter. Do not silently run the protected CLI/shim or relabel scripted tests as live
coding results. NOR-48 remains open for the smallest adapter to the existing extension runner and graders; no new grading
stack or broad suite recalibration is justified.

The dry run initially rejected `smoke-read-edit` because Windows checkout CRLF changed its prompt hash. The Git blob hash
matches the recorded `8999c9e5182d3b2aa3daf9ab3aa031ed89b22948dfc8ee811494e65159999244`. Exporting the baseline's `evals`
tree with `git archive`, extracting it outside the working repository, and setting `ALPHA_EVALS_REPO_PATH` to that exported
`evals` directory lets the unchanged loader verify the original bytes. The command then passed for five tasks and three
iterations. Its seeded estimate was $0.75 with a $1.20 reservation and $2 cap; these are campaign defaults, not measured
Copilot/Vertex pricing or authorization for a model run. No fixture, hash, or grader was changed to obtain the pass.

For the eventual paired run, retain source/build identity (including the full dirty delta if applicable), task/fixture/
grader identities, exact requested and routed models, effective reasoning, time/request/tool budgets, cache/host conditions,
and every attempt. Report grader failures, premature harness stops, false completion, exhaustion, cancellation, and
provider/infrastructure failures separately. Missing usage is unavailable. Do not assign an effective High setting from
an unset or unsupported requested value. Baseline and candidate must use matching conditions. No live solve-rate result
is claimed by this implementation or the dry run.

## Validation commands

For repeatable ongoing checks, use the self-contained [core confidence gate](core-confidence.md):
`pnpm test:core:confidence`. It generates a fresh exact-host completion capture for webview replay and retains each run.

```sh
pnpm --dir src test -- core/task/__tests__/Task.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts core/task/__tests__/subagent-followup.spec.ts core/tools/__tests__/AttemptCompletionTool.spec.ts core/webview/__tests__/ClineProvider.subagents.spec.ts core/prompts/__tests__/sections.spec.ts core/prompts/sections/__tests__/tool-use.spec.ts core/agent/__tests__/SubagentDelegation.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
pnpm certify:managed-agents:automated
```

The managed-agent certification requires `ALPHA_COMPLETION_IDLE_EVIDENCE` pointing to the existing real-host completion-idle
capture described in [tool-progress-observation.md](tool-progress-observation.md). Its deterministic and host results are
separate from outstanding live-provider quality evidence. Record actual results in the ticket and generated certification
evidence after running against the unchanged final source tree.

The eight focused suites above passed 428 tests. The pre-fix streamed-child regression observed two provider requests;
the candidate observed one and exactly one completion. These are deterministic request counts, not a live quality result.

## Subsequent core-loop work

The next NOR-56/NOR-38 increment covers changed file/command reads, opaque MCP exchanges, relevant repair budgets,
stuck command-evidence publication, and correct request-limit accounting. See the dated section in
[tool-progress-observation.md](tool-progress-observation.md) for ownership, regressions, and limits. It deliberately
preserves the existing objective/verification workflow and adds only concise recovery guidance.

NOR-49 is scoped to GitHub Copilot's `vscode-lm` provider only; it must preserve Vertex and other providers' current edit
tools. NOR-48's broader Copilot/Vertex comparison remains separate. The live campaign requires explicit fixed model
identities and an API-call or spending budget; no live quality results have been claimed for the offline repairs.
