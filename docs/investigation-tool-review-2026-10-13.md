# Investigation tooling review — 2026-10-13

Mode: operational hardening, scoped to incident capture, dashboard projection, evidence export, and investigation launch.
The intended result is an evidence-grounded investigation that ends with a short incident paragraph and a cautious,
copyable follow-up prompt. Improving these components does not establish the cause of the incident on the user's other
computer or repair that task's missing receipt. See the [earlier incident analysis](post-tool-stall-receipt-investigation-2026-10-13.md).

## Assessment and confirmed findings

The existing architecture is useful: canonical lifecycle events drive a bounded dashboard, investigations open the source
conversation and journals, launch requests are coalesced, and projected reports omit private content. The main weaknesses
were loss and misclassification of evidence between those layers. Before the fixes, the added regression cases produced
19 failures across four focused test files; existing checks in that run contributed 24 passes.

| Severity / disposition     | Finding and effect                                                                                                                                                                                                                                                        | Correction                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High / must-fix, fixed     | `diagnosticsEvidence.ts` omitted the valid `tool_effect_started` event from its allowlist. One such record made collection reject the entire lifecycle source as malformed.                                                                                               | Derive canonical event names from the shared lifecycle schema; retain the hashed effect-start call ID.                                                                                                            |
| High / must-fix, fixed     | Lifecycle tool and approval fields live inside `payload.item`; the exporter looked only at the outer payload. Tool result status, call identity, approval decision, and reason-presence evidence disappeared.                                                             | Project nested safe fields, allowlisted tool names, and hashed identifiers without arguments, output, or private reasons. Preserve effect-tracking snapshot counts.                                               |
| High / must-fix, fixed     | The collector writes event-log projections under `events`, but the joiner read `records`. Reports had join fields without the event-log evidence actually participating.                                                                                                  | Join the current `events` representation, retaining a fallback for the earlier `records` shape. Tests require a real joined group with sequences from both journals.                                              |
| Medium / should-fix, fixed | Denied, cancelled, and indeterminate tool results all appeared as `tool_failed`. An unknown effect could disappear from aggregate evidence when its detail event aged out.                                                                                                | Preserve distinct event kinds and bounded outcome counters through live observation, history restoration, prompts, and dashboard details. Keep actual error counts separate.                                      |
| Medium / should-fix, fixed | History hydration and live incident observers excluded ordinary Code investigations using `diagnosticIncidentId`. An investigation's own failure was invisible to this dashboard.                                                                                         | Observe normal investigations through the same harness path. Legacy restricted diagnostic sessions remain excluded. Observing a failure only records/notifies; it does not automatically launch an investigation. |
| Medium / should-fix, fixed | The tail reader reported valid retained events as captured even after dropping earlier records or an unfinished append. The diagnostic tool silently removed event detail in its compact fallback. Journal validation gaps also did not affect overall collection status. | Mark incomplete tail coverage and invalid/unverified journal sequences; include event/omission counts and explicit fallback truncation. Qualify prompt counters as observed, bounded evidence.                    |
| Medium / should-fix, fixed | Investigation prompts did not require the requested concise summary or a grounded implementation handoff.                                                                                                                                                                 | Both alert and turn launches now request an incident paragraph of 3–5 sentences followed by a standalone follow-up paragraph.                                                                                     |

The earlier, still-uncommitted receipt diagnostic fix is retained: exported pending reservations contain hashed tokens and
command status, including `succeeded`, with bounded truncation metadata. It improves evidence; it does not clear receipt debt.

## Final report contract

Supporting findings must distinguish the original task from the investigator's own execution. They should identify the
request, observed sequence, failure boundary, source references, and missing records. They distinguish tool error, denial,
cancellation, indeterminate effect, provider failure, persistence failure, and completion-gate failure. A generic cancellation
reason does not establish its initiator, and a failed turn does not establish that its task stopped recovering.

The final two sections requested by the launch prompt are:

- **Incident summary:** one short plain-language paragraph covering the request, what happened, where it happened,
  relevant tools or source references, impact, and the next area to inspect. Include a cause only if supported; otherwise
  identify it as unknown. Detailed hashes and timelines belong in the supporting findings.
- **Follow-up prompt:** one copyable paragraph restating the issue, location, evidence, and uncertainties. Ask the next
  coding agent to verify the boundary, reproduce the failure, and apply the smallest justified fix with a regression test
  if a defect is confirmed. Preserve successful effects, user edits, approvals, and persistence guarantees. If evidence
  is insufficient, request specific missing records or instrumentation. Do not prescribe a broad rewrite, replay effects,
  clear receipts, or treat this suggested next task as authorization to begin repairs during the investigation.

These are model instructions, not a claim that every model will follow the format. The tests check both launch paths
receive the contract; live report quality still needs evaluation against incident fixtures with known ground truth.

## Data path and review coverage

| Surface                         | Status                    | Evidence and boundary                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool execution and cancellation | Reviewed                  | `ToolScheduler` retains structured terminal outcomes; `Task.publishCanonicalLifecycleToolResult` deliberately marks errors/cancellations after an effect started as indeterminate. No execution semantics were changed.                                                 |
| Canonical persistence           | Reviewed                  | Lifecycle journals remain authoritative. `AgentTurnEventLog` preserves structured tool status, timeout flags, retry events, identity, and provider-timeout classification. The exporter remains a projection, not a second state store.                                 |
| Export and joins                | Edited                    | `diagnosticsEvidence.ts`, settlement diagnostics, and the scoped diagnostic reader; real filesystem fixtures cover nested records and cross-journal joins.                                                                                                              |
| Recent history and counters     | Edited                    | Bounded tail reading, separate tool outcomes, restored/live counters, detail rollover, and explicit coverage limits.                                                                                                                                                    |
| Launch and attribution          | Edited                    | `AlphaProvider` shares one source-task prompt for both entrypoints. Existing task coalescing, reopening, debug-mode checks, workspace policy, and source-record protection remain.                                                                                      |
| Dashboard UI                    | Edited                    | Shared validated schemas, distinct localized outcome labels, outcome counts, and positive-turn filtering for incomplete evidence or indeterminate effects. Existing message validation, stale-response handling, semantic buttons, and listener cleanup were inspected. |
| Security and privacy            | Reviewed                  | Saved transcripts remain untrusted evidence. Tests exercise hashed joins and exclusion of private arguments/output/reasons. Native tools and existing approvals still govern investigation access; no broader authority was introduced.                                 |
| Resource use                    | Reviewed, not benchmarked | Existing task/event/source limits remain. Added counters are fixed-size, result-ID deduplication is bounded, and readers retain their bounded asynchronous I/O. No speed or memory improvement is claimed.                                                              |
| Dependencies and configuration  | Reviewed                  | No dependency, toolchain, release, mode, or VS Code API changes.                                                                                                                                                                                                        |
| Real host and live model        | Not verified              | The exact-host gate is blocked by the Windows VS Code update lock. Unit tests do not establish live narrative accuracy or resolve the remote incident.                                                                                                                  |

The shared dashboard contract adds optional outcome counts, so older rows remain readable, and adds explicit outcome event
kinds consumed by the matching extension/webview release. Persisted lifecycle formats are unchanged. No migration is needed.
Capturing source bytes remains distinct from validating the journal: a source can be captured while overall evidence is
incomplete. Missing sources and join fields remain explicit.

## Codex reference

Inspected upstream source and tests on 2026-10-13 at commit
[`e342df7b668acea2a0417d56cf872dab837276ef`](https://github.com/openai/codex/tree/e342df7b668acea2a0417d56cf872dab837276ef).

- [`tools/context.rs`](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/src/tools/context.rs)
  preserves tool call identity and structured success in response items.
- [`tasks/mod.rs`](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/src/tasks/mod.rs)
  carries explicit abort reasons, distinguishes replacement from interruption, and flushes interruption history before
  publishing the terminal event.
- [`dynamic_tool_cancellation.rs`](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/tests/suite/dynamic_tool_cancellation.rs)
  checks that interruption completes the dynamic tool call before turn abortion.

Alpha retains its native TypeScript lifecycle, approval, and effect-tracking contracts. Its explicit `indeterminate` outcome
is preserved rather than collapsed into a successful result or assumed failed write. The incident dashboard and report format
are Alpha-specific observability features, not a port of a Codex runtime.

## Validation

The focused runs cover 243 distinct passing tests across 14 files: 218 extension tests, 18 dashboard tests, and 7
shared-schema tests. The initial extension run had 216 passes; two additional collector cases and the final counter
simplification were verified by rerunning the affected files. Coverage includes the incident monitor, lifecycle event log,
tool scheduler, settlement diagnostics, evidence collector/export, history tail reader, both investigation launch paths,
dashboard hydration/panel, scoped evidence tool, task diagnostic authority, and dashboard schemas/UI.

Passed:

- `pnpm --dir src check-types`
- `pnpm --dir webview-ui check-types`
- `pnpm --filter @alpha-code/types check-types`
- Focused ESLint on every changed TypeScript/TSX file, with `--max-warnings=0`.
- Shared types build, extension bundle, and webview production builds.
- Final diff whitespace/scope check, preserving each tracked file's original line endings.

`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` built successfully and selected exact VS Code 1.125.0, but no host
tests ran. The host waited 30 seconds for Windows' `vscode-updating` mutex and exited with “Code is currently being updated.”
The runner reported `host-preflight-missing`, run `1894e04c-08d7-4864-9bde-ae890306224a`. The log is
`/tmp/alpha-investigation-smoke1250.log`. The inherited `ELECTRON_RUN_AS_NODE` was removed only from the child process;
the user's editor/update processes were not changed. This is a blocked host gate, not a pass.

## Closure ledger

- **Fixed now:** the evidence loss, join failure, outcome conflation, investigation visibility, incomplete-evidence
  reporting, and final-report instructions described above.
- **Flagged for follow-up:** a focused lifecycle audit should add structured cancellation initiator/cause/recovery
  provenance at the owning runtime boundary. Generic stored reason strings cannot establish who cancelled the remote turn.
  A separate evidence-reader pass could provide bounded windows around an incident in large or partly corrupt journals;
  current full exports explicitly report source/record limits and malformed sources instead of inventing completeness.
- **Not verified:** the remote task's actual cancellation and missing-receipt causes; live-model adherence and investigative
  accuracy; host behavior because the exact 1.125.0 gate could not start. Obtain both the original task and the failed investigator records
  to distinguish the two incidents and evaluate the new report against known facts.
- **Out of scope:** watchdogs, lifecycle recovery redesign, receipt repair/migration, automatic effect replay, deployment,
  and a repository-wide cleanup. No such work is needed to deliver the requested investigation-report improvements.

Structural verdict: the existing pipeline solves the problem cleanly enough to retain. The changes repair projection and
classification at their owning boundaries and extend existing schemas; they do not add another engine or state store.
Fixed-size counters and explicit outcome mapping add limited, explainable state. Tests at the affected boundaries make the
behavior clear to the next engineer. The remaining runtime provenance gap is not hidden by these projection fixes.
