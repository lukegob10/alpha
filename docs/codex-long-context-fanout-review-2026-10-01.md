# Large ticket prompts and managed-agent stalls

Reviewed on 2026-10-01 America/New_York (2026-10-02 UTC). The upstream reference was refreshed from
`openai/codex` and pinned to `cb6da58876afed3ede0ab11084f67dd5394ecb48`, committed at
2026-10-02T01:34:23Z. This review extends the earlier completion/command investigation without replacing its changes.
The reference and automated extension host remain VS Code **1.125.0** with the retained Alpha-owned test profile.

## Scope and evidence

The reported workload was four or five large app tickets followed by extensive delegation, after which the task
appeared to stop. No incident trace was available. The findings below come from controlled reproductions against the
current implementation; they establish real failure paths, rather than a diagnosis of that particular run.

Current Codex source and tests were inspected before changing the owning Alpha boundaries. Relevant upstream sources
include [agent control](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/agent/control.rs),
[local compaction](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/src/compact.rs),
and [recovery after stream errors](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/core/tests/suite/stream_error_allows_next_turn.rs).
The detailed companion reviews record the specific additional sources, tests, and intentional differences.

## Reproduced findings

| Finding                                                         | Why it can look stuck                                                                                                                                                       | Owning correction                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compaction/preparation could outlive its configured deadline    | The initial request did not have a retry deadline, and read-only preparation waited only on that retry deadline even when compaction metadata carried a configured deadline | Reuse the existing disposable linked abort controller and bounded request-control wait at automatic, forced-recovery, and manual/post-turn compaction boundaries |
| A failed child startup could retain running capacity            | The child start method owns a background promise, but its manager watched only completion/abort events; a startup rejection could produce neither                           | Observe the existing owned lifecycle join and settle abnormal startup through the established stop/join, durable terminal result, and capacity-release path      |
| Cancelled queued mutations waited for another task              | The workspace gate checked cancellation only when its active owner eventually released                                                                                      | Remove and reject the exact cancelled queued waiter promptly; route lifetime cancellation through provider mutation and Worker admission callers                 |
| A synchronous mutation callback throw stranded the gate         | The callback was invoked before entering its promise cleanup path                                                                                                           | Invoke admitted callbacks inside the existing promise/finally boundary so all failures release ownership                                                         |
| Explicit ticket attachments repeatedly scanned the same project | Five references independently discovered project tickets and then read the selected ticket again                                                                            | One transient reference scan per attachment preparation, followed by existing fresh per-ID validation; no persistent cross-step cache                            |
| A ticket reader could ignore Stop while waiting for migration   | Store opening joined editor-owned preparation without the reader's cancellation signal                                                                                      | Cancel only that reader's wait and detach its listener; keep the editor's migration and surviving readers joined                                                 |

The gate releases a cancelled **waiter**, not an admitted mutation. An operation that has already started still owns the
workspace until its physical operation and settlement finish. Committed results remain truthful. Stopped-task cleanup
continues through its existing explicit allowance and stays serialized.

Compaction keeps canonical tool pairs, provider metadata, instruction authority, ticket content, and saved history. Its
serialized transcript writes remain joined. Deadline/cancellation fencing prevents a late read-only summarizer from
publishing a candidate after the owning phase has ended. A configured zero timeout retains its existing disabled-timeout
meaning.

Delegation limits, root budgets, approval authority, isolated Worker workspaces, parent verification, and Alpha's execution
protections remain in place. A capacity limit is still reported as a bounded admission error rather than silently creating
an unlimited queue. This review does not introduce Codex's sandbox or a second task engine.

## Ticket preparation workload

The deterministic fixture stores five tickets with four 16,000-character sections each. Its unique Markdown content is
321,395 bytes. Before batching, attachment preparation performed 30 file reads totaling 1,928,370 bytes. After batching,
it performed 10 reads totaling 642,790 bytes: a 66.7% reduction in reads and bytes. Selected records remain deeply equal,
with reference order, duplicate-ID checks, fresh per-ID reads, and per-ticket errors preserved. A reference that changes
between discovery and the selected read fails closed. The regression caps discovery plus validation at ten reads.

This measurement concerns local file reading and parsing. It does not reduce the full requested ticket content sent to
the model and is not evidence of a general live-model speed or quality improvement.

## Real-host regression

`apps/vscode-e2e/src/suite/long-context-fanout.test.ts` sends a synthetic five-ticket prompt of more than 250,000
characters through the real extension. Five Explore children inherit the parent context. A controlled provider barrier
prevents any child from finishing until all five are sampling concurrently. The parent must receive every terminal
receipt, complete exactly once, retain complete tool transactions, and project idle with no active or queued child capacity.

This scenario belongs to the managed-agent host certification and the extended core host gate. It uses a scripted
provider with deterministic token estimates; it demonstrates harness concurrency and lifecycle behavior, not live-model
reasoning quality. Existing compaction host coverage separately exercises context overflow, reduction, reload, and follow-up.

## Companion investigations

- [Compaction deadlines](codex-long-context-compaction-review-2026-10-01.md)
- [Managed-agent fan-out](codex-agent-fanout-review-2026-10-01.md)
- [Ticket preparation and mutation scheduling](codex-ticket-scheduling-review-2026-10-01.md)

## Validation

The implementation was frozen before certification and host checks. Results recorded on October 1 local time / October 2
UTC:

| Check                                                                 | Result                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compaction, retry, context management, and summarization units        | 440 tests across 15 files passed                                                           |
| Managed child startup and retained lifecycle units                    | 195 tests across 7 files passed                                                            |
| Ticket, mentions, mutation, scheduler, and adjacent integration units | 726 tests across 17 files passed (714 in the broader command plus 12 legacy-handoff tests) |
| Additional provider transforms and saved-history units                | 147 tests across 6 files passed                                                            |
| Root mutation wiring, completion, and scheduler integration command   | 225 tests across 9 files passed                                                            |
| `pnpm lint` and `pnpm check-types`                                    | Passed                                                                                     |
| E2E runner typecheck and touched-file formatting                      | Passed                                                                                     |
| `pnpm certify:managed-agents:automated`                               | 2,683 tests passed, 26 deterministic rows passed, then both scripted host scenarios passed |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                | 34 tests across 12 exact-host scenarios passed                                             |
| `pnpm bundle`, `pnpm vsix`, and VSIX content verification             | Passed; 1,675 packaged entries verified                                                    |
| Final whitespace inspection and dependency comparison                 | Passed; lockfile matches the pre-turn baseline                                             |

These commands overlap; their counts are individual command results, not a sum of unique tests. Certification evidence
is `artifacts/certification/managed-agent-milestone-evidence.json`. It reports matching start/end source fingerprints
(`dbca652e3bd8cd1111d244814e45cdb159bb37f25b09f7e0b631cac869ea3174`) on dirty checkout
`1adc85c1a3f560508458f6526b4de370ad0ad3d5`. Final documentation receipts were appended afterward; implementation and tests
remained unchanged.

The managed Worker acceptance receipt is `1dff963c-7c52-4f0b-bffb-618d209fceb9`. The large-prompt receipt is
`70696128-c522-439e-9ecc-d2ef8433cb04`, with `long-context-fanout.json` in its artifact directory. The latter records a
302,941-byte prompt, five concurrent children, three parent requests, exactly six task completions, six saved tool calls
with six terminal results, zero transaction errors, and zero remaining active/queued child capacity. The test completed
in 2,901 ms; this is one scripted harness run, not a live-model latency claim.

All final hosts used VS Code 1.125.0 and the retained profile under `F:\alpha-e2e\profiles\1.125.0`, with owned workspace
`F:\alpha-e2e\long-context-certification-workspace-20261001`. Artifacts are under `F:\alpha-e2e\artifacts\<runId>`.
Every final receipt below reports exit 0, complete capture, verified ownership, and observed host exit:

| Smoke scenario                          | Run ID                                 |
| --------------------------------------- | -------------------------------------- |
| Extension activation                    | `f484da5a-a435-4149-b872-80bbea81b405` |
| Modes                                   | `444e86bd-bbec-4f5b-8697-00a8c4d51813` |
| Approval modes                          | `281173fe-26d1-4712-8b6f-968e9a21e051` |
| Command path approval                   | `e4069e1d-3f59-467f-b917-d88f73715e72` |
| Command file diff                       | `b68d2b30-7cf1-41d7-86f5-a9480a070011` |
| Tool discovery                          | `5665d949-3512-4a24-9c6c-c080bbdac8e1` |
| Native tickets                          | `9fe6c3ca-0bb3-42bc-82c3-0e021cd87582` |
| Asynchronous user input                 | `0b25adac-164c-44eb-98ff-d2aec692c69b` |
| Plan updates                            | `cb14931e-4e63-4026-84ef-33fd9b9cd5b1` |
| Image viewing                           | `ab2a2f19-8048-44af-8c63-a40b8f8d218f` |
| Compaction, reload, and queued steering | `67c9713f-77bb-4b34-a3df-0354750c7d6d` |
| VS Code LM cancellation and recovery    | `144ff022-47a0-4356-bf13-477b4f3e4abb` |

The rebuilt package is `bin/alpha-3.1.3.vsix`, SHA-256
`14151f1ece8917315774a1b80fb208dd440e0ab13f2c8fc23f14967639035569`. It was built and inspected, not installed or published.

The certification matrix still identifies eight broader live/multi-window integration rows as pending. No live-provider
evaluation or reproduction of the original incident is claimed. This repair closes every confirmed code finding above;
it does not guarantee that arbitrary provider or operating-system failures cannot stall an underlying physical operation.
