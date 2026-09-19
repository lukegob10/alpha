# Diagnostics and evidence implementation note

## Scope

This note records the privacy and join contracts implemented from the Alpha observability research at revision `f85371b0` (2026-09-18). The diagnostics report and E2E evidence capture are projections of existing task state. They do not add a tracing authority or make provider history canonical.

## Runtime diagnostics

`AgentTurnEventLog` remains an additive, best-effort JSONL record. Its optional `turnId`, `stepId`, `requestId`, `attemptId`, `correlationId`, and `causationId` envelope fields preserve old records and make stable joins possible when the producer has the identity. Event payloads are recursively bounded and redacted at write time; the diagnosis projection hashes identifiers, allowlists event/status/category values, hashes tool names, and keeps only counters, presence markers, and response item shapes.

`Task.appendAgentTurnEvent` uses the current step identity only when the caller did not provide a context or supplied the current context snapshot. A late event with a different context does not inherit the current step's IDs. Request and attempt IDs may still be derived from the supplied context metadata. Lifecycle events remain the canonical journal; the additive log is not replay authority.

## Report privacy and evidence status

`diagnosticsHandler` delegates to `diagnosticsEvidence`. Reads are bounded to 4 MiB per source, 256 KiB per JSONL record, 2,000 records/messages, and an 8 MiB final report. Source identity is checked before and after streaming reads. The report keeps the historical `history` field as role/block/tool shape only, hashes IDs, projects runtime counters through closed fields, and stores error details as `{present, bytes, sha256}`. Raw provider history, prompts, arguments, outputs, and error text are omitted by default.

Each source has a capture status (`captured`, `absent`, or `incomplete`). Journal projections additionally expose `captureStatus`, `validationStatus`, warnings, and a compatibility `complete` boolean. `complete` is true only when every projected record has a positive sequence and identity and each sequence partition is contiguous. Canonical lifecycle rows partition by run and turn because a terminal turn may reset its local sequence; additive event-log rows partition by run. Sequence gaps, duplicate sequences, dropped/unknown rows, malformed records, source replacement, and limit violations are marked incomplete; a readable source without enough identity for validation is explicitly `unverified`.

E2E joins use hashed task/run/turn/step identity and merge optional request/attempt fields only when they agree. Missing fields remain visible as markers, and contradictory optional IDs retain an `identityConflicts` marker so later rows cannot restore a disputed value. A row cannot be called joined when its stable task/run/turn/step identity is missing. `*-evidence-join.json` carries source validation statuses and is incomplete unless both journals validate and at least one joined record exists.

The projection allowlists include the canonical lifecycle event names (`step_started`, `turn_terminal`, and the other `AgentLifecycleEvent` variants) as well as the additive event-log names. A malformed primitive runtime callback produces `{ unavailable: true }` rather than being copied into the report. If a source disappears after the initial `lstat`, capture records `SOURCE_CHANGED`; it is not treated as a clean absence. These cases have focused regressions because they otherwise create either false-complete evidence or a raw-value privacy leak.

## Validation

- `pnpm --dir src exec vitest run core/agent/__tests__/AgentTurnEventLog.spec.ts core/webview/__tests__/diagnosticsHandler.spec.ts` — 20 tests passed.
- `pnpm --dir src check-types` — passed.
- The E2E evidence compile and test results from before the latest focused follow-up remain parent-owned; they must be rerun after the final source changes.

The exact VS Code host gate and bundle run remain parent-owned. Event-log persistence is intentionally best-effort, and no raw prompts, provider payloads, hidden reasoning, or raw tool output are reconstructed by these projections.
