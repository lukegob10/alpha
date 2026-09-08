# NOR-38 stage-one evidence

September 7, 2026. Work is scoped by the [implementation plan](nor38-stage-one-plan.md) and the
[existing NOR-36 measurement contract](nor36-efficiency-acceptance.md). The unchanged production baseline is
`90bb4ea24cfc3848e4c245bebdbbea2aa20f80fd`, measured with Node 20.19.2 and pnpm 10.8.1 before production edits.
The first engine reports identify a clean tree. Later baseline reports correctly identify a modified tree because the
implementation plan and measurement/owning tests had been added; production source still had no diff at capture.
These are exploratory local comparisons, not clean-source paired admission or a release performance certification.

## Workload and predeclared acceptance

Three complementary offline boundaries retain the same workload before and after implementation:

- The existing seven `proportionalScope.integration.spec.ts` fixtures exercise the real turn engine and scheduler with
  fixed scripted responses, real fixture reads/edits, and Node verification commands. Their prompts, scripted actions,
  repairs, and quality assertions remain unchanged. All seven class oracles must pass with unchanged script counters.
- The existing NOR-36 request-preflight measurement runs three fresh Task-catalog instances for each of no/small/large
  MCP catalogs. It invokes the actual `Task.attemptApiRequest`, context manager, native catalog, and step capture, with
  injected lifecycle/UI seams, fixed system text, and an offline provider. Request/history/authority/output invariants
  must remain intact; native-schema descriptions may shrink, with no increase in schema bytes or local token estimate.
- The added [prompt measurement](../src/core/prompts/__tests__/nor38-efficiency-measurement.spec.ts) invokes production
  objective, rules, shared tool-use, tool-use-guidelines, Code instructions, and completion/todo schema builders. It fixes
  primary Code mode, no delegation overrides, a public workspace path, and Bash. Code instructions are imported from
  package source so an old package build cannot hide edits. The seven emitted sections must reduce aggregate bytes by
  at least **10%**, with no increase in their aggregate local estimate. Behavioral tests separately retain authority,
  requested coverage, necessary unknowns, applicable checks, fresh evidence, and ordinary-answer completion.

Local estimates use Alpha's existing `o200k_base` estimator with its **1.5 safety multiplier**, independently over each
text/JSON part. They are not exact provider serialization or billed usage. The section aggregate excludes the remaining
system prompt, custom instructions, history, and other tools. The preflight seam intentionally injects fixed system text,
so it measures changes to emitted tool schemas but does not measure the full production prompt.

These thresholds were sent to the implementation lanes before production edits. Stage one introduces no model routing,
call cap, output-length cap, cache, or alternative lifecycle engine. Broad 25% call and 20% input-token targets require
repeated adaptive-provider evidence and remain unproven by fixed responses.

## Unchanged-code baseline

The seven quality classes passed. Each has one finalization request; the escalation fixture retains the stale rejection,
reread, retry, preserved external content, required check, and two recovery tools.

| Class                    | Model requests | Tool results | Commands | Tool-output bytes |
| ------------------------ | -------------: | -----------: | -------: | ----------------: |
| Conversation             |              1 |            0 |        0 |                 0 |
| Narrow lookup            |              2 |            1 |        0 |                36 |
| Small edit               |              4 |            3 |        1 |               171 |
| Cross-component bug      |              6 |            5 |        1 |               534 |
| Security change          |              4 |            3 |        1 |               178 |
| Comprehensive audit      |              6 |            5 |        0 |               856 |
| Stale-context escalation |              6 |            5 |        1 |               391 |

All nine preflight continuations passed: each makes one catalog build, one native-schema factory call, one provider request,
zero emitted tools, and zero commands. System text is 90 bytes / 23 local estimated tokens; messages are 398 bytes / 155
local estimated tokens; response text is 47 bytes. Baseline schema bytes are 33,345 / 34,516 / 33,988 for no/small/large
MCP catalogs, with local estimates 10,740 / 11,109 / 10,943. Larger catalogs retain deferred discovery.

## Candidate prompt result

The declared aggregate reduced **15,318 to 9,347 bytes (38.98%)**; its local estimate reduced **4,247 to 2,601 (38.76%)**.
Objective guidance grows because it now owns proportionality and escalation requirements; overlapping sections shrink.
The new test retains the predeclared size budget of at most 13,786 bytes and 4,247 local estimated tokens. Its sampling
inputs are unchanged from baseline; only formatting and post-baseline budget assertions changed the test-file digest.
The captured [local evidence](benchmarks/nor38-stage-one-20260907.json) retains both identities and measured section digests.

| Measured section    | Baseline bytes | Candidate bytes | Baseline local estimate | Candidate local estimate |
| ------------------- | -------------: | --------------: | ----------------------: | -----------------------: |
| Objective           |          1,985 |           2,462 |                     513 |                      633 |
| Rules               |          4,608 |           1,602 |                   1,287 |                      455 |
| Shared tool use     |          1,404 |             392 |                     383 |                      114 |
| Tool-use guidelines |            942 |             788 |                     264 |                      216 |
| Code instructions   |          2,194 |             967 |                     531 |                      234 |
| Completion schema   |          2,097 |           1,880 |                     600 |                      548 |
| Todo schema         |          2,088 |           1,256 |                     669 |                      401 |
| Total               |     **15,318** |       **9,347** |               **4,247** |                **2,601** |

The unchanged preflight sampler passed all nine candidate continuations. Catalog/schema factories, model/tool/command
counts, fixed history with opaque reasoning state, final read-grant authority, system/message bytes, and output text are
unchanged. Each outgoing catalog reduces by **1,049 schema bytes** and **321 locally estimated schema tokens**. Request
and schema digests intentionally change with descriptions. The measurement's full harness and fixture digests match.

| MCP catalog | Samples per side | Schema bytes, before → after | Local schema estimate, before → after |
| ----------- | ---------------: | ---------------------------: | ------------------------------------: |
| None        |                3 |              33,345 → 32,296 |                       10,740 → 10,419 |
| Small       |                3 |              34,516 → 33,467 |                       11,109 → 10,788 |
| Large       |                3 |              33,988 → 32,939 |                       10,943 → 10,622 |

The final integrated candidate also passed the seven unchanged engine classes. All fourteen reports (one per class per
side) were exactly equal after excluding only `workingTree`; this includes fixture/configuration identities, completed
quality outcomes, total and phase counters, and the explicit unavailable metrics. The artifact retains baseline metrics
once and hashes of both full reports. One invocation per side is a structural comparison, not a repeated latency study.

## Independent runtime review and remaining boundary

Review of Task, BaseTool, command execution, scheduler, failure normalization, and repetition state found three material
edges that were corrected before the final integrated engine run: bounded records could drop unknown outcomes,
registered aliases could mismatch admission and observation identities, and tools that caught their own mutation errors
could omit failure metadata. The corrected paths retain a terminal error receipt, canonicalize operation names, and
use trusted conservative failure metadata for both thrown and callback-reported execution errors. Known-to-unknown
upgrades remain sticky; running commands do not count as successful repair. Inspection and supported alternatives remain
available for ordinary per-operation failures. Unknown effects remain protected when ordinary repetition limits are off.

The bounded failure-record overflow is an explicit safety stop for the task; it cannot silently forget unresolved effects.
This is separate from the ordinary per-operation allowance. The runtime lane reports **158 tests across eight files**
passing, including these corrections; the integration lane owns its Task adapters and final package/host gates.

Relevant repair can restore an operation while its allowance remains, and a successful terminal retry clears its known
blocker. Once the same-operation allowance is exhausted, there is no trusted host producer that can prove a prerequisite
repair and renew that allowance automatically. Explicit user guidance resetting the attempt is required to retry that
same operation; supported independent alternatives remain available. Unknown effects similarly require reconciliation
under the existing execution and mutation authority. Unrelated reads, writes, and model claims never count as proof of
repair. This remaining repair-after-exhaustion boundary is not presented as implemented automatic recovery.

## Observation limits and validation

The existing reporter/admission suite passed **86/86** tests and real-Task reporting support passed **10/10**. No changes to reporter attribution, fixture choices, or quality
oracles are needed. Timing is not compared: the engine baseline test duration was 32.06 seconds including 28.77 seconds
of collection, preflight 20.09 seconds including 18.43 seconds of collection, and section measurement 0.947 seconds.
Parallel agent activity and warm module/tokenizer caches make these unsuitable for a latency claim. Provider input,
cache, and output usage, time to useful answer, and publication latency are unavailable in these observations.

The real-Task host reporter already lives in
[`proportional-context.test.ts`](../apps/vscode-e2e/src/suite/proportional-context.test.ts). It observes conversation and
known-file lookup with three fresh Tasks per scenario in one host, including real prompt/schema bytes, scoped-read
evidence, and completion. The integration lane owns exact VS Code 1.122.1 validation and any host measurements; this
measurement lane does not substitute its prototype seam for a completed real Task or a host gate.

The initial measurement inspected the `live` provider path in `apps/vscode-e2e/src/suite/index.ts`, which selects
`openai/gpt-4.1` through OpenRouter. Presence-only inspection found `OPENROUTER_API_KEY` and
`apps/vscode-e2e/.env.local` absent. No credential contents, secret stores, or unrelated authentication were inspected;
that offline comparison made no live calls. The subsequent Copilot workflow validation is recorded below. Neither the
fixed scripts nor the candidate-only live run establish comparative strategy, billing, or latency improvements.

## Integrated validation

Final validation on the combined local implementation passed:

- `pnpm --dir src exec vitest run core/agent/__tests__ core/tools/__tests__ core/task/__tests__ core/task-persistence/__tests__ core/prompts --maxWorkers=3`:
  **168 files, 2,371 passed, 8 existing skips**. The first combined run had one provider-retry countdown assertion fail
  while repository compilation ran concurrently. All 165 tests in its owning `Task.spec.ts` then passed in isolation,
  followed by the complete combined command above without competing compilation. No assertion or timeout was weakened.
- `pnpm check-types`: **13/13 tasks passed**. `pnpm lint`: **12/12 tasks passed**.
- Shared types: **276 tests passed**, with package build, lint, and typecheck passing.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`: **2 extension, 2 mode, and 4 VS Code LM tests passed** on
  actual VS Code **1.122.1**, covering activation, mode transitions, tool/result continuity, completed-task follow-up,
  late cancellation/recovery, and provider-error retry.
- `pnpm certify:managed-agents:automated`: **1,744 deterministic test results and 26 matrix rows passed**, followed by
  the real VS Code **1.122.1** nested-worker Apply/discard/verification/projection/navigation scenario (**22.721 seconds**).
  This duration describes the acceptance fixture, not a comparative performance result. The deterministic artifact reports
  `stableDuringRun: true`; its eight separately listed live/manual integration rows remain pending.
- Touched-file formatting and final `git diff --check` passed. Protected CLI/shim trees, manifests, dependencies,
  lockfile, versions, and root agent instructions have no changes.

The tested bundle SHA-256 is `6f99a0f370c45cc91e679bd709d3f312d53c2a148742a7b9519b84308e0beeee`.
Code remained unchanged between the successful combined test run and both host gates; subsequent edits record results
in documentation. Changes are local and uncommitted. NOR-38 is not marked Done: live-model strategy acceptance and the
automatic repair-after-exhaustion boundary described above are not established by these checks.

## Extension-only full-suite and Copilot follow-up

The user requested full tests and live Copilot validation, then explicitly restricted testing to the extension because
the CLI is outdated. The first repository-wide invocation had already completed; its six extension failures were
acquisition/benchmark timeouts and async-readiness assertions under default parallel load. The subsequent repository-wide
retry was stopped at the scope correction. No further CLI or shim tests were run, and their results are excluded here.
The remaining commands target the extension, webview, or VS Code extension-host harness.

All four originally failing extension files passed in isolation: **223 tests**. Read-only review identified a 75 ms
real-filesystem initialization allowance in the queue diagnostic fixture, 1-second readiness waits in Task tests, and
20-second limits around filesystem/Git-heavy tests. No source, assertion, timeout, or production configuration changed.
The complete extension rerun with three workers then passed:

| Surface      | Command / coverage                                                | Result                                                                   |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Extension    | `pnpm --dir src exec vitest run --maxWorkers=3`                   | **8,161 passed, 42 skipped; 538 passing files, 3 skipped files; exit 0** |
| Webview      | Complete `webview-ui` Vitest run from the initial invocation      | **1,560 passed, 2 skipped; 151 files; exit 0**                           |
| Host harness | `pnpm --dir apps/vscode-e2e test:unit`, in both gate preparations | **330 passed, 2 platform-specific skips per invocation; exit 0**         |
| Exact host   | `test:smoke:1221`, in both gate preparations                      | **2 extension + 2 mode + 4 VS Code LM tests per invocation; exit 0**     |

The full extension rerun took 225.49 seconds; this is a test-run duration, not a product performance measurement. Its log
is `%TEMP%/alpha-nor38-extension-full-tests-20260907.log`; the isolated retry log is
`%TEMP%/alpha-nor38-full-tests-focused-20260907.log`. The original default-concurrency failures remain recorded in
`%TEMP%/alpha-nor38-full-tests-20260907.log` and are not relabelled as a passing invocation.

Both live campaigns used the existing dedicated profiles at `F:/alpha-vscode-e2e-runs/20260906/profiles`, normal Windows
Machine + User PATH, exact model ID `gpt-5.6-luna`, and explicit effort `high`. Commands used the existing
`pnpm test:live:gate` entrypoint with fresh campaign IDs, without source edits or builds during workflow execution.
Their receipts are retained under `F:/alpha-vscode-e2e-runs/nor38-live-20260907/`:

- `nor38-reference-current-20260907-01/gate-result.json`: the default two-host matrix exited **2**. Exact **1.122.1**
  authentication and Luna/high selection succeeded, but an uncaught exception originated in bundled Copilot 0.50.1 at
  `copilot/dist/extension.js:1167`. No Alpha task ID or workflow result was created. There is **one infrastructure-blocked
  attempt, zero passing workflows, and 19 cells not run**. Guarded requests, token usage, and cost are unavailable, not
  zero. Numeric host exit was observed, evidence capture and retention completed, and built artifacts stayed unchanged.
- `nor38-current-20260907-01/gate-result.json`: the explicit **1.136.1** run using the installed `Code.exe` exited **0**,
  with **all ten workflows passed**, no failed or blocked attempts, and scope `single-host-only`. The final retention
  audit completed and `artifactsUnchanged` is true. This does not certify live Copilot on the reference host.

The successful campaign ran from **21:39:24.517 to 21:50:42.370 UTC**, excluding preparation, and used **113 guarded
requests**. Input/output token counts and cost are unavailable. It sampled each registered workflow once:

| Workflow                              | Requests | Result |
| ------------------------------------- | -------: | ------ |
| Review, edit, test, commit, follow-up |       16 | Passed |
| Cancellation and resume               |        5 | Passed |
| Dependent multi-turn thread           |       25 | Passed |
| Host reload and continuation          |        5 | Passed |
| Repository bootstrap                  |       12 | Passed |
| Git inspection                        |        6 | Passed |
| Refactoring                           |       15 | Passed |
| Selective commit                      |        9 | Passed |
| Merge conflict                        |       10 | Passed |
| Idempotent local migration            |       10 | Passed |

Independent read-only receipt review verified **11 physical host launches** (reload has two phases), **575 passing check
rows with zero failures**, and all **88 projected artifact hashes**. Every host reported actual 1.136.1 / Luna / high,
numeric exit 0, verified ownership, and complete evidence capture. The final storage audit measured 548,670,791 bytes
across 9,383 entries, within the configured budget.

The successful gate's artifact digest is `53d678d3008a4e391ec341c00adb4f942f87b61fd07fe2faedf0789e99f79c50`.
The extension bundle retains the SHA-256 recorded above. These are candidate workflow acceptance results, not paired
baseline measurements or evidence of a general reduction in calls/tokens. NOR-38's comparative efficiency acceptance,
automatic repair-after-exhaustion boundary, and exact-reference-host live-provider compatibility remain open.

## Reproduce

Run from the repository root. Output variables are optional and should point outside the measured checkout. Preserve the
baseline output before modifying production source; use distinct candidate output filenames and directories.

```powershell
$env:ALPHA_SCOPE_REPORT_DIR = Join-Path $env:TEMP 'alpha-nor38-baseline-scope-20260907'
pnpm --dir src test -- core/agent/__tests__/proportionalScope.integration.spec.ts
$env:ALPHA_NOR36_PREFLIGHT_REPORT = Join-Path $env:TEMP 'alpha-nor38-preflight-baseline-20260907.json'
pnpm --dir src exec vitest run --config ../scripts/benchmarks/nor36-request-preflight.config.ts
$env:ALPHA_NOR38_PROMPT_REPORT = Join-Path $env:TEMP 'alpha-nor38-prompt-baseline-20260907.json'
pnpm --dir src test -- core/prompts/__tests__/nor38-efficiency-measurement.spec.ts
node --test scripts/evals/proportional-scope-report.test.mjs scripts/evals/proportional-scope-compare.test.mjs
```

The existing paired admission helper must remain strict: these modified-tree observations and the intended changed-schema
digests do not satisfy NOR-36's unchanged-request admission contract. Do not weaken admission or manufacture usage/cache
coverage to turn this exploratory evidence into an accepted provider-performance comparison.
