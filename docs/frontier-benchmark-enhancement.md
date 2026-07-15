# Frontier Benchmark Enhancement

**Status:** keyless implementation complete; model calibration pending  
**Primary eval model:** Luna High  
**Reference model:** Luna High (`frontier-v1` is Luna-only)  
**Main-repository expansion roadmap:** [`cost-effective-frontier-benchmark-main-plan.md`](./cost-effective-frontier-benchmark-main-plan.md)  
**Private expansion roadmap:** `F:\roo-fork\Alpha-Code-private-evals\docs\private-frontier-benchmark-expansion-plan.md`

## Release boundary

`smoke-v1` contains the original eight JavaScript fixtures and is excluded from frontier scoring. `frontier-v1` contains 40 immutable task identities: 20 development, 8 regression, and 12 opaque private holdouts. Frontier tasks remain `calibrating`; the runtime and UI cannot treat them as scored tasks until their reports pass admission and the suite is released.

| Milestone                 | Status                     | Evidence                                                                                                                                                                                                                                                                              |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0 — grading correctness  | Complete                   | Production grading loads task manifests and executes visible, private command, final-state, diff/safety, static, trace, and usage-policy graders with real trace, changed-path, usage, and environment context. Final audit `2026-07-13T024540987Z-1bcb0f21` passed.                  |
| B1 — authoring system     | Complete                   | Versioned suite/task/bundle/calibration contracts, strict validation, keyless calibration, model-trial ingestion, admission, release, and scaffolding commands are implemented.                                                                                                       |
| B2 — visible bank         | Calibrating                | 20 development and 8 regression identities and workspaces exist; all 28 passed 20 gold, 3×20 broken, and 50 determinism repetitions across seven grader layers. Real Luna High trials and human calibration remain required.                                                          |
| B3 — private holdouts     | Calibrating                | Separate `Alpha-Code-private-evals` Git repository contains 12 opaque task workspaces, 40 hidden graders, gold solutions, three broken solutions per task, and private reports; all 12 passed the strict keyless repetitions.                                                         |
| B4 — model calibration    | Pending paid authorization | OpenAI-backed Luna High campaigns are configured, but no task can be admitted without five Luna High trials and required human review.                                                                                                                                                |
| B5 — governed convergence | Keyless path certified     | Automated Luna campaigns, exact pairing contracts, aggregate-only holdout reporting, release gates, deterministic review sampling, and promotion decision gates exist. Final keyless campaign `2026-07-13T024540987Z-1bcb0f21` passed 10/10; a real paired campaign remains required. |

## Security model

- Agent containers receive neither `/var/run/docker.sock` nor the private benchmark mount.
- The web service mounts the private host path only into the trusted controller.
- A task copies its final workspace to a run-scoped shared directory and submits a filesystem broker request.
- The trusted controller executes all graders, writes content-addressed grader evidence, and returns the result.
- Holdout task workspaces are copied individually into an agent mount and deleted after the attempt.
- Autonomous consumers receive aggregate holdout metrics; detailed exports require explicit reviewer authorization.

## Admission invariants

- Initial non-restraint fixture fails for the intended reason.
- Gold passes 20/20; each of three broken solutions is rejected 20/20.
- All layered grader result digests are identical across 50 repetitions.
- Luna High supplies at least five frozen trials per task.
- Unexpected passes and safety failures are reviewed, plus at least 10% of all model trials.
- Zero unresolved false-positive passes remain.
- Release shape is exactly 20/8/12 partitions, 16/8/8/8 families, and 10/20/10 difficulty bands.

The release command computes and freezes fixture, prompt, repository snapshot, task-set, grader-bundle, model, and environment identities. Released task versions are never edited in place.
