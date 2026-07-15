# M3 Implementation Plan — Visible Bank Replacement

**Status:** public bank and companion private keyless admission complete (2026-07-13)

## Objective

Replace duplicated visible fixtures with 28 capability-diverse development/regression tasks while retaining no more than four visible reducer foundations.

## Visible family allocation

| Family                         | Visible tasks | Private holdouts | Total |
| ------------------------------ | ------------: | ---------------: | ----: |
| Real-repository engineering    |            12 |                4 |    16 |
| Alpha agent/extension behavior |             6 |                2 |     8 |
| Safety/stateful behavior       |             5 |                3 |     8 |
| Long-horizon/recovery          |             5 |                3 |     8 |

## Context allocation

- Compact: 12 visible tasks.
- Medium: 11 visible tasks.
- Long: 5 visible tasks.
- The private plan supplies the remaining context-band totals.

## Visible task matrix

### Real-repository engineering (12)

1. Cache invalidation across layered configuration.
2. Cursor pagination with deletion/insertion stability.
3. Stream backpressure and cancellation cleanup.
4. Workspace package build ordering.
5. Transaction outbox crash recovery.
6. Concurrent file-lock ownership and stale lock recovery.
7. Plugin dependency-cycle diagnosis.
8. Schema compatibility across rolling versions.
9. Worker graceful shutdown with in-flight work.
10. Build-artifact boundary and package exports.
11. Dependency upgrade with changed API behavior.
12. Test-runner isolation and flaky shared state.

### Alpha agent and extension behavior (6)

13. Repository-rule compliance across nested instructions.
14. Context continuity after compaction.
15. Resume idempotency after interrupted tool execution.
16. Tool-result integrity and malformed response recovery.
17. Validation after final edit rather than before it.
18. Cancellation cleanup across extension and CLI state.

### Safety and stateful behavior (5)

19. Path traversal and protected-directory policy.
20. Secret redaction across logs and errors.
21. Prompt-injection resistance in repository content.
22. External-side-effect idempotency and retry keys.
23. Migration rollback after a partial failure.

### Long-horizon and recovery (5)

24. Multi-package feature with backward compatibility.
25. Browser-validated settings behavior.
26. Failed-approach recovery with preserved work.
27. Performance optimization under correctness and memory constraints.
28. Cross-process scheduler ordering and restart recovery.

## Authoring waves

- W1: tasks 1-5.
- W2: tasks 13-17.
- W3: tasks 19-23.
- W4: tasks 6-10.
- W5: tasks 11, 12, 24-26.
- W6: tasks 18, 27, 28 plus two regression variants from real historical Alpha defects.
- W7: replace any retained placeholder that fails diversity/admission and rebalance partitions/context.

Each task gets a distinct fixture tree, issue prompt, visible validation, capability metadata, budgets, and opaque private grader references. Corresponding private graders/gold/broken assets are completed in the private repository before admission.

## Automation

- Replace the monolithic reducer scaffold with archetype-specific builders.
- Generate fixtures deterministically from versioned source templates or pinned snapshots.
- Emit fixture/prompt/repository digests.
- Run similarity and keyless admission after every wave.
- Do not run Luna until a wave passes public and private keyless gates.

## Exit evidence

- The public manifest contains exactly 20 development and 8 regression tasks.
- Visible allocation is 12 real-repository, 6 Alpha-extension, 5 safety/stateful, and 5 long-horizon tasks; total allocation including holdout references is 16/8/8/8.
- Context allocation is exactly 12 compact, 11 medium, and 5 long visible tasks; total allocation is 16/16/8.
- `benchmark:author-check` reports zero duplicated visible pairs, down from 378 before replacement.
- `benchmark:fixture-check` executes every declared visible command and proves all 28 non-restraint fixtures initially fail.
- Every visible task uses one scored repetition for routine research. No paid authoring trials were run.
- The companion private repository now supplies aligned task-specific hidden graders, gold solutions, and three broken solutions for all 40 tasks. All 40 passed keyless admission, determinism, mutation, executable-entrypoint, identity-alignment, and isolation gates. Tasks remain `calibrating` only because paid model calibration and human review are intentionally separate release gates.
