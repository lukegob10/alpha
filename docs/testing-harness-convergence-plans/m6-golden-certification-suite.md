# M6 implementation plan — golden harness certification suite

## Suite design

- Define 15 versioned, machine-readable scenarios covering every required M6 truth: pass, outcome failure, safety/scope denial, hidden-state access, agent/grader timeout, setup failure, artifact corruption, missing/duplicate events, infrastructure and agent retries, cancellation, network denial, secret redaction, and grader nondeterminism.
- Each manifest declares the expected trial and attempt statuses, grader/hard-gate result, artifact completeness, event-integrity result, retry count, and inclusion in outcome/reliability/infrastructure/safety metrics.
- Keep prompts/models out of the runner. Scenarios execute through the M2 hostile runtime, M3 classification rules, M4 evidence validator/redactor, and M5 concurrency-safe runtime boundaries.

## Runner and comparator

- Add a schema-validated manifest loader, deterministic scenario executor, strict result comparator, and canonical reproduction bundle.
- A result is accepted only when every expected field matches; intentionally invalid evidence must terminate as infrastructure failure and remain excluded from outcome scoring.
- Add a CLI/script usable as a mandatory preflight by later model-backed campaigns and M7 promotion policy.

## Repeatability gates

- Run the entire suite 20 consecutive times serially and require byte-stable canonical results.
- Run it 5 consecutive times at the production-like concurrency configured in the suite and require the same canonical result vector.
- On drift, emit scenario id, expected/actual values, seed, repetition, and serialized reproduction input.

## Files and validation

- Store manifests under `evals/certification/` and implementation/tests under `packages/evals/src/certification/`.
- Add `test:certification`; include it in coverage and autonomous campaign validation.
- Validate with certification, all harness tests, infrastructure contracts, coverage, migrations/integration, types, lint, and web compatibility.

## Non-goals

- The suite certifies harness truthfulness; it does not measure model capability, rank agents, call providers, or use subjective judges.
