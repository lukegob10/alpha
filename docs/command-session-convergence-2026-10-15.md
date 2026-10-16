# Command session convergence

This records the command-session contract for Alpha's shared execution kernel and terminal adapters.
Evidence below records the pre-integration state on 2026-10-15; scripted results do not establish release acceptance.

## Reference

The current reference is Codex CLI commit `97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb`, retrieved 2026-10-15.
Earlier evidence below used `bb64b894fd67158be0f874872e6d7bfe717e7368`; those results retain their original scope.
The pinned local source and tests were inspected before the Alpha implementation:

- [Output and process limits](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/unified_exec/mod.rs).
- [Separate pending and transcript buffers](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/unified_exec/process.rs).
- [Head/tail retention](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/unified_exec/head_tail_buffer.rs).
- [Polling, input and process ownership](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/unified_exec/process_manager.rs).
- [Pruning and finalizer tests](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/unified_exec/process_manager_tests.rs).
- [Per-command PTY schema](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/tools/handlers/shell_spec.rs).
- [Completed-item dispatch](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/stream_events_utils.rs).
- [Cancellable dispatch and ordered result collection](https://github.com/openai/codex/blob/97ebf2d94d62e2ff2045f3ea17b6e11eae9a21fb/codex-rs/core/src/tools/parallel.rs).

Those sources define separate 1 MiB pending/completion buffers, a 64-process store, raw chunk polling,
plain pipes by default, explicit PTY allocation, and exact Ctrl-C handling for closed pipe stdin.
Alpha implements the applicable behavior through native TypeScript and VS Code adapters.

## Execution and output ownership

All canonical and historical command names use the ordinary `ExecuteCommandTool` collector.
Eligible native `exec_command` ripgrep searches of 1–16 explicit regular files can start after a completed tool item
has durable acceptance, serial approval and the scheduler effect fence, while the provider response tail is streaming.
The prepared adapter uses that same collector, session registry and archive writer, with a trusted executable,
direct argument vector and captured environment. It revalidates the captured scope, executable, ignore state
and authority immediately before launch; it never reinterprets an audited command through a shell profile.
Directory/default traversal, glob/type selection, file-list and pattern-file forms, Git, interactive TTY and other
ineligible commands retain ordinary execution after the provider response boundary. Admitted files must pass both
lexical/real workspace scope and existing ignore/protected-file checks. Changes to captured file identity or those
controllers before launch revoke early admission.
Explicit pattern options apply to all positional files, including files before a later `-e` or `--regexp`; `--` keeps its
ordinary argument meaning. Every actual target receives the same checks.
This is a bounded eligibility contract, not a claim of general Codex CLI parallelism or measured speed improvement.

Physical collection and archive flush/close continue while presentation is held. Eight coalesced presentation slots
retain current output for the existing ordered scheduler finalizer. Opening flushes one finite snapshot, so continuing
background output cannot hold the assistant commit until process exit. The scheduler's synchronous acknowledgment then
transfers pending and ongoing projections to one ordered, bounded background drain. Command-output UI, completion-evidence
publication and the terminal tool receipt wait for the assistant response to be durable. They cannot block
physical completion or archive finalization while waiting. Cancellation/discard suppresses held presentation
and joins only its original process ownership; a later task, session or replacement process is never released.
Yield still returns a live command session; it is not a process-killing timeout or permission to rerun a command.
The former separate audited executor remains retired.

Prepared-command disposal observes the original physical abort, passive archive closure and ordinary producer together.
A local 15-second observation deadline reports unconfirmed cleanup and retains the original ownership pins. This limit
is separate from the archive writer's flush/close deadlines. A later explicit cleanup retry observes the same settlement;
it neither relaunches the command nor invents physical exit. An already-reported producer error remains the tool failure
when cleanup itself succeeds; physical, archive and ownership cleanup failures remain failures.
If cancellation or finalization also fails cleanup, the scheduler stages the accepted call's truthful terminal receipt
before reporting the cleanup failure. Deferred commit rejects the exact reason; ordinary execution returns a truthful
failed outcome through its existing receipt boundary. Retained pins and a failed cleanup never become a completed batch.
A rejected run that never returned a finalizer still joins its original cleanup before later admission or result commit.
Its bounded failure-only projection settles command evidence after assistant durability; raw output remains suppressed.
Public discard and Stop revoke that projection. A committed command error cannot leave its command evidence running.
Asynchronous timeout error projections check ownership inside the operation before and after an awaited message, before
any later Task state mutation. Releasing a held old message after Stop or replacement cannot mutate the replacement lifecycle.
Actual prelaunch policy revocation is a known, no-effect denial; observation faults remain errors and cancellation remains
cancelled. Native agent yield and the captured policy's process-lifetime timeout keep separate meanings.

`BaseTerminalProcess` owns a 1 MiB pending-output buffer and an independent 1 MiB completion transcript.
Head/tail retention preserves early and recent text and makes middle omissions explicit.
These are per-process bounds, not a total limit across running commands.
Receipt delivery is transactional: capture reserves output, successful delivery commits it, and release allows retry.
An active reservation survives buffer pressure; new bytes cannot be consumed by its earlier commit.
Receipt boundaries and retained text preserve Unicode scalars, including across repeated drains.
This assumes valid incoming text chunks. Host delivery that already splits UTF-16 surrogate pairs
across chunks has not been verified.

`CommandSessionRegistry` retains at most 64 eligible finalized settled sessions per Task instance and
64 compact expiry receipts with host execution identity, known exit code and finalized artifact reference.
Physical commands, output finalizers and active receipt reservations pin their sessions until safe release.
Pins can exceed the settled-session limit. Alpha does not evict a live process to satisfy LRU pressure.
Session IDs cannot control another Task instance or a replacement command in a reused terminal.

Raw archival writes are attached before collection and remain active after UI line listeners detach.
The producer awaits backpressure. Completion and reader-error paths share one idempotent output finalizer.
Finalization joins flush/close; failure paths destroy the sink under a bounded close deadline.
Flush and failed-close each have a 5-second deadline; a failure path can therefore take up to 10 seconds.
An interrupted or incomplete archive never receives a complete artifact ID; real I/O failures stay failures.
Approved Stop can cancel a blocked writer without inventing successful persistence or physical exit.
Successful artifact references remain available in final polls, durable output messages and compact expiry receipts.
Expiry without an artifact is explicit; an unavailable session is never relaunched by polling it.

Explicit polls return active partial text without requiring a newline. Legacy line/UI consumers retain
their complete-line behavior. VS Code cleanup carries split OSC/CSI state only with committed receipts,
and completion transcripts exclude shell prompts after the command-end marker.

## Command presentation and durable identity

The Task that creates a command approval row owns its presentation identity. An optional internal receipt
carries that exact row timestamp through the existing typed approval and boolean tool callback path.
The receipt describes an existing row; it grants no execution authority. Normal and automatically approved
asks reuse their row. Approved reviewer or exact-session paths that create no ask receive one answered
presentation row from the Task before launch, without repeating approval or changing pending input ownership.

The frozen command-row timestamp identifies UI status events, partial/final output and the numeric archive
filename for that invocation. A separate nonce-bearing physical execution identity continues to own the
process, command session, mutation reservation and file-change provenance. Historical numeric and UUID
archive readers remain compatible. Repeated commands must not reuse another invocation's output archive.

Tagged cumulative command output updates its original row by exact command identity, including when
another command or ordinary message has arrived in between. Partial updates and finalization preserve the
output row's timestamp and command ID through publication, persistence and reload. Tagged output cannot
adopt a legacy ID-less row or overwrite a different command. ID-less histories retain their adjacent-output
compatibility behavior. New ask, say and completion rows reserve distinct Task-owned timestamps separately
from the timestamp that controls pending user input; noninteractive output does not supersede an ask.

## Interactive controls and intentional limits

Native `exec_command` treats omitted, null or false `tty` as pipes; `tty: true` requests the VS Code PTY adapter.
Historical `execute_command` arguments without `tty` retain the configured transport.
PTY availability follows Alpha's mode and managed-worker restrictions; explicit PTY requests do not silently fall back.
Custom `shell` and `login` options remain unsupported and are not advertised.

Only an exact approved `\u0003` invokes provider-owned interruption. Other pipe stdin remains unsupported;
mixed text containing Ctrl-C is not reinterpreted as an interrupt. Literal PTY input keeps its existing approval path.
Approval and the workspace mutation gate are followed by physical Task/session/process identity rechecks.
A failed output reader does not prove physical exit: a still-running command retains its handle and safe interrupt route,
while literal-input authority is not restored. Finalization and physical liveness remain separate conditions.
POSIX pipe interruption targets the owned process tree with SIGINT. Windows pipes use the existing owned-tree stop
because the adapter cannot deliver console Ctrl-C to that transport.
This stop never substitutes a synthetic exit code of 130.
Yield deadlines return control; configured command lifetime limits and approved Stop retain separate cancellation ownership.

Alpha's provider-neutral policy, approvals, workspace protections, mutation receipts and cancellation remain authoritative.
Its skills, HTML previewer, Alpha Tickets and scheduled tasks remain integrated capabilities of the same harness.
Codex CLI sandbox implementation is outside this alignment scope.

## Evidence and remaining gates

The prepared-ripgrep adapter is a separate source change from the earlier results below. It requires fresh
collector/preparation/cancellation regressions, affected types/lint and the unchanged held-tail case in the exact
VS Code 1.125.0 host gate. Historical output-buffer and session results do not validate this adapter or establish
release acceptance. Its source packet has not been executed by the authors.

One source-backed pure-method probe used controlled transport fixtures: all 21 candidate observations passed;
the baseline failed 19 target observations and passed two controls. That probe mocked archival I/O.
The real Vitest run with the reviewed Task-fixture amendment selected 27 baseline cases: 20 intended failures
and seven passing controls, with 30 cases filtered. All 57 candidate cases passed across
`commandSessionConvergence.spec.ts` and `commandOutputConvergence.spec.ts`.
The latter includes a real temporary-file `OutputInterceptor` write/read after backgrounding, cleaned in `finally`.
Transport/process fixtures do not establish live provider, real PTY or full `ExecuteCommandTool`
plus host/process archival behavior.

Central post-integration acceptance remains pending: broader owning command, scheduler and cancellation tests,
extension types/lint, and a rebuilt exact VS Code 1.125.0 smoke gate. Use Node 24.21.0 and pnpm 11.24.0.
Run focused Vitest file filters directly after `test`, without a standalone `--`:

```sh
pnpm --dir src test core/tools/__tests__/commandSessionConvergence.spec.ts integrations/terminal/__tests__/commandOutputConvergence.spec.ts
pnpm --dir src check-types
pnpm lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```
