# Command admission cancellation and captured timeout policy

Date: 2026-10-20. Mode: **correctness cleanup**, limited to command policy/admission and its focused regressions.

## Owning invariant and verified defects

`Task.captureToolExecutionPolicy` owns the immutable command-policy capture for a model step. `ExecuteCommandTool`
adapts that policy and the scheduler signal into the existing terminal execution owner. Ordinary and prepared commands
must use the same captured hard timeout; yield time remains a separate wait budget. Step cancellation must prevent an
unlaunched command from being admitted, without revoking a valid resumable process already owned by its task.

Verified against current code before production edits:

- **High / must-fix:** ordinary native `exec_command` and historical `execute_command` dispatch omitted `callbacks.signal`.
  Aborting only the step signal during terminal acquisition or mutation admission still called `runCommand` once.
- **Medium / should-fix:** Task's policy capture omitted `userTimeoutMs` and `timeoutAllowlist`; prepared reads therefore
  received the policy defaults, while ordinary execution ignored the captured resolver and read live settings instead.

The new baseline command completed with **11 expected failures and 1 passing characterization**, without a real
subprocess. The cancellation failures observed one synthetic launch where zero was required. The timeout failure observed
zero calls to the captured resolver. Earlier fixture-only runs had missing mock members; those were corrected before
recording this clean failing baseline.

## Implemented changes

- `src/core/task/Task.ts`: capture and freeze both timeout settings alongside command prefixes before asynchronous step
  preparation. Validate finite nonnegative seconds, convert to integer milliseconds, and bound to the contributed
  configuration maximum of 600 seconds. Copy only string allowlist entries. Settings changed later cannot widen an
  admitted step's policy.
- `src/core/tools/ExecuteCommandTool.ts`: use `resolveCommandTimeoutMs` whenever supplied for both execution paths, and
  forward the ordinary scheduler signal into all existing prelaunch rechecks. Preserve the direct legacy-call fallback
  when no scheduler policy exists.
- Explicitly transfer launch ownership after `runCommand` successfully returns. Subsequent steering cannot suppress the
  valid process's completed mutation/diff projection. Whole-task cancellation checks remain active. Prepared reads retain
  their existing independent disposal owner until scheduler presentation commits.
- `src/core/task/Task.ts`: coordinated one-line integration for fix-07: pass captured `this.cwd` into
  `new FileContextTracker(provider, this.taskId, this.cwd)`. The tracker implementation and its tests belong to that patch.

New test files:

- `src/core/task/__tests__/Task.command-timeout-policy.spec.ts`
- `src/core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts`

The regressions cover native/historical aliases, cancellation during acquisition/admission, reservation release, one
cancelled evidence/result receipt, immutable allowlist capture and complete-token matching, malformed settings, ordinary
and prepared hard timeout after yield, retained sessions after steering, and completed mutation/diff publication after
ownership handoff.

## Codex source and intentional differences

Inspected the local upstream checkout at **`c7234c1174b27d9c55199fba0d546dc27d1b0415`**, verified with `git rev-parse HEAD`
on 2026-10-20:

- [Unified execution process owner](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/unified_exec/process_manager.rs):
  distinct yield/completion waits, stored process identity and background ownership.
- [Unified execution handler](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs):
  cancellable preparation precedes process reservation; managed one-shot execution uses a different contract.
- [Unified execution integration tests](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/tests/suite/unified_exec.rs):
  `unified_exec_interrupt_preserves_long_running_session` explicitly preserves a started resumable process on turn
  interruption. `managed_one_shot_command_is_terminated_when_the_turn_is_interrupted` explicitly tests the one-shot
  difference.

Alpha retains its existing stronger whole-task cleanup, serialized mutation/terminal interactions, staged prepared-read
publication, and user-configured lifetime ceiling. No sandbox architecture, Rust, prompts, scheduler redesign, or new
runtime was introduced. The started-session behavior follows verified resumable Codex execution rather than the managed
one-shot variant.

## Validation

Clean failing baseline, before product edits (the new timeout-only test content was initially executed under the
`Task.command-policy-capture.spec.ts` filename):

```sh
pnpm --dir src test core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts core/task/__tests__/Task.command-policy-capture.spec.ts --maxWorkers=1
```

Result: **11 failed / 1 passed**, all failures at the intended cancellation/snapshot assertions after fixture repair.
After the fix and added prepared-path/handoff variants: **2 files, 14 tests passed**.

Final diff review caught that the initial test filename collided with an existing tracked capture suite. The existing
file was clean at startup and was restored byte-for-byte from HEAD; new timeout tests now use the unique
`Task.command-timeout-policy.spec.ts` filename. No pre-existing capture tests are removed. A fresh run includes both.

```sh
pnpm --dir src test core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts core/task/__tests__/Task.command-timeout-policy.spec.ts core/task/__tests__/Task.command-policy-capture.spec.ts --maxWorkers=1
```

Result: **3 files, 24 tests passed**, including all ten pre-existing public capture/retry tests.

Adjacent validation:

```sh
pnpm --dir src test core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts core/task/__tests__/Task.command-policy-capture.spec.ts core/tools/__tests__/executeCommand.spec.ts core/tools/__tests__/executeCommandTool.spec.ts core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts core/tools/__tests__/executeCommand.fileChanges.spec.ts core/tools/__tests__/preparedCommandSharedCollector.spec.ts core/tools/__tests__/ParallelCommandRead.integration.spec.ts --maxWorkers=1
```

Result: **7 files passed, 1 file failed; 142 passed / 2 failed**. Both failures were existing artifact-search cases in
`ParallelCommandRead.integration.spec.ts:549` (`code` and `architect`), returning
`Error reading command output: commandOutputSearch.unavailable` while fix-02 was changing that worker path. Reported to
the owning agent and parent; the search owner confirmed source-test worker path resolution needs a dedicated seam and
owns that integration-test adjustment/rerun. No search implementation/test was edited here. All command execution, new
policy, prepared-collector and lifecycle tests in this run passed.

Follow-up from fix-02: its owner added an isolated, in-memory source-worker test seam and reported **97 tests passed**
across `ReadCommandOutputTool`, `commandOutputSearch.lifecycle`, and `ParallelCommandRead.integration`, including the two
previously failing code/architect cases. That command was run by the search owner, not repeated by this agent.

Prettier checks for the four changed TypeScript files and `git diff --check` passed. Only the new command test file was
formatted. Focused ESLint for the command tool and both new tests passed. No explicit install, dependency edit, lockfile
change, broad format, build, commit, or host run was performed.
One identical pnpm test invocation automatically executed workspace install/bootstrap hooks before Vitest; no lockfile
change was observed.

Parent integration owns final typecheck/lint and exact VS Code 1.138.0/minimum-host gates. No benchmark or general latency
improvement is claimed; the measured change is deterministic prelaunch admission correctness.

## Closure and residual risk

- **Fixed now:** dropped ordinary cancellation signal, lost production timeout fields, ordinary/prepared timeout-policy
  divergence, and implicit step ownership after successful resumable launch.
- **Flagged for follow-up:** the existing VS Code PTY timeout path can report termination without physical exit proof.
  `TerminalProcess.abort()` sends Ctrl-C synchronously; it does not confirm exit. `ExecuteCommandTool` still preserves
  unknown mutation debt when no exit is observed, but its timeout response can say the command was terminated. This patch
  deliberately does not change terminal control or its public outcome contract.
- **Not verified:** OS process-tree termination, live VS Code behavior, exact-host gates, and final integrated type/lint
  checks. Ordinary steering still waits for the existing command yield/completion boundary (native yields are bounded by
  the existing platform limits); this patch does not add a new scheduler cancellation race. Legacy direct calls without a
  yield deadline retain their prior wait behavior.
- **Out of scope:** scheduler ownership redesign, command-output search worker implementation, live-session admission
  limits, one-shot command APIs, and sandbox imitation.
