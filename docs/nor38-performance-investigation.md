# NOR-38 performance follow-up

September 7, 2026. Follow-up audit of the Stage 1 candidate, restricted to the VS Code extension. The question is whether
the enhancement improves or degrades performance while preserving completed-work quality. CLI testing and changes are
out of scope. No production optimization is included in the measurement phase.

## Finding

Stage 1 has a measurable local bookkeeping regression, but these repeated extension workflows do not show a consistent
end-to-end slowdown. All 18 live workflows passed. The candidate used 139 model requests versus 135 for the baseline
(2.96% more), so this comparison demonstrates no request-efficiency improvement. Workflow median timing changes were
mixed, with overlapping ranges. The prompt subset became smaller, but that alone does not establish faster tasks or
lower billed usage.

The most concrete follow-up is to remove unnecessary retry/recovery hashing on healthy calls while preserving failure
policy. Larger live samples under better controlled machine/provider conditions would be needed to attribute small
end-to-end differences. No production optimization was implemented in this audit.

## Protocol declared before new measurements

- Baseline: isolated checkout of `90bb4ea24cfc3848e4c245bebdbbea2aa20f80fd`, before Stage 1.
- Candidate: the previously tested, frozen Stage 1 extension bundle
  `6f99a0f370c45cc91e679bd709d3f312d53c2a148742a7b9519b84308e0beeee`.
- Keep production source unchanged throughout each comparison. Record source/artifact identities; do not relabel a dirty
  source tree as clean or admit this as the older NOR-36 unchanged-prompt contract.
- Local runtime measurement: compare the detector admission/observation work using identical healthy observations,
  128-byte / 8-KiB / 128-KiB arguments, polling, and bounded retained-failure state. Alternate baseline/candidate order,
  warm the implementations, retain at least ten batch samples and medians, and check the returned behavior. Isolate
  imports and setup from timing; document mocks and boundaries. Report absolute overhead as well as percentage change.
- Live comparison: reuse the existing extension campaign runner and immutable fixture graders, actual VS Code 1.136.1,
  Copilot `gpt-5.6-luna`, effort `high`, and the same dedicated profile. The 1.122.1 live provider remains blocked by its
  bundled Copilot exception; this run does not substitute for reference-host acceptance.
- Representative live workloads: `dev-git-inspect`, `review-edit-test-commit-followup`, and `long-thread`, covering short
  inspection, implementation/verification/follow-up, and a dependent multi-turn task. Run three samples per revision in
  six sequential blocks ordered baseline, candidate, candidate, baseline, baseline, candidate. Each block starts fresh
  fixture workspaces and uses the same scenario order. This audit does not run competing builds or timing benchmarks
  during sampling. Other development in the shared workspace was observed; its machine contention is uncontrolled,
  so wall-clock comparisons remain exploratory even when test artifacts are isolated.
- Primary outcomes: completion/quality for every attempted sample, guarded model-request count, and workflow elapsed
  time. Campaign elapsed time includes host/setup/verification overhead; it is not time to first token. Do not replace
  failed samples with passing retries in the comparison. Any diagnostic reproduction is separate evidence.
- Bounds: at most 150 model requests and 20 minutes per block, 10 minutes per attempt. Stop on infrastructure, auth,
  usage, or evidence failures. Do not force an unavailable provider, remove safety checks, or alter model choices.
- Provider prompt/cache policy, billed input/output tokens, and time to first useful answer are not controlled or
  observed by this harness. Retain them as unavailable. Alternating order reduces an ordering bias but cannot remove
  live-provider variability. Three samples per workload can expose a substantial regression; they are not a general
  performance guarantee or proof of billing savings.

Existing historical live receipts will be compared separately as exploratory observations. Only newly matched samples
and measured local boundaries may support stronger conclusions. All test/quality failures remain visible.

## Measurement wrapper

`scripts/benchmarks/nor38-live-comparison.mjs` arranges the six fixed blocks through the existing compiled extension
campaign APIs. It does not implement a second task runner or grader: `runCampaign` owns scenario order, request and time
budgets, and result accounting; `createExtensionCampaignOperations` owns fresh fixture workspaces, actual host/model
validation, evidence retention, profile ownership, and process cleanup. The wrapper disables diagnostic reproduction
with `reproduceFailures: false`. An ordinary failed sample remains failed and the controller continues the matrix;
infrastructure, authentication, usage, evidence, retention, cancellation, or artifact changes stop later blocks.

Pass all five absolute paths explicitly:

```powershell
node scripts/benchmarks/nor38-live-comparison.mjs `
  --baseline-root 'F:/alpha-vscode-e2e-runs/nor38-performance-20260907/source-baseline' `
  --candidate-root 'F:/alpha-vscode-e2e-runs/nor38-performance-20260907/source-candidate-artifact' `
  --campaign-root '<absolute dedicated campaign root>' `
  --profile-root '<absolute dedicated authenticated test profile>' `
  --host-executable '<absolute VS Code 1.136.1 executable>' `
  --dry-run
```

Dry-run validates existing compiled artifacts and the marked campaign root without preparing a sidecar, launching a
host, initializing a root, or reading profile contents. Both fixed sidecars must already be prepared for this check.
For a real run, omit `--dry-run`; the wrapper uses the existing fixed-sidecar preparation API before freezing identities.
It performs no builds or source repairs. Baseline and candidate harness source, compiled output, fixture directory, and
fixed manifest/compiler/package inputs must match; scenario definitions and prompts are included in the harness source
hash. The pre-run baseline build supplies the source-to-output provenance, while these comparisons verify the same
source/output pairs across both sides. The candidate extension bundle must match the declared Stage 1 digest.

Both revisions' artifact and harness identities are checked before and after every block, outside the scenario timing.
Every comparison and block receives a fresh ID under the same marked campaign root, with immutable plan/result
manifests and the campaign store's immutable report checkpoints. Progress prints only after an attempt's evidence and
report are persisted. JSON output retains each raw report path, original quality counts and usage, and an explicit
`performanceVerdict: "not-computed"`; the wrapper does not replace failures, calculate winning averages, or infer
unobserved provider metrics. SIGINT/SIGTERM cancel the campaign signal and await the existing owned-host cleanup before
writing final evidence. The wrapper itself only checks the profile directory's path; profile contents and credentials
are left to the existing isolated-profile runner.

## Isolation and interrupted run

The first repeated comparison, `nor38-comparison-20260907235905063-a79a35c0`, stopped after its second block when the
artifact guard detected unrelated development changing the shared candidate's manifest and harness source. Its six
passing sample receipts remain available, but are excluded from the completed comparison. The baseline block used
45 requests and the candidate block used 47; those incomplete, interrupted observations support no performance verdict.

The replacement comparison uses two isolated directories. The baseline was built from commit
`90bb4ea24cfc3848e4c245bebdbbea2aa20f80fd` with the locked extension dependencies; its bundle digest is
`3dcef87c785da21921c83e2a1030159d9d6dc391e3e7ee8610fca0386ae6b9c3`. Its exact VS Code 1.122.1 smoke gate passed all eight
tests before sampling. Harness text files initially differed only in checkout line endings; after verifying that fact,
the bytes were aligned and the baseline harness recompiled. Both sides now use byte-identical harness source, compiled
output, fixtures, and build inputs. No scenario or grader logic changed.

The isolated candidate is deliberately **baseline source plus the frozen Stage 1 runtime artifact**, not a rebuildable
Stage 1 source checkout. The original Stage 1 bundle and its matching source map were recovered from the existing cache
archive `c292b5f184ed2941.tar.zst`; an independent audit verified the bundle against the declared Stage 1 digest above.
Rebuilding this directory would replace the candidate and invalidate the comparison. The extension manifest, 18 NLS
files, 644 webview build files, 922 assets, audio, native/worker/WASM/ripgrep runtime files, and external runtime dependency
entries match the baseline. Only the intended extension bundle and its diagnostic source map differ among runtime
artifacts. Packaging documentation was also copied for parity.

The immutable manifests retain the complete identities. Isolating inputs prevents unrelated edits from changing the
tested extension, but does not control other processes' CPU/disk use, provider latency, or cache state.

## Completed repeated live comparison

The replacement comparison `nor38-comparison-20260908001538584-154f41a3` completed all six blocks with exit 0 on
September 7, 2026 local time (September 8 UTC). It retained all 18 original attempts, with no replacement or diagnostic
reproduction. Raw samples, identities, source-report paths, descriptive summaries, and null unavailable metrics are in
[nor38-live-performance-20260907.json](benchmarks/nor38-live-performance-20260907.json).

Both revisions passed nine workflows. Baseline used **135 requests**, candidate **139 requests**: four more requests,
or **2.96%**. Per-workload results below use all three samples per revision. Timing is median seconds with the full
observed range in parentheses; request arrays retain within-revision execution order.

| Workflow                   | Baseline requests | Stage 1 requests | Baseline seconds       | Stage 1 seconds        | Median change |
| -------------------------- | ----------------- | ---------------- | ---------------------- | ---------------------- | ------------- |
| Git inspection             | 6, 6, 5           | 6, 6, 6          | 47.18 (46.73–56.16)    | 49.92 (47.22–52.65)    | +5.81%        |
| Edit/test/commit/follow-up | 15, 15, 15        | 15, 16, 16       | 85.29 (81.58–86.94)    | 87.35 (78.53–90.40)    | +2.42%        |
| Dependent long task        | 24, 25, 24        | 25, 25, 24       | 122.45 (120.14–139.90) | 121.43 (115.58–122.56) | −0.84%        |

Summed attempt time was 786.360 seconds for the baseline and 765.639 seconds for Stage 1, a descriptive 2.64% reduction.
Summed campaign time was 786.422 versus 765.702 seconds. The aggregate reduction is driven largely by the baseline's
first long-task sample: it does not imply uniformly faster workflows, and is not a causal speedup estimate. Both sides
show within-revision variation, including request counts. These observations cannot establish that Stage 1 caused a
roughly 3% request increase either. Three samples per workload, unknown provider/cache conditions, and concurrent machine
use preclude a precise small-regression bound.

The measured host/model combination is VS Code **1.136.1 / Copilot gpt-5.6-luna / high**. The exact 1.122.1 smoke gate
passed, but its live Copilot exception remains an unresolved host/provider compatibility limit. Actual input/output
tokens, billing, provider cache state, and time to first token remain unavailable.

Retained comparison manifests and original block reports are under
`F:/alpha-vscode-e2e-runs/nor38-performance-20260907/campaigns/`. The wrapper retained SHA-256
`aa9b5108b976b5a42505c976ccb6808833d657f9011b9b1940dc0d4d656f799e` throughout sampling. The interrupted shared-checkout
comparison above is excluded from these totals.

An independent final receipt audit rechecked all six completed blocks: **18 verified host launches**, **1,356 passing
check rows** (678 per revision), zero failed checks, and **144 matching projected artifact hashes** totaling 1,590,226
bytes. Each workflow used the same named checks in all six samples. Every host recorded the expected actual host/model/
effort, correct side's bundle, matching ownership identity and completion nonce, observed exit 0, complete finalized
capture without warnings, and complete retention. Every block's before/after fingerprints matched the original plan.

## Local runtime result

The raw measurement is [nor38-runtime-overhead-20260907.json](benchmarks/nor38-runtime-overhead-20260907.json), produced by
`pnpm exec node scripts/benchmarks/nor38-failure-overhead.mjs`. The run used Node 20.19.2 on an AMD Ryzen 7 5800X, two warmup
pairs and twelve timed pairs in alternating order. No builds, tests, live hosts, or other timing benchmarks from this
audit ran during its 9.54-second measurement window. The JSON records exact source digests and every raw batch sample.

Median cost per modeled successful serial call, with no retained failure blockers:

| Tool argument bytes |  Baseline |     Stage 1 |  Added cost |
| ------------------- | --------: | ----------: | ----------: |
| 128 B               |   6.25 µs |    19.52 µs |    13.27 µs |
| 8 KiB               |  28.10 µs |   106.72 µs |    78.62 µs |
| 128 KiB             | 399.32 µs | 1,583.33 µs | 1,184.00 µs |
| 128 B polling       |   3.00 µs |    16.14 µs |    13.14 µs |

These sizes describe **arguments, not tool output**: a large read result with small arguments does not exercise the
128-KiB case. Results with 32 retained blockers were similar. Healthy decisions passed all behavior checks. The modeled
path covers two normalized retry gates and outcome observation using the actual detector implementations; imports,
setup, failure seeding, assertions, actual tools, Task, the scheduler, VS Code, and provider requests are excluded.

Stage 1 performs four full-argument serialization/hash passes in the measured non-command path versus one previously.
That is consistent with the measured argument-size scaling, although individual hashing costs were not profiled. This
is a real local overhead regression; its ratio is not a whole-task slowdown estimate. Allocation volume, retained heap,
failure-loop savings, provider tokens, and model latency were not measured by this benchmark.

A possible follow-up can avoid normalization of absent metadata and avoid recovery hashes when no failure allowance
needs checking. It must preserve the capacity-exhaustion check, unknown-outcome protection, and legacy progress behavior.
No fast-path change was mixed into the frozen comparison.

## Earlier observations, kept separate

The prior Stage 1 prompt measurement found a 38.98% byte reduction and 38.76% reduction in estimated tokens within the
measured prompt subset; it did not measure the full request or billed provider tokens. Seven deterministic engine
workloads retained the same request counters and passed their quality checks. These results are recorded in
[the Stage 1 evidence](nor38-stage-one-evidence.md).

An exploratory comparison of historical ten-workflow campaigns found 128 requests before versus 113 for Stage 1, and
882.933 seconds versus 677.853 seconds for campaign elapsed time. Both passed all ten workflows and the same 575 named
checks on VS Code 1.136.1 / Luna / high. However, the older bundle cannot be tied to the declared baseline commit from
the available safe receipts, and runs were about 18.6 hours apart. Provider, cache, and machine conditions are unknown.
Those apparent 11.7% request and 23.2% time reductions are **historical observations, not an attributable Stage 1 gain**.

Historical records:

- `F:/alpha-vscode-e2e-runs/live-gate/current-live-gate-20260907-05`
- `F:/alpha-vscode-e2e-runs/nor38-live-20260907/nor38-current-20260907-01`

## Audit artifact validation

Both benchmark scripts passed `node --check` and ESLint with the existing shared configuration and their standard Node
globals declared. The five new report/benchmark files passed scoped Prettier and whitespace checks. The live wrapper's
digest still matches the one recorded in the immutable plan. No CLI/shim tests, production edits, dependency changes,
or unrelated formatting were included in this performance follow-up.
