# Command inspection batches

Implemented September 14, 2026. This extends the command batching guidance and progress observer described in
[tool-progress-observation.md](tool-progress-observation.md).

## Behavior

The model can request several independent inspections in one response. `ToolScheduler` collects each command's existing
explicit approval serially, then runs eligible inspections in separate noninteractive processes. The default window is
four calls, using the scheduler's existing bounded concurrency. It joins the entire window before publishing results in
model-call order or starting a subsequent mutation. Each accepted call retains its own approval, result ID, exit status,
and cancellation receipt. Requesting several commands together already saves model round trips even when their execution
is serial; concurrent processes additionally reduce time spent waiting for independent commands.

The built-in `execute_command` descriptor remains serial and workspace-affecting. Its captured `parallelCommandRead`
capability enables a separate audited preparation hook; only a successfully prepared inspection can enter the concurrent
lane. Ordinary parallel-read metadata, model arguments, and auto-approval settings cannot grant this capability. The
prepared processes have no approval or shared Task/UI callback. Their finalizers publish command evidence and output after
all workers have settled. Command evidence remains bounded and does not confer verification credit for workspace changes.

Overlapping command read scopes may share a window because they are audited independent readers. Other overlapping tool
scopes, mutations, terminal interaction, and lifecycle barriers retain their existing serial behavior. Cancellation joins
already started processes and closes queued calls without starting them.

## Eligible operations and compatibility

- Primary tasks only, subject to the current Code/Plan tool policy. Plan does not gain any additional command authority.
- Common `rg` content and filename searches with the existing explicit argument allow-list. No shell expansion, scripts,
  processors, pattern files, or following links. Arguments are passed directly to the resolved executable.
- Selected `git status`, `diff`, `log`, `show`, `ls-files`, `ls-tree`, and `rev-parse` forms. Git runs with optional index
  updates, pagers, external diff/text conversion, configured signature formatting, and lazy object fetching disabled.
- Git must support `--no-lazy-fetch`. A bounded capability probe runs under the first command's approval and is cached for
  up to sixteen executable identities. Unsupported binaries retain serial execution and reuse that exact approval for
  the first fallback. This machine's Git `2.43.0.windows.1` uses the fallback; subsequent commands avoid the probe.
- Commands with verification declarations, unrecognized options, a nonempty `.alphaignore`, custom Git environment
  configuration, `RIPGREP_CONFIG_PATH`, or submodule configuration retain the existing serial handler. Executables located
  inside the workspace are excluded. Scope, mode, disabled-tool settings, command denial rules, and ignore-controller
  identity are revalidated before launch.
- Concurrent inspections finish within 60 seconds or a shorter requested/captured timeout. Output is bounded to 1 MiB per
  process stream; exceeding that bound is an error asking for a narrower inspection. Existing output artifacts preserve
  larger successful results with bounded previews. The remaining command forms retain their existing terminal behavior.

`ClineMessage.commandExecutionId` is an optional association between a batched output and its approval timestamp. The
shared message projection uses it to attach output to the correct command across intervening approvals and reloads.
Messages without the field keep the legacy sequential projection. No provider tool schema or transcript call ID changes.

## Measurements

The deterministic scheduler fixture uses the same twelve inspections, immediate individual approvals, a 100 ms fake
process duration, and a four-call window. It uses no network, live model, or warm/cold repository cache.

| Scheduler workload                            |   Before |    After |
| --------------------------------------------- | -------: | -------: |
| Selective-parallel mode, virtual elapsed time | 1,200 ms |   300 ms |
| Peak active inspection processes              |        1 |        4 |
| Explicit approvals / terminal receipts        |  12 / 12 |  12 / 12 |
| Serial control, virtual elapsed time          | 1,200 ms | 1,200 ms |

The new assertion failed before implementation with 1,200 ms instead of 300 ms. This is a scheduling regression threshold,
not a prediction of live-model speed, Git performance, human approval time, or API cost. The real-process integration test
separately runs four `rg` inspections through the built-in registry and checks result identity, output association, and
unchanged fixture contents. The shared inspection prompt grows from 75 to 84 `o200k_base` tokens; live cache effects and
model adoption of batching have not been measured.

The existing `Task.inspection-batching.spec.ts` scripted-provider fixture separately compares one versus four calls per
model response for twelve inspections: thirteen versus four model steps, including the final synthesis. Commands and
individual approvals remain twelve in both runs. This checks the round-trip mechanism; prompt-driven batching frequency
with a live model remains unmeasured.

Reproduce the focused checks:

```sh
pnpm --dir src test -- core/agent/__tests__/ToolScheduler.command-batching.spec.ts core/tools/__tests__/ParallelCommandRead.spec.ts core/tools/__tests__/ParallelCommandRead.integration.spec.ts
pnpm --dir src test -- core/task/__tests__/Task.inspection-batching.spec.ts
pnpm --filter @alpha-code/core test -- src/message-utils/__tests__/consolidateCommands.spec.ts
pnpm --filter @alpha-code/types test -- src/__tests__/message.test.ts
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

## Validation

- Affected scheduler, command, Task, registry, and prompt tests passed. Final regressions cover out-of-order process
  completion, cancellation, denial, serial fallback, mutation barriers, and approval feedback/output association.
- The real-process integration test passed on this host; it requires `rg` on PATH.
- Shared package suites passed: 166 core tests and 302 type/schema tests, including legacy message compatibility.
- Lint and type checks passed for `alpha`, `@alpha-code/core`, and `@alpha-code/types`.
- The rebuilt `test:smoke:1221` gate passed on VS Code 1.122.1: extension activation, modes, and VS Code LM contracts.
- Touched-file formatting and whitespace checks passed; no lockfile or protected CLI/shim changes were introduced.

## References

Primary references checked September 14, 2026: [Codex parallel tool calling](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#parallel-tool-calling),
[Git process controls](https://git-scm.com/docs/git), [external diff and text conversion](https://git-scm.com/docs/git-diff),
and [Git configuration](https://git-scm.com/docs/git-config). The latest Git manual reported version 2.55.0; the local
2.43.0 binary was checked directly and does not accept `--no-lazy-fetch`.
