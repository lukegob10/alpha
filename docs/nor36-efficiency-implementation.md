# NOR-36: remove repeated request preparation

September 5, 2026. Implementation baseline: `main-v2` at
`8b574a6cbfa8a2ca90fd296878e6410fb6b6c208`, including the completed NOR-33/NOR-37 corrections.
The implementation used a clean isolated checkout, Node 20.19.2 and pnpm 10.8.1. The
[issue](https://linear.app/norval/issue/NOR-36) was retrieved on this date. Historical evidence is in
[proportional context](nor-36-proportional-context.md) and
[integration results](nor31-parallel-integration-results.md).

## Owning boundaries and candidate selection

1. `Task.attemptApiRequest` built a tool catalog for context management on every later step, even when
   `manageContext` returned unchanged, then built the dispatch catalog. The early build omitted the final
   approval/read-grant inputs, so the two builds used different keys in the existing single-entry catalog cache.
   Removing the unused build also avoids that cache replacement. The final executable surface must remain fresh.
2. With subfolder rules enabled, `addCustomInstructions` launched the same recursive discovery through mode Alpha
   rules, mode legacy rules, AGENTS, generic Alpha rules and generic legacy rules. One assembly can share the
   directory discovery while retaining the existing ordered file readers.

These are demonstrated local setup costs. Existing incremental environment injection already omits unchanged
fields. `FileContextTracker` records paths and timestamps, not exact delivered ranges, content versions or active
transcript presence. It cannot justify suppressing reads or verification. No effort classifier, additional prompt
policy, call cap, cross-step evidence cache or completion intervention was introduced.

## Baselines and declared acceptance

The following operation-count targets and correctness conditions were declared before production edits. Both
workloads use public synthetic inputs, no external model and no wall-time acceptance threshold.

| Workload                                                                                                              | Observed baseline    | Declared candidate | Correctness oracle                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Three fresh low-context `Task.attemptApiRequest` samples using real `manageContext` and a counted catalog test double | 2 catalog calls each | 1 each             | Same outgoing prompt/history, one provider request, no compaction/history save, fresh dispatch read-grant capture |
| Enabled `addCustomInstructions` with global/project/a/z rules and mode + AGENTS                                       | 5 discovery calls    | 1                  | Complete pre-change prompt snapshot remains identical                                                             |
| Three subsequent instruction assemblies, including newly discovered directories and changed contents                  | 15 discovery calls   | 3                  | New evidence appears on the next assembly; removed discovery results are absent                                   |
| Enabled instructions with AGENTS disabled or supplied                                                                 | 4 calls each         | 1 each             | Existing precedence and supplied-source behavior                                                                  |
| Subfolder discovery disabled                                                                                          | 0 calls              | 0                  | Complete pre-change prompt snapshot remains identical                                                             |

The Task regression first needed a fixture correction because provider projection intentionally omits transcript
timestamps. After that correction, all three samples passed their request/history assertions and failed precisely
because the catalog count was two instead of one. The instruction suite recorded four intended count failures and
one passing disabled case before the change; its three complete output snapshots were inspected and retained.
These snapshots normalize platform path separators only.

The independent evaluation lane owns the stronger paired measurement with the actual production catalog builder,
request bytes, local tokenizer estimates and fixed fixtures. Its artifacts and acceptance are documented in
`docs/nor36-efficiency-acceptance.md`; this implementation record does not substitute unit-double counts for those
measurements.

## Implementation and safety

`manageContext` accepts optional deferred tool metadata. It resolves this metadata once before forced full-input
counting, actual summarization, or truncation. The authoritative count and existing thresholds still decide whether
work is needed. This matters because the earlier `willManageContext` preview can return false for an invalid count,
or a later uncached count can differ. Invalid authoritative counts still stop the request.

Only four tool fields can be returned by the typed callback, and runtime selection prevents replacing eager
signal/deadline/task metadata. Both operation and metadata cancellation signals are checked around preparation.
The Task callback retains resolved metadata for post-compaction counting and environment refresh. Summarization
continues to use its existing tool-free provider request; tool definitions remain necessary for input-budget
accounting. The final tool surface is captured separately with current authority, and transport retries retain
their original immutable request and surface.

Instruction assembly captures its directory list once, preserving global/project/sorted-descendant order and Alpha
precedence over legacy rules. File contents and trust-root checks still use the existing readers. Every new assembly
and standalone `loadRuleFiles` call discovers afresh. A discovery failure retains root rules and the next assembly
retries normally. Directory changes during an assembly are observed on the next assembly; there is no persistent
discovery cache. Existing frozen managed-child instruction sources remain supported.

No wire/persisted schemas, scheduler permissions, provider selection, user commands, read/check evidence or completion
outcomes change. Protected CLI/shim trees and dependencies remain untouched.

## Validation and remaining acceptance

The focused suites cover ordinary preflight, invalid counts, preview/recount divergence, cancellation during deferred
construction, exact thresholds, forced recovery, truncation overhead, fallback reuse, post-compaction catalog growth,
provider-state preservation and retained retries. Instruction tests cover exact output, ordering, flags, fresh
discovery/content and failure recovery. Existing compaction test doubles now invoke the deferred preparation boundary;
the post-compaction retry assertion expects one dispatch catalog while retaining its provider-state assertions.

Validation completed in the implementation checkout:

- `pnpm install --frozen-lockfile` and the required `pnpm --filter @alpha-code/types build` succeeded without tracked
  dependency/lockfile changes. The initial test collection failed before that package build; it was not a baseline result.
- Eight focused suites passed 177 tests with two existing skips: `Task.compaction-safety`, `Task.retry-wire`,
  `lazy-metadata`, context-management `recovery`, and all four custom-instruction suites.
- After the required metadata/test defaults were corrected, `pnpm --dir src check-types` passed.
- `pnpm --dir src lint` passed; focused ESLint also passed after the type corrections.
- Widening to the existing tokenizer-deadline suite exposed an added no-op await for eager metadata callers. Removing
  that unnecessary await preserved their existing scheduling contract. The final command below passed all 145 tests
  across six suites. These totals overlap and must not be added together.

```sh
pnpm --dir src test -- core/context-management core/condense/__tests__/tokenCountContext.spec.ts core/task/__tests__/Task.compaction-safety.spec.ts
```

Touched files were formatted and the final diff/three baseline snapshots reviewed. Exact VS Code 1.122.1 smoke and
combined integration gates are centrally coordinated by the parent task; no competing host or comparative timing run
was launched here. Commit creation runs staged formatting through `pnpm exec lint-staged` and uses the completed owning
package lint; the hook wrapper is disabled because it invokes `npx` and an uncoordinated root lint. Git blobs for the
touched existing source files were verified as LF, matching the retained source bytes.
No lifecycle/delegation contract changed, so these corrections do not independently require managed-agent certification.

These measurements establish fewer local setup operations with preserved behavior. They do not establish fewer
model-selected tools/commands, lower provider token use, useful-answer latency, or improved investigation strategy.
NOR-36's proposed broad 25% tool/command and 20% input-token targets remain unproven, and NOR-36/NOR-31 remain open.

Actual GPT-6 Astra medium subagents contributed within this task: `/root/task_path_investigation` investigated and
implemented the instruction change and regressions; `/root/context_safety_review` identified the preview-count hazard,
added 15 independent lazy-metadata regressions and reviewed the production changes. The lead implemented Task/context
management changes and integration regressions and reviewed the combined diff.
