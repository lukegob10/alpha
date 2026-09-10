# Compaction and recovery implementation

Started September 9, 2026. Informed by the pinned upstream sources in
[Codex/Zoo runtime review](codex-zoo-agent-runtime-review.md) and
[Zoo extension reliability review](zoo-extension-reliability-review.md).

## Scope and sequence

All four steps below are complete for this implementation.

1. Add bounded compaction diagnostics and replay the existing failing live workload. Identify summary normalization,
   terminal outcome, token budget, candidate validation or installation failure before changing acceptance behavior.
2. Reproduce the identified cause deterministically and fix its owning layer. Preserve complete recent steps, provider
   state, cancellation, measurable recovery and saved history. Change retention policy only if the evidence requires it.
3. Reproduce and fix reopening that writes UI history before both histories have loaded. Cover read failures and eviction;
   preserve retained-task follow-up, canonical transcript recovery and completed reasoning.
4. Run focused regressions, affected-package lint/typecheck and the exact VS Code 1.122.1 smoke gate. Run bounded live
   Copilot tests using the existing authenticated profiles. Revise only in response to a specific failed assertion.

Rendering, tool grouping and other secondary review findings are outside this implementation's compaction/recovery scope.

## Acceptance evidence

- Automatic compaction continues beyond the previously failing eighteenth turn in the 32-turn workload.
- The twelve-turn empty-response exhaustion workload stops at its retry budget, admits a follow-up, manually compacts,
  preserves its seeded anchor on the next answer and passes the independent code grader.
- Reopen and cancellation regressions preserve original history and reject stale writes; completion admits subsequent input.
- Each live result records model, host, bundle identity, requests, elapsed time, summaries and final correctness. A summary
  API response or disappearing progress indicator alone is not a pass. Live samples supplement deterministic coverage.
- Retry loops have attempt/request/time limits. A failed run retains evidence; it is never relabeled as a pass.

## Baseline

Existing Alpha HEAD: `127978c916897dd532b80ddfdb789f00f5a308fb`, with pre-existing uncommitted harness/efficiency changes.
Live profiles: `F:/alpha-vscode-e2e-runs/20260906/profiles`. Portable live host: 1.136.1; reference gate: 1.122.1.
Model: Copilot `gpt-5.6-luna`, high effort. Prior 32-turn run failed at turn 18; twelve-turn exhaustion recovered from
the injected empties but failed manual compaction. See [retained evidence](long-context-recovery-testing.md).

## Results

### Root cause and implementation

All three pre-installation checks in `Task` passed stored history to `measureCompactedContext`. Condensation deliberately
keeps the old archive with markers for rewind, so these checks counted hidden messages as active model input. A valid
summary could pass the summarizer's candidate check and then fail with `ContextRecoveryExhaustedError` before persistence.
The same error affected manual condensation, automatic context management and forced context-limit recovery.

Three focused regressions failed at that exact boundary before the fix. All three installation paths now validate
`getEffectiveApiHistory(candidate)` while preserving the complete stored candidate for the atomic history write.
Final request validation remains intact, including changed tool schemas and provider-specific state. No token ceiling,
tool integrity rule or summary acceptance requirement was relaxed. Zoo-style whole-history summary replacement was
unnecessary for this bug; Alpha retains its exact recent steps.

Reopen tests independently reproduced premature UI writes and stale writes after eviction. Reopen now loads both
histories, checks cancellation/abandonment after the awaits, then hydrates both without an initial UI rewrite. Sidecar
backfill is deferred to the normal persistence owner. Completed reasoning survives; only trailing partial reasoning is
removed. The strict existing-task UI reader distinguishes missing, invalid and I/O failures while preserving original
bytes. Non-resume readers retain their tolerant behavior and explicitly saved empty arrays remain readable.

Compaction results now include bounded diagnostic reasons and counts. Task sends these through the existing output
channel, and separately records validation failures. Logging cannot prevent persistence. Diagnostics exclude prompt,
summary and provider payload text. The first diagnostic live run reproduced the baseline failure with 16 requests;
console-only output was not retained by that runner, which is why the output-channel path was added.

### Validation results

- Initial focused suite after the behavioral fixes: 543 tests passed in 17 files.
- New compaction archive tests: three failed before the fix; all three passed after it.
- Reopen ordering/eviction tests: four failures before the fix; six focused cases passed afterward.
- Broader provider/recovery suite: 205 tests passed in seven files. Extension lint and typecheck passed.
- Additional hydration/sidecar coverage: all 56 persistence tests passed.
- Harness unit suite: 359 passed, two existing skips. Harness lint and typecheck passed.
- Exact `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` completed successfully on the fixed bundle.
- Live candidate bundle SHA-256: `f148e6d91e74a0af65be59f2304d575349aa228d9ae60b0cb9d6bd0b917bd7de`.
- The live campaign completed with six passed attempts, zero failures/blocks and complete evidence retention. Total:
  136 model requests, 14 minutes 40.584 seconds including host startup and teardown. Runtime code remained unchanged
  across the six attempts. No automatic code repairs or extra reproduction attempts were needed.

| Live scenario                 | Sample 1            | Sample 2            | Required outcome                                                                                    |
| ----------------------------- | ------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| 32-turn long-context recovery | Passed, 41 requests | Passed, 41 requests | Automatic/manual summaries, late empty recovery, reopen, anchor recall, graded code fix             |
| Twelve-turn empty exhaustion  | Passed, 21 requests | Passed, 22 requests | Two injected empties, one warning, bounded retry, new question, compaction, reopen, graded code fix |
| Full-host reload continuation | Passed, 6 requests  | Passed, 5 requests  | Checkpoint survives process exit; new host continues the same saved task correctly                  |

The first automatic candidate was 42,626 tokens against a 150,000-token target; its later manual candidate was 42,900.
Both used the conservative post-deadline counting path successfully. All six summary diagnostics are retained with
the workflow references and bundle hash in
`F:/alpha-vscode-e2e-runs/task-efficiency-20260909/compaction-recovery-validation/validation-evidence.json`.
The campaign's terminal report and original per-step/grade artifacts remain alongside it. Full-host restart request
totals combine the separate `prepare` and `continue` phases; a checkpoint alone is not counted as a passed scenario.

These results fix the reproduced archive-counting failure and exercise the corrected reopen path. They do not establish
the absence of every provider stall or a general improvement in ordinary coding request counts. Empty responses were
deliberately injected after consuming real Copilot output. Token usage/cost totals were unavailable in the campaign
report and are not represented as zero. The tested live model/host is Copilot `gpt-5.6-luna`, high effort, VS Code 1.136.1;
the separate exact 1.122.1 gate supplies the compatibility evidence.

### Repeatable live validation

Use a fresh campaign ID on subsequent runs. The checked-in matrix runs two samples each of the 32-turn compaction
workload, twelve-turn empty-exhaustion recovery and fresh-host reload continuation. It is capped at six attempts,
180 requests and 45 minutes overall; each attempt has a 20-minute deadline. No automated code repair is enabled.
Both long-context workloads now close/reopen the saved task after manual compaction, require a replacement Task instance
with the same summary count, and submit the anchor question through the composer before grading the code fix. This
recreates the Task inside the same host; the separate reload-continuation scenario tests a full extension-host restart.

```powershell
pnpm --dir apps/vscode-e2e test:campaign --config F:/roo-fork/Alpha-Code/apps/vscode-e2e/campaigns/compaction-recovery-validation.json --root F:/alpha-vscode-e2e-runs/task-efficiency-20260909 --profile-dir F:/alpha-vscode-e2e-runs/20260906/profiles
```

The live 1.136.1 profile supplements, and does not replace, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`.
