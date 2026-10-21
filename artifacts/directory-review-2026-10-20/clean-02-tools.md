# Clean-code review 02: tool surface and effects

Date: 2026-10-20 (user timezone). Repository HEAD: `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`.

Mode: **full-surface review**, bounded to the canonical tool registry/surface, validation, mutation dispatch, command execution and output retrieval. This was a read-only audit; only this report was added. Good means one immutable policy/surface, correctly fenced effects, preserved external edits, bounded work and deterministic cancellation/results. This pass identifies gaps; it does not claim closure or whole-repository cleanliness.

## Findings

### 1. High / must-fix: ordinary command dispatch drops the scheduler cancellation signal

- **Location:** `src/core/tools/ExecuteCommandTool.ts:906` (conditional options through line 918); relevant signal use at `src/core/tools/ExecuteCommandTool.ts:1217`.
- **Trigger and risk:** A normal `exec_command` is approved, then the user steers/cancels the current step while command admission, mode lookup or terminal acquisition awaits. The scheduler signal is aborted while `task.abort` and the task-lifetime signal remain false. Only the prepared-read branch copies a signal into `ExecuteCommandOptions`; ordinary commands proceed with `signal === undefined`. Their prelaunch cancellation checks can therefore admit a command after the step was interrupted. A pending ordinary foreground execution also cannot observe that step signal through this option.
- **Active reachability:** `ToolScheduler` always supplies `callbacks.signal` (`src/core/agent/ToolScheduler.ts:2959`); `ToolRegistry` routes the native alias into `ExecuteCommandTool.execute` and its ordinary `executeApproved` call has no `host`. Human steering aborts the current-request and step-interruption controllers without terminating the whole task (`src/core/task/Task.ts:11339`). The ordinary path is the fallback for commands outside the audited `rg` subset, including workspace-mutating commands.
- **Evidence:** Executed an AST-based probe of the actual `executeApproved` method (TypeScript transpilation in memory, no source edits). Its mocked async `getTaskMode` aborted `callbacks.signal` after successful approval. The method still invoked the terminal executor: `{"schedulerSignalAborted":true,"terminalCalls":1,"receivedSchedulerSignal":false,"receivedSignalPresent":false,"timeoutResolverCalls":0}`. This proves the adapter drops cancellation at dispatch; no real subprocess was launched by the probe.
- **Smallest fix:** Pass the ordinary scheduler/step signal to the terminal admission owner as well, and recheck it after awaited prelaunch work. Define an explicit ownership transfer when a command yields to background execution so a later request's cancellation does not accidentally kill legitimately task-owned background work. Keep the prepared-read disposal/receipt protocol intact.
- **Regression check:** Use a controlled promise for ordinary terminal acquisition/admission; abort only the scheduler signal, release the promise, assert `runCommand` is never called, no mutation reservation is leaked, and one cancelled receipt is emitted. Cover both native `exec_command` and historical command aliases. Separately cover steering while a foreground command is running and a yielded background command's lifetime.
- **Confidence:** High for signal loss and post-interruption dispatch; running-process cleanup behavior was not exercised in a live host.

### 2. High / must-fix: allowed artifact-search regex can block the extension host for seconds per line

- **Location:** `src/core/tools/ReadCommandOutputTool.ts:853`; incomplete safety classification at `src/core/tools/ReadCommandOutputTool.ts:84`.
- **Trigger and risk:** `write_stdin` artifact reads or legacy `read_command_output` searches with `search: "a+$"` against a legal line containing 65,535 `a` characters followed by `!`. The classifier accepts one variable-width quantifier; the synchronous, case-insensitive JavaScript regex scans/backtracks on the extension-host event loop. The 64 KiB line bound limits memory but still permits seconds of blocking. Cancellation and every other extension task remain unresponsive during that synchronous call; several nonmatching lines repeat the delay.
- **Active reachability:** Native `write_stdin` artifact requests route through `ManageCommandTool` action `read` into `ReadCommandOutputTool.execute`. Search invokes `searchInArtifact`, which calls `regex.test(line)` directly. `READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES` is 65,536. Existing tests explicitly accept `a+$` but only test matching input (`src/core/tools/__tests__/ReadCommandOutputTool.test.ts:658`).
- **Measured evidence:** A bounded Node probe of the same `/a+$/i.test("a".repeat(n) + "!")` operation returned false in 78 ms at 8,193 characters, 257 ms at 16,385, 846 ms at 32,769, and 5,428 ms at 65,536 on this machine. These are local diagnostic measurements, not general performance claims.
- **Smallest robust fix:** Move arbitrary regex evaluation to an owned worker/process with a hard timeout and cancellation, or use a guaranteed-linear search implementation. A literal-only option is also safe if the tool contract is deliberately narrowed. Merely counting quantifiers or adding an async timeout around synchronous `RegExp.test` does not provide an execution bound.
- **Regression check:** Run the adversarial nonmatching 64 KiB case behind a terminable worker with a deadline; verify bounded completion, cancellation, cleanup and a truthful error receipt. Retain useful matching-pattern coverage and artifact pagination tests.
- **Confidence:** High; blocking cost was reproduced directly and the accepted pattern has explicit existing coverage.

### 3. Medium / should-fix: production prepared reads lose the configured hard command timeout

- **Location:** `src/core/task/Task.ts:2595`; consumer at `src/core/tools/ExecuteCommandTool.ts:886`.
- **Trigger and risk:** A user sets a nonzero `alpha.commandExecutionTimeout` and runs a command admitted as an audited prepared `rg` read. `captureToolExecutionPolicy` captures only allowed/denied prefixes. `ToolPolicy` therefore defaults `userTimeoutMs` to zero and its timeout allowlist to empty. Prepared execution chooses `callbacks.resolveCommandTimeoutMs` exclusively; its captured zero replaces the nonzero VS Code setting already read in the same method. The model's yield timeout only returns a session; it is not a process-lifetime ceiling. The command can keep running beyond the user's configured limit.
- **Active reachability:** Task constructs the scheduler with `executionMode: "selective-parallel"` (`src/core/task/Task.ts:4740`). `ParallelCommandRead.prepareParallelCommand` prepares supported explicit-file `rg` inspections, and the registry attaches this handler to `exec_command` (`src/core/tools/ToolRegistry.ts:1242`). `ToolScheduler` provides the snapshot-based timeout resolver (`src/core/agent/ToolScheduler.ts:2960`). The timeout policy fields are defaulted in `src/core/agent/ToolPolicy.ts:147`.
- **Equivalent-path issue:** Ordinary execution reads live VS Code timeout settings while prepared execution reads the captured policy. Thus the same user setting has two owners; a policy supplied to the scheduler is ignored by the ordinary path. The AST probe for finding 1 also observed zero calls to the supplied timeout resolver on the ordinary path.
- **Smallest fix:** Capture the validated VS Code command timeout and timeout allowlist at the same step boundary as other command policy, then consistently use the captured resolver for both execution paths. Preserve the distinction between yield time and hard process timeout.
- **Regression check:** Construct a real Task step with nonzero VS Code timeout configuration, assert the captured policy retains it, and use fake timers with a prepared read that yields before the hard timeout. Verify the process is aborted at the configured ceiling and its receipt settles exactly once. Run the same test through ordinary execution and verify midstep settings changes do not widen its captured policy.
- **Confidence:** High from the complete production capture-to-consumer trace; a live slow `rg` workload was not launched.

## Strengths and quality estimate

**Reviewed-surface quality: 82/100, approximate uncertainty +/- 8 points.** This is a qualitative engineering assessment, not a measured defect rate or a Codex convergence percentage.

- `TaskToolSurface` seals the registry, deep-freezes schemas, derives callable names and immutable policy from the same boundary, and includes the catalog/profile in its digest.
- The registry has conservative effect/concurrency metadata and keeps audited parallel reads behind explicit preparation and approval. Dynamic MCP tools capture original targets and recheck connection/schema identity before dispatch.
- Workspace writes route through the established mutation owner. File tools preserve raw expected state across approval waits; direct creation uses exclusive `wx`, and patch deletion additionally verifies file identity and dirty editor state.
- Mutation receipts explicitly preserve unresolved debt instead of treating observation failure as successful completion. Command sessions use task/physical-process identities, bounded retention and passive output-finalization ownership.
- Regression coverage is substantial, including command lifecycle, stale file state, partial patches, output bounds, approvals and sessions. The open findings show gaps between the captured-policy architecture and some actual effect paths, and a safety test set that misses expensive failing regex cases.

## Validation and coverage

- Ran `pnpm --dir src test core/tools/__tests__/executeCommand.spec.ts core/tools/__tests__/ReadCommandOutputTool.test.ts --maxWorkers=1`: **2 files, 108 tests passed**, reported duration 22.23 seconds. Passing tests do not cover the newly identified cancellation/snapshot gaps or the nonmatching regex workload.
- Ran two deterministic, in-memory Node probes described above: bounded regex scaling and actual-method command-dispatch signal/timeout forwarding. No production or test file was edited.
- Inspected registry/surface and policy paths; scheduler preparation/approval/effect/result collection; ordinary/prepared command execution; command controls, sessions and artifacts; patch and direct-edit stale-state protections; legacy file editors; MCP dispatch/resource wrappers; semantic-search wrapper and native schemas.
- Coverage was sampled, not exhaustive. Did not audit every browser/lifecycle/ticket/skill tool implementation, shell parsing and terminal process internals, every MCP transport/media decoder, all custom tool code, full multi-root/symlink race behavior, or every provider-specific stream. Other reviewers own those surfaces.
- No live VS Code 1.138.0/1.125.0 host gate was run for this read-only audit. No typecheck, full suite, bundle or package gate was run because no product code changed.
- Existing dirty source/tests and the two untracked design documents were preserved. Some legacy editors examined have no fresh native schema and were not promoted to active-path defects without stronger runtime evidence.

## Closure ledger

- **Fixed now:** none; user requested an audit and this slice made no product edits.
- **Flagged for follow-up:** the three findings above.
- **Not verified:** live host behavior, complete process-tree termination after steering, all platform combinations, full tool suite and exact-host gates.
- **Out of scope:** upstream sandbox architecture and an independent Codex convergence percentage; separate convergence reviewers are handling behavioral comparisons.

Next pass: correctness cleanup on ordinary/prepared command admission and policy ownership, plus operational hardening of command-artifact search execution bounds. Close these with controlled regression tests before rerunning this audit slice.
