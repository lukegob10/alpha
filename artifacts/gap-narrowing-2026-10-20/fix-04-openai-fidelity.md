# OpenAI Responses text and cache-write fidelity

Run mode: contract alignment. Reviewed and implemented on 2026-10-20 for the bounded G1/G2 findings in
`artifacts/directory-review-2026-10-20/converge-04-providers.md`.

## Result

- Fixed G1: completed message and refusal content now extends a matching streamed prefix exactly once. Repeated
  `response.output_item.done` and terminal `response.completed` snapshots participate in reconciliation instead of
  suppressing content after the first delta or receipt.
- Fixed G2: `input_tokens_details.cache_write_tokens` now populates the existing `cacheWriteTokens` usage field, including
  a legitimate zero. The shared normalizer serves streaming and nonstreaming completed, failed, incomplete and interrupted
  Responses results.
- Preserved assistant IDs, late phase metadata, output indexes, empty-message boundaries, tool identity/completion,
  canonical output ordering, opaque reasoning bytes/summary state, response identity and continuation semantics.
- Left G3's existing visible reasoning-summary policy unchanged. No Task, accumulator, shared schema or persisted format
  was changed.

## Source-first comparison

Reference checkout: `C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`. Verified HEAD:
**`c7234c1174b27d9c55199fba0d546dc27d1b0415`**.

- [Responses SSE parser and usage mapping](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/codex-api/src/sse/responses.rs#L129):
  lines 129–152 retain cached and cache-write input counters; lines 354–366 deliver completed items independently of text
  deltas; lines 414–473 retain interrupted continuation and terminal usage semantics.
- [Responses SSE tests](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/codex-api/src/sse/responses.rs#L757):
  `partial_answer_phase_survives_item_start_and_completion`, `parses_items_and_completed`,
  `parses_cache_write_token_usage` and `error_when_missing_completed` were inspected before implementation.
- [Completed-item handling](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/stream_events_utils.rs#L316):
  `handle_output_item_done` finalizes the supplied full non-tool item and records it with
  `record_completed_response_item_with_finalized_facts` (lines 377–407).

Alpha's prior `Set` recorded only that a content part had emitted a delta. Its full `done` content was then skipped, and
the final response skipped already-handled messages again. A partial `Hello` could therefore remain a successful saved
answer despite authoritative `Hello world` content. The replacement tracks accumulated text and kind by source output and
content index and appends only a verified missing suffix.

## Compatibility decision

Alpha's provider stream appends text chunks; it has no operation to replace already-emitted text or insert a suffix before
text from a later content part. Matching extensions are reconciled. Contradictory replacements, shorter final content,
changed/removed parts, final output arrays that omit a streamed message, and impossible content-order changes now fail
explicitly through the existing provider error boundary. Error messages contain no provider text. Minimal terminal
envelopes that omit `output`, and interrupted terminals that omit unfinished messages, retain their existing behavior.

This deliberately preserves Alpha's append-only transport while preventing incompatible snapshots from silently becoming
successful canonical history. Codex's full-item persistence remains the behavioral reference; no Rust or runtime was
copied. No VS Code API, installation minimum, provider selection, tool policy or authorization changed.

## Exact edited files

- `src/api/providers/openai.ts`
- `src/api/providers/__tests__/openai-responses-fidelity.spec.ts` (new)
- `src/api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts`
- `artifacts/gap-narrowing-2026-10-20/fix-04-openai-fidelity.md` (this report)

All unrelated working-tree edits, including `src/api/providers/__tests__/vscode-lm.spec.ts`, were preserved. No dependency
or manifest edit was requested or made by this agent.

## Validation evidence

The initial deterministic fixtures were added before the production edit. No network requests or timing sleeps are used.

```text
pnpm --dir src test api/providers/__tests__/openai-responses-fidelity.spec.ts api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts --maxWorkers=1
Before production change: 2 files failed; 47 tests failed, 158 passed (205 total); 2.98 seconds.
Failures showed missing text/refusal suffixes, acceptance of incompatible final snapshots and omitted cache-write counters.
```

The text fixtures initially assumed the accumulator coalesced adjacent text chunks. Source inspection showed it retains
canonical fragments while joining the compatibility `text` projection, so the assertions were corrected to require the
full joined text and every fragment's identity/phase. No production accumulator behavior changed. Six additional adjacent
guards for omitted/minimal/interrupted output and invalid content indexes were added after implementation.

```text
pnpm --dir src test api/providers/__tests__/openai-responses-fidelity.spec.ts api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts api/providers/__tests__/openai-message-phases.spec.ts api/providers/__tests__/openai.spec.ts api/providers/__tests__/openai-responses.spec.ts api/providers/__tests__/provider-history-roundtrip.audit.spec.ts api/providers/__tests__/single-completion-cancellation.openai.spec.ts --maxWorkers=1
After final code/test changes: 7 files passed; 404 tests passed; 17.44 seconds.

pnpm --dir src exec eslint api/providers/openai.ts api/providers/__tests__/openai-responses-fidelity.spec.ts api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts --max-warnings=0
Passed, exit 0.

pnpm exec prettier --write src/api/providers/openai.ts src/api/providers/__tests__/openai-responses-fidelity.spec.ts src/api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts
Passed; formatting restricted to the three owned TypeScript files.

git diff --check -- src/api/providers/openai.ts src/api/providers/__tests__/openai-provider-outcomes.ws06.spec.ts
Passed; only existing Windows LF/CRLF working-copy notices.
```

The new tests cover partial/full, repeated and identical receipts, terminal-only content, refusals, incompatible content,
multiple content parts, late text alongside tool/opaque reasoning items, same-turn continuation, minimal/interrupted
envelopes, malformed indexes, cache writes of 0/60, invalid counter rejection, and exactly-once usage on success and error
terminals. Existing tests exercise identity/phase, cancellation and history replay.

The final pnpm test and lint invocations automatically ran workspace preinstall/install/prepare before their commands;
pnpm reported its pinned 11.24.0 version and transient missing-bin chmod warnings. Both requested validations subsequently
passed. The agent did not invoke an install, alter dependencies, manifests or lockfiles, or modify generated trees.

## Residual risk and handoff

- No live provider request or upstream Rust build was run; the frequency of abbreviated deltas in live streams remains
  unmeasured.
- The new explicit failure on incompatible or impossible-to-insert final text is an intentional observable correction.
  Supporting authoritative replacement would require a separate shared stream/UI contract and is outside this patch.
- Full extension typecheck, bundle/package and exact VS Code 1.138.0/1.125.0 gates were not run by this agent, per the
  delegated validation boundary. The parent owns integrated validation and must not infer those gates passed here.
- Existing readable-summary suppression with encrypted reasoning (G3) remains an explicit follow-up/product decision.

Closure ledger: G1 and G2 fixed now; G3 unchanged/out of scope; live-provider incidence and integrated host gates not
verified by this agent.
