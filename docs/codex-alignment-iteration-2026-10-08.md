# Codex alignment iteration — October 8, 2026

This iteration fixes lost provider retry advice through Alpha's existing error normalizer and OpenAI adapter.
It also records the next bounded alignment investigations. Existing indexing, reasoning, UI, IPC, and command work
in the shared checkout is preserved.

## Current upstream reference

Fetched `openai/codex` main on October 8 local time (October 9 UTC) and pinned
[`03b761dca9b04f47e166494232d70b3fe7c6738a`](https://github.com/openai/codex/commit/03b761dca9b04f47e166494232d70b3fe7c6738a).
Its commit time is `2026-10-09T02:04:35Z`. The research receipt records the actual retrieval time.

There are 18 commits after the previous implementation reference, `75e0b4088eff1760443856cc5f187fc9327e37b5`.
Only one commit follows the more recent research reference, `0ada5d8806cdad498230d5b1b2924091e04c8feb`:
the dedicated Realtime v3 voice list and its schemas/tests. Alpha's text chat harness does not need a voice-list change.
The readonly research checkout remains at its original HEAD; fetching updates remote refs without replacing old evidence.

Reviewed the latest 70 commit subjects and selected source changes from October 6–8. Relevant current contracts include:

| Upstream change                                                                                                                                | Alpha assessment                                                                                                                                                                                                               | Iteration decision                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Retry advice in streamed errors, October 6](https://github.com/openai/codex/commit/f6cf05af1dc701322664bb3f22ee4dafbc733ffc)                  | The shared error wrapper dropped both HTTP advice and explicit retry fields. SDK failures while reading OpenAI streams bypassed that wrapper; `completePrompt` stripped metadata in a second wrapper.                          | Implemented at the existing normalization and adapter boundaries.                                                                                           |
| [Parallel read-only tools, October 8](https://github.com/openai/codex/commit/c9e0fffbbc05c36478686444f6ab1edbadfe2768)                         | Alpha's scheduler already supports bounded reads, but `list_agents` has conservative approval metadata and no independent scope in its built-in descriptor. The `skill` tool applies task instructions and is not a pure read. | Next small performance investigation: audit a pure status/catalog read path before changing scheduling metadata.                                            |
| [Complete dynamic tool lifecycles on cancellation, October 7](https://github.com/openai/codex/commit/18e28fe1b96db7e1d6b13584bec37c41f71b8b0e) | Alpha already has canonical terminal receipts and cancellation tests. Upstream specifically tests blocked hooks, dispatch admission, and late responses. No additional Alpha defect was reproduced here.                       | Next small correctness investigation: compare those adversarial cases against custom/MCP dispatch and ordered finalization.                                 |
| [Preserve large tool arguments, October 8](https://github.com/openai/codex/commit/515c291d875e07faa64e3fa43dc9bbffed8db31f)                    | Alpha's response accumulator retains full call arguments; no equivalent 8 KiB per-call limit was found in the inspected path. Output limits serve a separate purpose.                                                          | Next small regression investigation: exercise large escaped/freeform arguments through persistence and replay without increasing output budgets.            |
| [Subagent capabilities independent of history, October 8](https://github.com/openai/codex/commit/845345b1dd4f8e2a5d5ce91363fff666e41b07fc)     | `captureSubagentContext` already records skill paths/digests independently of selected history turns. MCP/plugin choices and cold resume need a deeper caller audit before asserting parity.                                   | Medium follow-up: a capability inheritance matrix for fresh/history forks and resume, with managed-agent certification.                                     |
| [Async questions honor the user setting, October 8](https://github.com/openai/codex/commit/82e70121f86bc1f6fea7f2bb7bbc169d259b3c6b)           | Alpha gates its async declaration by root-task status and model capability. It has no equivalent dedicated global user-input toggle in that declaration path.                                                                  | Medium product follow-up: define an explicit user disable control and propagate it through the captured tool surface, UI edit buffer, and execution policy. |

The instant-interrupt persistence and cancelled-child reload test additions were also inspected as follow-up coverage
targets. Experimental app-server read-state revisions, realtime voices, Guardian behavior, and platform sandbox changes
were not treated as reasons to add another Alpha runtime or replace its protections.

## Reproduced failure and owning invariant

The retry policy consumes `retryAfterMs`, while the shared provider normalizer copied only status, code, structured
details, and AWS metadata. An SDK error with `status: 429` and `Retry-After: 60` therefore reached the task without its
60-second advice. The existing bounded policy could select only its local backoff.

The initial focused reproduction recorded **21 failed and 36 passed tests**. Failures cover missing advice, mixed-case
headers, invalid numeric coercion, and lost cancellation identity. A subsequent adapter test reproduced asynchronous
iterator errors bypassing normalization. HTTP asctime parsing also exposed dependence on the host's local timezone;
that form is now interpreted as GMT.

The invariant is: valid scheduling advice and existing retry restrictions survive error normalization, while one
shared bounded policy continues to own whether another request is allowed. Advice does not grant tool permissions,
enable automatic recovery, increase attempt budgets, or allow replay after semantic output.

## Implementation and compatibility

- `RequestPacing` now offers an optional advice reader, distinguishing missing advice from explicit zero. The existing
  `parseRetryAfterMs` entry point still returns zero when advice is absent. Header names are case insensitive; invalid
  control characters, non-string values, negative/fractional/exponential delay seconds, and unsafe numeric ranges are
  rejected. Standard and obsolete HTTP date forms are interpreted in GMT.
- The existing shared error wrapper preserves finite explicit `retryAfterMs`, boolean `retryable`, recognized
  `retryCategory`, and cancellation identity. Valid nested `error.headers` advice precedes outer headers; malformed
  nested advice falls back. Normalized errors and plain-object diagnostics do not retain raw header collections.
- `OpenAiHandler.createMessage` normalizes admission and iterator failures once for Responses, generic Chat Completions,
  and the existing reasoning-model branch. Abort/deadline errors retain their original identity, and linked controllers
  are still disposed. `completePrompt` uses one metadata-preserving wrapper rather than stripping status/advice in a
  second wrapper.
- Task retry sequencing, immutable wire inputs, tool approval, semantic-output guards, transcript formats, dependencies,
  settings, and the exact VS Code baseline keep their existing contracts.

The provider tests exercise streaming/nonstreaming admission, errors after visible streamed text, and single completion.
Task tests feed normalized advice into both canonical and compatibility waits: a 60-second hint remains a 60-second
deadline, with 10 seconds of notification latency leaving a 50-second wait. Advice longer than the 90-second default
allowance is refused. Cancellation during notification enters no backoff wait and leaves no timer.

## Intentional differences from Codex

Alpha still uses its existing HTTP/SSE SDK adapter. This change does not introduce Codex's WebSocket transport or its
endpoint-specific overload/quota policy. SDK error metadata is normalized at Alpha's current boundary; inline Responses
error-event metadata remains a separate protocol investigation.

Alpha retains its compatible-endpoint reset-epoch fallback, bounded attempt/elapsed budgets, jitter, and semantic-output
guard. Its normalized advice is a delay in milliseconds, and the existing policy captures an absolute retry deadline
when making a decision. Codex instead carries a deadline captured at advice receipt across its transport layers.
The new tests establish Alpha's notification/wait behavior, not equivalence across arbitrary asynchronous error handoffs.

This is a retry correctness change. No indexing throughput, general latency, model quality, or live rate-limit
improvement is claimed. Upstream tests were inspected; Rust tests were not executed. All new validation uses offline
providers or scripted extension hosts and requires no live-model sign-in.

## Validation and evidence

Evidence directory: `F:/alpha-e2e/artifacts/codex-alignment-iteration-20261008`.

- `reproduction-before.log`: the initial failing reproduction.
- `contract-tests.log`: retained intermediate adapter/timezone failures.
- `affected-surface-tests-final.log`: provider, retry, turn, and canonical history coverage; 340 passed across 12 files.
- `typecheck-after.log`: `pnpm --dir src check-types` passed.
- `lint.log`: `pnpm --dir src lint` passed.
- `workspace-typecheck-final.log` and `workspace-lint-final.log`: final `pnpm check-types` and `pnpm lint` passed,
  including fresh execution for the changed extension package and valid cache hits for unchanged dependency owners.
- `smoke-1250.log`: required exact-host gate passed with 13 deterministic launches and 42 executed assertions, zero failed
  or pending assertions, and actual host version 1.125.0 for every launch. Each receipt confirms observed host exit,
  verified ownership, and complete capture; `host-runs.json` contains the structured receipts.
- `upstream-research.json`: pinned source, retrieval time, recent subjects, and comparison boundaries.
- `pre-existing-file-hashes.json`: the 63 files already modified/untracked before this iteration; final preservation is
  verified against these hashes in `preservation.json`. All 63 remain byte-for-byte identical.

The touched legacy error-handler file retains its original tracked CRLF line endings. Formatting uses
`prettier --check --end-of-line auto`; whitespace inspection uses a process-local `cr-at-eol` setting without changing
repository or global Git configuration. The final diff adds seven tracked file changes and this research document.

Commands:

```sh
pnpm --dir src test api/providers/__tests__/openai.spec.ts api/providers/__tests__/openai-protocol.spec.ts api/providers/__tests__/openai-timeout.spec.ts api/providers/__tests__/openai-responses.spec.ts api/providers/utils/__tests__/error-handler.spec.ts api/providers/utils/__tests__/openai-error-handler.spec.ts core/agent/__tests__/AgentRetryPolicy.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/RequestPacing.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/task/__tests__/Task.retry-progress.spec.ts core/task-persistence/__tests__/canonicalAssistantHistory.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm check-types
pnpm lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

No release, package publish, Git branch, push, or PR was performed by this iteration.
