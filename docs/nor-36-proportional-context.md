# NOR-36: proportional investigation and context

Reference: Alpha 2.1.23, commit `530d737ec07ba6c4feac0f6745960de224496944`, inspected September 5, 2026 UTC.

## Scope and evidence

The broader report of excessive investigation is qualitative. Existing objective instructions already ask for
proportionate work; `EnvironmentContext` already omits unchanged fields and retains the workspace listing across steps.
Path-only `FileContextTracker` records do not establish which ranges remain available, content freshness, or current
authority. They cannot safely suppress a subsequent read. No extra prompt wording or read/check cache is introduced on
that evidence.

NOR-33 owns verification recognition and NOR-37 owns finalization. Whole-task fixtures must separate discovery,
implementation, validation, and finalization, and leave missing measurements unavailable. Their results must not attribute
runtime repair costs to model strategy. Integration of those changes precedes final-stage savings claims or changes to
shared Task/StepContext contracts. Scripted-provider correctness is distinct from live-model task strategy.

## Scoped-read baseline and predeclared acceptance

The independent formatting workload invokes the actual `readWithSlice` implementation with freshly generated inputs of
128, 8,192, and 65,536 lines and a 20-line middle slice, three samples each. Run with Node 20.19.2 and pnpm 10.8.1:

```sh
pnpm exec tsx scripts/benchmarks/scoped-read.ts
pnpm --dir src test -- integrations/misc/__tests__/indentation-reader.spec.ts
```

Before runtime edits, the benchmark observed respectively `[128, 128, 128]`, `[8192, 8192, 8192]`, and
`[65536, 65536, 65536]` `trimStart` calls. Each call corresponds to source-line indentation analysis in `parseLines`.
Returned content measured 699, 779, and 819 bytes. A focused regression failed because reading 20 lines analyzed all
10,000 lines; the other 50 assertions passed.

Acceptance declared after that baseline and before implementation: slice formatting must analyze no more than the
requested 20 lines, preserve the entire returned value exactly, and pass text/line-number/metadata parity checks including
CRLF, Unicode, blank/trailing lines, long lines, and fractional offset coercion. Retain full-file line counting, exact
tool output, indentation-mode behavior, fresh disk reads, approval, ignore rules, and cancellation boundaries.

This benchmark measures local formatting work only. Tool/model calls, input tokens, and output bytes should remain
unchanged. It has no provider, tokenizer, warm-result cache, or wall-time assertion. The proposed whole-task 25% call and
20% input-token targets are not established by this workload. An uncontended timing window is required before comparative
wall-clock claims.

## Existing incremental-context baseline

The existing deterministic environment measurement was also run unchanged:

```sh
pnpm --dir src exec vitest run core/environment/__tests__/environment-measurements.spec.ts --silent=false
```

Its fixed 50-file workspace produced 1,686 bytes / 492 `o200k_base` tokens on the first capture, zero bytes/tokens on an
unchanged step, 225 bytes / 69 tokens after an editor change, 288 bytes / 84 tokens after a terminal-state change, and
zero bytes/tokens after the subsequent edit flag. Both tests passed, including cancellation with no remaining timers.
These token counts use the existing local tokenizer; they are neither provider billing nor a whole-request measurement.
The zero fake-timer latency is a scheduling contract, not a measured speedup. No environment implementation changed in
this ticket. This baseline provides no evidence for adding another unchanged-environment suppression mechanism.

## Scoped-read result

The paired run after the change used the same command, inputs, runtime, and three samples per input size. All
indentation-analysis counts became `[0, 0, 0]`. Output byte counts remained 699, 779, and 819. The complete return-value
SHA-256 digests matched before and after:

| Source lines | Result digest                                                    |
| ------------ | ---------------------------------------------------------------- |
| 128          | ca91f08e6dd7cbd67a0bc58a0b8955dfd100ac0b157296041a729839f8ebb201 |
| 8,192        | 9c20e4dda14bb84bdc20f5467e7856c6494caed362995aefb7a1e4f52da3ef36 |
| 65,536       | 886b8ce062eccaecf06104f52e3bebe5e227134752f5a257ab560b42911d3ed7 |

`readWithSlice` now selects raw lines before creating position/content records. `formatWithLineNumbers` accepts those
two fields without requiring indentation metadata; existing indentation readers still supply full records. The full
string split remains necessary for the existing exact total-line count. No read result is cached or omitted, and no
persisted, provider, tool-policy, or completion contract changes.

The focused indentation-reader suite passed all 51 tests after the change. Independent invariant review found no
correctness issue; source line endings were restored to avoid unrelated diff churn. Broader checks are recorded with the
whole-task fixture handoff once dependencies finish building.

## Scripted task baseline and remaining acceptance

The seven [fixtures](../evals/proportional-scope/README.md) ran through the real turn engine and scheduler with fixed
scripted decisions, fixture tool executors, temporary workspace copies, and Node validation subprocesses. One measured
sample per case produced the following baseline; all fixture oracles passed. There is no candidate call-reduction claim.

| Fixture                  | Model requests | Tool results | Commands | Tool-output bytes | Discovery / implementation / validation / finalization tools |
| ------------------------ | -------------: | -----------: | -------: | ----------------: | ------------------------------------------------------------ |
| Conversation evidence    |              1 |            0 |        0 |                 0 | 0 / 0 / 0 / 0                                                |
| Narrow lookup            |              2 |            1 |        0 |                36 | 1 / 0 / 0 / 0                                                |
| Small edit               |              4 |            3 |        1 |               171 | 1 / 1 / 1 / 0                                                |
| Cross-component bug      |              6 |            5 |        1 |               534 | 2 / 2 / 1 / 0                                                |
| Security change          |              4 |            3 |        1 |               178 | 1 / 1 / 1 / 0                                                |
| Comprehensive audit      |              6 |            5 |        0 |               856 | 5 / 0 / 0 / 0                                                |
| Stale-context escalation |              6 |            5 |        1 |               391 | 2 / 2 / 1 / 0                                                |

Each case has one final ordinary-text response. Model tokens and completion-stage counters are unavailable in this fixture
host. The escalation case includes one refused stale mutation, a reread, and a successful retry preserving the external
edit. The scripted fixture implements that version check; it is not proof of production stale-write or approval handling.
Do not shorten the response scripts in a paired run to manufacture savings.

`apps/vscode-e2e/src/suite/proportional-context.test.ts` adds real Task request capture for a conversation-only answer and a
known-file lookup, three fresh tasks per scenario. It measures system/message/schema bytes and the environment subset,
requires actual read evidence and visible ordinary-text completion, and leaves provider tokens unavailable. It is compiled
and statically checked but its host run is pending central integration. It does not change Task or its completion policy.

The full NOR-36 acceptance remains **pending**: integrate NOR-33/NOR-37, collect their completion-stage evidence, execute the
new real-Task fixture, and use comparable task/provider traces to select any remaining call/context intervention. No soft
effort classification, cross-step evidence cache, lower command cap, or additional prompt policy is justified by the
measurements above. No live-model quality result or 25% call / 20% input-token achievement is claimed.

## Validation and handoff

- Before the slice change: one intended operation-count regression failed, 50 tests passed.
- After the slice change: 97 indentation/read-tool tests passed; the paired formatting benchmark preserved every digest.
- The unchanged environment measurement suite passed both tests.
- Seven engine/scheduler fixture cases and 13 report/fixture-calibration tests passed.
- Extension package typecheck and full lint passed. E2E package typecheck, full lint, and CommonJS test compilation passed.
  Repository-wide `pnpm lint` also passed all 12 package tasks. Staged formatting ran via `pnpm exec lint-staged` for each
  commit; the hook wrapper was disabled only for commit creation because it invokes `npx`, contrary to the pnpm-only
  contract. Its formatting and lint checks were executed explicitly, and original CRLF source bytes were preserved.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` built the extension/webview and downloaded exact VS Code 1.122.1,
  then failed before loading tests because the Windows launch truncated development/test paths at `C:\Users\Luke`.
  No runner source was changed. A short-path `node --preserve-symlinks-main` launch subsequently passed `extension.test`
  (two tests) and `modes.test` (two tests) on exact 1.122.1. The remaining LM suite, new context suite, and full required
  gate are delegated to the orchestrator's directory without spaces; further parallel host launches were stopped.
- No lifecycle/delegation contract changed, so managed-agent certification was not triggered by these changes.

Two actual GPT-6 Astra/high sub-agents contributed: `/root/scope_cost_fixtures` implemented the reviewed fixture/report
portion; `/root/context_invariant_review` independently reviewed slice correctness and authority/invalidation constraints,
then added the isolated real-Task E2E fixture. The parent reviewed both contributions and ran the reported focused checks.

## Review corrections before fixture integration

Independent review identified two attribution errors: command count followed the observer's category rather than the
canonical tool identity, and unidentified usage rows could satisfy count-only coverage. Commands now depend solely on
`execute_command` identity; token metrics require a valid one-to-one request-index mapping supplied by the observer for
request-start events and by canonical usage records. Missing, duplicate, invalid, or mismatched identities yield
unavailable usage. Six focused assertions reproduced the failures before the correction; all 23 reporter/oracle tests
passed afterward.

The real-Task fixture now attempts each cleanup independently and preserves primary failures through cleanup failures.
Six host-independent support tests cover synchronous/asynchronous and nested cleanup failures, thrown `undefined`, and
strict provenance projection. It reports only after cleanup succeeds, labels provider-emitted calls accurately, and
requires external source/build/configuration/cache declarations as documented in the fixture README. Fresh tasks share
one host; no cold-host equivalence is claimed. E2E package typecheck and lint passed. No host launch accompanied these
review corrections; exact-host acceptance remains with central integration.
