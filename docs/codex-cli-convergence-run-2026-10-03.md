# Codex CLI convergence run — 2026-10-03

This run implements and validates a bounded convergence pass across subagents, instructions, skills, modes, history,
and provider continuity. It uses Alpha's TypeScript extension and shared execution kernel. It adds no sandbox or parallel
CLI runtime, retains the current approval system, and preserves bundled skills, HTML previews, Alpha Tickets, and
scheduled tasks. Complete Codex parity and a general quality or speed improvement are not established by this run.

## Reference and execution

- Alpha starting commit: `2660a8f8d68d38ec42d473de6a0eee6d2537e58b`; the initial checkout was clean.
- [Codex source reference](https://github.com/openai/codex/tree/b741e480e203f037ca726bc2a76d99a8e8668e66):
  `b741e480e203f037ca726bc2a76d99a8e8668e66`, retrieved 2026-10-03. Source and tests were inspected before implementation.
- Three coordinated chats and three root subagents used `gpt-6.1-sol` with `max` reasoning. Workstreams shared this
  checkout with explicit ownership; root integrated Task/AlphaProvider, shared model metadata, and final validation.
- Node `24.21.0`, pnpm `11.24.0`, and actual VS Code `1.125.0` were used. Host tests used disposable profiles with
  scripted providers or the VS Code LM fixture. No fresh authenticated Copilot evaluation was performed.
- Changes remain in the working tree for review. No commit, branch, release-version, dependency, or lockfile change
  was introduced. Production and test source stayed unchanged throughout the final smoke run. This report was written
  afterward; no production or test code changed after the gates.

Detailed source contracts and workstream receipts:

- [Subagents](F:/roo-fork/Alpha-Code/docs/convergence-subagents-2026-10-03.md)
- [Instructions, skills, and modes](F:/roo-fork/Alpha-Code/docs/convergence-instructions-skills-modes-2026-10-03.md)
- [Context and providers](F:/roo-fork/Alpha-Code/docs/convergence-context-provider-2026-10-03.md)

## Integrated behavior

| Area                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child history              | Full/N/none forks now use a selected native conversation seed in the managed launch path. Full forks no longer lose evidence at the old 24,000-character cap. User text and media survive in source order; parent tools, ordinary reasoning, non-final chatter, inbox deliveries, opaque provider state, and authorization receipts are filtered. Legacy capture callers retain their existing bounded text path.                                                                              |
| Invoking step              | History, selected route, profile configuration and name, applied user instructions, and approval ceilings are captured privately for the invoking step. Retries reuse that boundary; the next step captures again. An explicitly unnamed profile cannot fall through to a newly selected live profile.                                                                                                                                                                                         |
| Child startup and recovery | A fresh child validates and clones its seed, persists frozen instructions and canonical history, and awaits persistence before dispatch. Cancellation during that barrier prevents launch. Resumed children read their own transcript. Conflicting instruction snapshots are rejected without overwriting saved bytes. Exact empty and whitespace-only instruction snapshots remain valid.                                                                                                     |
| Authority and modes        | Inherited repository/user guidance retains user authority; the host rebuilds developer authority and child policy. Retired or unknown executable modes recover to Plan. Mode changes remain host-controlled. Captured and inherited approval grants intersect with current settings, which may narrow them. Command ceilings remain hashed and enforced.                                                                                                                                       |
| Skills                     | Discovery includes applicable ancestor `.agents/skills` roots. Exact captured paths remain resolvable despite name overrides. Prompt assembly, mentions, SkillTool, and slash skills use the logical task workspace; Workers use the original workspace rather than their private write checkout. Shared managers await discovery, suppress background Settings publication, and release watchers with their owners. Nested catalogs retain captured paths, descriptions, and content digests. |
| Lifecycle                  | Root identity and capacity are frozen at admission. Reentrant cancellation publishes lifecycle events in deterministic order. Existing resource, cancellation, and Worker mutation owners remain authoritative.                                                                                                                                                                                                                                                                                |
| Providers                  | Native OpenAI transport and freeform patch support use separate capabilities and an exact HTTPS-origin check. GPT-6.1 Sol retains Responses transport on tool-free steps. Its verified Copilot catalog identity now preserves selected maximum reasoning for canonical and opaque live IDs, while live input limits constrain static metadata.                                                                                                                                                 |
| Compaction and replay      | Summary requests isolate their instructions and continuation chain. Collection ends at the terminal outcome, rejects unexpected tools and incomplete continuations, and excludes late output. Known encrypted reasoning and signature shapes are validated before save/reload; unknown provider metadata remains opaque and saved bytes are not repaired automatically.                                                                                                                        |

These changes follow verified behavior, rather than transplanting upstream source or adding a second runtime. Alpha's
GPT-6.1 prompt resolver uses an Alpha-owned family adaptation; it does not claim byte identity with the upstream template.

## Validation

Counts below describe their individual runs and overlap; they must not be summed as unique test coverage.

| Check                                                            | Result                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined affected extension tests                                | 159 files, 3,182 passed, 3 existing skips. Covers agent runtime, prompts, skills, context/compaction, persistence, providers/transforms, and Task/AlphaProvider integration.                                                                                                                         |
| Additional reasoning, persistence, and completion coverage       | 6 files, 134 passed.                                                                                                                                                                                                                                                                                 |
| Final captured-profile regression and real Task request boundary | 2 files, 152 passed after the final profile fix. The new unnamed-profile case first failed for the intended reason.                                                                                                                                                                                  |
| Shared contracts and model metadata                              | 7 files, 128 passed; shared types build passed.                                                                                                                                                                                                                                                      |
| Final `pnpm lint`                                                | 8 tasks successful, including extension, webview, shared packages, and host runner.                                                                                                                                                                                                                  |
| Final `pnpm check-types`                                         | 9 tasks successful.                                                                                                                                                                                                                                                                                  |
| Touched-file Prettier and `git diff --check`                     | Passed. The deliberate retired-Ask-to-Plan prompt snapshot was inspected.                                                                                                                                                                                                                            |
| `pnpm certify:managed-agents:automated`                          | Exit 0. Deterministic certification: 3,051 passed, no skips or failures, all 26 rows passed. Both real-host managed-agent and long-context suites passed on VS Code 1.125.0. Eight live/integration matrix rows remain pending.                                                                      |
| Instruction discovery acceptance                                 | Exit 0; 1 passed on VS Code 1.125.0. Verifies ancestor override precedence and cwd guidance.                                                                                                                                                                                                         |
| `pnpm harness run host`                                          | Exit 0. Runs the required `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`: 13 host launches, 42 passed, no pending or failed tests. Every receipt confirms actual VS Code 1.125.0, completed capture, observed host exit, and verified ownership. Source was unchanged at the run boundaries. |

The broad extension run preceded the final localized unnamed-profile fix. The complete affected Provider test file and
real Task boundary tests, lint, type checks, certification, and final exact-host gate all ran after that fix.

Final exact-host evidence:
[report](F:/roo-fork/Alpha-Code/artifacts/harness/2026-10-03T13-29-17-313Z-d69f8316/result.md),
[structured result](F:/roo-fork/Alpha-Code/artifacts/harness/2026-10-03T13-29-17-313Z-d69f8316/result.json).
Deterministic certification evidence:
[managed-agent result](F:/roo-fork/Alpha-Code/artifacts/certification/managed-agent-milestone-evidence.json).
These generated local artifacts are ignored by Git; this document retains the outcome and scope.

An earlier smoke invocation executed all 42 tests successfully but its wrapper failed with
`source_changed_during_run` because root added and fixed the unnamed-profile regression during final review. Its
[failed receipt](F:/roo-fork/Alpha-Code/artifacts/harness/2026-10-03T13-16-07-546Z-fba1a26b/result.json)
is retained and is not counted as the final gate. Earlier red regression and concurrent-integration type failures are
recorded in the workstream documents. Independent final reviews found no remaining concrete production blocker.

## Retained fanout baseline

The strengthened exact-host fixture reviews five roughly 60,000-character Tickets concurrently. Each child must retain
the entire original parent prompt once, all 15 start/middle/end evidence markers, and the child's own objective in
structured order. The former 24,000-character text capture cannot satisfy these assertions.

A supplemental run retained the fixture's measurements before disposable-profile cleanup:
[fanout metrics](F:/roo-fork/Alpha-Code/artifacts/core-confidence/convergence-2026-10-03/long-context-fanout.json),
[host receipt](F:/roo-fork/Alpha-Code/artifacts/core-confidence/convergence-2026-10-03/host-receipts/01bfdd09-f26c-477e-9128-7685836bc098.json).

| Measurement                    | Observed                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| Host/provider                  | VS Code 1.125.0 / scripted                                       |
| Parent prompt                  | 303,341 UTF-16 code units; 303,371 UTF-8 bytes                   |
| Model requests                 | 3 parent requests; 1 request per child, 5 children               |
| Latest serialized message size | 312,802 UTF-8 bytes for the parent; 308,430 per child            |
| Child inheritance              | 1 parent-prompt copy and all 15 evidence markers for every child |
| Initial context                | 1 instruction layer and 1 fresh environment layer per task       |
| Completion                     | Parent and all 5 children each completed once                    |
| Final capacity                 | 0 active, 0 queued, 5 terminal children                          |
| Parent transactions            | 6 calls, 6 results, no transaction errors                        |

The retained `childRequests` map stores ticket indices, not request counts. The fixture rejects a second model request
for any child explicitly. Serialized message sizes exclude the system prompt and represent the latest request per task;
the legacy `requestBytes` field remains UTF-16 units, while `requestUtf8Bytes` is actual UTF-8 bytes.

This is a reproducible current baseline, not a before/after speed or quality comparison. Full conversation retention can
increase model input relative to the old lossy cap. The supplemental run logged a VS Code utility-process shutdown
error after the test passed; Alpha's extension host exited 0 and the runner reported complete capture and verified
ownership. The required smoke gate and managed-agent gate passed independently.

## Remaining convergence gaps

1. Preserve explicit provider assistant phases in the canonical response/history contract. Current final-message
   selection infers passive canonical completion; legacy reports without that evidence are conservatively excluded.
   Upstream `FinalAnswer` is a provider phase, separate from host completion or Stop-hook acceptance.
2. Verify reusable full-fork context baselines through adapters. Production children currently rebuild their first
   environment, including full-history forks. Generated assistant media also needs an additive canonical contract.
3. Add typed native remote compaction with complete opaque-window persistence/replay and provider-switch recovery.
   Alpha currently retains its native text summarizer and transaction-safe recent tail. Legacy providers without
   lifecycle declarations intentionally retain EOF completion compatibility.
4. Implement shared skill implicit-invocation metadata and enforcement for `agents/openai.yaml` policy. Recursive
   portable discovery and same-name ambiguity behavior still differ from Codex. Alpha's deterministic name precedence
   and additional skill roots are retained intentionally.
5. Complete real-provider, crash/restart, live webview, and multi-window acceptance for the eight pending certification
   rows. The passing deterministic and scripted host suites do not establish those properties.
6. Evaluate task quality, cache/input/output tokens, latency, retry amplification, and cost on matched before/after
   workloads before claiming a performance improvement or raising a numerical parity estimate. Exact CLI JavaScript
   tool composition and every CLI surface were not implemented or audited by this bounded pass.

## Coordinated chats

| Workstream                      | Chat                                   |
| ------------------------------- | -------------------------------------- |
| Subagents and history forks     | `01a101c4-ca49-7e71-8426-2e2346ebf553` |
| Instructions, skills, and modes | `01a101c4-cf6c-76e0-a561-0ea481236c30` |
| Context and provider continuity | `01a101c4-d52a-7e51-9983-2b0ebf6cf5a3` |

All three chats handed off their work and froze source before root's final gates. The implementation remains in this
checkout; these chat records and the detailed documents preserve ownership and verified upstream contracts.
