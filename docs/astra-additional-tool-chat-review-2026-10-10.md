# Additional Astra tool and chat reliability review — October 10, 2026

> Historical audit snapshot: the unchanged five-case reproduction now passes after the coordinated fixes.
> See [the closure report](astra-reliability-bug-hunt-2026-10-10.md) for implementation and final validation.

This independent audit found **two confirmed defects beyond the supplied fix list**. Production files and existing
tests were not edited. The sole new regression file is
[`additional-chat-tool-flow.astra.spec.ts`](../src/core/tools/__tests__/additional-chat-tool-flow.astra.spec.ts).
At audit time it had **4 failing cases and 1 passing control**, preserving the observable failures for a fixer.
The surrounding bounded validation passed **90 tests in 6 files**.

## Scope and reference

The audit read root `AGENTS.md`, inspected the dirty checkout, and treated all concurrent changes as owned by others.
It covered the captured tool surface, scheduler admission, command sessions and receipts, input routing, continuation,
and terminal recovery. No subagents, commits, resets, deletions, dependency changes, Electron launches, or broad gates
were used. Alpha's sandbox, skills, Tickets, HTML previewer, and schedules remain outside any replacement proposal.

The supplied current Codex CLI reference is
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/commit/cc7ba33601286a751477832b01de7b6f8de0dd9c),
retrieved by the coordinating audit at **2026-10-11 01:37 UTC**. This review independently fetched the relevant files at
that exact commit through the GitHub connector before comparing Alpha behavior. It did not execute upstream Rust tests.

- [`tools/parallel.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/tools/parallel.rs)
  retains the advertising step and separates cancellable admission from handler execution. Its tests check cancellation
  before dispatch and terminal outcome observation.
- [`tools/registry.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/tools/registry.rs#L615)
  routes registered calls through the common invocation and lifecycle boundary.
- [`dynamic_tool_cancellation.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/dynamic_tool_cancellation.rs)
  checks terminal settlement of interrupted dynamic calls and exclusion of late replies from future model context.
- [`unified_exec/process_manager.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/unified_exec/process_manager.rs#L1024)
  accounts for omitted output and original size before returning a completed `write_stdin` result.
- [`head_tail_buffer_tests.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/unified_exec/head_tail_buffer_tests.rs#L5)
  verifies an explicit omission marker when the buffer exceeds its bound.
- [`unified_exec/mod_tests.rs`](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/unified_exec/mod_tests.rs)
  covers session reuse, completed process identity, terminal input approval, and preserved exit codes.

The custom-tool approval finding below follows **Alpha's own declared policy and lifecycle contract**. It does not
assume Codex has Alpha's TypeScript custom-tool API or propose adopting Codex's sandbox implementation. Alpha's retained
output receipts and artifact reader are also intentional implementation choices; silent omission is the defect.

## Confirmed P1: custom callbacks bypass approval and durable effect admission

**Owning layer:** `ToolRegistry.registerCustomTools`, specifically
[`ToolRegistry.ts:1048`](../src/core/tools/ToolRegistry.ts#L1048).
The production catalog reaches this path from
[`build-tools.ts:398`](../src/core/task/build-tools.ts#L398) and
[`build-tools.ts:582`](../src/core/task/build-tools.ts#L582).

**Trigger:** A user enables the `customTools` experiment and has a valid custom tool in a Code task. The model calls it
while the task is in **Ask** approval mode. A custom tool can legitimately invoke a command or external API using its
arguments; it is not restricted to pure computation by the definition contract.

**Root cause and violated invariant:** The captured descriptor declares `sideEffects: "external"` and
`requiresApproval: true` through `getToolCapabilities("custom_tool")`. Its execute wrapper nevertheless calls the
custom function directly, without invoking `callbacks.askApproval`. The scheduler intentionally waits for an
approval-required handler to request approval before publishing effect start:
[`ToolScheduler.ts:2433`](../src/core/agent/ToolScheduler.ts#L2433). Consequently, both the human decision and the durable
`onEffectStart` callback are skipped. A schema-visible tool's policy, execution, and lifecycle evidence disagree.

**Deterministic evidence:** The new test registers a harmless callback through the real `customToolRegistry`, constructs
the real `ToolRegistry` and `TaskToolSurface`, and dispatches through the real scheduler with normal mode validation and
`experiments.customTools: true`. It does not override the descriptor or skip policy validation.

- With an Ask-mode host configured to deny, expected approval count is `1`, callback count is `0`, and result status is
  `denied`. Actual counts are `0` and `1`, and result status is `success`.
- With an approving host, expected order is `approval → effect-start → execute`. Actual order is only `execute`.
  `onEffectStart` is never called.

These are two failing tests for one underlying defect. No actual command or network effect was performed by the probe.
The immediate approval bypass is reproduced. The reload consequence is established by tracing, not by crashing a host:
[`Task.ts:4732`](../src/core/task/Task.ts#L4732) interprets an accepted call without a version-1 effect-start record as
not executed. An interrupted custom side effect can therefore lack the evidence needed to warn against unsafe retry.

**Smallest complete fix:** Gate custom invocation inside the existing registered wrapper using the canonical approval
callback, carrying the captured custom name and full validated arguments for review. Respect denial/cancellation and
recheck cancellation after any awaited preparation, immediately before invoking the callback. Successful approval must
flow through the scheduler's existing durable effect-start fence. Cover denied and accepted invocation, cancellation
before dispatch, failed effect-start persistence, and recovery after a started effect. Preserve opt-in loading, Plan
exclusion, and the existing tool definition API. Merely marking the descriptor approval-free would conceal the policy
mismatch and would not implement Ask behavior.

## Confirmed P2: a terminal command poll hides retained output

**Owning layer:** command receipt construction in
[`ManageCommandTool.ts:148`](../src/core/tools/ManageCommandTool.ts#L148), reached through native `write_stdin` in
[`ToolRegistry.ts:369`](../src/core/tools/ToolRegistry.ts#L369).

**Trigger:** `exec_command` has yielded a session. The process finishes before the next poll and has more than 8,000
unread characters, such as a build or diagnostic log whose conclusion is at the end. The model polls with default
`max_output_tokens`. A second trigger uses any small positive token budget whose character allowance is at most 512.

**Root cause and violated invariant:** The receipt capture is capped at 8,000 characters and reserves 512 characters
before capture. `BaseTerminalProcess.captureUnretrievedOutput` correctly leaves the unreturned tail unread. The caller
constructs a result containing only that slice, includes `session_id` only while command evidence says `running`, and
does not mark the partial capture or advertise a way to retrieve the remainder. The scheduler only sees an already
shortened string and reports `truncated: false`. `WriteStdinToolAdapter` correctly retains the session while unread
output remains, but that continued availability is invisible in the terminal receipt.

**Deterministic evidence:** The reproduction uses a real `ExecaTerminalProcess` and its real transactional output
receipt, with only the process's output seeded at the post-yield boundary. It uses the real session registry, adapter,
captured surface, and scheduler. No process is launched.

- An approximately 9 KB completed output ends in a distinctive diagnostic. The first poll reports exit code `0`, has
  `truncated: false`, omits the diagnostic, and contains neither an omission warning nor a retrieval instruction.
  `hasUnretrievedOutput()` remains true. A second poll with the original ID returns the diagnostic and then releases the
  session. Three observable contract assertions fail in this case.
- With `max_output_tokens: 100`, a short diagnostic becomes an empty `Output:` section beneath `Process exited with
code 0`, still with `truncated: false`; the whole output remains unread. Both omission assertions fail.
- A complete short receipt returns its output, reports no truncation, and releases its session normally. This control
  passes.

**Impact:** The agent can stop reading a successful command before seeing its final diagnostics or relevant results.
This is not proof that bytes were deleted; the second poll proves they remain recoverable. It is also independent of
the already-known retired artifact-hint defect: no artifact hint is generated on this path at all.

**Smallest complete fix:** Extend the existing receipt/result path to expose whether output remains after the captured
range. Preserve the true terminal process status while adding an explicit omission indication and an actionable
`write_stdin` retrieval instruction using the retained session, or a verified artifact reference. Carry partial-output
state through the structured result/metadata so the scheduler does not label it complete. Do not render a retained
output handle as proof that the process is still running. Keep cursor commit/release transactional, preserve output
limits, and test small budgets as well as completed large output and terminal reuse.

## Checked controls and unconfirmed candidates

- Captured surfaces seal the registry and intersect schemas, visibility, explicit denies, and execution profiles.
  Relevant `TaskToolSurface` coverage passed. No additional schema/policy widening was confirmed.
- Completed command sessions retain physical execution identity. Input revalidates it around approval, and a later
  terminal reuse does not authorize stale input. Relevant session and command-control coverage passed.
- Completion and user-suspending barriers have a shared isolation preflight; the apparent possibility of mutating after
  an explicit completion call in the same batch was ruled out by tracing that preflight.
- Task-ID and ask-timestamp routing rejects stale asks after asynchronous preparation. The published-ask response
  controls passed; no new stale-route defect was established.
- Turn-engine failure, terminal completion, and cancellation controls passed. This does not certify every provider,
  tool, or live-model workflow.
- A separate concern about persistence of output emitted after a command yields was noticed while tracing the line
  listener and interceptor. It was not independently reproduced, so it is **not an additional confirmed finding**.
- The supplied fixes for nonzero command exits, retired artifact hints, queue acknowledgment, Anthropic history/usage,
  scheduled toasts, closed-child budgets, and follow-up admission are excluded. The in-progress artifact-only
  `write_stdin` Plan work was not judged from partial writes.

## Validation

The sandbox initially rejected pnpm workspace `realpath` with `EPERM`. The same narrowly scoped commands then ran with
process escalation and one worker.

```sh
pnpm --dir src test core/tools/__tests__/additional-chat-tool-flow.astra.spec.ts --maxWorkers=1
```

Result: **4 failed, 1 passed** on the final five-case reproduction, with failures at the intended assertions above.

```sh
pnpm --dir src test core/tools/__tests__/TaskToolSurface.spec.ts core/tools/__tests__/CommandSessionRegistry.spec.ts core/tools/__tests__/RequestUserInputTool.spec.ts core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts core/tools/__tests__/ManageCommandTool.spec.ts core/webview/__tests__/published-ask-response.spec.ts --maxWorkers=1
```

Result: **90 passed in 6 files**. The coordinating chat owns typechecks, integration validation, and the exact
VS Code **1.125.0** gate. This audit did not run or claim those gates, live-provider evaluations, or a production fix.
