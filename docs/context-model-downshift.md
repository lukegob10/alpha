# Context retention across model downshifts

Reference inspected on 2026-10-17: [Codex turn handling](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/session/turn.rs)
(`maybe_run_previous_model_inline_compact`) and its [compaction integration tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/tests/suite/compact.rs).
Codex uses the previous model to summarize history when switching to a smaller window; the selected model owns the
replacement context. Its tests cover downshifts, resumption and incomplete compaction outcomes. The pinned source was
retrieved directly over HTTPS.

Alpha's local compactor previously budgeted its replacement against the selected model, but also sent the entire older
prefix to that model. A smaller model can therefore reject the summary request before producing a replacement, causing
fallback truncation despite a previously selected model being able to read the old window.

The existing compactor now accepts an optional host-selected `compactionApiHandler`. This handler only generates the
summary and supplies its stream lifecycle contract and image capability. The selected `apiHandler` still counts the
input and replacement, budgets exact recent steps and carried user instructions, and rejects an oversized replacement.
The summary request remains tool-free with independent response-chain metadata. No additional history store, tool
execution path or provider transport is introduced.

The host must restrict selection to the same authorized provider and configuration, retain the previous handler for the
operation, and release it afterwards. A larger context window does not prove opaque reasoning compatibility. Alpha does
not infer Codex compaction hashes or introduce native OpenAI encrypted compaction. Missing, retired or unavailable
previous models retain the existing bounded failure/truncation behavior; no unbounded retries are added.

Controlled tests in `src/core/condense/__tests__/request-isolation.spec.ts` reproduce a prefix exceeding the new window,
verify successful generation with the previous handler, reject incomplete lifecycle output, and reject a replacement
that exceeds the selected budget. Existing recent-tail tests cover exact tool transactions, opaque/reasoning retention,
carried user constraints and reload/rewind; Task compaction-safety tests cover stale summary adoption.
