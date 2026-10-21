# Fix 03: scheduled command process ownership

Date: 2026-10-20, America/New_York. Mode: operational hardening. Baseline HEAD:
`f67f53ee1f53929669cdda523d6cbd509ea0bfd1`.

This bounded pass addresses finding 1 in `artifacts/directory-review-2026-10-20/clean-07-extensions.md`.
It closes the reproduced timeout/disposal leak while a scheduled shell and its descendants remain owned. Windows
descendants that already escaped a terminated shell remain an explicit limitation, described below. Startup, Tickets,
recurrence/timezone, terminal presentation, CompletionHooks, and unrelated dirty work were not edited.

## Root cause and intended invariant

`ScheduledTaskService.executeCommandRun` used promisified `execFile(command, { shell: true, signal, timeout })`.
Aborting Node's shell process did not terminate its descendants. `dispose()` also cleared command controllers and
released the scheduler owner lease before those commands or their final durable writes had settled. A second window
could therefore recover a run while its old command continued working.

The scheduled service owns command admission, policy and durable status. A focused command runner owns bounded output,
deadline/cancellation and process-close coordination. Cross-platform tree discovery/termination belongs to the existing
terminal process utility, now shared. A stopped run must retain that ownership until cleanup settles and its failed
terminal status is attempted. Late close callbacks cannot convert a stop to success.

## Source-first evidence

Reviewed current Codex CLI commit `c7234c1174b27d9c55199fba0d546dc27d1b0415` from
`C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1` before changing production code:

- [exec.rs](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/exec.rs):
  expiration/cancellation stops a process group; cancellation permits bounded TERM cleanup and then kills remaining
  group members, including after the original child exits.
- [process_group.rs](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/pty/src/process_group.rs)
  and [process tests](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/pty/src/tests.rs):
  group ownership and a background-child exit assertion protect descendant cleanup.
- [Windows/pipe ownership](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/pty/src/pipe.rs):
  upstream can use a native Windows Job Object. Alpha retains its existing native taskkill utility; this pass does not
  add a native Windows binding or copy the upstream runtime. That is an intentional platform implementation difference.

Primary OS/runtime contracts retrieved 2026-10-20:

- [Node 24.21.0 child_process](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html): AbortSignal is
  analogous to killing the child; shell descendants require separate handling. Detached POSIX children lead a process
  group/session. Process exit and stdio close are separate boundaries.
- [Microsoft taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill):
  `/PID`, `/T` and `/F` select a process, its children and forced termination. Cleanup invokes the executable with an
  argument array, without a shell or command-string concatenation.
- [Apple ps source manual](https://raw.githubusercontent.com/apple-oss-distributions/adv_cmds/main/ps/ps.1) and
  [procps-ng ps source manual](https://gitlab.com/procps-ng/procps/-/raw/master/man/ps.1): explicit `-e`/`-o` selection,
  PID/process-group/state fields and empty headers support bounded, structured POSIX settlement queries.

## Exact changes

- `src/utils/processTree.ts`: extracted ExecaTerminalProcess's existing descendant discovery, taskkill, forced stop,
  physical POSIX settlement and exposed cleanup errors. Added validated ownership for an optional detached POSIX group,
  a 100 ms TERM grace followed by KILL, and group-member settlement even after a parent exits. Discovery and physical
  settlement each retain a five-second bound. Scheduled callers reject unverifiable missing Windows roots.
- `src/integrations/terminal/ExecaTerminalProcess.ts`: replaced private tree implementation with the shared utility.
  Existing force-stop semantics remain; `allowMissingWindowsRoots: true` explicitly retains terminal missing-root
  idempotence/compatibility while the terminal continues joining its subprocess promise.
- `src/services/scheduled-tasks/runScheduledCommand.ts`: runs the exact already-approved shell command, owns separate
  raw stdout/stderr buffers capped at 2 MiB each, decodes complete UTF-8, and joins tree cleanup with process close.
  Cancellation, timeout, reader errors and buffer exhaustion latch a failed outcome before stopping. Open-pipe shutdown
  is bounded at 11 seconds, after the shared utility's bounded cleanup phases. Cleanup errors remain in the run error.
- `src/services/scheduled-tasks/ScheduledTaskService.ts`: tracks command completion through cleanup and terminal write;
  repeated disposal is idempotent and owner lease release joins those completions. Existing failed-on-stop durable
  status, approval behavior and output truncation are preserved.
- `ScheduledTaskService.command-process.integration.spec.ts`: real service/store/process tests with a TCP READY
  handshake and real parent/descendant PID checks before the terminal write. The deadline callback is triggered after
  READY while native cleanup timers keep running normally; no arbitrary child-start sleep or live model is involved.
- `runScheduledCommand.spec.ts`, `processTree.spec.ts` and `ScheduledTaskService.terminal-durability.spec.ts`: controlled
  barriers cover cleanup/close ordering, first failure, repeated disposal, owner retention through durable write,
  output bounds, stream/start errors, cleanup errors, late/reentrant callbacks, missing Windows roots and shutdown bounds.
- `ScheduledTaskService.before-run.astra-audit.spec.ts` and terminal-durability tests: moved command mocks to the focused
  runner boundary. Approval and existing store/notification tests continue exercising their original contracts.

## Regression and validation

Environment: Windows, Node `v24.21.0`, pnpm `11.24.0`. All Vitest commands used `--maxWorkers=1`.

Before the production fix, the first real-service test failed for the intended reason:

```text
READY descendant survived scheduled-command disposal: expected true to be false
Test Files 1 failed (1); Tests 1 failed (1)
```

The child had announced READY, the service's queue/completion had settled, and `process.kill(childPid, 0)` still found
the child. The fixture's owned PIDs were forcibly cleaned in `finally`; there were no unhandled test errors.

After the fix:

- Nine focused files: **141 tests passed**. This includes scheduled approval, profiles, before-run advisory notifications,
  terminal durability, the command runner, the shared utility, terminal stop/physical-settlement units, and the real
  scheduled-command tests. Command:
  `pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.command-process.integration.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.terminal-durability.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.before-run.astra-audit.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.approval.spec.ts services/scheduled-tasks/__tests__/ScheduledTaskService.profiles.spec.ts services/scheduled-tasks/__tests__/runScheduledCommand.spec.ts utils/__tests__/processTree.spec.ts integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts integrations/terminal/__tests__/ExecaTerminalProcess.settlement.spec.ts --maxWorkers=1`.
- Existing real terminal cleanup coverage: **4 passed, 2 unrelated tests skipped**, using
  `pnpm --dir src test integrations/terminal/__tests__/ExecaTerminalProcess.integration.spec.ts --testNamePattern='real process tree|real shell' --maxWorkers=1`.
- Re-ran the real scheduled tests after adding an explicit queue-start type guard: **2 passed**. Both timeout and
  disposal verify dead parent/descendant PIDs before `completeRun`, failed durable status, and lease release after the
  terminal write. Command:
  `pnpm --dir src test services/scheduled-tasks/__tests__/ScheduledTaskService.command-process.integration.spec.ts --maxWorkers=1`.
- Changed-file ESLint, changed-file Prettier check and `git diff --check` passed. No broad build, typecheck, host gate,
  dependency install, lockfile mutation or commit was performed by this agent; the parent coordinates those final gates.
- Physical cleanup inventory found **0** `node.exe` processes matching the owned `alpha-scheduled-process-*` fixture and
  **0** matching temporary directories after the final test runs. Tests also verify known parent and descendant PID exit
  before persistence, rather than inferring cleanup from a callback or a signal request.

## Closure and limits

Fixed now: the reproduced ordinary scheduled-shell descendant leak on disposal/deadline, early command-owner release,
and success races during cleanup. Terminal regression coverage verifies the extraction preserves its active contracts.

Follow-up: a Windows process that already escaped/reparented after its shell disappeared cannot be reliably terminated
using that missing shell PID alone. Scheduled cleanup now reports this as unverifiable failure and bounds pipe draining;
it does **not** claim escaped descendants stopped. Full Windows containment needs a separately reviewed native process
ownership seam, such as a Job Object. POSIX processes that deliberately leave the owned group and evade the captured
descendant snapshot are likewise outside this utility's containment guarantee. This is not a sandbox change.

Not verified here: real Linux/macOS execution, exact VS Code 1.138.0 integration, minimum-host compatibility and the final
aggregate type gate. POSIX behavior has controlled tests and primary-source inspection, not a live POSIX execution claim.
Filesystem terminal writes retain their existing completion semantics; the 11-second bound applies to process/pipe
shutdown, not a forced cancellation of in-flight storage operations.
