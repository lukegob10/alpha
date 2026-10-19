# Context and tool continuity

This change is bounded to Alpha's provider-neutral local harness, including GitHub Copilot through VS Code 1.125.0.
The reference is Codex commit `8c076942cb70fba8e5c4732c23f1faabc4aed484`, retrieved on 2026-10-17.

## Model changes

Codex's [previous-model compaction](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/session/turn.rs)
can use the previous model before adopting a smaller model. Alpha retains at most one previous handler across a model
selection change when all non-model profile settings match. Endpoint, credentials and account changes invalidate it.
After asynchronous model preparation, only a larger previous window can supply summary generation. The selected model
still owns token counting, exact recent transactions, carried constraints and replacement acceptance. The captured
handler is released in request/compaction cleanup on success or failure. It is process-local; reload uses the existing
bounded local compaction/fallback path. See [the compactor contract](context-model-downshift.md).

## Recovery after reads

Codex reconstructs retry input from updated committed history in the same turn module; its executed-tool metadata is
not a universal effect deduplicator. Alpha admits a new logical request after transport failure or missing terminal
outcome only when all observed calls match the host's audited early-read dispatches, each scheduler has settled, and
the original terminal results are durably paired with the assistant calls. Known read errors remain errors. Partial
calls, unexecuted calls, mutations, cancellation, unknown outcomes, cleanup failures, mismatched identities and missing
receipts remain ineligible. Existing ownership, persistence, provider-error and retry-budget guards remain authoritative.
Recovery consumes the existing attempt allowance and does not dispatch the old tools again.

## Managed context

Codex's [fork filter](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control/spawn.rs)
and `spawn_agent_can_fork_parent_thread_history_with_sanitized_items` in
[its control tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agent/control_tests.rs)
retain partial and final assistant answers. Alpha's context projection now preserves committed `partial_answer` text
and its phase through JSON reload, model changes and nested forks. Commentary, parent-owned opaque/reasoning state and
tool traffic remain excluded. Terminal-tool answer projection still requires host-established finality. Existing v1
context seeds remain readable without a wire/schema migration.

Positive numeric fork counts remain Alpha's recent-N user-led turns, and explicit spawn model overrides retain priority
over role defaults. These are intentional existing Alpha contracts. Private editing worktrees and review/apply boundaries
remain intact. Catalog-level model/effort availability checks and the eight historical certification integration
obligations remain follow-up evidence gaps. Schema fanout limits do not establish measured 15-child host capacity.

Native direct OpenAI encrypted compaction, transport features, compatibility hashes and automatic memories are outside
this change. No VS Code adapter, instruction-loading, Tickets or rich-document contracts are changed.
