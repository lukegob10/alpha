# Process settlement integration audit

Status: **READY / FROZEN**. All files in this handoff are frozen for coordinator integration and gates.

Mode: integration follow-up audit. Scope is the active Execa process owner, its callback delivery, and the command
controller's output/user-question ownership split, following the tools lane's physical-settlement finding. The coordinator
explicitly authorized these edits after the completed lanes froze. These are bounded reliability repairs; test timings
are not a general process-performance claim.

## Sources and owning contract

- Codex CLI source inspected at `cb6da58876afed3ede0ab11084f67dd5394ecb48`, retrieved 2026-10-02:
  [`core/src/exec.rs`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/exec.rs),
  [`unified_exec/process.rs`](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/unified_exec/process.rs),
  and `unified_exec/process_tests.rs`. These separate process failure from an observed exit and preserve termination
  failure rather than declaring a successful confirmed stop.
- The installed Execa version is **9.5.3**. Its
  [iterator cleanup](https://github.com/sindresorhus/execa/blob/v9.5.3/lib/convert/iterable.js) waits for the subprocess;
  its [result collector](https://github.com/sindresorhus/execa/blob/v9.5.3/lib/resolve/wait-subprocess.js) joins exit and IO.
  Both installed files and the matching primary source were inspected. The observed iterator behavior is reproduced
  with real processes, not inferred only from a mock.
- Node's official [EventEmitter documentation](https://nodejs.org/api/events.html#capture-rejections-of-promises),
  retrieved 2026-10-02, explains that normal event delivery ignores returned promises, whereas `captureRejections`
  observes rejection. The custom rejection hook must not return a rejecting promise. Native `rawListeners` preserves
  the wrappers used by `once`. Local Node 24.14.1 and installed event types were checked; version-specific documentation
  URLs were unavailable to the browser tool. The used APIs predate Node 24 and are covered by local deterministic tests.
- Alpha callers are `ExecaTerminal.runCommand`, `BaseTerminal.shellExecutionComplete`, the terminal registry, and
  `executeCommandInTerminal`. Emitting completion clears terminal ownership; emitting the process error gives the
  existing command consumer its failed outcome and recovery fence. There are no persisted or wire schema changes.
- Alpha retains its existing `taskkill /T /F` and POSIX tree discovery/kill mechanisms. This intentionally preserves
  Alpha's process and approval setup; no Codex sandbox, runtime, Rust, or source port is introduced.
- The active `ExecuteCommandTool.onLine` previously returned an async promise that also waited for `task.ask`.
  `onCompleted` publishes its final `task.say` as noninteractive, which does not supersede that ask. Output finalization
  must therefore join output work independently of the controller-owned user question.

## Fixed now

**High / must-fix — output failure could orphan a running command or hang before cleanup.** The old generic catch
fabricated shell exit 1, emitted completion, and cleared the subprocess even when the process still lived. A real output
callback failure also exposed a different path: JavaScript closes the async iterator before reaching that catch, and
Execa's iterator cleanup waits for process exit. The catch could therefore never initiate termination.

The owner now observes the subprocess result from launch, starts the existing shared tree termination before closing an
iterator after a synchronous output callback failure, and observes merged-output stream errors before they can block
iterator cleanup. It waits for physical subprocess settlement and termination handling before releasing terminal
ownership. A failed tree termination remains observable and leaves Stop retryable. Output failure is emitted as a
process error; its actual exit/signal evidence is retained instead of manufacturing a command exit 1. Normal command
nonzero exits and cancellation retain their existing result semantics. The temporary output-error listener is removed.

**High / must-fix — callback rejection or throwing finalization could hang or become successful completion.** Execa
opts into native promise-rejection capture through the existing base constructor; other terminal adapters keep their
defaults. Its rejection hook is synchronous and preserves the first failure. Completion dispatch invokes every native
raw listener, including later listeners after a synchronous throw, and joins returned promises with `allSettled` before
`continue`. A throwing shell-complete callback also reaches the same failure path and owner cleanup. Finalization failure
does not kill a PID after its physical process already settled, and cleanup runs even when observers fail.

Execa owns only still-pending line callback promises and removes them as they settle. It joins them after completion
observers have had a chance to flush output, so rejection after EOF and physical exit still precedes successful
`continue`. Streaming is not serialized per chunk: a batch of 16 outstanding callbacks backpressures further reading.
No additional retained output queue is introduced. In the active command controller, output accumulation, interception,
and publication remain synchronous, and only its existing caught user-question continuation is detached. That question
retains its existing response and cancellation behavior and cannot hold process finalization.

**High / must-fix — old completion cleanup could modify a replacement command.** Shell completion makes the terminal
available for reuse before async finalization finishes. The old process's busy listener and stream/binding cleanup now
check the terminal's current owner. Cleanup still runs when the old binding is removed and no replacement exists, while
a replacement keeps its process, busy/running state, and active stream.

Changed files:

- `src/integrations/terminal/ExecaTerminalProcess.ts`
- `src/integrations/terminal/BaseTerminalProcess.ts`
- `src/integrations/terminal/__tests__/ExecaTerminalProcess.settlement.spec.ts`
- `src/integrations/terminal/__tests__/ExecaTerminalProcess.integration.spec.ts`
- `src/core/tools/ExecuteCommandTool.ts` (only output/user-question ownership and stale callback comments in this follow-up)
- `src/core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts` (held-question regression and its fixture helpers)

All preexisting coordinator/tools-lane edits in the two command files were preserved.

## Evidence and validation

Before the repair, the two initial deterministic reader/callback regressions both failed: `isSettled` was already true
while the held subprocess still lived. The first attempted repair also failed the real callback case with a 10-second
timeout, exposing the iterator-close dependency; termination was moved ahead of iterator cleanup and the real case
then passed. No assertion was relaxed to hide either failure.

Further fail-before tests demonstrated ignored async line rejection, a synchronous completed observer leaving the command
promise pending, and async finalization or delayed output rejection becoming success. The active consumer regression
failed while its held user question was returned as output work. Two replacement-owner tests independently failed on
the stale busy flag and stale stream closure. These assertions passed after the bounded owner/caller fixes.

The final 16 deterministic process cases cover reader and merged-output errors; synchronous and asynchronous line
callback failure while the process lives; failed termination and Stop retry; output EOF before physical exit; synchronous
and asynchronous finalization failure; a throwing shell outcome observer; delayed line rejection after physical exit;
preserving the original failure despite secondary completion/error observer rejection; a bounded async streaming batch;
and replacement ownership during completed delivery and final cleanup. Separate barriers hold termination acknowledgement,
physical exit, and callback settlement. Native once removal, later-observer delivery, single finalization, void rejection
capture, and removal of temporary listeners/pending callbacks are asserted. The consumer regression additionally completes
all output bookkeeping while its question remains held.

Two new real-process cases inject callback and merged-stream failures into the existing shell/parent/child sleeper
fixture. Both assert that all three real PIDs have stopped before finalization. The existing real tree-abort and
agent-timeout ownership cases also pass. Real process checks ran on Windows; POSIX tree behavior received the existing
deterministic coverage, not a live POSIX run.

| Final check                                                                          | Result                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Terminal surface plus the four ExecuteCommand consumer files below, `--maxWorkers=2` | **263 passed / 12 existing skips / 18 files** |
| `pnpm --dir src check-types`                                                         | **Passed**                                    |
| Scoped ESLint for all six code/test files                                            | **Passed**                                    |
| Scoped Prettier check and whitespace diff check                                      | **Passed**                                    |

Final checks ran after the replacement-owner guards. Earlier type failures in the new test and native event hook were
corrected before the final typecheck; no unrelated fixtures, dependencies, manifests, or generated files were changed
by this handoff.

Reproduction/consumer commands:

```sh
pnpm --dir src test integrations/terminal/__tests__ core/tools/__tests__/executeCommandTool.spec.ts core/tools/__tests__/executeCommand.spec.ts core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts core/tools/__tests__/executeCommand.fileChanges.spec.ts --maxWorkers=2
pnpm --dir src check-types
pnpm --dir src exec eslint integrations/terminal/BaseTerminalProcess.ts integrations/terminal/ExecaTerminalProcess.ts integrations/terminal/__tests__/ExecaTerminalProcess.settlement.spec.ts integrations/terminal/__tests__/ExecaTerminalProcess.integration.spec.ts core/tools/ExecuteCommandTool.ts core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts
```

## Closure and remaining coverage

| Surface                                                                                                                              | Closure                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Execa output/reader failure, Stop retry, EOF, physical process ownership                                                             | Fixed; deterministic and real-process evidence above                             |
| Active output/user-question split, late line rejection, shell/completed observer failure, bounded callback ownership, terminal reuse | Fixed; fail-before and adjacent deterministic cases above                        |
| Other adapters' event-rejection defaults                                                                                             | Unchanged; terminal regressions pass                                             |
| Live POSIX processes, live providers, packaged extension, exact VS Code 1.125.0 host                                                 | Not run by this subagent; coordinator owns serial exact-host and packaging gates |
| Codex sandbox, approval changes, Task engine changes, dependencies, general benchmarks                                               | Out of scope; unchanged                                                          |

The fix removes a demonstrated failure-path hang and false completion. Test timings are validation overhead and are not
evidence of a general latency, throughput, token, or memory improvement.
