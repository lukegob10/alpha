# Long-chat continuity: reused tool-call IDs

Investigated on October 19, 2026. Scope: canonical context preparation, compaction, recent exact history, and bounded
truncation. This is one finding from the 15-agent extension reliability audit.

## Confirmed failure

**Severity: high for affected long-running chats.** A provider or saved transcript can legally reuse a tool-call ID after
the previous occurrence has a terminal result. Alpha's integrity validation and provider projection already accept this
format. However, `getLogicalStepStarts` calculated transaction spans from a map that grouped every occurrence by raw ID.
The first completed call and the newest completed call then looked like one transaction covering all intervening turns.

When context became full, a fitting recent transaction could no longer be retained independently. The deterministic
reproduction returned `exhausted` instead of reducing history to the original constraints and exact recent transaction.
With summarization available, the same boundary error could cause unnecessarily broad summarization instead of exact
recent retention. This is an execution-history defect, independent of authentication or user setup.

## Fix and compatibility

Logical-step boundaries now track each occurrence from its opening call through its matching terminal result. A reused
ID starts another occurrence after closure. Open calls still prevent boundaries through their transaction. Existing
integrity validation continues to reject duplicate open calls, orphan results, and duplicate terminal receipts.

The change is in `src/core/condense/index.ts`. Both summary tail selection and bounded truncation use this shared helper.
Saved records, tool IDs, opaque provider fields, public pair-map behavior, and rewind data are unchanged. Existing saved
histories benefit on their next context-preparation operation; no data migration is needed.

## Reference behavior

The reference is Codex CLI commit `091008729d5572712ac08964a9602eb71cf31428`, verified October 19, 2026:

- [`compact.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/compact.rs)
  performs bounded compaction and replaces history after a completed result.
- [`context_manager/history.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/context_manager/history.rs)
  removes the matching counterpart when dropping a call or output, preserving transaction integrity.
- [`context_manager/history_tests.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/context_manager/history_tests.rs)
  tests function-call, function-output, local-shell, and custom-tool removal as pairs.

Alpha deliberately retains its non-destructive history and exact recent-tail policy rather than copying Codex's storage
or compaction implementation. The reused-ID rule is Alpha's existing persisted/provider compatibility contract; the
upstream comparison supports transaction-safe reduction, not a claim that Codex tests this precise compatibility case.

The audit also checked the suggested post-turn failure path: Alpha's `maybeCompactAfterTurn` already catches ordinary
compaction failures and preserves a completed answer, matching Codex `session/turn.rs`. No additional defect was confirmed
at that boundary.

## Reproduction and validation

Two regressions were added to `src/core/condense/__tests__/recent-tail.spec.ts`. Before the fix:

- Independent completed occurrences yielded only boundary `[0]`, instead of `[0, 3, 4]`.
- Actual `manageContext` truncation returned `exhausted` despite a fitting newest transaction.

After the fix, both tests pass. The second also verifies the exact recent call/result, token-budget compliance, input
immutability, and complete restoration after the truncation marker is removed.

```sh
pnpm --dir src test core/condense/__tests__/recent-tail.spec.ts core/condense/__tests__/index.spec.ts core/context-management/__tests__/context-management.spec.ts core/context-management/__tests__/recovery.spec.ts --maxWorkers=1
```

Result: 174 tests passed across four files. The original failing run had two failures and 32 passes in the recent-tail
file. No paid model request was used. This finding does not establish the frequency of ID reuse in deployed providers or
attribute an unidentified user's original stuck chat to this defect. Extension type checks and exact VS Code 1.138.0
integration validation are coordinated by the parent audit and must be reported separately.
