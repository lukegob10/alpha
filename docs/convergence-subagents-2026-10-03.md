# Subagent convergence — 2026-10-03

Reference: [Codex CLI `b741e480`](https://github.com/openai/codex/tree/b741e480e203f037ca726bc2a76d99a8e8668e66),
retrieved 2026-10-03. Alpha starting HEAD: `2660a8f8d68d38ec42d473de6a0eee6d2537e58b`.

## Verified fork contract

- `codex-rs/core/src/agent/control/spawn.rs:87–128` keeps user/instruction messages and explicitly final assistant messages,
  filters ordinary reasoning, top-level tool transactions, non-final assistant messages and inter-agent deliveries, and
  preserves context baselines only for full-history forks. This is **not** a blind copy of provider history.
- `spawn.rs:1006–1032` flushes the parent rollout before selecting the live model context. Recent-turn forks select from
  that effective history, including the current partial turn.
- `spawn.rs:1068–1085` marks inherited conversational messages and removes parent sender authorization/order metadata.
- `codex-rs/core/src/agent/control_tests.rs:2587–2606` asserts filtered conversation and the inherited full-fork baseline.
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` defaults omitted `fork_turns` to all, supports none/N and
  distinguishes full-history from recent-turn startup. Current V2 allows route/role overrides; V1 restrictions are not
  the current V2 contract.

Alpha's existing `captureSubagentContext` strips native blocks into text and then truncates the selected evidence to
24,000 characters. The integration must use a filtered native conversational seed, not replay tools or preserve ordinary
reasoning as a new fork target. Alpha's policy, frozen instructions, Workspace protection and quarantined Worker changes
remain authoritative.

## Integration hooks

The opt-in capture input is:

```ts
historyInheritance?: {
	parentModelRoute: SubagentModelRouteState
	finalAssistantMessageIndexes?: readonly number[]
	contextBaselineVerified?: boolean
}
```

Indexes refer to the exact supplied effective history. Tool-bearing responses are filtered. Trusted retained finals receive
`phase: "final_answer"` on their cloned seed so nested forks preserve their classification. Alpha supplies indexes from
canonical, completed, tool-free visible responses; assistant role or legacy text alone is insufficient. This is an Alpha
approximation because its canonical response contract currently lacks provider message phases.

The private return contract is:

```ts
historyFork:
	| { kind: "none" }
	| { kind: "text"; reason: "legacy_capture" }
	| {
		kind: "native"
		parentTaskId: string
		messages: ApiMessage[]
		digest: string
		requiresContextRebuild: boolean
	}
```

`assertSubagentHistoryFork(historyFork, manifest)` validates parent identity, native history integrity and inherited-input
provenance before startup. `digest` is `digestValue(messages)`; it covers the exact detached seed, not a public manifest
field. The existing v1 manifest digest/reference algorithm remains unchanged, and its native selected-turn refs describe
the full selected conversation without a character cap. The manifest still excludes bodies and opaque provider state.

Native messages contain selected conversation in source order. Both inherited user and assistant messages carry
`input_origin: "agent"`; parent queue/inbox/hook/authorization-order receipts are removed. This provenance remains durable
in the ordinary child transcript and prevents inherited prompts becoming fresh human grants on reload. The inherited
seed is reused once for nested forks, with no recursive prompt wrapping. Triggered parent follow-ups remain turn boundaries;
queue-only inbox deliveries and summaries do not create them.

Canonical conversational content is portable across model/provider overrides. Compatible routes can retain aligned content
classification annotations; opaque continuation state, reasoning signatures and response IDs are excluded on every route.
Context reuse is a separate gate: `requiresContextRebuild` defaults to true, and becomes false only for all-history forks on
a compatible route when the caller supplies `contextBaselineVerified: true` after verifying a baseline captured at the same
boundary.
Legacy callers without `historyInheritance` retain the existing sanitized text path and existing saved tasks remain readable.

The host integration contract is:

1. Flush/verify the parent transcript, freeze the provider-facing effective history, route and instructions at one capture
   boundary, then opt into `historyInheritance`. Keep host `input_origin` on this private prefix; transport projection is
   insufficient. Preserve the captured prefix across transport retries and release it with the existing request lifecycle.
   Supply final indexes from canonical terminal state or persist a phase marker; plain assistant text alone is not finality.
2. Carry `historyFork.messages` in the private launch descriptor and a new optional Task constructor input.
3. In fresh-child `startTask`, assert the native seed against the finalized context manifest, install a deep clone instead
   of clearing it, persist it through the authoritative provider transcript writer, then append the child's local objective
   with agent provenance. Do not replay historical tools or publish their messages as new UI/task lifecycle events.
4. Skip the duplicate text evidence block on native forks. Rebuild the child's current environment/instruction baseline.
   The host does not set `contextBaselineVerified`, so production full-history forks also rebuild their first environment;
   retaining the parent's full-fork baseline is an explicit current divergence from upstream. The optional reuse gate
   requires separate adapter verification before a future caller can enable it.
5. Retained children resume their own transcript; legacy manifests without a native seed retain their existing path.
   Parent authority and Worker scope remain separate host inputs and cannot be inferred from inherited user roles.

Codex `FinalAnswer` is a provider message phase, separate from host task completion. Pinned `protocol/src/models.rs:939–952`
defines it; `core/src/stream_events_utils.rs` records the completed item unchanged, and `core/src/session/turn.rs:655–689`
can append a Stop-hook continuation without rewriting that phase. Requiring post-hook acceptance would therefore be an
additional Alpha contract, not verified upstream parity. `control_tests.rs:2451–2465` explicitly filters unknown phases.

Alpha's passive canonical response inference remains an intentional approximation. It can retain a candidate followed by
a hook continuation, while legacy final reports without canonical evidence remain conservatively excluded. Staged
`attempt_completion` placeholders cannot prove an accepted final report and are not promoted. Exact provider phase
preservation, accepted legacy report projection, and generated assistant media need additive canonical response contracts
and adapter/history coverage before exact fork parity can be claimed.

The native seed preserves canonical user image/document blocks, including base64 bytes that happen to resemble credentials.
Current `AgentResponseItem` does not represent generated assistant media; this change does not claim parity for that separate
provider-response capability. Text redaction remains an Alpha privacy choice, and its sentinel is stable across nested
captures. N forks select provable user-led turns after compaction; summary baselines and inbox-only deliveries do not count.

## Lifecycle and frozen instructions

`BoundedDelegationManager` now captures each run's root identity and concurrency ceiling at admission. An earlier run's
cleanup cannot reevaluate a queued run's resolver, mutate its effective ceiling or replace the earlier terminal result if
that resolver throws. Regression tests reproduced the resolver being called during unrelated cleanup. Queued admission
remains Alpha's deliberate adaptation of Codex's frozen tree limit and physical permits
(`codex-rs/core/src/agent/control/execution.rs` and `execution_tests.rs`).

`AsyncSubagentRunManager` serializes reentrant event publication. If an observer synchronously cancels a newly pending run,
other observers receive pending before cancelling, with monotonically ordered sequence numbers. This preserves Alpha's
durable lifecycle stream; Codex's watcher instead supplies the initial snapshot and may coalesce later updates
(`codex-rs/core/src/agent/control/watch.rs`). Cancellation and resource ownership remain in the existing
managers; no second scheduler or lifecycle engine was introduced.

The private v1 instruction snapshot is now compare-and-create under the existing file lock and atomic writer. An identical
launch retry validates the first body without rewriting it; a conflicting or corrupt snapshot fails without repair or
replacement. Missing legacy snapshots remain readable without creating storage. Task/root junctions, symbolic snapshot
files and inaccessible snapshots fail closed. The format and public function arguments remain unchanged. This follows the
upstream frozen instruction boundary in `codex-rs/core/src/agent/control_tests.rs:2950–3081`; root must await persistence
before child launch and propagate a conflict rather than recapture live workspace instructions.

## Validation

- Focused capture/delegation, four bounded-manager suites, async lifecycle and frozen-instruction persistence suites:
  8 files / 166 tests passed using direct Vitest file filters after `pnpm --dir src test`.
- `pnpm --dir src check-types` passed after host integration was present in the shared checkout.
- ESLint passed for the eight touched TypeScript files with `--max-warnings=0`; touched-file Prettier and scoped
  `git diff --check` passed.
- The credential-marker, reentrant lifecycle-order, queued-capacity resolver and frozen-snapshot regressions failed before
  their corresponding fixes. Tests use controlled promises or synchronous observers, without network calls or sleep races.

Shared root gates, exact VS Code 1.125.0 smoke and managed-agent certification are reserved to the parent. The checks above
cover this workstream; they do not establish release certification or verification of the host's completion acceptance
classification, provider normalization or generated assistant media. Parent baseline reuse is currently disabled.
