# Command and checkpoint reliability review — 2026-10-01

Reference: current `openai/codex` main at
[`b707714ae4200db0a0385da24b3981d99139fa62`](https://github.com/openai/codex/tree/b707714ae4200db0a0385da24b3981d99139fa62),
retrieved on 2026-10-01. Alpha's reference host is **VS Code 1.125.0**. This review compared current source and tests before
changing Alpha's native TypeScript implementation; no Rust runtime, upstream implementation, or prompts were copied.

## Reference behavior and host contract

Codex's [unified execution manager](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/src/unified_exec/process_manager.rs)
separates a bounded foreground output wait from the retained process lifetime. A yielded process remains available for
later input and polling. Output collection observes process exit notifications, cancellation, and deadlines rather than
waiting indefinitely for more output. The
[unified execution tests](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/core/tests/suite/unified_exec.rs)
cover early exit notifications (`unified_exec_respects_early_exit_notifications`), retained processes after a yield
(`unified_exec_timeout_and_followup_poll`), and termination at a completion-only command deadline. These are behavioral
references, not instructions to introduce Codex's sandbox architecture.

The exact [VS Code 1.125.0 terminal API declaration](https://github.com/microsoft/vscode/blob/1.125.0/src/vscode-dts/vscode.d.ts)
distinguishes terminal exit status from a command's shell execution result. `TerminalShellExecution.read()` supplies an
async output stream and must be started promptly to avoid missing output; it provides no dedicated cancellation method.
`onDidCloseTerminal` is the stable terminal disposal event. A disposed terminal therefore cannot supply evidence that
its previously running command succeeded.

## Reproduced failures and owning fixes

| Priority | Failure                                                                                                                                        | Ownership and change                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | An automatic checkpoint save never settles; a checkpoint-bearing tool holds its workspace mutation gate indefinitely.                          | `core/checkpoints` applies the configured checkpoint deadline to the entire save, including its transaction queue wait. Timeout or task cancellation releases the caller and signals the operation.                         |
| P1       | Checkpoint initialization has a caller deadline but its subprocess work survives timeout or cancellation.                                      | Each initialization attempt owns an abort controller and task cancellation listener. Deadline and cancellation settle all shared waiters, signal Git and nested-repository discovery, and prevent late service publication. |
| P1       | A VS Code terminal closes before stream start or while a reader is stalled; the process/end wait never settles.                                | `TerminalRegistry` forwards closure to the terminal owner. `TerminalProcess` races each output/end wait against disposal, emits one failure, requests reader cleanup, and releases listeners and timers.                    |
| P1       | A yielded command loses its foreground failure observer; subsequent process failure leaves running evidence and a mutation reservation behind. | `ExecuteCommandTool` observes process errors for the physical lifetime. Unknown mutation scope becomes existing unresolved mutation debt; the command is marked failed and late success is fenced.                          |
| P1       | Shell exit clears `terminal.process` before a stalled output reader finishes, making that reader unreachable by terminal close handling.       | `Terminal` retains pending process readers until the physical run finishes. Closure reaches both the current process and readers still draining after a reported shell exit.                                                |

The first checkpoint reproduction had four failing assertions: stalled initialization cancellation, stalled save timeout,
stalled save cancellation, and a save started after cancellation. Terminal regressions failed because a close event left
the foreground promise pending. The post-exit variation reproduced the same hang even after the command's exit callback
had fired. The yielded-command regression failed because unresolved mutation debt was never recorded. Controlled
promises and fake timers establish these failures without network or arbitrary sleep dependencies. An adjacent post-exit
close regression also exposed two failed-command finalizations: terminal disposal and the existing missing-output timer
both tried to own the result. Disposal now immediately rejects the output join and clears that timer; the failure and
background-task suspension are recorded once.

The checkpoint service retains its existing transaction queue. Aborting an operation does not advance that queue before
physical work settles; an expired queued save never starts Git work. Signal checks after staging, diff, and commit prevent
late success publication. A cancelled staging operation cannot proceed into commit even if its underlying promise later
resolves. Each cancellable save uses its own Git client; successful initialization leaves an independent client for later
host-owned restore operations.

Terminal close never substitutes the shell's terminal exit status for a command exit code. When no command exit was
reported, failure retains the unknown outcome. When exit was reported but the output reader remains stalled, the error
identifies incomplete output. Late reader/end events cannot emit another completion or replace the failed command
evidence. Closing an older draining process cannot clear ownership of a newer command in the same terminal.

## Preserved Alpha behavior and limitations

Alpha's existing command approval, workspace policy, mutation receipts, protected paths, output limits, managed-agent
boundaries, and execution providers remain authoritative. Foreground yield and hard command lifetime timeout remain
separate. Optional checkpoint failure still disables checkpoints for that task and permits its existing mutation policy
to continue; cancellation does not turn into a successful command or a passing verification. No completion gates were
weakened. Task orchestration and persisted history formats did not change in this command/checkpoint work.

The existing `checkpointTimeout` setting now bounds initialization and each automatic save; its English label and help
text describe both uses. The value/default/range and saved setting key remain compatible. Explicit host restore remains
serialized behind any physical checkpoint operation.

Cancellation is cooperative at external boundaries. The installed `simple-git@3.36.0` abort facility signals its Git child
with SIGINT, and checkpoint ripgrep uses Node's native `AbortSignal` process option. Signal checks also stop later phases
and publication. This is not a claim that every user Git hook, descendant process, or uninterruptible filesystem operation
can be forcefully stopped. In that case the optional caller still releases at its deadline, while the service queue
retains physical ownership instead of allowing concurrent shadow-repository mutations. VS Code readers similarly have
no cancellation API; iterator cleanup is requested without joining a return queued behind a stalled read.

## Validation

Focused checks after the fixes:

```sh
pnpm --dir src test integrations/terminal core/tools/__tests__/ExecuteCommand.lifecycle.spec.ts core/tools/__tests__/executeCommandTool.spec.ts core/tools/__tests__/executeCommand.spec.ts core/tools/__tests__/executeCommand.fileChanges.spec.ts core/tools/__tests__/CommandSessionRegistry.spec.ts core/tools/__tests__/ManageCommandTool.spec.ts core/tools/__tests__/commandTimeouts.spec.ts core/checkpoints/__tests__/checkpoint.test.ts services/checkpoints/__tests__/checkpoint-cancellation.spec.ts services/search/__tests__/file-search.paths.spec.ts
```

Result: **296 passed, 12 skipped across 23 files** (22 passed, one skipped); the skips are existing platform/fixture
conditions. This includes terminal/provider, command-session, command timeout, yielded error, optional checkpoint
deadline/cancellation, serialized service cancellation, and actual ripgrep process coverage. Three older command fixtures
were repaired to expose the existing EventEmitter/thenable process contract; their original behavioral assertions remain.

The final actual-Git checkpoint service suites and search coverage also passed **69 tests across five files**:

```sh
pnpm --dir src test services/checkpoints/__tests__/ShadowCheckpointService.spec.ts services/checkpoints/__tests__/RepoPerTaskCheckpointService.spec.ts services/checkpoints/__tests__/checkpoint-cancellation.spec.ts services/search/__tests__/file-search.spec.ts services/search/__tests__/file-search.paths.spec.ts
```

Combined repository type checks, packaging, and the required deterministic exact-host gate
(`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`) are coordinated after all parallel changes stabilize. Their final
results belong in the [combined reliability review](codex-loop-reliability-review-2026-10-01.md); this document does not
claim a live-model quality or speed improvement.

`pnpm --dir src check-types` passed after the combined source stabilized. Scoped `git diff --check` passed, and only the
touched files were formatted.
