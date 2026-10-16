# Context retention and recovery — 2026-10-15

WS04 implements failure-cost accounting and recoverable context projections in Alpha's existing TypeScript harness.
This note records coordinator-owned validation through the 163-file [PDF-repair source snapshot][source163]
(`46318e5fdd617fbc81d62c1c328e7549391c5fec931d2102ecfa1039465c2c77`).
Results below belong to their linked source epochs. Final combined-source gates remain pending; WS04 is provisional.

## Accounting and termination

[Message validation](../packages/types/src/message.ts) accepts optional, finite, nonnegative
`contextCondenseErrorCost` only on completed `condense_context_error` or `sliding_window_truncation` rows.
[Usage consolidation](../packages/core/src/message-utils/consolidateTokenUsage.ts) adds it to monetary cost without
changing token totals or the existing context-token receipts. Older rows without this field retain their meaning.
Successful summaries use `contextCondense.cost`; successful fallback carries known failure cost on its truncation row.

The [summary stream](../src/core/condense/index.ts) synchronously reports valid cumulative cost before checking
cancellation. Each valid snapshot replaces the previous value rather than being added to it. A later valid zero is
authoritative and clears an earlier positive observation. Missing, negative or nonfinite values leave the latest valid
observation unchanged; absent provider-cost evidence does not produce a charge.
[Task](../src/core/task/Task.ts) owns accounting per attempt, so an older receipt with the same price cannot discharge
a new attempt. Cleanup recognizes a new completed success/error/fallback receipt or creates one cost receipt, then
awaits the existing message-save queue. This also covers cancellation, deadline expiry and rejected history replacement.
A cleanup-save failure surfaces when no earlier error exists; otherwise the original error survives with a diagnostic.

Manual compaction ownership lasts through cleanup and cost persistence. The returned promise releases its ownership
in `finally` before either fulfillment or rejection reaches the caller, preserving the original rejection object.
An immediate next request can start after completion; a request during a held save is still rejected.
Termination captures that finalized settlement before its first await and joins it before final usage publication and
replacement-task recovery. This join stays outside `performAbortTask`, avoiding a cycle with abort completion.

## Recoverable document reads and attachment admission

[Raw extraction](../src/integrations/misc/extract-text.ts) returns unnumbered PDF, DOCX, notebook and XLSX text.
The metadata projection applies the existing line and long-line bounds. [ReadFileTool](../src/core/tools/ReadFileTool.ts)
passes raw extraction through the existing paginated reader: offsets and continuations describe extracted text,
including partial-line tails, with file/content identity checks for stale reads. Binary-file byte offsets are different.
Existing binary-sniffed direct/folder mention omissions remain in effect; this does not enable every document as a mention.

A valid PDF exposed an adapter defect with bundled `pdf-parse@1.1.1` / pdf.js `1.10.100`. The strict native oracle,
using plain `Uint8Array` bytes, recovered all five markers in order and the full 2,522-character long line. The same
fixture then failed specifically at canonical Alpha raw extraction. Fresh phase-labelled errors establish this boundary;
pdf.js inherits a module-load error stack, so an old cause stack alone cannot identify the failing phase.

The [reviewed repair][pdf-repair] passes `Uint8Array.from(dataBuffer)` at the PDF parser boundary. This gives the old
parser a plain, independently owned byte array instead of a Node Buffer; installed-source review identifies
constructor-preserving worker cloning and backing-buffer substream offsets as the compatibility hazard. The repair
leaves decoder dependencies, non-PDF paths, error identity and cancellation handling unchanged. A focused
[unit regression](../src/integrations/misc/__tests__/extract-text.pdf-buffer.spec.ts) verifies exact bytes from an
offset-11 Buffer view, sentinel exclusion, plain-array type, offset-zero independent storage and cancellation controls.

[Attachment admission](../src/core/mentions/attachmentBudget.ts) shares the existing 32,000-character allowance once
across generated file/folder excerpts in preceding and current prepared messages. It admits whole excerpts in source
order or omits them with one budgeted recovery notice. Host-held part identities distinguish generated excerpts;
authored instruction blocks, other payloads, tool-result wrappers and input-origin metadata survive this budget transform.
Normal mention parsing still performs its existing path-reference transformation.

This allowance measures JavaScript string length, not whole-request tokens. Historical context, URLs, tickets, slash
help and later environment context are outside this pool. Extraction materializes parser output before projection;
PDF normalization adds one input-sized byte copy. These changes do not bound decoder CPU/memory, add OCR, or preserve
content excluded by existing extraction policies.

## Codex reference and intentional Alpha behavior

Source was inspected locally on 2026-10-15 using the upstream checkout retrieved on 2026-10-14 at
`bb64b894fd67158be0f874872e6d7bfe717e7368`:

- [Compaction stream accounting][codex-compact] records observed completed/incomplete response usage separately from
  successful history replacement.
- [History recording][codex-history] truncates the live tool-output projection while preserving rollout originals;
  nearby `history_tests.rs` checks metadata preservation.
- [Input admission][codex-input] sums text across input items; its `turn_start.rs` combined-oversize test covers that
  aggregate boundary.

These are behavioral references. Alpha's monetary-cost field, document decoders, continuation format and generated-only
attachment allowance are intentional native extension capabilities; Alpha does not copy Codex's numerical input cap.
The implementation extends the shared TypeScript harness and existing VS Code adapters, with no Rust/runtime port or
adoption of Codex's sandbox architecture. Alpha's execution, approval and workspace protections remain authoritative.

## Recorded validation and remaining gates

Coordinator-owned runs used normal package configurations and canonical imports, with source/process/cleanup guards.
These are deterministic test observations; the linked receipts include raw results and exact source fingerprints.
Individual passing commands in an unaccepted group receipt do not establish overall workstream acceptance.

| Run                                          | Observed result                                                                           | Evidence                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| Accounting RED                               | 3 intended failures; 44 collected, 41 filtered                                            | [Receipt][cost-red]         |
| Settlement RED                               | 2 intended busy errors; 45 collected, 43 filtered                                         | [Receipt][settlement-red]   |
| Accounting/settlement GREEN                  | 45 passed, 0 failed, 0 filtered                                                           | [Receipt][settlement-green] |
| Schema and cost metrics                      | 12 schema and 8 metrics cases passed                                                      | [Checkpoint][contracts1]    |
| Documents, attachments and adjacent coverage | 36 document, 14 attachment and 381 adjacent cases passed; both package type checks passed | [Checkpoint][contracts2]    |
| Source 149 accounting/mentions and types     | 45 accounting + 6 mention cases passed; extension type check passed                       | [Checkpoint][gates149]      |
| Phase-labelled valid-PDF RED                 | Native oracle passed; canonical Alpha raw extraction failed; 1 selected, 3 filtered       | [Receipt][pdf-primary-red]  |
| PDF transport unit RED                       | 1 intended Buffer-passthrough failure; 5 error/cancellation controls passed               | [Receipt][pdf-unit-red]     |
| PDF adapter GREEN, source 163                | 6 unit, 4 real-format and 36 document-contract cases passed; 0 failures or filtered cases | [Receipt][pdf-green]        |

The intermediate [43/44 accounting run][intermediate] remains unaccepted; its retry-ordering failure led to the
settlement correction. The 45-case GREEN covers both held-save/termination orderings, authoritative zero, reload
accounting, original-error preservation, and immediate retry after fulfillment or rejection.

The final PDF GREEN retained the strict [real-format test](../src/integrations/misc/__tests__/extract-text.actual-documents.spec.ts)
at `a8e2c58e3507f1337061ce8f5fe5f9246c2cfe861cdb75aafe511f54c28bfeb7`: PDF, DOCX, XLSX and notebook decoding all passed
their marker/order/full-tail checks and bounded canonical projections. Fixture geometry, markers and assertions were
unchanged by the adapter repair. Earlier inherited-stack descriptions do not supersede the phase-labelled RED.

Final type checks against the combined source, formatting, lint and the exact VS Code 1.125.0 host gate remain pending.
The required host command is `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`.

No live-model comparison or speed/parity improvement is established. The unavailable incident from another computer
has no demonstrated causal link to these reproduced defects. The historical speech investigation is unchanged.

[source163]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/pdf-adapter-source-01/applied/source-input.json
[cost-red]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/public-red-02/reviewed-results.json
[intermediate]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/accounting-green-01/unaccepted-results.json
[settlement-red]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/settlement-red-01/reviewed-results.json
[settlement-green]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/settlement-green-01/reviewed-results.json
[contracts1]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/public-contract-green-01/unaccepted-results.json
[contracts2]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/public-contract-green-02/unaccepted-results.json
[gates149]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/final-context-gates-01/unaccepted-results.json
[pdf-primary-red]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/focused-reds-20261015-02/reviewed-results.json
[pdf-unit-red]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/pdf-unit-red-01/reviewed-results.json
[pdf-green]: F:/alpha-e2e/codex-convergence-implementation-20261014/integration/wave-06-context/pdf-adapter-green-01/reviewed-results.json
[pdf-repair]: F:/alpha-e2e/codex-convergence-implementation-20261014/workstreams/WS04/binary-extraction/fixture-investigations/pdf-adapter-repair-01/manifest.json
[codex-compact]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/compact.rs#L859-L920
[codex-history]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/context_manager/history.rs#L517-L576
[codex-input]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server/src/request_processors/turn_processor.rs#L517-L523
