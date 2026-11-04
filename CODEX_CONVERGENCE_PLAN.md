# Codex convergence delivery plan

**Status: all 20 implementation/verification scopes finished. Integrated checks pass except exact VS Code 1.125.0, which is blocked before tests by the Windows update mutex.** This file is the ordered queue for improving task outcomes, latency and behavioral alignment in Alpha's existing TypeScript harness. It is not authorization to weaken approval, workspace, persistence or lifecycle protections.

## Objective and reference

Prioritize fewer unnecessary model requests, clearer tool evidence, safe overlap of independent work and reliable long-task continuity. Ship small measured changes through the shared kernel. The earlier convergence percentages were source-review estimates, not measured accuracy, work remaining or acceptance thresholds.

- Pinned behavioral implementation reference: [`ac558e2a32`](https://github.com/openai/codex/commit/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e), checked November 3, 2026.
- Completion upstream recheck: [`781d89b91e`](https://github.com/openai/codex/commit/781d89b91e2487c3653208b9c13287e1a09f6f04). The seven changed paths only add cloud-client message submission/turn interruption APIs, examples and tests. The harness/tool/context source inspected for these 20 scopes is unchanged from the implementation pin; no extension cloud-client feature was inferred.
- The detailed assessment used `079e17a422347e49d02501304f79fade7e569362`. The intervening commit only adds saved Daybreak preference resolution against advertised model programs; its source/tests were inspected and it does not change the loop findings below. Recheck upstream before each item.
- Alpha baseline: snapshot commit `ab9989c3fd8adbee3bbd90a6abc42757e7b8b04f` on `codex/convergence`, preserving the complete pre-implementation state. An isolated clean reference was source-built from this commit; candidate identities and measurement conditions are recorded below.
- Keep VS Code **1.125.0** compatibility and use exact **1.141.0** as the reference host. Keep provider selection separate from execution and approval authority.
- Codex OS sandbox architecture is outside this queue. Built-in skills, Tickets, HTML preview and schedules remain integrated first-class Alpha capabilities.

## How to use the order

Implementation is authorized. The head is the lowest unfinished rank; concurrent work stays within **head through head + 9**. At head 1, only ranks 1–10 are eligible. Run independent file/contract assignments in parallel, sequence dependencies and shared-file integrations, and reuse worker slots as they finish. Root owns integration, commits and this tracker.

The **Finished** column receives **✅** only after the assigned behavior or verification scope has passed focused checks and integration review. Blank means unfinished. Broader harness/host/full-suite validation is a shared final gate, tracked separately; a check mark does not claim those final gates already passed.

Ranks reflect expected task benefit, scope of affected workflows, evidence confidence, effort, risk and prerequisites. They are engineering judgments, not measured performance claims. Backend-limited capabilities are explicitly conditional. A reproduced correctness, security or data-integrity defect takes precedence over this order.

Execution started with Gate 0 and items **1–3**, then **4–6**, where metadata enables native continuity. Item **7** retained the bounded read scope after its measured workload showed no additional dispatch wait. Relevant safety checks accompanied earlier changes; the later verification entries closed the remaining focused coverage.

Effort ranges are rough engineering days for one experienced contributor, including focused integration/testing and excluding unavailable provider access. Shared setup, scheduler and continuity work overlap; do not add the rows or turn them into a calendar promise. Re-rank after actual baseline/result evidence.

| Rank | Finished | Work                                                                                | Kind                                 | Potential benefit                                                       | Initial effort                                                                              |
| ---- | :------: | ----------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    |    ✅    | [Completion and goals: remove unnecessary model round trips](#item-1)               | Behavior change                      | Fewer unsolicited retries and repeated no-progress turns                | 3–5 days; goal follow-up 2–4 days, overlapping                                              |
| 2    |    ✅    | [Scheduling: overlap already-audited early reads](#item-2)                          | Optimization                         | Less serial waiting during streamed tool batches                        | 2–4 days for the bounded execution change; 3–6 with primary coverage                        |
| 3    |    ✅    | [MCP: give the model one authoritative structured result](#item-3)                  | Behavior change                      | Clearer tool evidence and less conflicting model input                  | 2–4 days for projection; 3–5 with primary coverage                                          |
| 4    |    ✅    | [Response items: preserve supported metadata through replay](#item-4)               | Continuity foundation                | Lossless supported replay and a base for native compaction              | 3–5 days initially; broader coverage 6–10 cumulative                                        |
| 5    |    ✅    | [Compaction: recover long tasks and preserve native continuity](#item-5)            | Recovery and capability              | Better recovery from oversized context and supported native checkpoints | 2–4 days for local overflow recovery; native support 7–12 days, overlapping continuity work |
| 6    |    ✅    | [Shell sessions: make explicit shell and login choices reproducible](#item-6)       | Capability                           | Fewer environment mismatches in CLI-style command workflows             | 5–8 days initially; hardening 8–13 cumulative                                               |
| 7    |    ✅    | [Turn loop: expand safe completed-item dispatch only where useful](#item-7)         | Conditional optimization             | Earlier useful work after safe calls complete                           | 5–10 days, shared with item 2 and durable admission                                         |
| 8    |    ✅    | [Provider continuity: prove supported route equivalence](#item-8)                   | Verification first                   | Reliable continuation without an unnecessary transport rewrite          | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 9    |    ✅    | [Persistence and replay: close crash-point evidence gaps](#item-9)                  | Verification first                   | Tasks resume with correct instructions, effects and checkpoints         | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 10   |    ✅    | [Cancellation: prove cleanup without changing Stop semantics](#item-10)             | Verification first                   | No leaked work or false completion after Stop                           | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 11   |    ✅    | [Step context: prove immutable capture across supported paths](#item-11)            | Verification first                   | Stable settings and authority during requests and retries               | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 12   |    ✅    | [Retries: align cadence only after measuring recovery behavior](#item-12)           | Policy experiment                    | Potentially less recovery waiting with bounded work                     | 1–2 days for a captured profile; 2–4 with initial proof                                     |
| 13   |    ✅    | [Instructions and memory: verify guidance, then improve bounded controls](#item-13) | Verification and targeted controls   | Current project guidance and explicit memory usage evidence             | 2–3 days for primary proof; optional quota 2–3 and attribution 1–3, overlapping             |
| 14   |    ✅    | [Delegation V2: verify the actual native surface](#item-14)                         | Verification first                   | Trustworthy delegated work and recovery                                 | 2–4 days initially; remaining matrix 5–9 cumulative                                         |
| 15   |    ✅    | [Lifecycle and sessions: verify projected behavior and bounded UI work](#item-15)   | Verification first                   | Correct session routing with responsive streaming                       | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 16   |    ✅    | [Skills: prove local behavior before adding remote source routes](#item-16)         | Verification first                   | Reliable skill selection, loading and inherited provenance              | 2–3 days initially; remaining matrix 4–6 cumulative                                         |
| 17   |    ✅    | [Tool registry: prove identity and discovery activation](#item-17)                  | Verification first                   | Advertised tools and executable authority stay consistent               | 2–4 days initially; remaining matrix 4–8 cumulative                                         |
| 18   |    ✅    | [File tools: verify data safety and explicit patch differences](#item-18)           | Verification first                   | Correct edits without overwriting external work                         | 1–3 days initially; remaining matrix 4–7 cumulative                                         |
| 19   |    ✅    | [Approvals: verify current authority before optional risk review](#item-19)         | Verification and optional capability | Fewer incorrect or stale approval decisions                             | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 20   |    ✅    | [Modes and questions: make deliberate compatibility decisions last](#item-20)       | Verification and product choice      | Predictable user interaction without lost authority                     | 2–4 days initially; remaining matrix 4–7 cumulative                                         |

## Gate 0: deterministic baseline record

- [x] Freeze completion, overlapping-read and MCP projection fixtures with independent outcome assertions, pinned-source reference expectations and declared provider/feature scope. Reuse the existing harness, Task tests and tool fixtures rather than create another runtime.
- [x] Record clean source-built baseline `ab9989c3`, candidate commits and source digests, the pinned Codex revision, and scripted provider/settings/workload conditions. Exact-host execution conditions and results are recorded in the final gates below; preparation or a host mock is never counted as a host pass.
- [x] Capture independent scripted outcomes, model requests, read overlap, bounded retry behavior and serialized result bytes. The read timing is one paired deterministic fake-clock sample; statistical dispersion and general wall-time gains are not established. Provider-reported usage/cost integrity is tested, without claiming live token/cache savings.
- [x] Preserve tool/result integrity, immutable authority, bounded work, stale-content refusal, cancellation, uncertain effects and post-turn review. The focused records name deliberate Alpha differences; they are not counted as Codex conformance passes.
- [x] Start with items 1–3 and reuse their evidence across related items. Full 20-area qualification did not block the first measured changes.

The baseline supports deterministic/source-level qualification. No directly executed Codex comparison or live-provider quality, latency, token/cache or long-task campaign was performed. Missing live release evidence remains unavailable and is separate from completion of this implementation queue.

## Ordered work

<a id="item-1"></a>

### 1. Completion and goals: remove unnecessary model round trips

Original assessment area **2**. Kind: **Behavior change**. Effort: **3–5 days; goal follow-up 2–4 days, overlapping**.

- **Why:** An avoidable model request can cost more than a local tool optimization. This is a concrete terminal-policy difference, although its frequency in real tasks is not yet measured.
- [x] **Work:** Normalize authoritative provider terminal signals, honor a genuinely successful empty turn through existing completion admission, then align the three-empty automatic-goal stop/reset policy. Keep unsupported or truncated streams on bounded recovery. Keep task verification and user waits explicit.
- [x] **Accept and measure:** A successful-empty reference trace performs no unsolicited retry; failed/truncated output never becomes success; goal counters reset correctly and cannot double-count replay. Measure model calls, goal progress, wall time and usage.
- **Dependencies:** Gate 0 and supported provider terminal semantics. Goal accounting follows terminal normalization. Provider, retry and cancellation tests are part of this change.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/AgentTurnEngine.ts](src/core/agent/AgentTurnEngine.ts), [src/api/providers/openai.ts](src/api/providers/openai.ts).
- **Nearest coverage:** [Task.stream-recovery.spec.ts](src/core/task/__tests__/Task.stream-recovery.spec.ts), [AgentTurnEngine.spec.ts](src/core/agent/__tests__/AgentTurnEngine.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/session/turn.rs:3396](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/turn.rs#L3396), [codex-rs/core/src/session/turn.rs:637](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/turn.rs#L637).

<a id="item-2"></a>

### 2. Scheduling: overlap already-audited early reads

Original assessment area **8**. Kind: **Optimization**. Effort: **2–4 days for the bounded execution change; 3–6 with primary coverage**.

- **Why:** The early-read path exists but chains execution serially. Improving this bounded path is a smaller experiment than replacing turn orchestration.
- [x] **Work:** Let the existing ToolScheduler admit independent prepared exec_command reads from the stream concurrently. Keep durable acceptance, captured policy, scope checks, hook barriers, worker/result bounds and ordered receipt publication. Keep mutations and terminal interactions serialized.
- [x] **Accept and measure:** Controlled traces prove two eligible reads overlap before EOF, limits hold, serial barriers work and receipts remain ordered/exactly once. Compare the same multi-read workload before and after; retain the optimization only with demonstrated benefit and no outcome regression.
- **Dependencies:** Gate 0. Shares scheduler/item-admission work with item 7; count it once. Cancellation and persistence regressions must pass in this change.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts).
- **Nearest coverage:** [Task.spec.ts](src/core/task/__tests__/Task.spec.ts), [ToolScheduler.command-batching.spec.ts](src/core/agent/__tests__/ToolScheduler.command-batching.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/stream_events_utils.rs:335](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/stream_events_utils.rs#L335), [codex-rs/core/src/tools/parallel.rs:286](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/parallel.rs#L286).

<a id="item-3"></a>

### 3. MCP: give the model one authoritative structured result

Original assessment area **18**. Kind: **Behavior change**. Effort: **2–4 days for projection; 3–5 with primary coverage**.

- **Why:** Codex prefers non-null structured results; Alpha currently combines structured JSON with ordinary display content. A focused projection change can remove competing answers without changing storage.
- [x] **Work:** Separate model-facing projection from UI evidence in UseMcpToolTool. Match the verified structured-result precedence, retain text/media fallback when appropriate, preserve isError and bounded output, and keep backend `_meta` out of model input.
- [x] **Accept and measure:** Freeze conflicting-text/JSON, structured-null, empty structured result, error and supplemental-media fixtures before changing expectations. Match reference model input while preserving UI evidence and repository outcomes. Measure tool-result input size; do not assume fewer tokens improve task quality.
- **Dependencies:** Gate 0. Reuse existing result/history projection. This does not require optional audio or URL elicitation.
- **Owners:** [src/core/tools/UseMcpToolTool.ts](src/core/tools/UseMcpToolTool.ts), [src/core/prompts/responses.ts](src/core/prompts/responses.ts), [packages/types/src/mcp.ts](packages/types/src/mcp.ts).
- **Nearest coverage:** [UseMcpToolTool.media.spec.ts](src/core/tools/__tests__/UseMcpToolTool.media.spec.ts), [elicitation.spec.ts](src/services/mcp/__tests__/elicitation.spec.ts).
- **Codex source/tests:** [codex-rs/protocol/src/models.rs:2491](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L2491), [codex-rs/core/src/tools/context.rs:222](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/context.rs#L222).

<a id="item-4"></a>

### 4. Response items: preserve supported metadata through replay

Original assessment area **5**. Kind: **Continuity foundation**. Effort: **3–5 days initially; broader coverage 6–10 cumulative**.

- **Why:** This is shared continuity work that prevents later checkpoint or provider changes from relying on a lossy projection. No default-loop failure was reproduced, so prove each supported field requirement first.
- [x] **Work:** Carry bounded, validated provider-scoped item IDs and required metadata through existing stream, canonical response and history contracts. Preserve phases, reasoning state and identity. Reuse native persistence; replay only within supported provider/model/account scope.
- [x] **Accept and measure:** Native request-to-history-to-request fixtures preserve the required fields across cancellation, late metadata, malformed calls and reload. Incompatible provider state is suppressed. Encrypted reasoning already works; do not rebuild it or add speculative private fields.
- **Dependencies:** Gate 0. Foundation for item 5 and shared with items 8/9. Combine overlapping envelope changes into one reviewed contract change.
- **Owners:** [src/core/agent/AgentResponse.ts](src/core/agent/AgentResponse.ts), [src/api/providers/openai.ts](src/api/providers/openai.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts).
- **Nearest coverage:** [openai-responses-fidelity.spec.ts](src/api/providers/__tests__/openai-responses-fidelity.spec.ts), [openai-codex.spec.ts](src/api/providers/__tests__/openai-codex.spec.ts).
- **Codex source/tests:** [codex-rs/protocol/src/models.rs:899](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L899), [codex-rs/protocol/src/models.rs:1141](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L1141).

<a id="item-5"></a>

### 5. Compaction: recover long tasks and preserve native continuity

Original assessment area **15**. Kind: **Recovery and capability**. Effort: **2–4 days for local overflow recovery; native support 7–12 days, overlapping continuity work**.

- **Why:** This is the largest concrete missing long-task capability, but native benefits depend on the selected backend. Native API work cannot be assumed to improve VS Code LM or another unsupported route.
- [x] **Work:** First reproduce reducible local-summary overflow requiring more pruning than the current fixed attempts; repair it with budget-aware complete-step removal while retaining finite deadlines and attempt bounds. Then add capability-selected native encrypted compaction behind the existing provider/compaction interface, including checkpoint persistence/replay and the generic fallback.
- [x] **Accept and measure:** Oversized but reducible histories recover without an unbounded retry loop. Native checkpoints survive continuation and reload, preserve usage/tool pairs, and are rejected after stale transcript/model/auth changes. Scripted fixtures compare recovery, checkpoint replay and reported usage on supported routes. Live long-task outcome, stall and cache qualification remains unavailable.
- **Dependencies:** Gate 0. Native checkpoints depend on item 4 and the persistence/replay checks in item 9. Deliver local recovery and native support as separate reviewable changes. Optional speculative async compaction is deferred.
- **Owners:** [src/api/index.ts](src/api/index.ts), [src/core/condense/index.ts](src/core/condense/index.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [request-isolation.spec.ts](src/core/condense/__tests__/request-isolation.spec.ts), [Task.compaction-safety.spec.ts](src/core/task/__tests__/Task.compaction-safety.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tasks/compact.rs:63](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tasks/compact.rs#L63), [codex-rs/model-provider/src/capabilities.rs:36](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/model-provider/src/capabilities.rs#L36).

<a id="item-6"></a>

### 6. Shell sessions: make explicit shell and login choices reproducible

Original assessment area **10**. Kind: **Capability**. Effort: **5–8 days initially; hardening 8–13 cumulative**.

- **Why:** Per-call shell/login controls are absent. Adding them addresses a real invocation difference across platforms without replacing the process manager.
- [x] **Work:** Pass a captured launch specification from schema and normalization through existing ExecuteCommandTool, Execa and VS Code adapters. Include shell/login in approval identity, executor fingerprint, audited-read readiness and terminal reuse. Preserve omitted-argument behavior and reject unsupported selections before effects.
- [x] **Accept and measure:** Explicit shell/login fixtures produce expected environment behavior; interpreter changes cannot reuse an old grant or early-read classification. Validate stdin/exit/reuse races on supported platforms and run both exact reference-host and minimum-host adapter gates.
- **Dependencies:** Gate 0. Shares capture, approval and scheduling contracts with items 2/8/11/19; their focused checks are required here, not postponed until those queue entries.
- **Owners:** [src/core/prompts/tools/native-tools/execute_command.ts](src/core/prompts/tools/native-tools/execute_command.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/tools/ExecuteCommandTool.ts](src/core/tools/ExecuteCommandTool.ts).
- **Nearest coverage:** [ExecaTerminalProcess.spec.ts](src/integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts), [ExecuteCommand.policy-snapshot.spec.ts](src/core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/handlers/shell_spec.rs:63](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/shell_spec.rs#L63), [codex-rs/core/src/tools/handlers/unified_exec.rs:151](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/unified_exec.rs#L151).

<a id="item-7"></a>

### 7. Turn loop: expand safe completed-item dispatch only where useful

Original assessment area **1**. Kind: **Conditional optimization**. Effort: **5–10 days, shared with item 2 and durable admission**.

- **Why:** After the bounded-read change, remaining dispatch delay may still dominate some workloads. Broader admission has greater crash/retry risk and must earn its place with a measured workload.
- [x] **Work:** Profile the remaining stream tail, then extend existing scheduler/transaction admission only to agreed safe call kinds with trustworthy completion signals. Keep per-item durable acceptance/effect evidence, approvals, stale-content checks and fallback for EOF-only adapters.
- [x] **Accept and measure:** The selected workload improves while Stop, steering, hooks, stream truncation and reload produce one truthful result per accepted call and never replay an uncertain effect. Preserve Queue versus Steer semantics. No broad Task or engine rewrite is justified.
- **Dependencies:** Items 2/4 plus related crash/approval/cancellation proof. Stop at existing safe read scope if no further outcome or latency benefit is established.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/AgentTurnEngine.ts](src/core/agent/AgentTurnEngine.ts).
- **Nearest coverage:** [Task.spec.ts](src/core/task/__tests__/Task.spec.ts), [Task.completedCallReceipt.spec.ts](src/core/task/__tests__/Task.completedCallReceipt.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/stream_events_utils.rs:335](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/stream_events_utils.rs#L335), [codex-rs/core/tests/suite/tool_parallelism.rs:295](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/tool_parallelism.rs#L295).

<a id="item-8"></a>

### 8. Provider continuity: prove supported route equivalence

Original assessment area **6**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** HTTP/SSE and full-history input can be valid continuation mechanisms. Previous transport/cache deductions did not establish a semantic defect.
- [x] **Work:** Compare normalized next-request semantics across native OpenAI, SIWC and VS Code LM where supported. Cover auth rotation, late chunks, cancellation, usage and reload. Fix only demonstrated adapter loss, sharing item 4 changes.
- [x] **Accept and measure:** Supported routes retain the same conversation/tool state without duplicate effects or stale-owner publication. Evaluate WebSocket/cache-affinity work separately only if route support and a matched benchmark justify it; preserve documented HTTP recovery and host constraints.
- **Dependencies:** Gate 0; focused route checks accompany items 1/4/5/6. This entry closes remaining coverage and is not a prerequisite for a transport rewrite.
- **Owners:** [src/api/providers/openai.ts](src/api/providers/openai.ts), [src/api/providers/openai-codex.ts](src/api/providers/openai-codex.ts), [src/api/providers/vscode-lm.ts](src/api/providers/vscode-lm.ts).
- **Nearest coverage:** [openai-responses.spec.ts](src/api/providers/__tests__/openai-responses.spec.ts), [openai-codex.spec.ts](src/api/providers/__tests__/openai-codex.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/client.rs:1525](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/client.rs#L1525), [codex-rs/core/src/client.rs:960](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/client.rs#L960).

<a id="item-9"></a>

### 9. Persistence and replay: close crash-point evidence gaps

Original assessment area **14**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** No persistence defect justifying a storage replacement was established. Existing atomic snapshots, receipts and rewind recovery should be verified rather than replaced for resemblance.
- [x] **Work:** Run paired accepted-call/effect-start/result and compaction/steer/rewind/reload traces. Reuse the existing history, receipt and rewind stores. Repair an owning invariant only after a failing fixture identifies it.
- [x] **Accept and measure:** No orphan call, duplicate mutation, lost user instruction or cross-provider opaque-state replay. Preserve explicit indeterminate-effect evidence. Do not collapse uncertainty into generic aborted text to claim parity.
- **Dependencies:** Cross-cutting crash checks are mandatory in items 1–7; this entry fills remaining combinations and shares their setup.
- **Owners:** [src/core/task-persistence/apiMessages.ts](src/core/task-persistence/apiMessages.ts), [src/core/task-persistence/ProviderTranscriptStore.ts](src/core/task-persistence/ProviderTranscriptStore.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [Task.persistence.spec.ts](src/core/task/__tests__/Task.persistence.spec.ts), [Task.rewind-recovery.spec.ts](src/core/task/__tests__/Task.rewind-recovery.spec.ts).
- **Codex source/tests:** [codex-rs/rollout/src/recorder.rs:1073](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/rollout/src/recorder.rs#L1073), [codex-rs/rollout/src/recorder.rs:1091](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/rollout/src/recorder.rs#L1091).

<a id="item-10"></a>

### 10. Cancellation: prove cleanup without changing Stop semantics

Original assessment area **12**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** No cancellation rewrite is justified. Reliable cleanup is a release condition for the higher-ranked concurrency and continuity changes.
- [x] **Work:** Exercise provider/tool/process/child cancellation, late callbacks, blocked producers, repeat Stop and reload with controlled barriers. Fix demonstrated ownership or cleanup defects at their existing owner.
- [x] **Accept and measure:** Accepted calls settle once, late work cannot mutate a replacement task, and owned resources release truthfully. Retain Alpha Stop terminating owned background commands; do not imitate arbitrary Rust future destruction or claim a 100 ms end-to-end deadline.
- **Dependencies:** Required focused checks in every affected earlier change. This queue position concerns additional matrix coverage, not deferred cancellation safety.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts).
- **Nearest coverage:** [Task.command-stop-escalation.spec.ts](src/core/task/__tests__/Task.command-stop-escalation.spec.ts), [Task.spec.ts](src/core/task/__tests__/Task.spec.ts).
- **Codex source/tests:** [codex-rs/core/tests/suite/unified_exec.rs:3011](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/unified_exec.rs#L3011), [codex-rs/core/src/session/handlers.rs:61](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/handlers.rs#L61).

<a id="item-11"></a>

### 11. Step context: prove immutable capture across supported paths

Original assessment area **3**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** The prior 95 estimate did not demonstrate a default snapshot defect. Different runtime/diagnostic representations are not a behavior backlog.
- [x] **Work:** Verify captured handler, raw wire request, instructions, tools and policy survive retries and asynchronous setting/catalog changes. Extend only missing controlled race fixtures; preserve diagnostic redaction separately from executable values.
- [x] **Accept and measure:** No stale configuration publication, mid-request authority change or corrupted opaque replay across supported providers, compaction and reload. Keep existing frozen snapshots/runtime companions.
- **Dependencies:** Focused capture tests accompany earlier provider/scheduler/shell changes. Optional live full-model activation remains a separate later capability decision.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/StepContext.ts](src/core/agent/StepContext.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [Task.reasoning-preference.spec.ts](src/core/task/__tests__/Task.reasoning-preference.spec.ts), [Task.retry-wire.spec.ts](src/core/task/__tests__/Task.retry-wire.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/session/step_context.rs:25](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/step_context.rs#L25), [codex-rs/core/src/session/mod.rs:4199](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/mod.rs#L4199).

<a id="item-12"></a>

### 12. Retries: align cadence only after measuring recovery behavior

Original assessment area **13**. Kind: **Policy experiment**. Effort: **1–2 days for a captured profile; 2–4 with initial proof**.

- **Why:** Codex starts ordinary transient backoff at 200 ms with proportional jitter; Alpha uses 1 s/full jitter. This is observable, but faster retries can also amplify provider pressure and are not a proven quality improvement.
- [x] **Work:** If the fixed outage/rate-limit workload supports the change, add or adopt an explicit captured backoff profile in AgentRetryPolicy. Keep server advice, request pacing, finite global/category budgets, deadlines and uncertain-effect guards.
- [x] **Accept and measure:** Deterministic timing/advice fixtures match the selected contract. Compare recovery wall time, request count and retry amplification; do not change defaults on parity alone. Never copy indefinite reconnect behavior.
- **Dependencies:** Gate 0 and provider/deadline/history coverage from items 1/8/9/10. Local compaction overflow policy remains owned by item 5.
- **Owners:** [src/core/agent/AgentRetryPolicy.ts](src/core/agent/AgentRetryPolicy.ts), [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/CommittedHistoryRecoveryPolicy.ts](src/core/agent/CommittedHistoryRecoveryPolicy.ts).
- **Nearest coverage:** [AgentRetryPolicy.spec.ts](src/core/agent/__tests__/AgentRetryPolicy.spec.ts), [Task.retry-progress.spec.ts](src/core/task/__tests__/Task.retry-progress.spec.ts).
- **Codex source/tests:** [codex-rs/async-utils/src/backoff.rs:7](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/async-utils/src/backoff.rs#L7), [codex-rs/protocol/src/error.rs:426](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/error.rs#L426).

<a id="item-13"></a>

### 13. Instructions and memory: verify guidance, then improve bounded controls

Original assessment area **4**. Kind: **Verification and targeted controls**. Effort: **2–3 days for primary proof; optional quota 2–3 and attribution 1–3, overlapping**.

- **Why:** Full-prefix assembly is not itself incorrect. Configurable instruction quota and completed-message memory attribution are narrower behavior choices than a world-state rewrite.
- [x] **Work:** Prove changed/removed instructions across retry, compaction and reload. If the selected workload requires it, add a bounded host-controlled quota and separate memory usage attribution from final-display citation rules.
- [x] **Accept and measure:** Authority/provenance and user corrections survive; malformed paths and stale sources remain rejected. Measure prompt/cache effects of quota changes. Keep advisory memory authority, local/legacy rules and source safety.
- **Dependencies:** Reuse instruction/replay fixtures from items 4/5/8/9/11. Do not add a second instruction or memory engine.
- **Owners:** [src/core/prompts/system.ts](src/core/prompts/system.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [custom-instructions-project-discovery.spec.ts](src/core/prompts/sections/__tests__/custom-instructions-project-discovery.spec.ts), [custom-instructions-configured-project-discovery.spec.ts](src/core/prompts/sections/__tests__/custom-instructions-configured-project-discovery.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/context/world_state/agents_md.rs:44](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/context/world_state/agents_md.rs#L44), [codex-rs/core/src/agents_md.rs:67](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/agents_md.rs#L67).

<a id="item-14"></a>

### 14. Delegation V2: verify the actual native surface

Original assessment area **16**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 5–9 cumulative**.

- **Why:** Native V2 already normalizes numeric forks to all history, exposes timeout-only waits and shares the invoking workspace. The earlier legacy-path deductions are retracted.
- [x] **Work:** Verify spawn, passive/triggering mail, waits, inherited authority, budget accounting, cancellation and cold restoration through native schemas and real extension adapters. Preserve separate legacy compatibility paths.
- [x] **Accept and measure:** No duplicated turn, lost mail, widened authority, double usage or stale overwrite; focused tests and automated managed-agent certification pass when the contract changes.
- **Dependencies:** Shares goal, cancellation, capture and history fixtures. Do not implement nonexistent fork/wait/quarantine fixes.
- **Owners:** [src/core/agent/SubagentDelegation.ts](src/core/agent/SubagentDelegation.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [SubagentDelegation.spec.ts](src/core/agent/__tests__/SubagentDelegation.spec.ts), [AgentLifecycleTools.spec.ts](src/core/tools/__tests__/AgentLifecycleTools.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:222](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L222), [codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:58](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L58).

<a id="item-15"></a>

### 15. Lifecycle and sessions: verify projected behavior and bounded UI work

Original assessment area **20**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** Compact metadata and a native journal already serve the shared runtime. No notification-format rewrite has a demonstrated behavioral benefit.
- [x] **Work:** Compare visible lifecycle facts under duplicate/gap/late events, reload, background sessions and view disposal. Measure payload size and render work when an affected change touches streaming.
- [x] **Accept and measure:** Stable task/turn routing, truthful terminal states, bounded projection and preserved task review/cleanup ownership. A completed turn must not prematurely dismiss a task awaiting review.
- **Dependencies:** Focused lifecycle checks accompany the higher-ranked changes; reuse shared adapters instead of duplicating task state.
- **Owners:** [src/core/webview/TaskSessionRegistry.ts](src/core/webview/TaskSessionRegistry.ts), [src/core/webview/AgentLifecycleProjection.ts](src/core/webview/AgentLifecycleProjection.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [AlphaProvider.lifecycle-transport.spec.ts](src/core/webview/__tests__/AlphaProvider.lifecycle-transport.spec.ts), [AgentLifecycleProjection.spec.ts](src/core/webview/__tests__/AgentLifecycleProjection.spec.ts).
- **Codex source/tests:** [codex-rs/app-server/src/bespoke_event_handling.rs:192](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/app-server/src/bespoke_event_handling.rs#L192), [codex-rs/app-server/src/thread_status.rs:156](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/app-server/src/thread_status.rs#L156).

<a id="item-16"></a>

### 16. Skills: prove local behavior before adding remote source routes

Original assessment area **17**. Kind: **Verification first**. Effort: **2–3 days initially; remaining matrix 4–6 cumulative**.

- **Why:** No ordinary local-skill defect was established. Source/package routing is useful only when the target workflows actually require it.
- [x] **Work:** Verify discovery, explicit/implicit policy, pagination, complete body delivery, approval, inherited digest/provenance and reload through the existing native SkillTool using real-file fixtures.
- [x] **Accept and measure:** Correct skills load without substitution or authority growth, with one provenance record per completed logical or paginated load; partial reads do not become completed loads, and later explicit reloads remain supported. Keep built-ins and Alpha precedence. Defer remote/package routing until justified.
- **Dependencies:** Reuse catalog, instruction and MCP capture checks; no replacement skills manager.
- **Owners:** [src/core/prompts/tools/native-tools/index.ts](src/core/prompts/tools/native-tools/index.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [SkillsManager.explicit-selection.spec.ts](src/services/skills/__tests__/SkillsManager.explicit-selection.spec.ts), [explicit-skills.spec.ts](src/core/mentions/__tests__/explicit-skills.spec.ts).
- **Codex source/tests:** [codex-rs/ext/skills/src/selection.rs:20](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/ext/skills/src/selection.rs#L20), [codex-rs/ext/skills/src/extension.rs:380](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/ext/skills/src/extension.rs#L380).

<a id="item-17"></a>

### 17. Tool registry: prove identity and discovery activation

Original assessment area **7**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–8 cumulative**.

- **Why:** Flattened function declarations versus native enums do not prove execution loss. The canonical registry and captured surface already exist.
- [x] **Work:** Verify identity/collision handling, freeform mapping, schema/executor/policy agreement, deferred discovery receipts, refresh, revocation and reload. Extend native envelopes only for a supported failing case, shared with item 4.
- [x] **Accept and measure:** Valid supported calls route correctly; unavailable or stale calls fail before effects. Preserve immutable persisted discovery activation. Optional programmatic CodeMode is deferred.
- **Dependencies:** Registry checks are mandatory in earlier schema/tool changes; this entry completes remaining proof without a competing registry.
- **Owners:** [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/tools/TaskToolSurface.ts](src/core/tools/TaskToolSurface.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts).
- **Nearest coverage:** [ToolRegistry.spec.ts](src/core/tools/__tests__/ToolRegistry.spec.ts), [TaskToolSurface.spec.ts](src/core/tools/__tests__/TaskToolSurface.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/registry.rs:402](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/registry.rs#L402), [codex-rs/core/src/tools/registry.rs:768](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/registry.rs#L768).

<a id="item-18"></a>

### 18. File tools: verify data safety and explicit patch differences

Original assessment area **11**. Kind: **Verification first**. Effort: **1–3 days initially; remaining matrix 4–7 cumulative**.

- **Why:** There is no missing live file primitive established. Retired read/search implementations must not be mistaken for active tools or a feature gap.
- [x] **Work:** Verify shell exploration and patch semantics across exact bytes, stale buffers, destination changes, partial failures and reload. Repair only a reproduced invariant violation.
- [x] **Accept and measure:** Expected bytes/errors and approval-time content checks hold. Preserve existing-file Add rejection and missing-final-newline behavior unless an explicit compatible product change is approved; never weaken editor-version fences for a score.
- **Dependencies:** File/mutation checks accompany any earlier effect change. No revived parallel read/search surface.
- **Owners:** [src/core/tools/ApplyPatchTool.ts](src/core/tools/ApplyPatchTool.ts), [src/core/tools/apply-patch/apply.ts](src/core/tools/apply-patch/apply.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts).
- **Nearest coverage:** [ApplyPatchTool.spec.ts](src/core/tools/__tests__/ApplyPatchTool.spec.ts), [apply.spec.ts](src/core/tools/apply-patch/__tests__/apply.spec.ts).
- **Codex source/tests:** [codex-rs/apply-patch/src/lib.rs:473](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/apply-patch/src/lib.rs#L473), [codex-rs/apply-patch/src/text_file.rs:104](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/apply-patch/src/text_file.rs#L104).

<a id="item-19"></a>

### 19. Approvals: verify current authority before optional risk review

Original assessment area **9**. Kind: **Verification and optional capability**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** The injectable reviewer already exists; an optional configured risk-review service is not a missing default approval engine.
- [x] **Work:** Verify once/session/deny/cancel outcomes, hook narrowing, grant invalidation, new shell identities and captured authority. Address only reproduced defects; keep optional model-review wiring separate.
- [x] **Accept and measure:** No stale grant, hook-produced authority growth or cancellation-triggered effect. Preserve exact reviewed-call grants and human fallback. Do not bypass approval to improve timing.
- **Dependencies:** Approval checks are release-blocking for earlier command/scheduler changes. Optional review service follows an explicit product and authority decision.
- **Owners:** [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts), [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/auto-approval/taskSessionApprovalGrants.ts](src/core/auto-approval/taskSessionApprovalGrants.ts).
- **Nearest coverage:** [ToolScheduler.approval-failure.spec.ts](src/core/agent/__tests__/ToolScheduler.approval-failure.spec.ts), [Task.spec.ts](src/core/task/__tests__/Task.spec.ts).
- **Codex source/tests:** [codex-rs/core/tests/suite/scenarios_managed_human_approval_tests.rs:25](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/scenarios_managed_human_approval_tests.rs#L25), [codex-rs/core/src/tools/approvals.rs:525](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/approvals.rs#L525).

<a id="item-20"></a>

### 20. Modes and questions: make deliberate compatibility decisions last

Original assessment area **19**. Kind: **Verification and product choice**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** Alpha allows blocking questions in Code as well as Plan; Codex defaults differ. Both already support asynchronous questions. Removing a useful host behavior is not an automatic performance improvement.
- [x] **Work:** Verify Plan/Code availability, root/catalog gating, asynchronous delivery, explicit plan handoff, cancellation, saved-mode restoration and reload. Change default question availability only for an agreed user-facing contract.
- [x] **Accept and measure:** No lost answer, stale handoff or retired mode gaining write authority. Preserve host-controlled mode changes and checklist approval/edit protections.
- **Dependencies:** Reuse user-input, lifecycle and persistence fixtures. No switch_mode tool or replacement question runtime.
- **Owners:** [src/core/prompts/tools/native-tools/index.ts](src/core/prompts/tools/native-tools/index.ts), [src/core/tools/RequestUserInputTool.ts](src/core/tools/RequestUserInputTool.ts), [packages/types/src/mode.ts](packages/types/src/mode.ts).
- **Nearest coverage:** [RequestUserInputTool.spec.ts](src/core/tools/__tests__/RequestUserInputTool.spec.ts), [mode-retirement.test.ts](packages/types/src/__tests__/mode-retirement.test.ts).
- **Codex source/tests:** [codex-rs/tools/src/tool_config.rs:6](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/tools/src/tool_config.rs#L6), [codex-rs/core/src/tools/handlers/request_user_input.rs:67](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/request_user_input.rs#L67).

## Validation and promotion for each change

Run the smallest owning checks during development, then the required affected-surface gates from [AGENTS.md](AGENTS.md). These commands are future implementation gates, not checks claimed to have passed for this plan.

| Affected work                       | Required validation                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension/core                      | Focused owning `pnpm --dir src test <file>`; `pnpm --dir src check-types`                                                                                                                                             |
| Shared types or webview             | Owning package tests/typecheck plus affected consumers; webview interaction tests/typecheck when touched                                                                                                              |
| Turn/retry/verification/stopping    | `pnpm harness run turns`, then `pnpm harness matrix --require turns`, plus affected exact-host gates                                                                                                                  |
| Provider/history/compaction         | Provider transform, turn/persistence and cancellation/error/reload cases                                                                                                                                              |
| VS Code integration                 | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1410`                                                                                                                                                                |
| Host adapters/minimum-host behavior | Also `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250`                                                                                                                                                   |
| Managed-agent contract              | Focused lifecycle/delegation tests and `pnpm certify:managed-agents:automated`                                                                                                                                        |
| Performance claim                   | Same fixed workload/conditions before and after; independent outcomes must not regress                                                                                                                                |
| Agent-affecting release             | Passing real short-task comparison against the previous published commit: at least three samples on each of two providers, matching each provider's model/settings and run conditions; evidence bound to both commits |

Use the existing [quality capture entry point](apps/vscode-e2e/src/runQuality.ts) and [release-quality evidence validation](scripts/harness/release-quality.mjs) for release evidence. Follow their current supported arguments when execution starts. Scripted checks do not replace live release evidence; a single successful live run does not establish a general improvement.

Mark an item finished only after its named behavior and outcome cases pass focused checks and integration review, and any claimed efficiency benefit is measured. Run the broader required gates at the final integrated stage before declaring the entire queue complete. If no gap or benefit is demonstrated, retain the evidence, skip the unjustified production change and update the queue. Do not revise graders, erase uncertainty or relax protections to make the result look better.

## Explicitly deferred or preserved

- Optional native speculative asynchronous compaction: only after supported native checkpoints and stale-prefix safety; prior estimate 6–10 additional days.
- Optional live full-model activation: no demonstrated default snapshot defect; prior estimate 5–10 additional days after capture/provider proof.
- Optional programmatic CodeMode: upstream default-disabled capability, distinct from Alpha Code editing mode; prior estimate 15–30 days. It must use the existing registry/scheduler, not a parallel agent runtime.
- Optional configured risk-review service: reuse the existing reviewer interface; prior estimate 8–15 days with explicit authority scope and human fallback.
- Optional remote/package skill routing and audio/URL MCP capabilities: defer until supported endpoint/host workflows justify them. Keep resource/auth ownership, bounded output and provider capability checks.
- WebSocket/cache-affinity changes: benchmark a documented supported route first. Full-history HTTP/SSE is not itself a semantic failure.
- Saved model access-program preferences in the newly checked Codex commit: revisit under provider/model capability work if Alpha exposes such a preference; do not invent unsupported request fields or alter execution authority.
- Preserve Alpha-only rules, built-ins, Tickets, previews, schedules, safe retired-mode restoration, exact grants, editor checks, finite budgets, Stop cleanup and explicit uncertain-effect recovery. Literal 100% matching of every upstream/product configuration is not the completion criterion for this queue.

## Execution record

- Baseline committed: `ab9989c3fd8adbee3bbd90a6abc42757e7b8b04f`; snapshot hooks were skipped for this commit only because the hook rewrites staged files. No validation pass is implied by the snapshot.
- Current head: **none**. All **20/20** focused scopes are finished; the ranked implementation queue is closed.
- Clean isolated reference **ab9989c3** installed from the frozen lockfile and source-built successfully with `pnpm bundle --concurrency=2`. Reference runtime and candidate source identities are recorded in `/tmp/alpha-codex-implementation-20261103`; local baseline fixtures do not constitute Codex runtime or live-provider evidence.
- Implementation checkpoint: `078b0dd0691ad5cca16a34491ab67c8a21acb825`. Test-contract follow-ups: `9585c82357af0579a30c75c4ccd42b70e726e8de` and `08426bbc7cbafd56f28f436aa5d8dcd2ae18faff`. Production code is unchanged by those follow-ups. The runtime validation below targets clean `08426bbc`; final closeout changes only this plan.
- Three workers and root completed disjoint assignments and integration reviews within the rolling ten-rank window. All implementation/test leases are released.
- File ownership is explicit; workers do not commit or edit the tracker. Shared schemas and replay contracts are coordinated before integration.
- Final broader validation: **available gates passed; minimum-host qualification remains open**. Exact 1.125.0 could not launch while the shared installer mutex was held. No unavailable gate is counted as passed.
- For each completed item, append the actual contract, changed files, focused commands/results and any remaining external capability limits below. Update the head/window only after integration review. Keep run evidence with the change or outside the checkout.

### Focused completion evidence

- **1 ✅ — Completion/goals:** Explicit successful, no-continuation provider outcomes complete through existing admission/hooks even without visible output; unknown or truncated EOF retains recovery. The goal ledger blocks after three automatic empty final turns, resets on activity, and rejects stale/duplicate settlement. Nine affected engine/task/goal/persistence files passed **360 tests**. Frozen empty-response fixture uses **one model request instead of two**; this is scripted evidence, with no general live-quality claim. Native adapter normalization is integrated with item 4. Combined typechecking passed; final integrated results are recorded below.

- **2 ✅ — Bounded early reads:** Launch up to four durably accepted, audited independent reads through the existing scheduler; keep the 16-result retention bound and join every started read before ordered receipt integration. Mutations, approvals, hooks and lifecycle barriers retain existing gates. Three affected files passed **476 tests**. In one paired sample using controlled fake-clock scheduler time, the same frozen four-read scripted workload completed in **1,300 ms / one pre-EOF start** on clean source-built `ab9989c3`, and **400 ms / four pre-EOF starts** on the candidate; this is not a wall-clock benchmark. Independent outcome assertions, one model request and ordered exactly-once receipts were unchanged. Failure tests now explicitly preserve successful siblings admitted before a failure became observable and block later work; cancellation/steering drain admitted reads.

- **3 ✅ — MCP model projection:** Non-null structured content, including `{}`, is the model's authoritative compact JSON; null/absent content retains ordered text/media fallback. UI evidence, typed errors/cancellation, bounded output and `_meta` exclusion are preserved. Two focused files passed **50 tests**. Three frozen serialized-content fixtures changed **90→32**, **55→4** and **224→32 bytes**; these are fixture bytes, not measured model tokens or general performance. Production/test formatting and CRLF-aware diff checks passed.

- **4 ✅ — Supported response metadata:** Bounded validated source envelopes preserve native item identity/status, annotated content parts and logprobs through canonical history, JSON reload and compatible native requests. Model/provider/account changes strip the envelope while retaining visible text and tool transactions; canonical call fields retain authority. **276 extension tests**, **14 shared-schema tests** and the focused scope case passed. Private output-token replay is not enabled; metadata over the declared bound is omitted. Final host/runtime results are recorded below.

- **5 ✅ — Local/native compaction and accounting:** The final **28-file / 893-test** owning matrix passed, with package/extension typechecks and shared types build. Root's affected turn/goal/stream/read integration passed **676 tests**; independent archive-chain cases passed **3/3**. Local pruning recovers the reducible frozen history in **two requests**, where the old three-attempt strategy exhausted. Verified native API-key models can use documented whole-window compaction; unsupported/SIWC/VS Code LM routes retain local recovery. Persisted windows are bounded, account/model/profile/transcript scoped, retain the archive on revocation, and support compatible parent continuation/reload. Child capture restores plaintext archived steps without exporting the parent checkpoint or ciphertext to incompatible routes.

- **5 accounting correction:** Final Task accounting coverage passed **255 tests**, schema coverage **19**, and core/wrapper metrics **88** plus core typecheck. Every admitted native/local attempt finalizes reported usage or explicit unknown-source counters, persists bounded host receipts before billing the captured original goal, and contributes task metrics once with correct cache/reasoning treatment. Manual root elapsed time includes trailing cleanup through a replay-safe zero-token companion; outer-step/parallel-child time is not doubled. Blocked zero-cost saves drain before replacement, missing/full receipt anchors reject before provider effects, and cancellation/discarded checkpoints retain known charges. A recursive new test fixture caused an earlier incomplete OOM run; it was corrected and the full final matrix reran successfully.

- Native compaction has source/mocked-contract evidence, with no live-provider long-task speed/cache/quality claim. Final integrated results below remain separate from the focused completion marks.

- **6 ✅ — Explicit shell/login controls:** Canonical schema/parser/normalization retain controls and carry one frozen, validated executable/argv specification through existing Execa and VS Code terminals. Interpreter identity affects approval and terminal reuse; explicit choices require fresh approval, remain outside Plan/audited early reads, and revalidate executable identity before launch. Omitted arguments preserve the old path. Primary coverage passed **91 tests**, localization/hardening follow-up **31**, legacy shell behavior **40**, plus adjacent command suites. The real ripgrep integration passed **8/8** after supplying the extension-bundled executable on the Windows child PATH; no test was weakened. Approved shell locations and Alpha authority protections remain deliberate constraints. The exact reference-host gate passed; the minimum-host launch blocker is recorded below.

- **7 ✅ — Conditional dispatch decision:** Reuse item 2's frozen stream-tail trace: four supported audited reads start before EOF, and the candidate's **400 ms** critical path is the configured **300 ms read + 100 ms durable-save phase**. No additional dispatch waiting remains in this measured workload. Current completed-call receipts, full step identity, truncation recovery, Queue/Steer, hook and mutation barriers passed in the same **476-test** affected matrix. Retain this safe scope; broader pre-EOF admission for file/MCP/mutation tools has no demonstrated benefit with an equally verified approval/effect contract. No extra scheduler, speculative mutation or provider transport rewrite was added. This closes the plan's conditional evaluation, not a claim of literal upstream dispatch identity for every tool.

- **8 ✅ — Provider continuity:** **388 tests** across nine files plus **three optional-host fallback cases** passed. Fresh actual handlers replay cold authoritative transcripts correctly for native OpenAI, generic Responses, SIWC token rotation and VS Code LM host mocks for 1.125/1.141. A reproduced Chat adapter gap was repaired: recognized clean `stop` now declares no continuation; `tool_calls` declares continuation, while missing EOF/length/unfinished calls remain guarded. New host tests compile against minimum-host types using supported structural adapters. Auth/cancellation/usage evidence and account/model isolation are explicit; no unsupported transport rewrite was introduced. Host mocks are not real host or live-provider results.

- **9 ✅ — Persistence/replay:** Eight focused files passed **179 tests**, including five new real-store cold-recovery proofs; the enriched five-case file also passed alone. Accepted-call, effect-start, API-result and journal-result crash cuts settle exactly one truthful result across repeated cold instances without executing the old mutation. Existing process-kill tests supplement these deterministic cuts. Interrupted rewind retains summary and steering, removes the later paired turn, and durably revokes opaque account state. No persistence-engine replacement was needed; native checkpoint cases are owned by item 5.

- **10 ✅ — Cancellation proof:** Eight focused cancellation/disposal/command-stop/hook/managed-owner files passed **88 tests**; item 2 additionally covers cancellation/steering of four admitted reads and ordered receipts. Controlled barriers verify engine abort, post-EOF/late-owner rejection, blocked command producers, disposal listeners/resources, question cancellation, hook stop ownership and managed-store cleanup. No cancellation rewrite was needed. Alpha Stop continues to terminate owned background commands, an intentional difference from Codex interrupt preserving unified-exec sessions. Native-compaction cancellation and accounting proof is recorded under item 5; no end-to-end 100 ms guarantee is claimed.

- **11 ✅ — Immutable step context:** Nine focused files passed **121 tests** (including two targeted compaction cases). Two new controlled actual-Task request fixtures change/remove project guidance while a provider request is gated: retry retains the original exact role/content/origin and instruction digest; only a fresh step adopts replacements/removal with a new context/digest. Existing proofs retain raw executable provider options and captured tools/skills across retries, create explicit child/compaction ancestry, and reject stale-owner publication. No snapshot-engine rewrite was justified. Context/compaction evidence is reused by item 13 and is not an additional independent test count.

- **12 ✅ — Retry experiment, candidate rejected:** The frozen paired experiment covers 14 workloads plus four jitter quantiles; the policy/actual-Task matrix passed **55 tests**. At median jitter, a 200 ms Codex-style candidate reduces one/two transient waits **500→200 / 1,500→600 ms**, but a 500 ms outage increases requests **2→3** and a 2 s outage fails after four attempts at **1,400 ms**, where Alpha recovers on attempt four at **3,500 ms**. Preserve the current finite-cap cadence: faster backoff did not preserve independent recovery outcomes. Production policy remains byte-identical to baseline; no unused profile/settings or unbounded retry were added. This is a completed qualification decision, not a promoted optimization.

- **13 ✅ — Guidance and memory attribution:** Prompt discovery/provenance/memory coverage passed **142 tests**, with changed/removed guidance retry/fresh-step and child/compaction proof reused from item 11. A concrete commentary-usage mismatch reproduced three failures and was repaired in the existing memory projection: completed commentary can attribute memory usage after durable response persistence, while final-display citation decoration, unknown partial-phase/reasoning/tool/input exclusions, reference limits, provenance and replay receipt identity remain intact. Five affected memory files passed **133 tests**. No selected workload justified configurable quota; preserve the tested 32 KiB UTF-8 project-instruction safety bound and advisory memory authority. No prompt-cache/quality improvement is claimed.

- **14 ✅ — Native Delegation V2:** Seven focused files passed **446 tests**, and a new native-only real AlphaProvider/Task lifecycle proof passed separately. Four initial/recovery × same/changed-profile cases prove full archive retention before actual child capture. The native proof uses native spawn parsing and the real provider prepare/launch path, full fork/shared workspace, passive versus triggering mail, stable authority across restored Task generations, timeout-only wait through the actual Task/scheduler, one durable completion result and cumulative usage. This particular spawn proof does not route through SpawnAgentTool. No delegation production rewrite was needed. Legacy array/targeted-wait harnesses are not presented as native V2 evidence; Alpha's empty-tree immediate wait result remains a deliberate adaptation.

- **15 ✅ — Lifecycle/sessions and bounded UI:** Twenty-four distinct focused files passed **372 tests** across host/session/journal, queue/steer/admission and webview projection. Existing evidence covers fifty-session incremental patches, terminal/review ownership, duplicate/gap/reload routing, payload bounds and coalesced rendering. One new controlled disposal proof cancels a pending animation frame, invokes an already-captured stale callback after replacement, and verifies the fresh provider's transcript/listener still updates correctly. No production lifecycle/UI engine change was justified.

- **16 ✅ — Local/built-in skills:** Twenty distinct focused files passed **305 tests**, including five new real-file manager→native SkillTool cases for paging, interrupted reload and unchanged/changed/removed/read-failure child sources. Discovery, exact selection, explicit-only catalogs, digest/provenance and instruction authority retain the existing implementation. No new remote routing/service was justified. Alpha deliberately invalidates a continuation when its source changes instead of serving a cached older snapshot; each load/page retains existing host approval and cannot widen child authority.

- **17 ✅ — Registry identity/authority fix:** Four reproduced alias failures were fixed by using the same sealed registry identity for schema deduplication, visible/allowed/disabled policy, output limits and executable lookup. Direct scheduler proofs deny both alias/canonical spellings with zero executor calls. Core/discovery/profile/provider matrices passed **188 + 44 tests** (overlapping case counts are not summed as a global total). A final cap review reproduced valid finite limits becoming `NaN` beside invalid alias overrides; a finite-value filter preserves the valid cap. The latest three-file follow-up passed **129 tests**, including all **14** new alias/cap guards. No competing registry or mutable step authority was introduced.

- **18 ✅ — File and patch safety:** Nine focused files passed **325 tests**, covering native multi-file approval, stale source/destination/editor checks, protected/ignored paths, partial and committed outcomes, byte/line-ending semantics, parser/context matching, FIFO mutation ownership and audited shell exploration. Earlier real-ripgrep and cold-recovery evidence is reused, not counted again. Preserve existing-file Add rejection and unterminated-file newline handling: Codex can overwrite an Add target and historically adds update newlines, while Alpha's stricter data-preservation choices remain deliberate. No retired file/read runtime or weaker version fence was added.

- **19 ✅ — Approval authority:** Seventeen distinct focused files/groups passed **557 executed tests**, including three new actual-scheduler shell/login/TTY identity cases and 31 injected-reviewer/human-fallback cases. Output/wait-only changes can retain exact grants; changed execution intent needs a fresh decision, and denial produces one truthful result without effects. Hook denial, protected/MCP revocation, stale owners, cancellation, child ceilings and reload remain enforced. Existing injected-reviewer authority is preserved; optional external risk service is deferred. Codex enterprise fresh-human-only checkpoint policy has no equivalent Alpha managed-policy flag and is explicitly unsupported equivalence, rather than being counted as passed or conflated with Alpha's existing explicit-review contract.

- **20 ✅ — Modes/questions contract:** Six core files passed **150 tests**, two webview interaction files **15**, and mode-retirement schemas **10**. Root-only grouped questions, async delivery, cancellation, pending plan handoff, captured catalogs, saved retired-mode restoration and explicit host mode authority remain intact. Preserve Alpha's existing blocking questions in both Code and Plan plus its async question tool: Codex default-mode feature/availability and blocking defaults differ, but removing a working extension clarification path has no demonstrated benefit. No `switch_mode` tool or model-controlled execution authority was added; unknown/retired saved modes still restore safely into Plan.

### Final integrated validation

Runtime/checkpoint: **`08426bbc7cbafd56f28f436aa5d8dcd2ae18faff`**. Windows and Linux Git confirmed a clean source identity. Windows Node **24.21.0**, pnpm **11.24.0** and the pinned workspace toolchain were used. The wrappers supply the extension-bundled ripgrep on the Windows child PATH.

| Check                                                              | Result                   | Scope and limits                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting, diff and source audit                                  | **PASS**                 | All 100 implementation paths and committed blobs match recorded hashes; 75 LF / 25 CRLF conventions preserved. Baseline diff is exactly 78 modified / 22 added files, with no lockfile, generated-output or hook changes. This Markdown closeout is formatted separately. |
| `pnpm lint --concurrency=2`                                        | **PASS**                 | Affected extension, shared-package, webview and host-runner workspace checks.                                                                                                                                                                                             |
| `pnpm check-types --concurrency=2`                                 | **PASS**                 | Affected workspace types, including minimum-host VS Code declarations and the host fixture correction.                                                                                                                                                                    |
| `pnpm test --concurrency=1`                                        | **PASS**                 | **23,317 passed / 45 declared skips** across the extension, webview and dependencies. The fresh extension run passed 18,771 tests; the final checkpoint reused matching successful Turbo inputs. Assertions, worker caps and timeout limits were preserved.               |
| `pnpm harness run turns`                                           | **PASS**                 | **814 tests / 14 files**, no skips. Source-bound receipts retain clean commit/tree/lockfile identities and unchanged-boundary checks in `artifacts/harness/`.                                                                                                             |
| `pnpm harness matrix --require turns`                              | **PASS**                 | The required `turns` lane has a matching executed-pass receipt. This does not qualify unrelated unexecuted matrix lanes.                                                                                                                                                  |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1410`             | **PASS**                 | Exact **1.141.0**, **62 tests / 15 suites**, no pending or failed cases. Includes real extension-host compaction, approvals, background processes and VS Code LM contracts.                                                                                               |
| `pnpm certify:managed-agents:automated`                            | **PASS**                 | **6,176 deterministic checks**, then **4/4** scripted acceptance suites on exact **1.141.0**, with no skipped cases. Live-provider/rendered-UI acceptance remains separate.                                                                                               |
| `pnpm knip`                                                        | **PASS**                 | The repository command checks unused files (`--include files`).                                                                                                                                                                                                           |
| `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250`     | **BLOCKED before tests** | Both attempts could not launch exact **1.125.0** because Windows' shared `vscode-updating` mutex remained held for the full startup wait. No minimum-host test executed or alternate host substituted.                                                                    |
| Live-provider quality, latency, cache/token and release comparison | **NOT RUN**              | Scripted/source evidence supports the contracts above; it does not establish general live-model gains or literal 100% behavioral identity.                                                                                                                                |

The 1.141.0 runs used fixture-defined model IDs under `scripted` and `vscode-lm-fixture`, with isolated runner-owned workspace, user-data, extension and Alpha-home directories. Host receipts record each actual version, provider mode, selection, profile paths, executed counts and verified process ownership. No signed-in live-provider profile was used. Counts from overlapping focused, workspace and certification matrices must not be added into a unique-test total.

The minimum-host blocker is outside Alpha's extension startup. Cached 1.125 applies the shared installer-mutex guard to archive builds; cached 1.141 limits it to installed user/system builds. A pre-existing installed-editor updater was found, with no remaining test-owned host to clean up; exact kernel mutex ownership was not proven. The safe remaining action is to resolve the installed editor's pending update normally, then rerun the unchanged exact-1.125 command. Minimum-host declarations and focused host-fallback coverage passed, but do not replace that gate.

Qualification follow-ups kept the original outcomes strict. The first parallel-package unit attempt hit two unchanged core process-fixture deadlines; both passed unchanged on isolated clean baseline/candidate runs, and the serial full core suite passed all 342 tests. The later broad run exposed 19 old response-envelope expectations, one old shell-schema exclusion, and an embedding inventory assertion that also failed on clean `ab9989c3`. Eight repaired files passed 279 focused tests, preserving exact metadata, ordering, opaque state, usage and call/result checks; two truncated-stream negative checks were strengthened.

The real-host 200k compaction fixture expected the old three summary requests but observed the intended two-request recovery. Independent source reviews verified why budget-aware pruning now reaches a fitting complete-step suffix on the first retry. The corrected fixture requires exactly two summaries, retains the three-request cap, and checks initial rejection, shrinking input, final token fit, five normal requests, settled lifecycle, archived evidence and a usable follow-up. All six compaction host cases passed; no production change was needed during these qualification repairs.

Baseline and implementation snapshots used per-command hook overrides to preserve exact staged bytes and CRLF conventions. A later normal hook attempt failed before checks because the existing CRLF shell script is incompatible with WSL; its staged formatter and broad lint checks were run explicitly and passed before committing. No hook or persistent Git configuration was changed.

Run evidence is retained outside tracked source in `/tmp/alpha-codex-implementation-20261103`, plus the existing ignored harness/certification and runner-owned host artifact locations. This is implementation and deterministic/host qualification, with the minimum-host exception above; live release promotion remains subject to the separate release gate.
