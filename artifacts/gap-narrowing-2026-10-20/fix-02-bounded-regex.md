# Fix 02: bounded command-output regex search

Date: 2026-10-20, America/New_York. Repository HEAD: `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`.
Mode: performance optimization and operational hardening, bounded to command-output artifact search.

## Defect and owning boundary

`ReadCommandOutputTool` accepted `a+$` but synchronously applied `/a+$/i` to each artifact line on the extension host.
A legal 65,536-byte line containing 65,535 `a` characters followed by `!` caused seconds of backtracking. The line-size
bound controlled memory, but neither cancellation nor an asynchronous timeout could interrupt the synchronous match.
Both historical `read_command_output` and native `write_stdin` artifact reads reach this owner through `ManageCommandTool`.

The regression was added before the production edit and failed for the intended reason: the tool emitted a successful
"No matches found" receipt after 3.38 seconds instead of a bounded failure. The focused red command was:

```sh
pnpm --dir src test core/tools/__tests__/ReadCommandOutputTool.test.ts -t 'bounds an accepted nonmatching regex' --maxWorkers=1
```

## Implementation and preserved behavior

- Regex compilation and matching now run in `src/workers/searchCommandOutput.ts`. Artifact IO, UTF-8 decoding, line
  numbers, output rendering, receipts and byte-offset accounting remain in `ReadCommandOutputTool`.
- The helper admits at most two active searches and eight queued searches. Queue waits expire after five seconds.
  Each batch has a one-second watchdog, and each admitted search has a 30-second overall deadline.
- Each batch is limited to 65,536 candidates, 256 KiB of decoded content and the existing 64 KiB individual line bound.
  The aggregate bound allows invalid UTF-8 replacement expansion plus one preceding partial line. The worker also has
  explicit V8 heap/stack limits. Only one batch may be outstanding per worker.
- Cancellation and deadlines stop the worker immediately, including while artifact cleanup remains pending. The owning
  operation awaits termination before publishing a result or releasing its admission slot. Timers, abort listeners and
  worker listeners are removed; error guards remain attached while Node drains events before worker exit.
- A primary search failure retains its identity when cleanup succeeds. Cleanup failure is observable; a simultaneous
  primary failure is retained as the cause and first error of an `AggregateError`.
- Case-insensitive matching, accepted regex syntax, invalid-regex literal fallback and the existing unsafe-pattern
  rejection remain intact. Matching is batched rather than a sequential IPC round trip for every line.
- A worker stops at the same rendered output budget as the host. It does not evaluate later expensive nonmatches or
  advance `nextOffset` past the returned page. Existing CRLF, UTF-8, EOF, long-line and pagination coverage stays green.
- A timeout emits one error receipt and no success telemetry. External cancellation propagates to the existing scheduler
  receipt owner without an extra tool result. No execution-policy, provider-selection or public wire contract changed.

## Repeated local measurement

Workload: identical `/a+$/i` nonmatch against the legal 65,536-byte line above. Node `24.21.0`, Windows, no provider/model,
three samples per condition, a fresh worker per sample. The baseline runs the original synchronous operation inside a
terminable worker with an independent eight-second watchdog, keeping the benchmark controller responsive. Its
`setImmediate` delay represents the event-loop stall when matching owns that thread. The after condition bundles the
actual helper and actual worker into a newly created temporary directory and measures the controller event loop while
matching runs off-thread. Translation is replaced only in this benchmark to avoid unrelated extension initialization.

```sh
node artifacts/gap-narrowing-2026-10-20/fix-02-regex-benchmark.cjs
```

| Condition | Sample wall time, ms           | Event-loop delay, ms           | Outcome                             |
| --------- | ------------------------------ | ------------------------------ | ----------------------------------- |
| Before    | 4,305.34 / 6,238.42 / 6,590.67 | 4,268.70 / 6,191.08 / 6,531.77 | Nonmatch after blocking             |
| After     | 1,020.76 / 1,013.92 / 1,005.68 | 3.15 / 1.04 / 0.97             | Truthful timeout; worker terminated |

An earlier bounded diagnostic measured 2,491 / 2,830 / 3,386 ms for the same match. Other review agents were active, so
these timings are local responsiveness evidence, not a general throughput or quality claim. The intentional change is
bounded failure with a responsive owner for expensive patterns, not a claim that every search becomes faster.

## Current upstream evidence

Inspected local current Codex source at commit `c7234c1174b27d9c55199fba0d546dc27d1b0415`, retrieved 2026-10-20:

- [write_stdin schema](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/tools/handlers/shell_spec.rs#L110):
  the upstream tool exposes session ID, input characters, yield time and output-token budget; it does not expose Alpha's
  artifact regex search. Alpha deliberately retains this extension capability through the shared tool owner.
- [write_stdin handler](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs#L50):
  the handler carries its invocation cancellation token into the unified-exec context. Alpha likewise carries scheduler
  cancellation into the search owner, its filesystem awaits and the worker; no alternate task engine was introduced.
- [Node worker termination contract](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerterminate),
  retrieved 2026-10-20 (served Node 24.22 documentation): termination interrupts worker JavaScript asynchronously and its
  promise completes on worker exit. The implementation therefore keeps its admission slot and error guards until that
  promise settles. It uses long-established worker APIs, not recently introduced Node or VS Code APIs.

## Validation and scope

- Before fix: the new focused adversarial regression failed, 78 other tests skipped; 3.38-second test body.
- After implementation: 99 tests passed across `ReadCommandOutputTool.test.ts`,
  `commandOutputSearch.lifecycle.spec.ts` and `ParallelCommandRead.integration.spec.ts`, 22.39 seconds.
- Final cleanup-error refinement: **101 tests passed** across the same three files, 54.54 seconds, using:

    ```sh
    pnpm --dir src test core/tools/__tests__/ReadCommandOutputTool.test.ts core/tools/helpers/__tests__/commandOutputSearch.lifecycle.spec.ts core/tools/__tests__/ParallelCommandRead.integration.spec.ts --maxWorkers=1
    ```

- Scoped ESLint across all six touched TypeScript files completed with exit code 0 after removing a throw from `finally`.
- Only touched files were formatted. `git diff --check` passed for the tracked implementation/test/locale diff.
- Lifecycle coverage uses controlled promises and fake timers for admission bounds, queued cancellation/expiry, active
  cancellation, delayed termination, pending artifact cleanup, total deadline, malformed replies, worker error/exit,
  startup/post failures, candidate bounds and cleanup failures. Real-worker tests assert `threadId === -1` and listener
  cleanup after timeout and cancellation.
- The two native artifact-search integration cases initially exposed a source-test worker-path issue. Their test seam
  now transforms the current worker source in memory with the existing esbuild dependency, so focused tests need no
  pre-existing `dist` output. Code and Plan integration cases passed after that correction.

Owned files: `src/core/tools/ReadCommandOutputTool.ts`, `src/core/tools/helpers/commandOutputSearch.ts`,
`src/workers/searchCommandOutput.ts`, `src/core/tools/__tests__/ReadCommandOutputTool.test.ts`,
`src/core/tools/helpers/__tests__/commandOutputSearch.lifecycle.spec.ts`, the minimal worker seam in
`src/core/tools/__tests__/ParallelCommandRead.integration.spec.ts` and
`src/core/tools/__tests__/ManageCommandTool.astra-audit.spec.ts`, English `commandOutputSearch` keys in
`src/i18n/locales/en/tools.json`, and this report/benchmark harness. No dependency, lockfile, version or unrelated file was
intentionally edited. Two `pnpm exec` validation calls unexpectedly auto-ran workspace install hooks; no explicit install
was requested, and the coordinator was informed.

Packaging owner fix-14 owns the new esbuild entry and VSIX-content verification for
`dist/workers/searchCommandOutput.js`. Parent owns broad validation, extension typecheck and the exact VS Code
1.138.0/minimum-host gates; this agent does not claim those gates passed.

## Residual risks and closure

Fixed now: extension-host regex blocking, unbounded regex execution, bounded admission/cancellation/cleanup, truthful
failure and page-boundary preservation. Worker startup and IPC add overhead to short searches. Legitimate work exceeding
a watchdog or the total deadline now fails explicitly; users can use a simpler pattern or read without searching. The
watchdog requests termination at its deadline; OS scheduling and existing filesystem cleanup can delay final completion.
The worker is stopped even while filesystem cleanup is pending.

Not verified here: live VS Code host behavior, final packaged worker presence, broad suites and cross-platform live runs.
No claim is made about unrelated tool-policy, command-admission, provider or sandbox gaps.

## Source-test fixture follow-up, 2026-10-21

The coordinator's complete extension suite exposed the same source-worker path prerequisite in the Code and Plan
artifact-read cases of `ManageCommandTool.astra-audit.spec.ts`. Added the same narrow, current-source worker seam used
by `ParallelCommandRead.integration.spec.ts`: only `searchCommandOutput.js` requests are redirected to an in-memory
esbuild transform of the actual worker entry source. Other worker requests retain their normal behavior. No production
file or API changed in this follow-up, and no generated worker prerequisite or global mock was added.

```sh
pnpm --dir src test core/tools/__tests__/ManageCommandTool.astra-audit.spec.ts core/tools/__tests__/ReadCommandOutputTool.test.ts core/tools/helpers/__tests__/commandOutputSearch.lifecycle.spec.ts core/tools/__tests__/ParallelCommandRead.integration.spec.ts --maxWorkers=1
pnpm --dir src exec eslint core/tools/__tests__/ManageCommandTool.astra-audit.spec.ts
```

Result: **4 files, 148 tests passed**, 21.43 seconds. Scoped ESLint and `git diff --check` for the added test seam passed.
The coordinator still owns complete-suite, package and exact-host gate results.
