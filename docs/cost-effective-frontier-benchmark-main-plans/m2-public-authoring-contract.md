# M2 Implementation Plan — Public Task Authoring Contract

**Status:** complete (2026-07-13)

## Objective

Make incomplete, duplicated, mutable, unsafe, or ungradeable benchmark tasks impossible to admit.

## Changes

1. Extend task contracts with context band, expected edit topology, public validation commands, evidence requirements, and explicit private bundle version/digest references.
2. Require fixture, prompt, repository snapshot, grader-reference, and environment digests for calibrating/admitted tasks.
3. Add a task template generator with compact, medium, and long profiles.
4. Add normalized prompt, source-tree, test-tree, and capability similarity analysis.
5. Accept private gold-diff and grader-overlap fingerprints as opaque admission inputs.
6. Reject path escapes, unsupported traces, unknown graders, duplicate identities, missing assets, and released-version mutation.
7. Produce a machine-readable authoring report and human-readable summary.
8. Add a `benchmark:author-check` command that does not require provider keys.

## Primary files

- `packages/evals/src/benchmark/contracts.ts`
- `packages/evals/src/benchmark/loader.ts`
- `packages/evals/src/benchmark/admission.ts`
- `packages/evals/src/benchmark/authoring.ts` (new)
- `packages/evals/src/benchmark/similarity.ts` (new)
- `packages/evals/src/benchmark/templates.ts` (new)
- `packages/evals/src/benchmark/cli.ts`
- `packages/evals/src/benchmark/__tests__/authoring.spec.ts` (new)
- `scripts/scaffold-frontier-bank.mjs`

## Tests

- Missing/digest-mismatched assets.
- Duplicate identity and released identity mutation.
- Prompt-only noun substitutions and structurally duplicated fixtures.
- Unsafe fixture/prompt paths and private-reference mismatches.
- Unsupported graders and missing required evidence.
- Valid compact, medium, long, restraint, and holdout-reference templates.

## Exit evidence

- `benchmark:validate` accepts both versioned suites: 48 task identities across the expected 8/20/8/12 partitions.
- The public registry validates all 40 opaque private-bundle references without loading private grader contents.
- Authoring tests cover compact, medium, long, restraint, and holdout-reference templates; duplicate identities; unsafe paths; unknown graders; missing trace evidence; prompt and fixture digest mismatch; released-version mutation; and opaque fingerprint mismatch.
- `.frontier-campaign/m2-authoring/benchmark-authoring.{json,md}` reports all 378 visible pairwise duplicates in the pre-M3 bank. This expected bank-quality failure is M3's input; the individual task contracts and assets are valid.
- The obsolete monolithic reducer scaffold now fails closed instead of overwriting the bank.
- M2 used no model API calls.
