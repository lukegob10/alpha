# Harness finalization and diagnostic credential contracts

## Release validation: bounded legacy request normalization

CodeQL's `js/polynomial-redos` check identified repeated unclosed `<environment_details>` tags in human request text as
an extension-host denial-of-service path. The previous global block regex searched the remaining suffix again for each
opening tag. A child-process regression with 50,000 unclosed tags hit its five-second deadline before the repair.
The equivalent user-message wrapper also hit that deadline with 100,000 tags. Both paths now have the bounded regression.

The existing request extractor now scans fixed opening/closing delimiters and assembles the retained text. It keeps
the old case-insensitive, first-closing-tag behavior, multiple-block removal, unmatched-tag preservation, Unicode text,
human provenance checks, and request classification. This is an Alpha legacy-wrapper compatibility repair, not an
execution-policy or tool-authority change.

Current Codex CLI source was rechecked at **`ca466061d64f0b44f416135c7fd06aa7af850bbc`**, retrieved **2026-10-02**, including
[`tools/executed_tool_calls/request_metadata.rs`](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/core/src/tools/executed_tool_calls/request_metadata.rs)
and [`session/turn.rs`](https://github.com/openai/codex/blob/ca466061d64f0b44f416135c7fd06aa7af850bbc/codex-rs/core/src/session/turn.rs).
Upstream attaches host observations to structured request items; Alpha retains its own historical XML-style wrapper
reader. No upstream prompt, sandbox, or runtime implementation is imported.

The bounded child-process regression passes after the repair. Focused tests also cover ordinary wrapped requests,
nested/multiple blocks, unmatched tags, and a Unicode character whose lowercase form changes length, so delimiter
offsets always refer to the original text.

The next CodeQL analysis exposed an adjacent quadratic expression in ticket recognition: `number\s*` was followed by
another `\s*`, giving failed numeric references many equivalent whitespace splits. Removing the inner repetition
preserves accepted ticket spelling and whitespace while making the groups disjoint. A child-process probe with
100,000 tabs after `PM number`, followed by a non-ticket suffix, hit its five-second deadline before the change and
passes after it. Existing ticket questions and added mixed-whitespace variants retain their classifications.

## Reference inspected

Retrieved on **2026-10-02** from Codex CLI commit
[`c39bfa4c8ff9a57c46a9d3766676d6435e262691`](https://github.com/openai/codex/tree/c39bfa4c8ff9a57c46a9d3766676d6435e262691):

- [`core/tests/suite/abort_lifecycle.rs`](https://github.com/openai/codex/blob/c39bfa4c8ff9a57c46a9d3766676d6435e262691/codex-rs/core/tests/suite/abort_lifecycle.rs)
  holds an abort callback behind a controlled gate and verifies that it finishes exactly once before the terminal event.
- [`core/src/tools/parallel.rs`](https://github.com/openai/codex/blob/c39bfa4c8ff9a57c46a9d3766676d6435e262691/codex-rs/core/src/tools/parallel.rs)
  retains the step that advertised the tools, separates shared and exclusive dispatch, and creates structured failure and
  aborted outputs.
- [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/c39bfa4c8ff9a57c46a9d3766676d6435e262691/codex-rs/core/src/session/turn.rs)
  processes asynchronous hook results after sampling and tools finish, then considers pending input and model follow-up.
- [`secrets/src/sanitizer.rs`](https://github.com/openai/codex/blob/c39bfa4c8ff9a57c46a9d3766676d6435e262691/codex-rs/secrets/src/sanitizer.rs)
  and its tests redact supported credential patterns before diagnostic output, including Bearer tokens and secret
  assignments. This is a best-effort text sanitizer.

These observations support Alpha's existing finalization and result-integrity invariants. Alpha retains its TypeScript
turn engine, durable tool boundary, and approval protections. Its legacy/staged adapter compatibility and precedence
between callback failures are Alpha contracts; upstream does not define those adapter shapes. Alpha deliberately applies
stricter diagnostic redaction to complete Authorization and Proxy-Authorization fields, including authentication schemes
with multiple parameters.

## Workflow evidence and native completion

The workflow trace review refreshed Codex CLI main on **2026-10-02**, at commit
[`4dd51f4a5f2037f8aa322fe7807315e6530a4ec8`](https://github.com/openai/codex/tree/4dd51f4a5f2037f8aa322fe7807315e6530a4ec8)
(committed 2026-10-02 06:50:10 UTC).
[`core/src/session/turn.rs`](https://github.com/openai/codex/blob/4dd51f4a5f2037f8aa322fe7807315e6530a4ec8/codex-rs/core/src/session/turn.rs)
retains the final assistant message when no model follow-up or pending input remains.
[`core/tests/suite/turn_state.rs`](https://github.com/openai/codex/blob/4dd51f4a5f2037f8aa322fe7807315e6530a4ec8/codex-rs/core/tests/suite/turn_state.rs)
exercises native command calls followed by ordinary assistant final text. Alpha retains its own canonical journal and
TypeScript execution kernel; evaluation readers consume those existing contracts.

Workflow and recovery traces recognize native `exec_command` with `cmd` and preserve historical `shell` and
`execute_command` with `command`. Native exit status comes from the formatter's `Process exited with code` header;
historical inline and persisted command headers remain readable. Status-like text inside `Output` or `Preview` cannot
establish an exit status. A source-only regression generates receipts through the owning `BaseTool` formatter, including
successful tool operations whose completed subprocess returned a nonzero exit code.

The same upstream commit's
[`core/tests/suite/unified_exec.rs`](https://github.com/openai/codex/blob/4dd51f4a5f2037f8aa322fe7807315e6530a4ec8/codex-rs/core/tests/suite/unified_exec.rs)
parses completed-process and running-session headers separately and exercises `write_stdin` session continuation.
Alpha's evaluation projection preserves `commandReceipts` as observed tool-operation counts and adds
`successfulCommandReceipts` for completed processes with exit code zero. Its shared transcript decoder joins a running
native command to the terminal `write_stdin` receipt for that same session; unmatched, malformed, changed, failed, or
still-running continuations do not supply success credit. A legacy running envelope cannot borrow status from its
untrusted output. Ordinary development phases require fresh invocation and successful-process counts; intentionally
failing recovery phases retain their independent expected-exit and output checks.

For unavailable integration verification, a physical agent turn may complete with an honest blocked or unverified
handoff. This does not prove that the integration was verified. The scenario retains the failed verification receipt,
independent missing-prerequisite and no-write checks, and explicit visible unverified report. Its trace grader also
requires exactly one completed canonical turn for the current phase. Missing, stale, open, failed, interrupted, or
duplicate lifecycle evidence cannot supply completion credit. Phase selection includes the containing turn's earlier
start because real task admission can follow `turn_started`. Legacy completion-tool reports remain readable, but neither
their presence nor their absence establishes physical completion.

The existing trace baseline passed 13 tests. Canonical call and lifecycle regressions reproduced seven failures before
the reader correction; native formatter and output-spoof regressions reproduced the remaining exit-format mismatch.
After correction, the source-only focused check passed **38 tests** without compiling or replacing host outputs:

```sh
pnpm exec tsx --test apps/vscode-e2e/src/scenarios/workflowTrace.spec.ts apps/vscode-e2e/src/scenarios/recoveryTrace.spec.ts apps/vscode-e2e/src/scenarios/transactionAssertions.spec.ts
```

The subsequent ordinary-phase review reproduced four false passes before correction: a completed nonzero process, a
still-running process, a headerless result, and status-like success text inside output. The final focused check passed
**73 tests**, including session completion and recovery continuations, with package typechecking and scoped ESLint also
passing:

```sh
pnpm exec tsx --test apps/vscode-e2e/src/scenarios/workflowTrace.spec.ts apps/vscode-e2e/src/scenarios/workflowDriver.spec.ts apps/vscode-e2e/src/scenarios/recoveryTrace.spec.ts apps/vscode-e2e/src/scenarios/transactionAssertions.spec.ts
pnpm --filter @alpha-code/vscode-e2e check-types
```

## Owning contracts and regression evidence

`AgentTurnEngine` must honor every non-success status returned by completion callbacks for both legacy and staged hosts.
Completion and cleanup still run after a phase fault, but a secondary callback result or exception cannot replace the first
terminal phase and its diagnostics. Cancellation controlled by the host retains authority over the turn. Staged ownership
release must finish exactly once before the outcome promise settles, including faults in commit, effects, completion
callbacks, and continuation selection.

The captured provider outcome and explicit sampled status are primary terminal boundaries too. A failed, incomplete, or
cancelled provider response cannot become an awaiting-user callback status, and an already failed or interrupted sample
retains its original diagnostics if transcript commit subsequently throws. Both adapters capture that boundary before
running finalization callbacks.

`src/core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts` exercises those public adapter outcomes and uses controlled
promises for cleanup. The tests do not depend on timers, live providers, or private runtime fields.

Both additive `AgentTurnEventLog` records and canonical `AgentLifecycleJournal` records use the same credential-text
redactor before bounding and writing diagnostic values. Redacting the complete authorization field prevents partial
redaction of Basic credentials or Digest parameters. Structured status, call identity, numeric evidence, and subsequent
diagnostic lines remain available. Original provider values remain unmodified. Persisted layouts are unchanged; this
change governs new writes and does not rewrite historical files.

`src/core/agent/__tests__/AgentEvidence.security.spec.ts` checks actual event bytes, canonical snapshots, journal reopening,
and replay for Bearer, Basic, Digest, Negotiate, proxy, quoted, and mixed-case/tab-delimited credentials. It also verifies
that credential redaction does not mutate the source output or error.

Before the runtime fixes, the two new suites reproduced **12 failures and 15 passes**: five legacy callback statuses were
reported as completion, secondary finalization faults replaced the original error in two adapter paths, and five
authentication header forms retained credentials in persisted evidence. An adjacent review reproduced **nine additional
failures** for provider-terminal/callback conflicts and sampled-terminal/commit conflicts before the final correction. The
corrected suites cover **36 tests**, including returned and thrown callback faults for each provider terminal outcome.

## Validation performed

Environment: Node **24.14.1**, pnpm **11.24.0**, local deterministic fixtures; no live model or provider was used.

```sh
pnpm --dir src test core/agent/__tests__/AgentTurnEngine.fault-contract.spec.ts core/agent/__tests__/AgentEvidence.security.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/AgentTurnEventLog.spec.ts core/agent/lifecycle/__tests__/AgentLifecycleJournal.spec.ts core/task/__tests__/Task.lifecycle-publication.spec.ts core/task/__tests__/Task.failure-recovery.spec.ts
pnpm --dir src test core/agent/__tests__/ToolScheduler.spec.ts core/task-persistence/__tests__/stageFourTranscript.integration.spec.ts core/task/__tests__/Task.lifecycle-publication.spec.ts core/task/__tests__/Task.failure-recovery.spec.ts
pnpm --dir src check-types
```

The first command passed **92 tests in seven files**, the second passed **147 tests in four files**, and the extension
typecheck passed. The pre-change focused baseline for `AgentTurnEngine`, `ToolPolicy`, and `ProviderTranscriptStore` passed
**35 tests in three files**. Exact VS Code **1.125.0** smoke and repository gates belong to the coordinated release
validation; these unit results do not substitute for them or establish a performance improvement.

## Deterministic checks under suite contention

A coordinated full unit run exposed five additional failures even though their focused baseline passed **87 tests in five
files**. The acquisition-deadline test now uses its existing retry-driven clock, so real filesystem latency does not consume
its intentionally short 75 ms budget. Stale-HEAD and committed-path-bound observations have separate tests, and the large
fixture uses bounded batches of 16 writes. Deletion-status fixtures are authoritative Markdown directly, preserving the
real deletion operation and its assertions without repeating CRUD setup already covered by the store suite.

The parser suite keeps adversarial-depth rejection through the actual bundled sanitizer worker. A separate actual worker
waits behind an `Atomics` gate, reports readiness through a `MessageChannel`, and verifies that the host event loop can
advance while that worker is blocked. Virtual time proves the host rejects at 1500 ms, avoiding assumptions about how many
interval callbacks the operating system schedules within 50 ms.

Concurrent `workOnTicket` callers in one extension process now share the pending launch for the same project directory,
ticket ID, and revision. The owning promise is removed on success or failure, and each caller receives an independent
ticket value. The existing advisory lock remains the authority between extension hosts. A controlled acquisition failure
reproduced the second local caller rejecting with `ELOCKED` before the fix; the corrected test joins both results and
confirms exactly one task starts. Ticket launch is an Alpha extension capability, with no direct Codex CLI ticket analogue.

The original concurrent-launch test joins both operations before asserting so a rejection cannot trigger fixture removal
while its sibling is still writing. These changes establish deterministic contracts, not a workload performance claim.

The corrected five files and adjacent ticket store, cancellation, and recovery-validation suites passed **124 tests in
eight files**, followed by a successful extension typecheck. The focused command was:

```sh
pnpm --dir src test core/agent/__tests__/AgentControlStore.contention.spec.ts core/agent/__tests__/VerificationScope.spec.ts services/tickets/__tests__/TicketStore.delete.spec.ts services/tickets/__tests__/TicketTaskLink.spec.ts core/webview/html-document/__tests__/parser.spec.ts services/tickets/__tests__/TicketStore.spec.ts services/tickets/__tests__/TicketStore.cancellation.spec.ts services/tickets/__tests__/TicketStore.recovery-validation.spec.ts
```
