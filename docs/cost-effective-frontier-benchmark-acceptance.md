# Cost-Effective Frontier Benchmark — Main Repository Acceptance

**Date:** 2026-07-13  
**Branch:** `codex/frontier-benchmark-expansion`  
**Overall:** main implementation and private keyless admission complete; the first governed T1 measurement is recorded, while benchmark release still awaits model calibration, human review, and a clean frozen baseline

## Requirement audit

| Requirement                       | Status            | Evidence                                                                                                                                                                                                                            |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned public/private boundary | Pass              | `frontier-v1@1` references `frontier-v1-graders@2` by content digest; released smoke suite has an immutable lock.                                                                                                                   |
| Complete model-backed grader path | Pass              | Production and keyless paths share manifest grader resolution; brokered hidden, visible, final-state, diff/safety, static, trace, usage, and evidence decisions persist with explicit terminal classes.                             |
| Hidden isolation                  | Pass              | Agent containers mount neither the private root nor Docker socket; real-Docker certification verifies hidden state is unmounted and secret values are absent from argv/process listings.                                            |
| Public authoring contract         | Pass              | Contract/template tests cover missing/changed assets, paths, identities, graders, traces, released locks, private references, and opaque fingerprints.                                                                              |
| 28 diverse visible fixtures       | Pass (public)     | 20 development + 8 regression; 12/6/5/5 family allocation; 12/11/5 context allocation; authoring similarity reports zero duplicate pairs.                                                                                           |
| Declared initial state            | Pass              | `benchmark:fixture-check` runs each task's manifest command: 28/28 non-restraint fixtures fail initially.                                                                                                                           |
| Private gold/broken/hidden assets | Pass              | All 40 private packages match the current task bank. Each has a task-specific grader, gold overlay, three broken overlays with expected codes, and admitted evidence. Keyless summary: 40 admitted, 0 rejected.                     |
| Cost-effective T1                 | Pass              | Eight-task deterministic subset: provisional $0.305 legacy-prior estimate, $0.48 reserved, $0.50 cap, with required coding/Alpha/safety/recovery/regression coverage. Governed run 12 cost $0.4147293.                              |
| T2/T3 governance                  | Pass (dry run)    | T2 reserves $1 for 20 tasks; T3 reserves $2 for 40 one-pass tasks. Neither tier has been run.                                                                                                                                       |
| Runtime cost enforcement          | Pass              | All work is reserved before scheduling; governed trials have no implicit retries; live task cost cancels execution; provider accounting, cache usage, latency, tools, and retries are durable.                                      |
| Promotion efficiency gates        | Pass              | Cost per success >20% and latency >25% without capability gain block or require review.                                                                                                                                             |
| Exact paired reporting            | Pass (model-free) | Reports require immutable task-set/variant/experiment manifests, exact pair keys, one declared candidate-difference set, and overall/capability/risk/family/difficulty segments. A paid control/candidate campaign remains pending. |
| Human-review sampling             | Pass (mechanism)  | Calibration reports cannot claim repetitions without unique trial IDs. A private digest-bound manifest selects a deterministic global 10% plus all mandatory/unstable/disagreement trials; release rejects incomplete reviews.      |
| Frozen Luna High baseline         | **Pending**       | Governed T1 run 12 is measurement evidence, not a frozen baseline: 3/8 trials passed, 3 exhausted their task budget, 1 had an agent-execution error, and 1 failed a safety gate.                                                    |

## Verified commands

- TypeScript typecheck and package lint.
- Unit: 216 tests passed, including immutable migration-history, disposable-workspace, terminal-settlement, trace-fallback, actionable-error, timeout classification, completed-task budget verification, idempotent measured-history ingestion, production live-ledger scheduling, family/difficulty reporting, and deterministic human-review sampling.
- Integration: 21 tests passed against PostgreSQL.
- Contract: 17 tests passed.
- Golden certification: 5 tests passed, including 20 serial and 5 concurrent repetitions.
- Infrastructure: 9 real-Docker tests passed.
- `benchmark:validate`: 48 tasks in the expected 8/20/8/12 partitions.
- `benchmark:author-check`: zero public duplicate pairs.
- `benchmark:fixture-check`: 28/28 declared initial states valid.
- Private keyless admission: 40/40 task packages admitted; 0 rejected.
- Private companion loader, executable grader smoke, isolation certification, and release-candidate verification passed.
- All 28 public-safe visible calibration reports were schema-sanitized from the admitted private evidence; the 12 holdout reports remain private.
- Fresh-database migration audit applied all 14 journaled migrations and verified the six campaign-governance columns; development and test databases are current.
- Model-free tier estimates: T0 $0, T1 $0.390431 expected/$0.48 reserved, T2 $0.80 expected/$1 reserved, T3 $1.60 expected/$2 reserved.
- T1 history provenance: run 12 is recorded once for eight measured task costs and end-to-end wall latencies; six unobserved candidate histories remain visibly seeded.
- Release-tier dry runs: the eight-task/three-iteration Luna reliability tier estimates $1.20, reserves $1.92, and caps at $2; five iterations require an explicitly larger approved cap. T5 estimates $10.40, reserves $16, and uses a $16 explicit-approval cap. Neither campaign has been run.
- Governed Luna High T1 run 12: 8 tasks, 1 iteration, high reasoning, $0.4147293 total, 459,971 ms aggregate task duration, 3 passed, 3 budget-exhausted, 1 agent error, and 1 safety failure.
- Run 12 executed all seven declared grader layers for seven tasks with valid evidence and no grader errors. The agent-error task stopped before grading and retained `pending` evidence, so it cannot enter the capability denominator.
- Four tasks produced seven passing grader decisions; one of those (`alpha-tool-result-integrity`) was nevertheless classified `budget_exhausted` after crossing the live cap during completion. The completed-task overwrite defect is now fixed and regression-tested; run 12 remains historical measurement evidence rather than a corrected baseline.
- Canonical fixture verification after the paid run remained valid: all 28 public fixtures still start in their declared failing state.

## Release blockers

1. Ingest five Luna High calibration trials for each of the 40 frozen task identities; the release audit currently reports 0/40 complete.
2. Complete authorized human review for all 40 tasks, including every disagreement/safety event and the deterministic random 10% sample; 0/40 are currently approved.
3. Resolve every unexpected pass, grader disagreement, and false-positive pass.
4. Re-run a clean paired T1 with the corrected timeout, completed-task budget semantics, and live campaign ledger before considering T2/T3.

Until those blockers are closed, `frontier-v1` correctly remains `calibrating`; it must not be promoted or described as a frozen frontier-grade release.
