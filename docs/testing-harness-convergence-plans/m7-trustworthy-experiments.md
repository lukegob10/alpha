# M7 implementation plan — trustworthy experiments and promotion

## Immutable identities and pairing

- Define schema-validated task-set, variant, experiment, pair, and policy manifests with canonical SHA-256 identities.
- Require every control/candidate pair to match task, task version, seed, resource profile, permissions, network, retry policy, time window, and repetition.
- Machine-diff all material variant dimensions: prompt, tool schema/implementation, policy, skills, extension build/commit/working tree, image, model/settings, compaction, permissions, resources, retries, and network.
- Separate harness-only and model-only templates; reject experiments that change dimensions outside the selected template.

## Statistics and denominator rules

- Implement fixed-seed bootstrap confidence intervals, paired win/loss/tie, consistency@k, pass@k, cost per success, p50/p95 latency, infrastructure/grader error rates, and capability/risk segments.
- Report first-attempt reliability independently from retry-assisted capability.
- Exclude infrastructure and grader errors from agent outcome denominators while retaining them in reliability/error-rate reporting.
- Test every statistic against fixed reference vectors, edge cases, and deterministic seeds.

## Governance and storage

- Add immutable experiments, task sets, experiment pairs/results, baselines, and append-only promotion records.
- Promotion requires completed M6 certification, paired evidence, reviewer/rationale, explicit rollback baseline, no safety hard-gate failure, no high-risk regression, and policy thresholds for reliability/infrastructure/cost/latency.
- Never mutate a baseline or promotion. Rollback creates a new reviewed promotion pointing at the prior immutable baseline.
- Add PR, nightly, and release-candidate policies as versioned code and expose machine-readable rejection reasons.

## Integration and tests

- Add `src/experiments/` with manifests, pairing, diffing, statistics, reporting, policies, and promotion service.
- Add database migration and integration tests for immutable audit records and copy/export behavior.
- Add `test:experiments`; include certification as a hard prerequisite and include M7 in coverage/campaign gates.
- Preserve existing run/task UI projections while adding typed report data suitable for later UI rendering.

## Non-goals

- No model judges, production-failure clustering, generated tasks, or actual model comparison is required to certify the comparison machinery.
