# Custom-tool compiler shutdown mitigation

`runEsbuild` now passes `--no-concurrent-recompilation` and `--no-concurrent-sparkplug` only to its Node compiler child.
This mitigates a verified Node shutdown hazard in the force-exiting Go/WebAssembly CLI. The exact native cause of
Alpha's observed compiler hang remains unproven.

## Evidence and scope

Clean Ubuntu QA source `59125f2d86d47e513aefb30f02ecb832475ad179`, run `39616040387`, timed out the original later-directory
override test at its unchanged 60-second deadline. Owner-only diagnostic source
`327760f916a65908e66cc2a8b37463b2864a3d15`, run `39621789279`, reproduced that case with unchanged registry bundle bytes and
compiler arguments, without a compiler preload. Its seventh compiler was still alive after 53.25 seconds; the prior six
had exited and closed normally. The live compiler had accumulated 2.92 CPU seconds. Its three remaining threads—main,
V8 worker and signal inspector—were all sleeping in `futex_do_wait`. The owner was waiting for that compiler, before its
exit/close; this was not a registry import, source-lock wait, or stream wait after compiler exit.

[Node issue 54918](https://github.com/nodejs/node/issues/54918#issuecomment-5211891066), inspected October 21, 2026, reports
an exit-time cycle on Node 24.18.1: the main thread joins platform workers while background JavaScript compilation waits
for main-thread garbage collection. The installed esbuild-wasm **0.28.2** Go loader uses `go.exit = process.exit`.
The observed sleeping-thread shape makes that hazard relevant, but no native backtrace confirmed the same cycle here.
Two full-core stack-probe samples and a bounded, untouched 100-compiler probe at concurrency two passed without producing
a stack. Passing samples are not evidence that the intermittent fault is resolved.

The selected flags disable background optimizing and baseline JavaScript compilation in the compiler process. The
[Node 24.21.0 Maglev dispatcher](https://github.com/nodejs/node/blob/v24.21.0/deps/v8/src/maglev/maglev-concurrent-dispatcher.cc)
explicitly gates its work on `concurrent_recompilation`. Parallel WebAssembly compilation stays enabled. The parent
extension host, custom-tool execution, `NODE_OPTIONS`, compiler inputs/options and module-loader behavior are unchanged.
There are no retries, deadline increases, skipped assertions, runtime upgrades or compiler-byte changes.

## Measured cost and compatibility

A serial Windows 11/Ryzen 5800X experiment used Node **24.21.0**, Execa **9.6.0**, esbuild-wasm **0.28.2**, and the real
`fixtures-override/simple.ts`, with one warmup per arm followed by six alternating measured pairs. Both arms used the
same output path, working directory, environment and compiler options. Wall time includes spawn, exit and consumed-pipe
completion.

| Arm                          |     Median |               Range |
| ---------------------------- | ---------: | ------------------: |
| Existing compiler invocation | 975.248 ms | 879.534–1046.808 ms |
| Two child-only flags         | 906.783 ms |  893.255–924.745 ms |

The local flagged median was 7.02% lower. All fourteen invocations, including warmups, exited zero and closed both
streams; all outputs were identical: 2,753,363 bytes, SHA-256
`67788022ca8eeb396a38612a68baa47d63e03bd81bd44c5cde2d8132d424a599`. This small, warm-cache, single-machine sample does not
establish general performance or rare-failure reliability. Raw arguments, timings, hashes and limits are retained under
`artifacts/harness/release-3.2.7/compiler-jit-benchmark/`.

An isolated, ownership-verified exact **VS Code 1.138.0** extension host compiled a TypeScript dependency, generated an
inline source map, imported the result and verified `42` using the current runner and real packaged WASM CLI. Both real
contract tests passed and the host exited zero. Its runtime was Node **24.18.1**, Electron **42.10.0**, V8
**14.8.178.38-electron.0**; it already inherited `ELECTRON_RUN_AS_NODE=1`, so no host-environment change was needed.

The cached **1.125.0** executable also compiled and executed that workload in bounded Node mode, using the existing owned
process runner: Node **24.15.0**, Electron **42.2.0**, V8 **14.8.178.14-electron.0**. Its parent had neither mitigation flag
and was unchanged. This is executable/compiler compatibility evidence, not a minimum-host gate. A local full 1.125 host
launch was blocked before preflight by the existing updater mutex; the updater was left untouched. Normal exact-host
and release gates remain the coordinating agent's responsibility.

## Regression and cleanup

A regression invokes a private CLI through the public `runEsbuild` API and records the child's actual `process.execArgv`
and compiler arguments. It failed before the change because the child received no Node flags, then passed with exactly the two flags,
unchanged compiler arguments, and unchanged parent `execArgv`/`NODE_OPTIONS`. The real compilation, dependency, error,
banner and source-map tests remain in place.

The separate test-worker guard cleanup fix remains: abort synchronously and idempotently removes its owned loader hook.
That fixes a deterministic test-resource leak; it does not diagnose the compiler hang. All 34 original registry tests,
their assertions/deadlines, sixteen native directory scenarios and sixteen catalog regressions are preserved. Original
forced loads already recompiled TypeScript; the 105 compiler starts were not introduced by native-child isolation.
All temporary tracing, preloads, process observers and diagnostic workflow wiring are removed from the final candidate.

Focused validation results are recorded in the companion
[catalog investigation report](../artifacts/gap-narrowing-2026-10-20/fix-10-custom-catalogs.md).
