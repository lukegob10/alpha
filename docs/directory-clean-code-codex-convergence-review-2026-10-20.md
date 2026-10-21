# Alpha directory review: clean code and Codex CLI convergence

Reviewed October 20, 2026, America/New_York. Review mode: full-surface review, with implementation left unchanged.

## Assessment

**Alpha is close to the requested 90%-ish Codex CLI target.** The ten convergence reviews scored **86.5 of 98
explicit behavioral criteria, approximately 88%**. Shared turn execution, captured step contexts, tool policy,
persistence, compaction, and managed-agent workflows are substantially implemented in active extension paths.
The findings support targeted boundary repairs and capability work, rather than another runtime or a broad rewrite.

**Clean-code quality is approximately 83/100.** The ten domain judgments average 83.25, using 81.5 as the midpoint
of the provider review's 78–85 range. The kernel is the strongest slice. Lifecycle adapters, command effects,
provider state, custom-tool ownership, and release/validation boundaries contain concrete defects.

These numbers are review judgments from a sampled behavioral rubric, **not** measured task-success rates,
statistical correctness estimates, percentages of upstream source implemented, or release certification.
Confidence is moderate to high for the cited source paths and deterministic reproductions; lower for live-provider
behavior and platform combinations not executed. A score near 90 does not waive an individual data-integrity defect.

**Compatibility qualification:** the original exact 1.125.0 gate failed one LM contract (18/19 passed). After the
coordinated startup repair, exact 1.138.0 full smoke passed 47/47 and the 1.125.0 compatibility runner passed 19/19
using rebuilt outputs. The earlier failure remains recorded and unexplained; the later pass does not establish that
the startup change repaired it. Original scores remain tied to the original audit snapshot.

## Reference and method

- Alpha source HEAD: `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`, including the existing working tree.
- Current Codex reference: [`d571eaf1f61d0d93a797506335a99a9950ffe37b`](https://github.com/openai/codex/tree/d571eaf1f61d0d93a797506335a99a9950ffe37b),
  resolved from upstream HEAD during this review. Reviewers inspected source and tests at this pin.
- Twenty subagents: ten clean-code domains and ten convergence domains. Each mapped active callers, contracts,
  nearest tests, evidence, limitations, and bounded remedies. The coordinating reviewer checked the stronger claims
  and reran selected reproductions.
- Convergence criteria use 1 for substantial alignment, 0.5 for partial alignment, and 0 for absent behavior.
  Criteria are equally weighted; domain denominators and evidence are retained below. This intentionally simple
  rubric is a navigation aid, not a complete inventory of every upstream feature.
- Sandbox architecture, Rust structure, exact terminal presentation, and proprietary hosted capabilities outside
  the extension's scope are excluded. Alpha's execution protections remain required.
- Native Code/Plan host operations, stricter terminal serialization, stronger task-owned process cleanup, Tickets,
  built-in skills, browser/HTML preview, and scheduled tasks are intentional extension capabilities. Their existence
  does not inflate the convergence score. Optional upstream mechanisms are identified separately in each review.
- The repository inventory found 3,488 tracked files and 1,461 test-like paths, including fixtures/history.
  Major owned surfaces were sampled; this was not a line-by-line examination of every file. Generated/downloaded
  trees and historical evaluation artifacts were not treated as application code or cleanup candidates.
- Runtime used for local checks: Windows, Node `24.21.0`, pnpm `11.24.0`.

At completion of the original audit, the four originally modified test files and two original untracked investigation
documents were checked by SHA-256 and remained byte-for-byte unchanged. Additional Ticket-search changes and a first-prompt-latency test appeared from
concurrent work during finalization and were preserved. Findings cite the reviewed source snapshot; concurrent edits
can shift line numbers. This audit did not author or claim ownership of those changes. Lint/type checks were repeated
after the Ticket changes; reference-host smoke exercised the bundle prepared earlier in this review. Later concurrent
work requires its own validation and is not certified by these earlier results.

## Highest-priority findings

These are the most consequential repair groups. Full reproduction details and smaller findings are in the twenty
linked domain reports. "Must-fix" means before relying on the affected contract, rather than an instruction to merge
all repairs into one change.

| Priority          | Finding and concrete effect                                                                                                                                                         | Owner and smallest complete direction                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High / must-fix   | Ordinary approved commands lose the scheduler signal and can launch after a step is interrupted. Prepared reads also lose the configured hard timeout in the production snapshot.   | `src/core/tools/ExecuteCommandTool.ts:906`, `src/core/task/Task.ts:2595`. Carry the captured signal and validated timeout consistently through ordinary and prepared admission; explicitly transfer ownership for yielded background commands.                                                                                                                                                                  |
| High / must-fix   | Scheduled shell commands can leave descendants writing after abort. Separately, a PTY hard timeout can report termination after only sending Ctrl-C.                                | `src/services/scheduled-tasks/ScheduledTaskService.ts:689`; `src/integrations/terminal/TerminalProcess.ts:432`; `src/core/tools/ExecuteCommandTool.ts:1925`. Reuse owned process-tree shutdown, await physical exit, and report the observed outcome. The scheduled-command defect was reproduced on Windows/Node 24.21.0; the PTY finding is source-level evidence.                                            |
| High / must-fix   | An accepted output-search regex can monopolize the extension host. A legal 64 KiB nonmatching line with `a+$` took 5.4 seconds in the local diagnostic.                             | `src/core/tools/ReadCommandOutputTool.ts:84`, `:853`. Bound execution using an owned terminable worker/process or a guaranteed-linear implementation. An asynchronous timeout around synchronous RegExp is insufficient.                                                                                                                                                                                        |
| High / must-fix   | Queued task creation can register/start after provider disposal finishes. Public API/IPC child completion also bypasses the provider's durable result/mailbox barrier.              | `src/core/webview/AlphaProvider.ts:1291`, `:7353`; `src/extension/api.ts:361`. Join or invalidate creation during disposal, recheck ownership after awaits, and publish the provider's committed completion. Both adapter defects were reproduced with controlled production-method probes.                                                                                                                     |
| High / must-fix   | Changing skill modes can silently overwrite a user edit saved after the read.                                                                                                       | `src/services/skills/SkillsManager.ts:851`, `:860`. Use a version-aware mutation transaction and reject stale content; create new files exclusively. A real-file controlled reproduction lost the injected external edit.                                                                                                                                                                                       |
| High / must-fix   | A gateway profile replaces process-global fetch/CA transport, affecting other profiles and unrelated requests; its error wrapper also drops retry advice and cancellation identity. | `src/api/providers/utils/vertex-gateway-transport.ts:50`; `src/api/providers/vertex-openai.ts:269`. Give each provider an owned transport, dispose it, and preserve structured error classification.                                                                                                                                                                                                            |
| High / should-fix | Custom-tool definitions from workspace A remain executable in workspace B. Edited/deleted definitions also survive refresh.                                                         | `packages/core/src/custom-tools/custom-tool-registry.ts:82`, `:100`, `:284`, `:437`; `src/core/task/build-tools.ts:409`. Publish per-source snapshots and capture a catalog for each workspace/step. This path requires the custom-tools experiment and Code mode; normal custom-tool approval remains in place.                                                                                                |
| High / should-fix | Ordinary proposal metadata is trusted as a filesystem path; changing a legitimate proposal's `patchFile` can make discard delete outside storage.                                   | `packages/core/src/worktree/managed-subagent-worktree.ts:660`, `:1460`. Validate identity, schema, and canonical containment for every artifact file reference. Reproduction used owned temporary canaries. Metadata is host-generated in global storage; remote/provider control of it was **not established**.                                                                                                |
| High / should-fix | Native worker preparation/capture subprocesses receive no managed-run cancellation signal. A stalled Git/filter/copy can retain startup and capacity after cancellation.            | `src/core/webview/AlphaProvider.ts:12635`; `packages/core/src/worktree/managed-subagent-worktree.ts:394`; `worktree-include.ts:314`. Propagate signals/deadlines to owned processes, join shutdown, and retain bounded recovery cleanup. The reproduction used a controlled copy barrier, not a real hung Git process.                                                                                          |
| High / should-fix | Retained UI lifecycle snapshots recreate removed tasks as running; delayed pasted images can attach to the newly selected chat.                                                     | `webview-ui/src/context/agentLifecycleState.ts:320`, `:419`; `webview-ui/src/components/chat/hooks/useTaskComposer.ts:75`; `ChatTextArea.tsx:1006`. Prune authoritative removals and bind asynchronous work to its originating task identity. Both were reproduced without a full visual host run.                                                                                                              |
| High / must-fix   | The universal release path installs/copies only the build host's LanceDB native binding. Eager indexing imports can then prevent activation on other accepted platforms.            | `.github/workflows/release-vsix.yml:19`; `src/package.json:982`; `src/lancedb-native.mjs:44`; `src/services/code-index/vector-store/lancedb-client.ts:3`. Produce verified platform packages or a deliberately complete universal artifact, and isolate optional backend loading. Source, the existing local VSIX, and loader simulations corroborate this; fresh cross-platform host installation was not run. |
| High / must-fix   | A nonempty Mocha filter can satisfy a purported full-host gate. Benchmark promotion also accepts missing/malformed safety metrics.                                                  | `apps/vscode-e2e/src/runTest.ts:193`; `scripts/harness/host-evidence.mjs:117`; `packages/evals/src/benchmark/cli.ts:496`. Separate focused/full selection, forbid focused tests in hard gates, record selection in receipts, and parse promotion input with a strict runtime schema. Actual Mocha and production gate functions reproduced both false-success paths.                                            |

## Convergence by domain

| Domain                          |  Behavioral rubric | What is already close                                                                                        | Remaining distance                                                                                                                                           |
| ------------------------------- | -----------------: | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turns and lifecycle             |          9/10, 90% | Active shared sequencer, frozen retries, steering, explicit terminal outcomes, completion hooks              | Safe semantic-output recovery covers a narrower tool subset; explicit successful empty/reasoning-only responses can trigger extra recovery.                  |
| Tool surface, policy, scheduler |          9/10, 90% | One captured executable surface, policy ceilings, ordered receipts, bounded read parallelism, serial effects | Advisory breadth differences: deny-only permission hooks and no optional risk-based approval reviewer. These are not reasons to weaken Alpha authority.      |
| Command execution               |        8.5/10, 85% | Native exec/input sessions, pipe/PTY choice, task ownership, yielding, output receipts                       | Physical hard-stop proof, total live-process admission bound, and requested poll aggregation window.                                                         |
| Provider normalization          |        8.5/10, 85% | Ordered items, identities/phases, opaque state, tool IDs, cancellation, model capture, retries               | Fuller final text can be dropped after a partial delta; cache-write usage is omitted; readable reasoning summaries are suppressed with encrypted state.      |
| Persistence and public history  |          9/10, 90% | Durable fences, replay, stale-producer protection, interrupted-tool repair, rewind/migration                 | Public history can merge an interrupted turn with its successor; active forks lack the optional interrupted snapshot retaining committed in-flight evidence. |
| Context and compaction          |          9/10, 90% | Safe boundaries, complete tool transactions, retained reasoning, cancellation, atomic persistence/reload     | Adaptive compactor-input overflow retry; durable previous-model reconstruction and unavailable-model fallback.                                               |
| Instructions, skills, modes     |         8/9, 88.9% | Ancestor AGENTS, overrides, authority, lazy skills, captured child/retry instructions, host modes            | Opt-in descendant AGENTS broadens scope/budget; structured per-file provenance is incomplete.                                                                |
| Managed agents                  |          9/10, 90% | Active six-tool surface, asynchronous lifecycle, authority/budgets, cancellation, durable results            | Cold nested followups require a loaded immediate parent; nested names and relative addressing are narrower.                                                  |
| MCP and additional tooling      |        8.5/10, 85% | Tool search, deferred discovery, resources/pagination, target identity, patch/image tools                    | Managed MCP OAuth and server-originated form/URL elicitation. Alpha additions generally reuse the same harness.                                              |
| Host/session UX                 |         8/9, 88.9% | Shared session ownership, task-scoped input, durable queues, projections/resync                              | Queued Steer lacks the direct-steering turn guard; an older-envelope lifecycle fallback mislabels terminal states.                                           |
| **Combined reviewed criteria**  | **86.5/98, 88.3%** | **Close to the 90%-ish target**                                                                              | **Targeted repairs and a finite set of capability gaps remain.**                                                                                             |

The default/core workflows deserve the strongest convergence conclusion. The 90% tool-policy row conservatively
counts optional approval-review breadth differences; the individual report labels them advisory. Experimental/default-off
upstream code mode, async compaction, and provider-specific checkpoint representations are not required rewrites.
The comparison follows behavior, rather than assuming matching tool names or copied instruction text prove equivalence.

## Other clean-code findings and maintenance debt

The ten clean-code reports contain **32 findings**, including advisory items. Their severity and closure status remain
in those reports. Additional bounded issues include:

- `src/core/context-tracking/FileContextTracker.ts:46`, `:74`, `:98`, `:208`, `:334`: wrong task root,
  suppressed first external-edit notice, watcher creation after disposal, and append-only metadata rewrite growth.
- `src/core/webview/AlphaProvider.ts:7458`: fresh API editor tasks can bypass the shared concurrency limit.
- `src/api/providers/utils/helix-token-manager.ts:32`, `:106`: cached token managers have no release path and can keep
  executing retired profile credential commands. `src/api/transform/gemini-format.ts:170` relocates signatures
  between response parts.
- `src/services/scheduled-tasks/schedule.ts:5`, `:21`: calendar recurrence ignores stored timezone and drifts across
  daylight saving time. Monthly output changed when only the host timezone changed in the diagnostic.
- `webview-ui/src/components/common/MarkdownBlock.tsx:357`: Windows absolute/file links are stripped and can route
  to `./`. `agentLifecycleState.ts:245` also mislabels generic completed/failed terminal events on the older-envelope
  fallback; current attached-snapshot handling avoids that narrower defect.
- `src/turbo.json:7`: bundle cache output declarations omit generated documents/icons/audio. A disposable fixture
  using the actual configurations reproduced a successful cache restore with those files absent.
- `packages/evals/src/cli/runEvals.ts:92`: the legacy CI path resolves after infrastructure task errors. Governed
  evaluation paths have stronger behavior; this is not a claim that every evaluator path is permissive.
- `src/core/task/Task.ts:14598`, `:14665`: terminal retry summaries are hardcoded to zero. Raw retry events still
  exist and current diagnosis counts those independently.
- `src/core/agent/AgentTurnEngine.ts:208`: the legacy sequencer appears test-only; the staged sequencer has the
  production caller. This is maintenance debt, not evidence of two active extension engines.
- `README.md:124` still calls 1.138 the installation minimum; the manifest correctly declares 1.125.
- `src/core/prompts/codex-model-instructions.ts:2`: wholesale upstream instruction bodies conflict with the current
  repository guide. Six comparable bodies were still byte-identical to current upstream; staleness was not
  demonstrated. Replace this coupling deliberately with concise Alpha-owned behavioral guidance and validation,
  rather than removing prompts blindly. This contract concern did not reduce the behavior score.

No stale script was confirmed for deletion. No broad file-size-driven decomposition, dependency upgrade, or mechanical
refactor is recommended by this review. In particular, the large Task/host integration layers should only be reduced
around a proven invariant and its existing owner.

## Coverage and reviewer evidence

Each report contains exact paths/lines, runtime reachability, test commands, reproductions, limits, and proposed checks.
The test counts below are **overlapping executions**, not unique tests or additive coverage.

| Clean-code review                                                                                   | Quality judgment | Focused verification                                                           |
| --------------------------------------------------------------------------------------------------- | ---------------: | ------------------------------------------------------------------------------ |
| [01 Kernel](../artifacts/directory-review-2026-10-20/clean-01-kernel.md)                            |               88 | 194 tests / 11 files                                                           |
| [02 Tools/effects](../artifacts/directory-review-2026-10-20/clean-02-tools.md)                      |               82 | 108 tests / 2 files; dispatch and regex diagnostics                            |
| [03 Persistence/context tracking](../artifacts/directory-review-2026-10-20/clean-03-persistence.md) |               86 | 137 tests / 8 files; tracker diagnostics                                       |
| [04 Providers](../artifacts/directory-review-2026-10-20/clean-04-providers.md)                      |            78–85 | 201 tests / 4 files; four provider diagnostics                                 |
| [05 Host/sessions/API](../artifacts/directory-review-2026-10-20/clean-05-host-sessions.md)          |               80 | 71 tests / 3 files; three adapter diagnostics                                  |
| [06 Webview](../artifacts/directory-review-2026-10-20/clean-06-webview.md)                          |               84 | 127 tests / 3 files; state, image ownership and link diagnostics               |
| [07 Extension tools](../artifacts/directory-review-2026-10-20/clean-07-extensions.md)               |               84 | 294 tests / 11 files; subprocess, skill-edit and timezone diagnostics          |
| [08 Managed/shared packages](../artifacts/directory-review-2026-10-20/clean-08-managed-packages.md) |               80 | 151 tests / 11 files; owned-temp registry/artifact/cancellation diagnostics    |
| [09 Workflow/build/release](../artifacts/directory-review-2026-10-20/clean-09-workflows.md)         |               84 | Cache-restoration fixture; native-loader simulation; archive/source inspection |
| [10 Validation/evaluation](../artifacts/directory-review-2026-10-20/clean-10-validation.md)         |               83 | Actual Mocha and production gate/scheduler diagnostics                         |

| Convergence review                                                                      | Focused verification                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [01 Turns](../artifacts/directory-review-2026-10-20/converge-01-turns.md)               | 173 tests / 7 files                                        |
| [02 Tool policy](../artifacts/directory-review-2026-10-20/converge-02-tool-policy.md)   | 78 tests / 5 files                                         |
| [03 Commands](../artifacts/directory-review-2026-10-20/converge-03-commands.md)         | 97 tests / 5 files                                         |
| [04 Providers](../artifacts/directory-review-2026-10-20/converge-04-providers.md)       | 329 tests / 9 files; injected no-network stream diagnostic |
| [05 Persistence](../artifacts/directory-review-2026-10-20/converge-05-persistence.md)   | 32 tests / 3 files; actual history-projection diagnostic   |
| [06 Compaction](../artifacts/directory-review-2026-10-20/converge-06-compaction.md)     | 187 tests / 5 files                                        |
| [07 Instructions](../artifacts/directory-review-2026-10-20/converge-07-instructions.md) | 173 tests / 13 files; prompt/source identity inspection    |
| [08 Managed agents](../artifacts/directory-review-2026-10-20/converge-08-multiagent.md) | 51 tests / 6 files                                         |
| [09 Integrations](../artifacts/directory-review-2026-10-20/converge-09-integrations.md) | 238 tests / 5 files                                        |
| [10 Host/UX](../artifacts/directory-review-2026-10-20/converge-10-host-ux.md)           | 63 tests / 3 files; actual fallback reducer diagnostic     |

The coordinator reran the host-method probes, custom-tool/artifact/cancellation diagnostic, and validation diagnostic.
They exited zero while asserting the reported defective behavior. These are characterization evidence, not new
production regression tests proving a repair. Logs are retained with the domain reports.

## Workspace validation

| Check                                                          | Result                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check-types`                                             | Passed; extension-focused workspace and consumers.                                                                                              |
| `pnpm lint`                                                    | Passed; extension-focused workspace and consumers.                                                                                              |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`         | Passed, exit 0; 13 required files, 47 tests, zero failed/pending; exact 1.138.0 observed in every host receipt.                                 |
| `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250` | Failed, exit 1; 18 passed / 1 failed across four files, zero pending; exact 1.125.0 observed. Held-tail audited command-read overlap timed out. |

The **later coordinated startup follow-up** ran full 1.138.0 smoke again (13 files, 47 tests passed), then the exact
1.125.0 compatibility `:run` command (four files, 19 tests passed) against the rebuilt extension/webview outputs.
The coordinator checked every receipt's actual host version, required selection, zero failed/pending counts, and
observed host exit. Root lint/type checks and focused startup tests also passed in that chat. These later results
supplement the original table rather than replacing its earlier failed invocation. Evidence:
[follow-up validation summary](../artifacts/directory-review-2026-10-20/startup-followup-validation.json),
[completed startup investigation](first-prompt-latency-2026-10-20.md).

For the reference-host run, `TEST_GREP` was absent and no focused `.only` tests were found in the host suite source.
The reproduced gate-selection weakness therefore does not by itself invalidate this invocation. Observed version,
suite counts, provider mode, completion, and exit status were checked in the actual receipts.

The checked receipts and counts are summarized in
[host-smoke-1380-summary.json](../artifacts/directory-review-2026-10-20/host-smoke-1380-summary.json).
The individual reports and broad-check logs are retained in the same artifact directory.

Not run by the original audit: the complete root unit suite, upstream Rust tests, fresh VSIX generation, managed-agent certification,
live paid/provider comparisons, service-backed Postgres/Redis evaluations, manual visual/accessibility acceptance,
long-duration memory/latency benchmarks, or actual macOS/Linux/ARM installed-artifact tests. Focused checks and the
Windows host baseline must not be presented as those results. The startup follow-up later added the scoped rendered
admission check described below; that does not establish full visual/accessibility coverage.

## Additional observed minimum-host failure

`pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250` exited 1. Activation (5), modes (2), and storage
recovery (4) passed. The LM fixture suite passed 7/8, with zero pending tests. Every receipt identified the actual
host as exact `1.125.0`; no alternate host was substituted.

Failing test: `apps/vscode-e2e/src/suite/vscode-lm-contract.test.ts:613`, **starts an audited exec_command read
while the VS Code LM response tail is held**. The wait at `:641` timed out after 10 seconds because the lifecycle
snapshot did not expose the isolated effect start before provider completion. The fixture reported its complete
tool call at 503 ms; the held response tail released at 10,564 ms during test failure cleanup. The diagnostic transcript
contained the human request and `api_req_started`, without a command result. The same test passed in the earlier
1.138.0 smoke invocation.

**Status: original failure retained; later exact-host invocation passed; cause unverified.** The completed startup
follow-up passed all four minimum-host files, including this test: the effect was observed 190 ms after the fixture
reported its call while the response tail remained held. This does not establish a flake rate or a causal repair.
The earlier failing contract concerns tool execution before response-tail completion, not ordinary command support
in general. Retain both results when investigating that boundary. No runtime fix was made by the review coordinator.
This additional gate history is separate from the 32 findings in the ten clean-code reports.

Evidence: [minimum-host summary](../artifacts/directory-review-2026-10-20/host-compatibility-1250-summary.json),
[full log](../artifacts/directory-review-2026-10-20/host-compatibility-1250.log). The failed run retained its host
manifest/logs under `C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-vscode-e2e-jOwSuW/artifacts/8d724269-c70d-4139-923f-5e372c25e5b3`.

## First-prompt latency: completed coordinated repair and validation

During finalization, the user authorized the **Fix initial prompt latency** chat to coordinate a newly reported issue:
submitting the first prompt can leave Alpha looking idle before the first API request or visible activity.
That chat owns measurement and a focused repair of submit → admission → context/preflight → provider request.
The coordinator exchanged the related admission findings and left that runtime path unchanged.

The companion investigation supplied source and executable evidence after the original audit. The coordinator read
the before/after source and regression evidence, checked the final host receipts and test logs, and independently
inspected the rendered pending-prompt screenshot. Production changes and test executions belong to the companion
chat; the coordinator's follow-up changes are documentation/evidence only.

- **Confirmed duplicate work:** normal saved-profile admission calls `listConfig()` and then resolves `getProfile()`
  through another serialized secret-storage read. The real admission method, with a controlled 50 ms cost per secret
  read, made two reads and took 100 ms at that boundary. The new desired-behavior regression failed for exactly that
  reason before the fix. After the repair, the regression passed with **one read / 50 ms**. These injected delays are
  not measurements of real user storage or a claim that overall startup is halved. The manager now resolves availability
  and settings from one snapshot while preserving missing-profile fallback and invalid/unsupported rejection.
  Evidence: [before characterization](../artifacts/first-prompt-storage-before.log),
  [passing host/settings tests](../artifacts/first-prompt-host-unit.log).
- **Visibility repaired:** first submission now keeps a task/request-correlated prompt preview and preparation status,
  claims the pending send once, replaces the preview with host transcript state, and restores rejected text/images to
  the originating draft. The shared composer store owns presentation only; the host retains task authority. The rendered
  1.138.0 check held saved-profile lookup, observed the prompt/status before admission, then verified rejection restoration.
  The coordinator inspected the [pending screenshot](../artifacts/directory-review-2026-10-20/startup-first-prompt-pending.png)
  and [observations](../artifacts/directory-review-2026-10-20/startup-rendered-admission.json).
  One run observed the preview at 18.2 ms after a pre-Enter timestamp; this includes CDP/polling overhead and is not a
  general UI latency benchmark.
- **Measured host baseline:** exact VS Code 1.138.0, scripted model `first-prompt-fixture`, three tiny tasks in the same
  process/workspace, no pacing, a fresh scoped catalog per task and warm filesystem caches. Host creation → injected provider
  entry was **769, 862, and 471 ms**; creation alone was **11, 5, and 5 ms**. This boundary excludes composer transport,
  renderer paint, actual network/provider latency, and uses explicit provider configuration that bypasses the ordinary
  saved-profile lookup above. The successful baseline run was `a3091431-5fb3-4bb7-baed-2da24b0bc163`.
  Evidence: [full baseline log](../artifacts/first-prompt-baseline.log),
  [bounded baseline summary](../artifacts/directory-review-2026-10-20/startup-followup-baseline.json).
- **After workload:** the same three-task scripted workload reached provider entry in **658, 288, and 487 ms**.
  Both series bypass saved-profile lookup and exclude composer transport, renderer paint, and provider/network latency;
  the small samples do not establish a general speedup. Task cleanup releases its scoped catalog, so each sample has
  a fresh catalog with warm filesystem caches. The original baseline metadata mislabeled later catalogs as warm;
  that description has been corrected in this review's evidence. See the
  [after log](../artifacts/first-prompt-after.log) and [checked summary](../artifacts/directory-review-2026-10-20/startup-followup-validation.json).

Neither three-sample host series reproduced a multi-second local stall. They do not establish the dominant cause of
every user report or a general end-to-end speed improvement. The initial diagnostic harness attempt used the fixture
configuration incorrectly; the baseline above comes from the corrected passing run. No relationship to the separate
1.125 held-response-tail failure is established. Original review scores and the 32-finding count remain tied to the
original audit snapshot. The completed repair's final evidence is in
[first-prompt-latency-2026-10-20.md](first-prompt-latency-2026-10-20.md): 397 focused host/settings tests plus six
pre-existing skips; 233 composer tests; 120 adjacent tests; 22 managed fixture tests; 673 shared-types tests; lint/type
checks; exact-host results and rendered UI. Counts are separate executions and do not constitute additive unique
coverage. A panel-opening-only workload cannot establish first-prompt latency.

## Closure and next repair passes

- **Fixed by this audit:** review documentation and diagnostic artifacts only. The coordinated startup follow-up
  separately completed the saved-profile read reduction and pending-submission UI with the validation above.
- **Flagged for follow-up:** confirmed defects and capability deltas above, with detailed remedies in each domain report.
- **Not verified:** the explicitly unexecuted live, visual, cross-platform, service, and long-duration conditions.
- **Out of scope:** sandbox convergence, a new runtime, Rust ports, removal of Alpha's additional tools, historical data
  deletion, unrelated user work, and wholesale repository formatting.

Recommended next work, in order:

1. **Correctness cleanup on effects and ownership:** command signal/timeout propagation, physical process cleanup,
   disposal/creation barriers, skill edit conflict detection, workspace-scoped custom catalogs, and artifact containment.
   Add deterministic desired-behavior regressions before changing each boundary. Preserve both exact minimum-host
   LM overlap results for a focused failure investigation; a causal explanation is still absent.
2. **Operational hardening on trustworthy evidence and packages:** full-selection host receipts, strict benchmark input,
   infrastructure-invalid CI outcomes, complete cache restoration, and matching-platform VSIX activation.
3. **Bounded contract alignment:** authoritative final response text, historical turn boundaries, queued-steer identity,
   compaction overflow/downshift recovery, and then MCP OAuth/elicitation and cold nested-agent ergonomics as needed.

Rerun the affected review slices and exact-host gates after these repairs. Use paired deterministic/live evaluations
before making task-quality or latency claims. Repeating another twenty-agent general sweep before closing the proven
boundaries is lower value than implementing and verifying those focused changes.
