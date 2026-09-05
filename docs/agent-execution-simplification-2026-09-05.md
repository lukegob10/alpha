# Execution and verification contract correction

September 5, 2026. Implements the findings in the [overfitting review](agent-overfitting-review-2026-09-05.md).

## Resulting contract

- Approved commands use the existing execution policy and terminal path. A failed bounded workspace observation no
  longer substitutes the Plan command classifier for Code permissions or prevents launch.
- A terminal process result remains authoritative about exit status. Incomplete diff observation is explicitly recorded
  as `observationIncomplete`, and the tool explains that limitation. An unavailable observer is not a failed command.
- A command still reserves its physical operation before launch. Pre-launch failures release the reservation; unknown
  launch/process outcomes retain unresolved effects. Durable receipt failures remain errors. Cancellation, timeout,
  background completion and approval denial retain their existing terminal semantics.
- Settled primary change receipts are advisory for completion. The model chooses checks from the request, repository
  instructions and risk. Ordinary edits do not generate mandatory verifier kinds, dependency scans, change-set IDs or
  verification mail. Explicit legacy associations remain readable and can retain scoped evidence; failed evidence is
  never rewritten as passing.
- Applied Worker changes retain their review and verification gates. A command with an unavailable diff invalidates
  earlier Worker verification. Known primary file changes continue to invalidate overlapping Worker receipts.
- Receipt metadata stays bounded. More than 256 accumulated primary paths marks observation incomplete instead of
  failing the already-completed edit. File-tool outcomes still report the actual individual operation.
- The public `read_file` batch works directly through the canonical scheduler. It accepts public `line_ranges` and
  historical `lineRanges`, validates each entry, enforces the eight-file bound, and reports missing/denied entries.
- Lifecycle display publication coalesces adjacent compatible text/reasoning fragments into bounded values. Tool,
  usage, grounding and reasoning-signature boundaries remain intact. Canonical response/provider history is unchanged.
  Publication still completes before tool effects; old individual IDs and new grouped IDs both replay idempotently.
- Markdown guidance permits useful links without requiring extra investigation merely to format a reference.

## Compatibility and deliberate policy change

Existing primary receipt records remain readable; they are not deleted or relabeled as verified. An old settled primary
`pending` or `failed` verifier status no longer prevents completion by itself. Existing reservations and `scopeUnresolved`
still block. Records without a primary origin retain the previous Worker interpretation.

`observationIncomplete` is an optional additive field. The schema admits an empty primary inventory only with an active
reservation or explicit incomplete observation; it still rejects unexplained empty inventories and empty Worker changes.
The withdrawn Git/JSON postcondition patch was removed, including its new verification kind and command recipes.

The completion tests were deliberately revised: retry/recovery limits are exercised against explicit Worker obligations,
and ordinary primary edits now have one-response acceptance tests. Evidence-correctness assertions still distinguish
passing, failed, skipped, stale and unscoped commands. Pending-operation tests were retained.

## Reproductions and measurement

The new regressions failed before the fix: four approved commands never reached the terminal, a README edit could not
complete after reload, public batches returned only the first file, and a 763-fragment response caused 763 journal
publications.

After the fix, physical Node and Git processes run in disposable 257-file workspaces containing malformed Git metadata.
The real Node version is returned as success; Git's real repository error is returned as failure. No user project is used.

The lifecycle fixture uses 688 reasoning fragments, 74 text fragments and one usage item, matching the recorded event
shape. It now uses four durable publications and preserves the concatenated content across replay. One measured run took
13 ms for publication. The before/after guarantee is the publication count (763 to 4); this is not a live-model latency
claim or an isolated measurement of the user's original 31.8-second delay.

Focused commands:

```sh
pnpm --dir src test -- core/task/__tests__/stageThreeCommandOutcome.integration.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts core/agent/__tests__/primary-completion-policy.spec.ts
pnpm --dir src test -- core/task/__tests__/Task.lifecycle-publication.spec.ts core/agent/lifecycle/__tests__/responseItems.spec.ts
pnpm --filter @alpha-code/types test -- src/__tests__/primary-observation.test.ts
```

The implementation does not repair the user's project, change model settings, implement the two-stage routing proposal,
or edit the protected CLI/shim. A running extension must load the rebuilt worktree bundle to exercise these changes.
