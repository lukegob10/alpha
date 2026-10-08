# Workspace command reads during provider streaming

This bounded alignment change lets an audited native `exec_command` read start before provider EOF when `workdir` names the workspace by an absolute path or a nested relative/absolute path. The owning path is `Task.isPreEofReadonlyToolCall`; execution, approval, cancellation, and result publication remain in the existing scheduler and isolated command adapter.

## Reference and scope

Codex CLI source and tests were retrieved on 2026-10-07 (America/New_York; 2026-10-08 UTC) at commit `e974aad3b1a8f144273e882c614aefe69eaef615`:

- [Tool runtime](https://github.com/openai/codex/blob/e974aad3b1a8f144273e882c614aefe69eaef615/codex-rs/core/src/tools/parallel.rs): captures the advertising step's router, uses read/write admission for eligible/serial calls, and handles cancellation during admission and execution.
- [Tool parallelism tests](https://github.com/openai/codex/blob/e974aad3b1a8f144273e882c614aefe69eaef615/codex-rs/core/tests/suite/tool_parallelism.rs): checks overlap, call-order results, and shell execution before a delayed response completes.

Alpha's isolated command executor already resolved and checked explicit working directories. Its early eligibility check instead accepted only omitted workdir or `"."`, then classified every command relative to the workspace root. Ordinary model calls with an absolute directory therefore missed stream overlap; relative ripgrep targets could also be classified against the wrong directory.

Early admission now resolves native `workdir` with the executor's semantics, checks the task workspace and captured policy, and classifies the command relative to that directory. Canonical scope and approval are checked again during preparation and immediately before process execution. Requests requiring legacy `cwd` normalization continue through the ordinary staged adapter.

Intentional divergence from Codex: Alpha's early lane remains a maximum four-call ordered prefix of audited Git/ripgrep reads, with serial preparation/execution across early dispatches. Mutations, lifecycle tools, interactive terminals, verification commands, unclassified commands, and external tools retain their established staging. Results stay deferred until the assistant transcript is durable. Expanding command concurrency or the allow-list is outside this change.

## Deferred presentation correction

The new real-host test exposed a related violation on the existing early path: `ToolScheduler.run` called read finalizers before retaining deferred results. A real command finalizer records inspection evidence and calls `task.say("command_output")`, so output appeared and was persisted in UI history while the provider response was still open. The previous Task fixture had an empty finalizer and could not detect this.

The scheduler now retains those finalizers until `commitDeferredResults`. It joins them in call order, runs each at most once across concurrent commits and publication retries, drops held presentation on discard or cancellation before commit, and updates both retained receipts and the returned outcome if finalization fails. The normal scheduler path keeps its existing finalization timing. Task regression fixtures now include an observable finalizer and require presentation after assistant persistence.

## Controlled before/after measurement

Command:

```sh
pnpm --dir src test core/task/__tests__/Task.spec.ts -t "measures read overlap" --silent=false
```

The same Task stream, captured surface, isolated read fixture, and fake clock were used before and after. The provider tail takes 200 ms, the read takes 300 ms, and assistant persistence takes 100 ms. The persistence store's disk receipt is stubbed for this timing fixture; separate interaction and extension-host tests verify durable admission and call/result ordering. The fixture has one provider request, one read effect, no retries, and no cache/network/provider variation.

| Native workdir            | Before |  After | Read starts before EOF, after |
| ------------------------- | -----: | -----: | ----------------------------- |
| `"."`                     | 400 ms | 400 ms | Yes                           |
| Absolute workspace        | 600 ms | 400 ms | Yes                           |
| Nested relative directory | 600 ms | 400 ms | Yes                           |

The two affected cases remove 200 ms of serialized waiting in this fixture (33.3%). This measures scheduling overlap, not live-model speed, filesystem throughput, or overall task quality. The regression requires the read to start before EOF and the total controlled time to remain 400 ms.

## Validation

Focused tests cover each working-directory spelling, legacy argument staging, delayed assistant persistence, lifecycle barriers, provider failure/cancellation, cancellation during an active read, and repair of an omitted accepted call. Adapter tests cover relative/absolute escapes, escaping junctions, a narrower captured workspace policy, and a directory replaced by an escaping junction after approval. Scheduler regressions cover discarded presentation, cancellation before commit, finalizer failure, publication retries/concurrent commits, and rejection of the isolated early path under serial execution policy.

The exact-host scripted test runs real extension-bundled ripgrep from absolute and nested working directories while holding the provider stream open. It checks durable acceptance before each effect, deferred presentation, exactly paired results in the next model request and persisted history, and one terminal task completion.

The VS Code LM fixture contract also proves physical read completion before EOF: it waits for all 400 matching lines in the command's bounded output artifact while the provider tail is held, then requires no UI output or terminal receipt until that tail is released. After release, presentation and the paired tool result appear once. This replaces an old assertion that depended on the premature UI publication corrected here.

Validation completed on 2026-10-08 UTC:

| Check                                                                   | Result                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Ten focused runtime Vitest files (exact filters in `final-runtime.log`) | 579 passed                                             |
| Controlled overlap benchmark command above                              | 3 passed; absolute/nested cases 600 ms to 400 ms       |
| `pnpm --dir src check-types`                                            | Passed                                                 |
| `pnpm --filter @alpha-code/vscode-e2e check-types`                      | Passed                                                 |
| ESLint and Prettier for the touched code/test files                     | Passed                                                 |
| `pnpm --dir src bundle`                                                 | Passed                                                 |
| `pnpm --filter @alpha-code/vscode-e2e test:vscode-lm:1250:run`          | 7 passed on exact 1.125.0                              |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                  | 42 passed across 13 exact 1.125.0 suites; zero pending |
| Scripted `core-loop.test` via the compiled E2E runner on exact 1.125.0  | 4 passed, including the new working-directory test     |

The retained working-directory run is `alignment-workdir-20261008-04`, with scripted model `core-workdir-read-stream`, profile `F:\alpha-e2e\profiles\alignment-workdir-20261008\1.125.0\user-data`, workspace `F:\alpha-e2e\alignment-workdir-20261008`, and evidence root `F:\alpha-e2e\artifacts\alignment-workdir-20261008`. Its receipts contain two provider requests, two calls, two results, one completed turn, and no transcript/lifecycle integrity errors. All final smoke runs verified host ownership, observed host exit, and reported actual VS Code 1.125.0. These are deterministic host checks; the measured speed conclusion is limited to the controlled fixture above.

## Evidence

Investigation logs, the initial working-tree snapshot, pinned upstream source, and benchmark receipts are stored outside the checkout at `F:\alpha-e2e\artifacts\tonight-alignment-20261007`. Existing user changes and the earlier composer/indexing work remain in place.

`overlap-before-after.json`, `core-workdir-read-stream.json`, `core-host-manifest.json`, and `smoke-1250-summary.json` record the final measurements and host results. `preservation-check.json` confirms that all 67 pre-existing tracked diffs match the initial snapshot and all 15 pre-existing untracked paths remain present. This follow-up adds no dependency, release-version, persisted-schema, or wire-protocol changes.
