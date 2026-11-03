# Codex convergence delivery plan

**Status: planned. Implementation has not started.** This file is the ordered queue for improving task outcomes, latency and behavioral alignment in Alpha's existing TypeScript harness. It is not authorization to weaken approval, workspace, persistence or lifecycle protections.

## Objective and reference

Prioritize fewer unnecessary model requests, clearer tool evidence, safe overlap of independent work and reliable long-task continuity. Ship small measured changes through the shared kernel. The earlier convergence percentages were source-review estimates, not measured accuracy, work remaining or acceptance thresholds.

- Current Codex reference: [`ac558e2a32`](https://github.com/openai/codex/commit/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e), checked November 3, 2026.
- The detailed assessment used `079e17a422347e49d02501304f79fade7e569362`. The intervening commit only adds saved Daybreak preference resolution against advertised model programs; its source/tests were inspected and it does not change the loop findings below. Recheck upstream before each item.
- Alpha basis: repository HEAD `4850a3f12608084374577106f43f14c243677bda` plus existing user changes. This working tree is not a qualified clean benchmark baseline; identify isolated reference/candidate source builds before measurement.
- Keep VS Code **1.125.0** compatibility and use exact **1.141.0** as the reference host. Keep provider selection separate from execution and approval authority.
- Codex OS sandbox architecture is outside this queue. Built-in skills, Tickets, HTML preview and schedules remain integrated first-class Alpha capabilities.

## How to use the order

Ranks reflect expected task benefit, scope of affected workflows, evidence confidence, effort, risk and prerequisites. They are engineering judgments, not measured performance claims. Backend-limited capabilities are explicitly conditional. A reproduced correctness, security or data-integrity defect takes precedence over this order.

Complete Gate 0 for the first thin slice, then start items **1–3**, shipping and measuring each independently. Continue with **4–6**, where metadata enables native continuity. Item **7** proceeds only if remaining dispatch delay warrants the extra risk. Verification entries later in the queue close remaining coverage; their relevant safety tests are required in every earlier affected change.

Effort ranges are rough engineering days for one experienced contributor, including focused integration/testing and excluding unavailable provider access. Shared setup, scheduler and continuity work overlap; do not add the rows or turn them into a calendar promise. Re-rank after actual baseline/result evidence.

| Rank | Work                                                                                | Kind                                 | Potential benefit                                                       | Initial effort                                                                              |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | [Completion and goals: remove unnecessary model round trips](#item-1)               | Behavior change                      | Fewer unsolicited retries and repeated no-progress turns                | 3–5 days; goal follow-up 2–4 days, overlapping                                              |
| 2    | [Scheduling: overlap already-audited early reads](#item-2)                          | Optimization                         | Less serial waiting during streamed tool batches                        | 2–4 days for the bounded execution change; 3–6 with primary coverage                        |
| 3    | [MCP: give the model one authoritative structured result](#item-3)                  | Behavior change                      | Clearer tool evidence and less conflicting model input                  | 2–4 days for projection; 3–5 with primary coverage                                          |
| 4    | [Response items: preserve supported metadata through replay](#item-4)               | Continuity foundation                | Lossless supported replay and a base for native compaction              | 3–5 days initially; broader coverage 6–10 cumulative                                        |
| 5    | [Compaction: recover long tasks and preserve native continuity](#item-5)            | Recovery and capability              | Better recovery from oversized context and supported native checkpoints | 2–4 days for local overflow recovery; native support 7–12 days, overlapping continuity work |
| 6    | [Shell sessions: make explicit shell and login choices reproducible](#item-6)       | Capability                           | Fewer environment mismatches in CLI-style command workflows             | 5–8 days initially; hardening 8–13 cumulative                                               |
| 7    | [Turn loop: expand safe completed-item dispatch only where useful](#item-7)         | Conditional optimization             | Earlier useful work after safe calls complete                           | 5–10 days, shared with item 2 and durable admission                                         |
| 8    | [Provider continuity: prove supported route equivalence](#item-8)                   | Verification first                   | Reliable continuation without an unnecessary transport rewrite          | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 9    | [Persistence and replay: close crash-point evidence gaps](#item-9)                  | Verification first                   | Tasks resume with correct instructions, effects and checkpoints         | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 10   | [Cancellation: prove cleanup without changing Stop semantics](#item-10)             | Verification first                   | No leaked work or false completion after Stop                           | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 11   | [Step context: prove immutable capture across supported paths](#item-11)            | Verification first                   | Stable settings and authority during requests and retries               | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 12   | [Retries: align cadence only after measuring recovery behavior](#item-12)           | Policy experiment                    | Potentially less recovery waiting with bounded work                     | 1–2 days for a captured profile; 2–4 with initial proof                                     |
| 13   | [Instructions and memory: verify guidance, then improve bounded controls](#item-13) | Verification and targeted controls   | Current project guidance and explicit memory usage evidence             | 2–3 days for primary proof; optional quota 2–3 and attribution 1–3, overlapping             |
| 14   | [Delegation V2: verify the actual native surface](#item-14)                         | Verification first                   | Trustworthy delegated work and recovery                                 | 2–4 days initially; remaining matrix 5–9 cumulative                                         |
| 15   | [Lifecycle and sessions: verify projected behavior and bounded UI work](#item-15)   | Verification first                   | Correct session routing with responsive streaming                       | 1–2 days initially; remaining matrix 3–5 cumulative                                         |
| 16   | [Skills: prove local behavior before adding remote source routes](#item-16)         | Verification first                   | Reliable skill selection, loading and inherited provenance              | 2–3 days initially; remaining matrix 4–6 cumulative                                         |
| 17   | [Tool registry: prove identity and discovery activation](#item-17)                  | Verification first                   | Advertised tools and executable authority stay consistent               | 2–4 days initially; remaining matrix 4–8 cumulative                                         |
| 18   | [File tools: verify data safety and explicit patch differences](#item-18)           | Verification first                   | Correct edits without overwriting external work                         | 1–3 days initially; remaining matrix 4–7 cumulative                                         |
| 19   | [Approvals: verify current authority before optional risk review](#item-19)         | Verification and optional capability | Fewer incorrect or stale approval decisions                             | 2–4 days initially; remaining matrix 4–7 cumulative                                         |
| 20   | [Modes and questions: make deliberate compatibility decisions last](#item-20)       | Verification and product choice      | Predictable user interaction without lost authority                     | 2–4 days initially; remaining matrix 4–7 cumulative                                         |

## Gate 0: establish the smallest useful measured baseline

- [ ] Freeze the first item's input fixtures, independent outcome assertions, expected reference traces, provider/feature scope and performance workload before repair. Extend the existing [harness](scripts/harness/catalog.mjs), [scripted core-loop suite](apps/vscode-e2e/src/suite/core-loop.test.ts) and [boundary suite](apps/vscode-e2e/src/suite/core-loop-boundaries.test.ts); do not build another agent runtime or wait for a new all-feature test platform.
- [ ] Record clean source-built Alpha reference/candidate identities, source digests, pinned Codex revision, exact host, model/provider/settings, profile and warm/cold conditions. Preserve the current user work in isolated preparation. Distinguish actual runtime/reference evidence from source-only expectations; missing execution or credentials remain unavailable.
- [ ] Capture task outcome and independent tests first, then model requests, tool waits/overlap, retry amplification, wall time and input/cache/output tokens. Record sample count and dispersion. Preserve the original workload/graders while measuring; any proposed fixture expectation change must be explained separately from the baseline.
- [ ] Name required safety invariants and deliberate differences: tool/result integrity, captured authority, bounded work, stale-content refusal, cancellation, uncertain effects and post-turn review. Never count a known exception as a passed Codex conformance case.
- [ ] Start with the fixtures needed for items 1–3. Capture evidence once and reuse it across related items. Do not make full 20-area qualification a prerequisite for the first small change.

## Ordered work

<a id="item-1"></a>

### 1. Completion and goals: remove unnecessary model round trips

Original assessment area **2**. Kind: **Behavior change**. Effort: **3–5 days; goal follow-up 2–4 days, overlapping**.

- **Why:** An avoidable model request can cost more than a local tool optimization. This is a concrete terminal-policy difference, although its frequency in real tasks is not yet measured.
- [ ] **Work:** Normalize authoritative provider terminal signals, honor a genuinely successful empty turn through existing completion admission, then align the three-empty automatic-goal stop/reset policy. Keep unsupported or truncated streams on bounded recovery. Keep task verification and user waits explicit.
- [ ] **Accept and measure:** A successful-empty reference trace performs no unsolicited retry; failed/truncated output never becomes success; goal counters reset correctly and cannot double-count replay. Measure model calls, goal progress, wall time and usage.
- **Dependencies:** Gate 0 and supported provider terminal semantics. Goal accounting follows terminal normalization. Provider, retry and cancellation tests are part of this change.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/AgentTurnEngine.ts](src/core/agent/AgentTurnEngine.ts), [src/api/providers/openai.ts](src/api/providers/openai.ts).
- **Nearest coverage:** [Task.stream-recovery.spec.ts](src/core/task/__tests__/Task.stream-recovery.spec.ts), [AgentTurnEngine.spec.ts](src/core/agent/__tests__/AgentTurnEngine.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/session/turn.rs:3396](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/turn.rs#L3396), [codex-rs/core/src/session/turn.rs:637](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/turn.rs#L637).

<a id="item-2"></a>

### 2. Scheduling: overlap already-audited early reads

Original assessment area **8**. Kind: **Optimization**. Effort: **2–4 days for the bounded execution change; 3–6 with primary coverage**.

- **Why:** The early-read path exists but chains execution serially. Improving this bounded path is a smaller experiment than replacing turn orchestration.
- [ ] **Work:** Let the existing ToolScheduler admit independent prepared exec_command reads from the stream concurrently. Keep durable acceptance, captured policy, scope checks, hook barriers, worker/result bounds and ordered receipt publication. Keep mutations and terminal interactions serialized.
- [ ] **Accept and measure:** Controlled traces prove two eligible reads overlap before EOF, limits hold, serial barriers work and receipts remain ordered/exactly once. Compare the same multi-read workload before and after; retain the optimization only with demonstrated benefit and no outcome regression.
- **Dependencies:** Gate 0. Shares scheduler/item-admission work with item 7; count it once. Cancellation and persistence regressions must pass in this change.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts).
- **Nearest coverage:** [Task.spec.ts](src/core/task/__tests__/Task.spec.ts), [ToolScheduler.command-batching.spec.ts](src/core/agent/__tests__/ToolScheduler.command-batching.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/stream_events_utils.rs:335](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/stream_events_utils.rs#L335), [codex-rs/core/src/tools/parallel.rs:286](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/parallel.rs#L286).

<a id="item-3"></a>

### 3. MCP: give the model one authoritative structured result

Original assessment area **18**. Kind: **Behavior change**. Effort: **2–4 days for projection; 3–5 with primary coverage**.

- **Why:** Codex prefers non-null structured results; Alpha currently combines structured JSON with ordinary display content. A focused projection change can remove competing answers without changing storage.
- [ ] **Work:** Separate model-facing projection from UI evidence in UseMcpToolTool. Match the verified structured-result precedence, retain text/media fallback when appropriate, preserve isError and bounded output, and keep backend `_meta` out of model input.
- [ ] **Accept and measure:** Freeze conflicting-text/JSON, structured-null, empty structured result, error and supplemental-media fixtures before changing expectations. Match reference model input while preserving UI evidence and repository outcomes. Measure tool-result input size; do not assume fewer tokens improve task quality.
- **Dependencies:** Gate 0. Reuse existing result/history projection. This does not require optional audio or URL elicitation.
- **Owners:** [src/core/tools/UseMcpToolTool.ts](src/core/tools/UseMcpToolTool.ts), [src/core/prompts/responses.ts](src/core/prompts/responses.ts), [packages/types/src/mcp.ts](packages/types/src/mcp.ts).
- **Nearest coverage:** [UseMcpToolTool.media.spec.ts](src/core/tools/__tests__/UseMcpToolTool.media.spec.ts), [elicitation.spec.ts](src/services/mcp/__tests__/elicitation.spec.ts).
- **Codex source/tests:** [codex-rs/protocol/src/models.rs:2491](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L2491), [codex-rs/core/src/tools/context.rs:222](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/context.rs#L222).

<a id="item-4"></a>

### 4. Response items: preserve supported metadata through replay

Original assessment area **5**. Kind: **Continuity foundation**. Effort: **3–5 days initially; broader coverage 6–10 cumulative**.

- **Why:** This is shared continuity work that prevents later checkpoint or provider changes from relying on a lossy projection. No default-loop failure was reproduced, so prove each supported field requirement first.
- [ ] **Work:** Carry bounded, validated provider-scoped item IDs and required metadata through existing stream, canonical response and history contracts. Preserve phases, reasoning state and identity. Reuse native persistence; replay only within supported provider/model/account scope.
- [ ] **Accept and measure:** Native request-to-history-to-request fixtures preserve the required fields across cancellation, late metadata, malformed calls and reload. Incompatible provider state is suppressed. Encrypted reasoning already works; do not rebuild it or add speculative private fields.
- **Dependencies:** Gate 0. Foundation for item 5 and shared with items 8/9. Combine overlapping envelope changes into one reviewed contract change.
- **Owners:** [src/core/agent/AgentResponse.ts](src/core/agent/AgentResponse.ts), [src/api/providers/openai.ts](src/api/providers/openai.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts).
- **Nearest coverage:** [openai-responses-fidelity.spec.ts](src/api/providers/__tests__/openai-responses-fidelity.spec.ts), [openai-codex.spec.ts](src/api/providers/__tests__/openai-codex.spec.ts).
- **Codex source/tests:** [codex-rs/protocol/src/models.rs:899](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L899), [codex-rs/protocol/src/models.rs:1141](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/models.rs#L1141).

<a id="item-5"></a>

### 5. Compaction: recover long tasks and preserve native continuity

Original assessment area **15**. Kind: **Recovery and capability**. Effort: **2–4 days for local overflow recovery; native support 7–12 days, overlapping continuity work**.

- **Why:** This is the largest concrete missing long-task capability, but native benefits depend on the selected backend. Native API work cannot be assumed to improve VS Code LM or another unsupported route.
- [ ] **Work:** First reproduce reducible local-summary overflow requiring more pruning than the current fixed attempts; repair it with budget-aware complete-step removal while retaining finite deadlines and attempt bounds. Then add capability-selected native encrypted compaction behind the existing provider/compaction interface, including checkpoint persistence/replay and the generic fallback.
- [ ] **Accept and measure:** Oversized but reducible histories recover without an unbounded retry loop. Native checkpoints survive continuation and reload, preserve usage/tool pairs, and are rejected after stale transcript/model/auth changes. Compare long-task outcomes, stalls and token/cache counters on supported routes.
- **Dependencies:** Gate 0. Native checkpoints depend on item 4 and the persistence/replay checks in item 9. Deliver local recovery and native support as separate reviewable changes. Optional speculative async compaction is deferred.
- **Owners:** [src/api/index.ts](src/api/index.ts), [src/core/condense/index.ts](src/core/condense/index.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [request-isolation.spec.ts](src/core/condense/__tests__/request-isolation.spec.ts), [Task.compaction-safety.spec.ts](src/core/task/__tests__/Task.compaction-safety.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tasks/compact.rs:63](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tasks/compact.rs#L63), [codex-rs/model-provider/src/capabilities.rs:36](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/model-provider/src/capabilities.rs#L36).

<a id="item-6"></a>

### 6. Shell sessions: make explicit shell and login choices reproducible

Original assessment area **10**. Kind: **Capability**. Effort: **5–8 days initially; hardening 8–13 cumulative**.

- **Why:** Per-call shell/login controls are absent. Adding them addresses a real invocation difference across platforms without replacing the process manager.
- [ ] **Work:** Pass a captured launch specification from schema and normalization through existing ExecuteCommandTool, Execa and VS Code adapters. Include shell/login in approval identity, executor fingerprint, audited-read readiness and terminal reuse. Preserve omitted-argument behavior and reject unsupported selections before effects.
- [ ] **Accept and measure:** Explicit shell/login fixtures produce expected environment behavior; interpreter changes cannot reuse an old grant or early-read classification. Validate stdin/exit/reuse races on supported platforms and run both exact reference-host and minimum-host adapter gates.
- **Dependencies:** Gate 0. Shares capture, approval and scheduling contracts with items 2/8/11/19; their focused checks are required here, not postponed until those queue entries.
- **Owners:** [src/core/prompts/tools/native-tools/execute_command.ts](src/core/prompts/tools/native-tools/execute_command.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/tools/ExecuteCommandTool.ts](src/core/tools/ExecuteCommandTool.ts).
- **Nearest coverage:** [ExecaTerminalProcess.spec.ts](src/integrations/terminal/__tests__/ExecaTerminalProcess.spec.ts), [ExecuteCommand.policy-snapshot.spec.ts](src/core/tools/__tests__/ExecuteCommand.policy-snapshot.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/handlers/shell_spec.rs:63](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/shell_spec.rs#L63), [codex-rs/core/src/tools/handlers/unified_exec.rs:151](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/unified_exec.rs#L151).

<a id="item-7"></a>

### 7. Turn loop: expand safe completed-item dispatch only where useful

Original assessment area **1**. Kind: **Conditional optimization**. Effort: **5–10 days, shared with item 2 and durable admission**.

- **Why:** After the bounded-read change, remaining dispatch delay may still dominate some workloads. Broader admission has greater crash/retry risk and must earn its place with a measured workload.
- [ ] **Work:** Profile the remaining stream tail, then extend existing scheduler/transaction admission only to agreed safe call kinds with trustworthy completion signals. Keep per-item durable acceptance/effect evidence, approvals, stale-content checks and fallback for EOF-only adapters.
- [ ] **Accept and measure:** The selected workload improves while Stop, steering, hooks, stream truncation and reload produce one truthful result per accepted call and never replay an uncertain effect. Preserve Queue versus Steer semantics. No broad Task or engine rewrite is justified.
- **Dependencies:** Items 2/4 plus related crash/approval/cancellation proof. Stop at existing safe read scope if no further outcome or latency benefit is established.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/AgentTurnEngine.ts](src/core/agent/AgentTurnEngine.ts).
- **Nearest coverage:** [Task.spec.ts](src/core/task/__tests__/Task.spec.ts), [Task.completedCallReceipt.spec.ts](src/core/task/__tests__/Task.completedCallReceipt.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/stream_events_utils.rs:335](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/stream_events_utils.rs#L335), [codex-rs/core/tests/suite/tool_parallelism.rs:295](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/tool_parallelism.rs#L295).

<a id="item-8"></a>

### 8. Provider continuity: prove supported route equivalence

Original assessment area **6**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** HTTP/SSE and full-history input can be valid continuation mechanisms. Previous transport/cache deductions did not establish a semantic defect.
- [ ] **Work:** Compare normalized next-request semantics across native OpenAI, SIWC and VS Code LM where supported. Cover auth rotation, late chunks, cancellation, usage and reload. Fix only demonstrated adapter loss, sharing item 4 changes.
- [ ] **Accept and measure:** Supported routes retain the same conversation/tool state without duplicate effects or stale-owner publication. Evaluate WebSocket/cache-affinity work separately only if route support and a matched benchmark justify it; preserve documented HTTP recovery and host constraints.
- **Dependencies:** Gate 0; focused route checks accompany items 1/4/5/6. This entry closes remaining coverage and is not a prerequisite for a transport rewrite.
- **Owners:** [src/api/providers/openai.ts](src/api/providers/openai.ts), [src/api/providers/openai-codex.ts](src/api/providers/openai-codex.ts), [src/api/providers/vscode-lm.ts](src/api/providers/vscode-lm.ts).
- **Nearest coverage:** [openai-responses.spec.ts](src/api/providers/__tests__/openai-responses.spec.ts), [openai-codex.spec.ts](src/api/providers/__tests__/openai-codex.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/client.rs:1525](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/client.rs#L1525), [codex-rs/core/src/client.rs:960](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/client.rs#L960).

<a id="item-9"></a>

### 9. Persistence and replay: close crash-point evidence gaps

Original assessment area **14**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** No persistence defect justifying a storage replacement was established. Existing atomic snapshots, receipts and rewind recovery should be verified rather than replaced for resemblance.
- [ ] **Work:** Run paired accepted-call/effect-start/result and compaction/steer/rewind/reload traces. Reuse the existing history, receipt and rewind stores. Repair an owning invariant only after a failing fixture identifies it.
- [ ] **Accept and measure:** No orphan call, duplicate mutation, lost user instruction or cross-provider opaque-state replay. Preserve explicit indeterminate-effect evidence. Do not collapse uncertainty into generic aborted text to claim parity.
- **Dependencies:** Cross-cutting crash checks are mandatory in items 1–7; this entry fills remaining combinations and shares their setup.
- **Owners:** [src/core/task-persistence/apiMessages.ts](src/core/task-persistence/apiMessages.ts), [src/core/task-persistence/ProviderTranscriptStore.ts](src/core/task-persistence/ProviderTranscriptStore.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [Task.persistence.spec.ts](src/core/task/__tests__/Task.persistence.spec.ts), [Task.rewind-recovery.spec.ts](src/core/task/__tests__/Task.rewind-recovery.spec.ts).
- **Codex source/tests:** [codex-rs/rollout/src/recorder.rs:1073](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/rollout/src/recorder.rs#L1073), [codex-rs/rollout/src/recorder.rs:1091](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/rollout/src/recorder.rs#L1091).

<a id="item-10"></a>

### 10. Cancellation: prove cleanup without changing Stop semantics

Original assessment area **12**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** No cancellation rewrite is justified. Reliable cleanup is a release condition for the higher-ranked concurrency and continuity changes.
- [ ] **Work:** Exercise provider/tool/process/child cancellation, late callbacks, blocked producers, repeat Stop and reload with controlled barriers. Fix demonstrated ownership or cleanup defects at their existing owner.
- [ ] **Accept and measure:** Accepted calls settle once, late work cannot mutate a replacement task, and owned resources release truthfully. Retain Alpha Stop terminating owned background commands; do not imitate arbitrary Rust future destruction or claim a 100 ms end-to-end deadline.
- **Dependencies:** Required focused checks in every affected earlier change. This queue position concerns additional matrix coverage, not deferred cancellation safety.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts).
- **Nearest coverage:** [Task.command-stop-escalation.spec.ts](src/core/task/__tests__/Task.command-stop-escalation.spec.ts), [Task.spec.ts](src/core/task/__tests__/Task.spec.ts).
- **Codex source/tests:** [codex-rs/core/tests/suite/unified_exec.rs:3011](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/unified_exec.rs#L3011), [codex-rs/core/src/session/handlers.rs:61](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/handlers.rs#L61).

<a id="item-11"></a>

### 11. Step context: prove immutable capture across supported paths

Original assessment area **3**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** The prior 95 estimate did not demonstrate a default snapshot defect. Different runtime/diagnostic representations are not a behavior backlog.
- [ ] **Work:** Verify captured handler, raw wire request, instructions, tools and policy survive retries and asynchronous setting/catalog changes. Extend only missing controlled race fixtures; preserve diagnostic redaction separately from executable values.
- [ ] **Accept and measure:** No stale configuration publication, mid-request authority change or corrupted opaque replay across supported providers, compaction and reload. Keep existing frozen snapshots/runtime companions.
- **Dependencies:** Focused capture tests accompany earlier provider/scheduler/shell changes. Optional live full-model activation remains a separate later capability decision.
- **Owners:** [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/StepContext.ts](src/core/agent/StepContext.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [Task.reasoning-preference.spec.ts](src/core/task/__tests__/Task.reasoning-preference.spec.ts), [Task.retry-wire.spec.ts](src/core/task/__tests__/Task.retry-wire.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/session/step_context.rs:25](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/step_context.rs#L25), [codex-rs/core/src/session/mod.rs:4199](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/session/mod.rs#L4199).

<a id="item-12"></a>

### 12. Retries: align cadence only after measuring recovery behavior

Original assessment area **13**. Kind: **Policy experiment**. Effort: **1–2 days for a captured profile; 2–4 with initial proof**.

- **Why:** Codex starts ordinary transient backoff at 200 ms with proportional jitter; Alpha uses 1 s/full jitter. This is observable, but faster retries can also amplify provider pressure and are not a proven quality improvement.
- [ ] **Work:** If the fixed outage/rate-limit workload supports the change, add or adopt an explicit captured backoff profile in AgentRetryPolicy. Keep server advice, request pacing, finite global/category budgets, deadlines and uncertain-effect guards.
- [ ] **Accept and measure:** Deterministic timing/advice fixtures match the selected contract. Compare recovery wall time, request count and retry amplification; do not change defaults on parity alone. Never copy indefinite reconnect behavior.
- **Dependencies:** Gate 0 and provider/deadline/history coverage from items 1/8/9/10. Local compaction overflow policy remains owned by item 5.
- **Owners:** [src/core/agent/AgentRetryPolicy.ts](src/core/agent/AgentRetryPolicy.ts), [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/agent/CommittedHistoryRecoveryPolicy.ts](src/core/agent/CommittedHistoryRecoveryPolicy.ts).
- **Nearest coverage:** [AgentRetryPolicy.spec.ts](src/core/agent/__tests__/AgentRetryPolicy.spec.ts), [Task.retry-progress.spec.ts](src/core/task/__tests__/Task.retry-progress.spec.ts).
- **Codex source/tests:** [codex-rs/async-utils/src/backoff.rs:7](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/async-utils/src/backoff.rs#L7), [codex-rs/protocol/src/error.rs:426](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/protocol/src/error.rs#L426).

<a id="item-13"></a>

### 13. Instructions and memory: verify guidance, then improve bounded controls

Original assessment area **4**. Kind: **Verification and targeted controls**. Effort: **2–3 days for primary proof; optional quota 2–3 and attribution 1–3, overlapping**.

- **Why:** Full-prefix assembly is not itself incorrect. Configurable instruction quota and completed-message memory attribution are narrower behavior choices than a world-state rewrite.
- [ ] **Work:** Prove changed/removed instructions across retry, compaction and reload. If the selected workload requires it, add a bounded host-controlled quota and separate memory usage attribution from final-display citation rules.
- [ ] **Accept and measure:** Authority/provenance and user corrections survive; malformed paths and stale sources remain rejected. Measure prompt/cache effects of quota changes. Keep advisory memory authority, local/legacy rules and source safety.
- **Dependencies:** Reuse instruction/replay fixtures from items 4/5/8/9/11. Do not add a second instruction or memory engine.
- **Owners:** [src/core/prompts/system.ts](src/core/prompts/system.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [custom-instructions-project-discovery.spec.ts](src/core/prompts/sections/__tests__/custom-instructions-project-discovery.spec.ts), [custom-instructions-configured-project-discovery.spec.ts](src/core/prompts/sections/__tests__/custom-instructions-configured-project-discovery.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/context/world_state/agents_md.rs:44](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/context/world_state/agents_md.rs#L44), [codex-rs/core/src/agents_md.rs:67](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/agents_md.rs#L67).

<a id="item-14"></a>

### 14. Delegation V2: verify the actual native surface

Original assessment area **16**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 5–9 cumulative**.

- **Why:** Native V2 already normalizes numeric forks to all history, exposes timeout-only waits and shares the invoking workspace. The earlier legacy-path deductions are retracted.
- [ ] **Work:** Verify spawn, passive/triggering mail, waits, inherited authority, budget accounting, cancellation and cold restoration through native schemas and real extension adapters. Preserve separate legacy compatibility paths.
- [ ] **Accept and measure:** No duplicated turn, lost mail, widened authority, double usage or stale overwrite; focused tests and automated managed-agent certification pass when the contract changes.
- **Dependencies:** Shares goal, cancellation, capture and history fixtures. Do not implement nonexistent fork/wait/quarantine fixes.
- **Owners:** [src/core/agent/SubagentDelegation.ts](src/core/agent/SubagentDelegation.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [SubagentDelegation.spec.ts](src/core/agent/__tests__/SubagentDelegation.spec.ts), [AgentLifecycleTools.spec.ts](src/core/tools/__tests__/AgentLifecycleTools.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:222](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L222), [codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:58](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L58).

<a id="item-15"></a>

### 15. Lifecycle and sessions: verify projected behavior and bounded UI work

Original assessment area **20**. Kind: **Verification first**. Effort: **1–2 days initially; remaining matrix 3–5 cumulative**.

- **Why:** Compact metadata and a native journal already serve the shared runtime. No notification-format rewrite has a demonstrated behavioral benefit.
- [ ] **Work:** Compare visible lifecycle facts under duplicate/gap/late events, reload, background sessions and view disposal. Measure payload size and render work when an affected change touches streaming.
- [ ] **Accept and measure:** Stable task/turn routing, truthful terminal states, bounded projection and preserved task review/cleanup ownership. A completed turn must not prematurely dismiss a task awaiting review.
- **Dependencies:** Focused lifecycle checks accompany the higher-ranked changes; reuse shared adapters instead of duplicating task state.
- **Owners:** [src/core/webview/TaskSessionRegistry.ts](src/core/webview/TaskSessionRegistry.ts), [src/core/webview/AgentLifecycleProjection.ts](src/core/webview/AgentLifecycleProjection.ts), [src/core/webview/AlphaProvider.ts](src/core/webview/AlphaProvider.ts).
- **Nearest coverage:** [AlphaProvider.lifecycle-transport.spec.ts](src/core/webview/__tests__/AlphaProvider.lifecycle-transport.spec.ts), [AgentLifecycleProjection.spec.ts](src/core/webview/__tests__/AgentLifecycleProjection.spec.ts).
- **Codex source/tests:** [codex-rs/app-server/src/bespoke_event_handling.rs:192](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/app-server/src/bespoke_event_handling.rs#L192), [codex-rs/app-server/src/thread_status.rs:156](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/app-server/src/thread_status.rs#L156).

<a id="item-16"></a>

### 16. Skills: prove local behavior before adding remote source routes

Original assessment area **17**. Kind: **Verification first**. Effort: **2–3 days initially; remaining matrix 4–6 cumulative**.

- **Why:** No ordinary local-skill defect was established. Source/package routing is useful only when the target workflows actually require it.
- [ ] **Work:** Verify discovery, explicit/implicit policy, pagination, complete body delivery, approval, inherited digest/provenance and reload through the live native SkillTool.
- [ ] **Accept and measure:** Correct skills load completely once without substitution or authority growth; partial reads do not become completed loads. Keep built-ins and Alpha precedence. Defer remote/package routing until justified.
- **Dependencies:** Reuse catalog, instruction and MCP capture checks; no replacement skills manager.
- **Owners:** [src/core/prompts/tools/native-tools/index.ts](src/core/prompts/tools/native-tools/index.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/task/Task.ts](src/core/task/Task.ts).
- **Nearest coverage:** [SkillsManager.explicit-selection.spec.ts](src/services/skills/__tests__/SkillsManager.explicit-selection.spec.ts), [explicit-skills.spec.ts](src/core/mentions/__tests__/explicit-skills.spec.ts).
- **Codex source/tests:** [codex-rs/ext/skills/src/selection.rs:20](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/ext/skills/src/selection.rs#L20), [codex-rs/ext/skills/src/extension.rs:380](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/ext/skills/src/extension.rs#L380).

<a id="item-17"></a>

### 17. Tool registry: prove identity and discovery activation

Original assessment area **7**. Kind: **Verification first**. Effort: **2–4 days initially; remaining matrix 4–8 cumulative**.

- **Why:** Flattened function declarations versus native enums do not prove execution loss. The canonical registry and captured surface already exist.
- [ ] **Work:** Verify identity/collision handling, freeform mapping, schema/executor/policy agreement, deferred discovery receipts, refresh, revocation and reload. Extend native envelopes only for a supported failing case, shared with item 4.
- [ ] **Accept and measure:** Valid supported calls route correctly; unavailable or stale calls fail before effects. Preserve immutable persisted discovery activation. Optional programmatic CodeMode is deferred.
- **Dependencies:** Registry checks are mandatory in earlier schema/tool changes; this entry completes remaining proof without a competing registry.
- **Owners:** [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts), [src/core/tools/TaskToolSurface.ts](src/core/tools/TaskToolSurface.ts), [src/api/providers/openai-responses.ts](src/api/providers/openai-responses.ts).
- **Nearest coverage:** [ToolRegistry.spec.ts](src/core/tools/__tests__/ToolRegistry.spec.ts), [TaskToolSurface.spec.ts](src/core/tools/__tests__/TaskToolSurface.spec.ts).
- **Codex source/tests:** [codex-rs/core/src/tools/registry.rs:402](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/registry.rs#L402), [codex-rs/core/src/tools/registry.rs:768](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/registry.rs#L768).

<a id="item-18"></a>

### 18. File tools: verify data safety and explicit patch differences

Original assessment area **11**. Kind: **Verification first**. Effort: **1–3 days initially; remaining matrix 4–7 cumulative**.

- **Why:** There is no missing live file primitive established. Retired read/search implementations must not be mistaken for active tools or a feature gap.
- [ ] **Work:** Verify shell exploration and patch semantics across exact bytes, stale buffers, destination changes, partial failures and reload. Repair only a reproduced invariant violation.
- [ ] **Accept and measure:** Expected bytes/errors and approval-time content checks hold. Preserve existing-file Add rejection and missing-final-newline behavior unless an explicit compatible product change is approved; never weaken editor-version fences for a score.
- **Dependencies:** File/mutation checks accompany any earlier effect change. No revived parallel read/search surface.
- **Owners:** [src/core/tools/ApplyPatchTool.ts](src/core/tools/ApplyPatchTool.ts), [src/core/tools/apply-patch/apply.ts](src/core/tools/apply-patch/apply.ts), [src/core/tools/ToolRegistry.ts](src/core/tools/ToolRegistry.ts).
- **Nearest coverage:** [ApplyPatchTool.spec.ts](src/core/tools/__tests__/ApplyPatchTool.spec.ts), [apply.spec.ts](src/core/tools/apply-patch/__tests__/apply.spec.ts).
- **Codex source/tests:** [codex-rs/apply-patch/src/lib.rs:473](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/apply-patch/src/lib.rs#L473), [codex-rs/apply-patch/src/text_file.rs:104](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/apply-patch/src/text_file.rs#L104).

<a id="item-19"></a>

### 19. Approvals: verify current authority before optional risk review

Original assessment area **9**. Kind: **Verification and optional capability**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** The injectable reviewer already exists; an optional configured risk-review service is not a missing default approval engine.
- [ ] **Work:** Verify once/session/deny/cancel outcomes, hook narrowing, grant invalidation, new shell identities and captured authority. Address only reproduced defects; keep optional model-review wiring separate.
- [ ] **Accept and measure:** No stale grant, hook-produced authority growth or cancellation-triggered effect. Preserve exact reviewed-call grants and human fallback. Do not bypass approval to improve timing.
- **Dependencies:** Approval checks are release-blocking for earlier command/scheduler changes. Optional review service follows an explicit product and authority decision.
- **Owners:** [src/core/agent/ToolScheduler.ts](src/core/agent/ToolScheduler.ts), [src/core/task/Task.ts](src/core/task/Task.ts), [src/core/auto-approval/taskSessionApprovalGrants.ts](src/core/auto-approval/taskSessionApprovalGrants.ts).
- **Nearest coverage:** [ToolScheduler.approval-failure.spec.ts](src/core/agent/__tests__/ToolScheduler.approval-failure.spec.ts), [Task.spec.ts](src/core/task/__tests__/Task.spec.ts).
- **Codex source/tests:** [codex-rs/core/tests/suite/scenarios_managed_human_approval_tests.rs:25](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/tests/suite/scenarios_managed_human_approval_tests.rs#L25), [codex-rs/core/src/tools/approvals.rs:525](https://github.com/openai/codex/blob/ac558e2a3264e1025fd8025fdd71d03dfbe8c86e/codex-rs/core/src/tools/approvals.rs#L525).

<a id="item-20"></a>

### 20. Modes and questions: make deliberate compatibility decisions last

Original assessment area **19**. Kind: **Verification and product choice**. Effort: **2–4 days initially; remaining matrix 4–7 cumulative**.

- **Why:** Alpha allows blocking questions in Code as well as Plan; Codex defaults differ. Both already support asynchronous questions. Removing a useful host behavior is not an automatic performance improvement.
- [ ] **Work:** Verify Plan/Code availability, root/catalog gating, asynchronous delivery, explicit plan handoff, cancellation, saved-mode restoration and reload. Change default question availability only for an agreed user-facing contract.
- [ ] **Accept and measure:** No lost answer, stale handoff or retired mode gaining write authority. Preserve host-controlled mode changes and checklist approval/edit protections.
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

Close an item only after its named behavior and outcome cases pass, required gates run, and any claimed efficiency benefit is measured. If no gap or benefit is demonstrated, retain the evidence, skip the unjustified production change and update the queue. Do not revise graders, erase uncertainty or relax protections to make the result look better.

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

All work above is **not started**. Before implementation, record the selected item, current upstream source/tests and intended behavior, baseline/candidate identities, fixture expectations, metrics and required gates. After each item, record actual outcomes and remaining exceptions with the change; keep this file as the single ordered queue rather than creating dated audit reports.
