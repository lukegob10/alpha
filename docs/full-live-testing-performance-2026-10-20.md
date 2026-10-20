# Full testing and live-framework performance pass

## Release preparation update

The following closure supersedes the earlier status paragraphs and table, which remain chronological investigation
history. These results belong to the frozen pre-version-bump candidate (`c1fa0ff9` source, `c0e7bcda` runtime), not
automatically to the final 3.2.5 release. The release version, announcement ID, English highlights, and their tests are
being updated together; the GitHub release workflow validates the final committed source and package.

| Surface                           | Latest closed result before the version bump                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic package tests       | 18,011 passed, 34 existing skips, zero failures; fresh root run with no cached test tasks. Workspace lint, types, and Knip passed.                                                                                                          |
| Evaluators                        | 562 offline checks and 25 real PostgreSQL/Redis service checks passed. Owned services and resources were cleaned up.                                                                                                                        |
| Exact VS Code 1.138.0             | Confidence and managed certification passed 22 host runs/59 checks. Each strict matrix separately passed 4,783 cases; these overlapping results are not a unique total. Supplemental exact-host coverage passed another 11 hosts/21 checks. |
| Installed package                 | Seven exact-host runs, eight cases, and two installs passed, including document reopen, preferences, and synthetic storage persistence.                                                                                                     |
| Native UI campaign                | Stages one through four passed. Stage five failed its original history-hover assertion; the cause remains unresolved. Stages six through 21 were not admitted.                                                                              |
| Managed-agent manual acceptance   | All eight integration rows remain pending. Automated certificates do not satisfy them.                                                                                                                                                      |
| Post-policy governed API campaign | No paid task ran. Read-only preflight defects were repaired and tested, but execution was deferred. The unused empty services and their references were released.                                                                           |
| Remote Copilot acceptance         | All 19 framework owners remain pending. Discovery found 19 models with zero requests; the corrected setup was later closed normally for release preparation without an actual completion probe. The signed-in profile is preserved.         |
| Packaging                         | The pre-bump 3.2.4 VSIX (`109ab345`) passed contents and canonical source checks. A fresh 3.2.5 package and release evidence are required.                                                                                                  |

The completed run receipts remain under `artifacts/testing-2026-10-20/`: the
`deterministic/after-presentation-policy-20261020093330508-a7b659` broad run,
`evaluator-policy-20261020T095002487-63b7be`, `presentation-policy/exact-supplemental-47e8d914`,
`confidence-package-renewal-20261020/run-20261020101356329-dd5df419`,
`installed-renewal-20261020/runs/installed-renewal-20261020-6a9a019a-5f409537`, and
`native-renewal-20261020`. The final setup cleanup is recorded in
`live-final/policy-v3/setup-only-reopen/cleanup-final.json`; unused service teardown is recorded in
`post-presentation-policy-t1/service-release-and-cleanup.json`. Earlier package hashes and failed attempts are retained
without relabeling their provenance.

## Investigation history

Date: October 20, 2026. Mode: operational hardening. The requested end state is a complete run of the applicable
deterministic and configured live frameworks, concrete findings repaired at their owning boundaries, and measured
improvements to extension responsiveness. This document is a working ledger until final source-bound evidence is
recorded; an inventory or successful unit test is not a live acceptance result.

Latest closed results: the fresh [broad run][broad] passed 17,961 package cases with 34 existing skips and its static
gates; the renewed [offline evaluator run][offline] passed 529 cases. Literal [core confidence][confidence] passed
18 host phases/55 cases and 4,766 strict cases; literal [automated managed certification][managed] separately passed
four host phases/four cases and its 4,766 strict cases. Both retained 26 deterministic passing rows and eight pending
manual integration rows. These overlapping checks must not be added into a claimed unique total.

The [native campaign][native-second] has four of 21 stages passed across two explicitly composed runs. Stage five
stopped on a 15-second history-hover assertion; its cause is undetermined, and [owned cleanup][history-cleanup] is
complete. Stages six through 21 remain unadmitted. Installed-artifact testing has never executed. All 19 remote
Copilot framework owners remain pending because no corrected actual-completion setup probe has succeeded.

The governed API candidate produced eight valid terminal observations: four passed and four `outcome_failed`.
Its CLI retained database/Redis handles after final output and required an owned-process stop, so this was not a
complete framework pass. The CLI cleanup repair has seven passing model-free regressions and the 529-case offline
renewal. Separately, the observed $0.3085571 covers root/child task-event usage only; unmetered automatic titles and
possibly later reasoning-synopsis usage leave total provider charges unknown. The governed
`presentationModelCalls: false` opt-out/capability repair for both presentation paths has passed focused regressions
and independent review. Fresh broad, database, exact-host, package and live validation remain pending; no paid retry
has run. The [policy report](testing-presentation-model-policy-2026-10-20.md) records the runtime contract and Codex
comparison. See [candidate closure][candidate] and [CLI repair][cli-repair].

The append-only run receipts under `artifacts/testing-2026-10-20/` retain each attempt. The mutable
`root-session-progress.json` records orchestration status; individual command receipts, source hashes, and test reports
establish results. Preparation is not execution, and an earlier passing source does not certify a later repair.

Results below are bound to their actual historical source and build fingerprints. The last closed fixture-validation
source before this ledger edit and the in-progress production repair was whole-source
`339355e0ee8d3e84b6055d52420fe251625832ccad13e775b13c7b0207d7fa43`, with the runtime-plus-E2E scope
`b993f67b127eb5db8729aa87a89a758b44a1b7add089e003f9ab4edeaa9574c2`. These are not a claim about source after
subsequent edits. Earlier `7719f4e1`, `7330e4b0`, `3e1dacb4`, `8e008255` and `97066a56` receipts remain historical.
Existing changes, historical evidence, the signed-in profile, and user data are preserved. Current Codex CLI source is
pinned to `18795fc12571a3530d3e4ac18366e41cd2f57448`, retrieved October 20; see the
[current source comparison](codex-live-testing-reference-2026-10-20.md). Alpha retains its execution protections and
additional tools. Codex's sandbox architecture remains outside the alignment target.

## Confirmed findings and changes

| Finding                                                                | Severity and owning boundary                                         | Correction and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Streaming one chat projected every registered chat                     | Medium / should-fix; `TaskSessionRegistry` and incremental publisher | Share the existing uncached projector with a per-task lookup. At 50 chats, model and usage reads per update fall from 50 each to one each. Ten new regressions, 230 focused passes and six existing skips; no metadata/lifecycle or payload change.                                                                                                                                                                                                                                                                                                    |
| Completed file edits repeatedly searched unrelated history             | Medium / should-fix; file-change presentation adapter                | Index prior unmatched previews by the existing normalized path, retaining nearest-compatible matching and order. For 1,000 completed edits, candidate reads fall from 501,500 to 2,000; full outputs match the baseline. 110 affected-surface cases pass.                                                                                                                                                                                                                                                                                              |
| Setup could report readiness without a real completion                 | High / must-fix; VS Code live-test adapter                           | Exact host 1.138.0 implements `canSendRequest()` as a constant `true`. Explicit setup now requires one completed request through Alpha's actual provider with the selected model identity. Failed checks keep setup open. Three intended failing regressions established before repair; 53 focused runner cases pass. Real consent/completion validation is pending below.                                                                                                                                                                             |
| Governed local benchmarks launched a PATH editor                       | High / must-fix; evaluator VS Code adapter                           | The previous launcher ignored the explicit reference binary/profile and could open an installed editor before rejecting its IPC identity. The governed local path now requires an owned disposable profile, native executable, current build identity, ancestry, and isolated IPC endpoint before paid dispatch. The affected boundary passed 162 cases; all eight later candidate observations matched the selected exact host and packaged entrypoint. The candidate's CLI finalization still failed. Legacy/container paths retain their contracts. |
| Governed attempts could continue after unknown spend or failed startup | High / must-fix; evaluator dispatch and cost accounting              | Stop on infrastructure/lifecycle failures and unavailable actual cost. Send the run's configured prices through existing model metadata, narrow the existing cost limit, and cancel once at the observed threshold. Six financial scheduling regressions failed before repair. The admission budget cannot prevent one in-flight response or late accounting from overshooting; see the benchmark adapter report.                                                                                                                                      |
| Focused test inventory depended on a fixed repository filename list    | Low / should-fix; tooling fixture                                    | Replace the stale repository-dependent expected list with the existing isolated inventory fixture, retaining nested matching and generated/dependency exclusion assertions. Intended red/green and all 261 tooling cases pass.                                                                                                                                                                                                                                                                                                                         |
| Search ranking fixture renamed a directory unnecessarily               | Low / should-fix; Windows test fixture                               | A pristine full run encountered an intermittent setup-only EPERM before any search API ran. Seed the same canonical status directly instead of renaming its directory. Search assertions and production code are unchanged; the focused suite passed 18 cases with one existing benchmark skip. The complete source-stability rerun is retained separately.                                                                                                                                                                                            |
| Benchmark events were not scoped to their root and child identities    | High / must-fix; evaluator IPC adapter                               | Capture the first root ID before asynchronous effects; aggregate cumulative usage and tool counts per runtime ID. Child completion cannot finish the root. Root context remains distinct from summed usage. Controlled root/child/restart tests pass.                                                                                                                                                                                                                                                                                                  |
| Async event writes could escape cleanup or overwrite newer usage       | High / must-fix; evaluator IPC effect ownership                      | The synchronous EventEmitter now feeds one bounded ordered async-effect lane. Accepted writes drain before terminal success; write failures prevent further admission and retain cleanup evidence. Controlled barriers reproduce stale-write, rejection, and stalled-effect cases.                                                                                                                                                                                                                                                                     |
| Cancelling a benchmark task did not stop later admissions              | High / must-fix; governed campaign admission                         | Forward the existing execution outcome after cleanup and reject fresh or resumed admission after cancellation, infrastructure/grader errors, safety failure, or unknown cost. Known-spend ordinary task failures remain distinct. The two-invocation masked-cancellation regression passes without rewriting saved evidence.                                                                                                                                                                                                                           |
| Stop could address the visible chat instead of the captured task       | High / must-fix; extension IPC adapter                               | Add optional validated task-targeted cancellation and an advertised capability. Explicit IDs use existing lifecycle ownership; unknown IDs never fall back to another chat. Governed paid dispatch rejects missing capability. Types: 655 passes; IPC: 35; API/queue: 26. Legacy commands remain compatible.                                                                                                                                                                                                                                           |
| Local benchmark grading lacked the required transcript                 | High / must-fix; local evaluation evidence adapter                   | After the owned host exits, retain history from the verified local profile's globalStorage task root, with ownership and path checks. Container collection retains its existing default. Success, failure, cancellation, traversal, and cleanup cases pass; all eight candidate transcripts were nonempty and all 104 recorded artifacts retained matching sizes.                                                                                                                                                                                      |
| Completed benchmark CLI retained service sockets                       | High / must-fix; evaluator CLI resource owner                        | The candidate reached all eight terminal results and final exports, but PostgreSQL/Redis handles kept the CLI alive. The owned CLI was stopped without rewriting results. The real subprocess/socket regression failed before repair; seven cases pass after both existing disconnect helpers are awaited. Full offline renewal passed 529 cases. [Repair receipt][cli-repair].                                                                                                                                                                        |
| Request-input driver raced normal rendered UI readiness                | Test-harness defect; native request-input driver                     | The bounded driver repair has 11 passing focused cases, followed by 696 runner cases and literal smoke on 13 hosts/44 cases. Exact E2E-only source deltas and original product-byte preservation are retained in the [driver handoff][driver-outer].                                                                                                                                                                                                                                                                                                   |
| Reasoning fixture counted presentation-title HTTP as an agent turn     | Test-fixture defect; reasoning request classification                | The actual product completed two agent turns, while a title call made the fixture count three HTTP requests. The fixture now distinguishes task and title requests. Five focused cases and 701 runner cases pass, with two existing platform exclusions. [Fixture validation][fixture-validation].                                                                                                                                                                                                                                                     |
| History hover never reached its required state                         | Open; native history interaction boundary                            | Stage five retained visible history content but the existing 15-second `:hover` predicate failed. Geometry, input routing and actual hover behavior remain undistinguished; no bypass, longer timeout or successful retry is claimed. [Investigation][history-investigation] and [offline cleanup][history-cleanup].                                                                                                                                                                                                                                   |
| Governed dispatch still admitted unmetered presentation calls          | In progress; shared title/synopsis policy and capability boundary    | The recorded task/child cost does not cover automatic titles or any synopsis finishing after the terminal snapshot. The `presentationModelCalls: false` contract for both paths is being repaired. It has no completed validation, new package or paid rerun at this checkpoint.                                                                                                                                                                                                                                                                       |

Strict certification additionally exposed the Windows linked-administration startup defect described below. Its shared
adapter repair has 55 passing affected cases. Live orchestration review found that the problem-solving campaign could
dispatch another prompt arm, repetition, or task after terminal provider/infrastructure/cancellation failures or a
`grader_error`. Six actual-boundary regressions reproduce that behavior before the repair. The existing post-evidence
stop guard now prevents automatic admission; ordinary graded outcomes, task assertions, and per-task request budgets
remain observations that can continue. See the [benchmark adapter report](benchmark-exact-host-launch-2026-10-20.md).

The performance changes remove repeated work rather than adding caches or another runtime. Their deterministic
operation counts are primary evidence. Synthetic CPU timings do not establish model latency, paint latency, or a
general user-perceived speedup. See the [runtime measurements](testing-runtime-performance-2026-10-20.md) and
[file-change measurements](file-change-projection-performance-2026-10-20.md).

## Framework coverage ledger

The [source-verified framework inventory](full-test-framework-inventory-2026-10-20.md) records commands, cases,
prerequisites, overlap, and full-sample versus prolonged-soak distinctions. The final aggregate must retain exact
commands, outcomes, source fingerprints, model/profile identities, failure history, and evidence hashes.

| Track                                              | Current verified state                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All-workspace lint, typechecks, unused-file gate   | Literal `pnpm lint:all` passed nine tasks (seven cached), `pnpm check-types:all` passed ten (eight cached), and `pnpm knip` exited zero after the worktree repair. These are source-bound historical checks, not validation of the in-progress presentation-policy repair. [Broad receipt][broad].                                                                                                                                  |
| Full extension/dependency/UI tests                 | Literal forced `pnpm test --concurrency=1 --env-mode=loose --force` passed all seven package test tasks freshly: 17,961 passed, zero failed, 34 existing skips. Extension: 14,608/32 skips; webview: 2,435/2; core: 215; types: 655; IPC: 35; telemetry: seven; build: six. Whole source `7330e4b0` is historical. No literal `pnpm test:all` pass is claimed. [Broad receipt][broad].                                              |
| Developer tooling                                  | 261 cases passed with zero failures/skips. [Tooling report][tooling].                                                                                                                                                                                                                                                                                                                                                               |
| Service-free evaluator aggregate                   | Latest literal `pnpm test:evals:offline` passed 529/529: 504 unit, 20 contract and five certification cases. Source, dependency and generated-output fingerprints were stable. Earlier 513- and 522-case receipts remain retained. This renewal includes the CLI teardown repair. [Offline receipt][offline].                                                                                                                       |
| Real PostgreSQL and Redis                          | Earlier unchanged-framework coverage passed 22 database cases and one Redis case against fresh owned containers. No later final-source service rerun is implied. [Service receipt][services].                                                                                                                                                                                                                                       |
| Real Docker infrastructure                         | Earlier unchanged-framework coverage passed ten cases; exact owned containers were removed. This remains composed coverage alongside offline/service phases, not a literal full evaluator or root `test:all` invocation. [Infrastructure receipt][services].                                                                                                                                                                        |
| Compiled E2E runner units                          | Latest closed fixture source passed 701 cases with two existing platform skips. Earlier 685- and 696-case reports remain historical. This is full existing compiled-owner coverage, distinct from the literal smoke wrapper. [Runner receipt][runner-units].                                                                                                                                                                        |
| Exact 1.138 confidence and managed certification   | Literal `pnpm test:core:confidence` passed 18 hosts/55 cases plus strict 4,766/4,766. Literal `pnpm certify:managed-agents:automated` separately passed four hosts/four cases plus another strict 4,766/4,766. Both certificates report 26 deterministic rows passed/eight manual rows pending. [Confidence][confidence], [managed certification][managed].                                                                         |
| Literal exact smoke and earlier additional hosts   | The later literal `test:smoke:1380` passed 13 hosts/44 cases/zero pending on development bundle `36be9a7d`; canonical production restoration subsequently restored `3cc0a973` before native runs. Earlier extended 5/13, cross-task 1/3, checkpoint 1/1, navigation 1/1 and repository outcomes 3/3 remain separate historical receipts. [Smoke][smoke], [mode closure][driver-outer].                                              |
| Packaging                                          | Literal bundle/VSIX/standard verifier completed for historical `bin/alpha-3.2.4.vsix`, SHA256 `1cb26b767ee925aedac92f61dbc7a739a081e8780440fc2b496af782875a9779`. Corrected canonical projection proves 1,813 mapped entries and all 788 shipped webview files. The original supplemental raw-tree count failure remains retained. No package for the in-progress production repair is claimed. [Package closure][package-closure]. |
| Native UI and local acceptance drivers             | Four of 21 stages passed through explicit composition: first-run composer/request-input, then repaired reasoning/file-review. History stage five is blocked; six through 21 were not admitted. This does not establish all native UIs, local recovery drivers or the two performance stages. [First run][native-first], [continuation][native-second].                                                                              |
| Installed artifact and persistence                 | Seven hosts/eight cases/two same-VSIX installs were prepared but never executed. Read-only admission matched an earlier outer handoff; later fixture and production edits make that evidence historical. No installed identity, document reopen, preference reinstall or synthetic-storage persistence pass is claimed. [Historical admission][installed-admission].                                                                |
| Offline performance/probe owners                   | All nine existing workloads completed with zero real provider requests or VS Code hosts. Actual installed Node/Vitest/tsx owners ran directly; unavailable literal `pnpm exec` wrappers are not claimed. The optional V8 threshold instrumentation provider is absent and was not installed. [Probe result][probes].                                                                                                                |
| Model-free benchmark validation/fixtures/authoring | Two suites/48 tasks validated, 28 visible initial fixtures checked, and 48 authoring records passed with zero issues/duplicates. Private grader contents or expected answers were not inspected for outcome-specific fixes. [Admission receipt][benchmark-admission].                                                                                                                                                               |
| Governed API benchmark                             | Candidate T1 admitted all eight selected tasks once at concurrency one on exact 1.138.0, `gpt-5.6-luna`/high: eight terminal valid observations, four passed/four ordinary `outcome_failed`. The original CLI finalization failed and required an owned stop. No full framework or candidate-acceptance pass is claimed. [Candidate closure][candidate].                                                                            |
| Live Copilot suites and campaigns                  | All 19 prepared remote owners/138 planned observations remain pending. Initial readiness timed out before any suite case; corrected setup has no successful actual-completion probe. Scripted/native/API evidence cannot satisfy these rows. [Remote plan][remote-plan].                                                                                                                                                            |

The source chain is explicit: the broad `7330e4b0` source was followed by one benchmark-fixture-only repair to
`3e1dacb4`; that source owns the passing confidence/certificate/package receipts. The evaluator CLI three-path repair
produced `8e008255`, followed by the two-path E2E readiness-driver repair (`97066a56`) and three-path reasoning-fixture
repair (`339355e0`). The original `12106610` runtime fingerprint includes E2E code, so it cannot be called current
after the latter repairs; the last closed same-scope fingerprint is `b993f67b`. The
[driver handoff][driver-outer] and [fixture handoff][fixture-outer] retain the exact deltas, fresh harness inventories,
and historical gates separately. The next production freeze must account for this ledger edit and the new product
repair rather than relabeling an old fingerprint.

The development-smoke/production-restoration closure also distinguishes raw build files from shipped payload.
Only the excluded 75-byte `src/webview-ui/build/sourcemap-manifest.json` timestamp marker differed in the raw webview
tree; its exact before/after digests and unchanged generator are retained. All 788 shipped webview files and the
mapped runtime payload matched the original package. That narrow historical exception is not permission for other
byte drift or a claim that development smoke used packaged production bytes.

The nine offline owners exercised NOR36 request preflight (nine deterministic fake-provider calls), activation
environment, 10,000-entry task history, welcome and Markdown startup graphs, code indexing, scoped reads, HTML worker
limits, and file-change projection. Their original workload sizes, samples, warm/cold conditions and historical
comparators are retained in the [probe result][probes]. This is one bounded pass per existing owner, not a soak or a
general user-perceived speed claim. Small/large supported HTML fixtures were accepted; the deliberately deep and
malformed fixtures returned bounded `size` errors. A completed measurement process is not universal parsing success,
and later samples of rejected jobs do not establish worker reuse. The raw error category does not distinguish every
structural/resource/deadline subcause. Optional V8 instrumentation has no threshold result because its compatible
provider is not installed.

## Live admission and persistence

The dedicated profile root is `F:/alpha-e2e/profiles`; the runner resolves the exact 1.138.0 stores without copying
credentials. Initial live admission verified the owned normal host, saved account/catalog access, selected
`gpt-6-luna`, and applied reasoning effort `max`. The single readiness attempt then remained in request admission until
its 60-second deadline, with no text or usage. `requests: 1` means Alpha called the host once; it is not proof that a
backend accepted or billed the request. Zero suite cases executed.

The retained initial attempt is under
`F:/alpha-e2e/live-full-20261020-b1adf304/artifacts/live-quality-20261020-b1adf304`.
Exact-host source inspection found that catalog access cannot establish consent on 1.138.0. The corrected owned setup
window remained idle without Continue or any probe. It was closed through the owned window's normal close operation,
with process exit, complete retained evidence and lease release verified. Reopening is held behind the new production
freeze and predecessor lanes. It will use the same persistent profile, awaiting explicit Continue, any native Allow
prompt, and Finish only after an actual successful completion. This is a native adapter/setup issue, not evidence that Alpha needs a new
execution engine. The saved launcher's three stale host/path fields were atomically refreshed to the verified 1.138.0
host and profile. Its helper script was byte-identical, and no authentication store was copied or changed. That metadata
repair does not establish successful completion or consent.

## Governed API attempts and accounting limits

The first API campaign used immutable historical bundle
`d78cadfff2f1d155744b35552eccd27e79abba2dbe8ffd1e9dad983265345eb4` and explicitly did not claim to test the
performance candidate. Exact host, fresh profiles, IPC ancestry and entrypoint/manifest identities were verified before
dispatch. All selected prices were configured estimates, not a provider invoice guarantee.

The canonical controller had no campaign cancellation control. Task-only cancellation could not prevent the next
admission. After four admissions, the exact captured evaluator process was stopped; every captured extension host and
owned profile process was then verified absent. The isolated services were exported through a safe allowlist and
removed. Existing rows were not rewritten to conceal interruption.

Those historical three terminal attempts recorded configured task-event cost totaling $0.105494. The fourth retained
$0.0245576 in partial observed task usage, explicitly unreconciled. These are not complete auxiliary or billed totals.
Neither a zero-cost nor a final billed-total claim follows. The raw
failure and safe status/evidence export are retained under
`artifacts/testing-2026-10-20/benchmark-host/pre-performance-baseline-2026-10-20T05-26-15-709Z/`.

The later [candidate run][candidate] used the original production entrypoint `3cc0a973` and manifest `766f0f5b`,
matching the historical verified VSIX `1cb26b76`. Its one eight-task T1 selection ran at concurrency one with one
iteration on exact VS Code 1.138.0, OpenAI `gpt-5.6-luna`, reasoning effort high. All eight attempts ended with valid
evidence and nonempty transcripts; all 104 recorded artifacts retained matching sizes. Four task outcomes passed and
four were `outcome_failed`. Aggregate result metadata supports ordinary incorrect or incomplete solutions for the
latter; it does not establish a hidden semantic cause or prove that every harness path is correct. No hidden expected
answers were inspected and no benchmark-specific solution patch or paid retry was made.

After all eight results and final summary/exports, the CLI still retained PostgreSQL/Redis sockets. The exact captured
completed CLI was revalidated and stopped under root authorization; its original exit `4294967295`,
`stopped-or-incomplete`/finalization failure and task outcomes remain intact. The existing CLI boundary now awaits
both disconnect helpers on success and failure, attempts both when one rejects, and preserves the original command
error. A real subprocess/socket stand-in reproduced the missing natural exit before repair; [seven lifecycle
regressions][cli-repair] pass afterward. The [529-case offline renewal][offline] is complete. This repair has not been
used to relabel the original paid campaign as naturally completed.

**Cost qualification:** $0.3085571 is the observed configured estimate from root/child `TaskEvent` usage for these eight
tasks. The receipt's empty unreconciled-task list applies to that scope only. Automatic task titles were not metered
there, and a reasoning synopsis may finish after the terminal snapshot. Auxiliary cost and actual total provider
charges are **unknown**. The configured $0.48 reservation/$0.50 admission budget and per-task thresholds are not proof
that all provider spend stayed within those amounts. The production `presentationModelCalls: false` opt-out and
capability enforcement for titles and synopses are in progress; no new validation or paid rerun is claimed. The
original [candidate accounting receipt][candidate] is preserved with this additive qualification.

Source review against the pinned Codex thread/turn ownership contract also established that Stop must address the
captured task, regardless of visible navigation or child activity. The backward-compatible IPC adapter now accepts an
optional explicit task ID and a typed handshake capability. Older handshakes remain readable; governed execution must
reject absent capability before paid dispatch, because an old schema silently discards unknown optional command data.

## Windows worktree finding from strict certification

The first literal core-confidence attempt retained 4,761 passing certification cases, one Git failure, and one conditional
Windows alias skip. Its 26 deterministic rows were ten passing and sixteen failing because the strict track requirements
propagate those incomplete tracks; all eight manual rows remain pending. All 18 real host phases passed their 55 cases.
The failed certificate, track JSON, completion-idle capture, source fingerprints, and cleanup receipts are preserved under
`artifacts/testing-2026-10-20/confidence-package-final/run-20261020060720058-6ca28acd/`.

The path defect is not confined to a test's direct Git call. Existing public `create`/`capture`/reload behavior reaches
`read-tree` through the shared adapter. The short-path decision inspected the checkout and explicit paths before
resolving the longer linked administration directory. A 157-character checkout referenced a 221-character administration
path. A separate unchanged-source focused run reproduces that failure; its eleven other tests were filtered out, not
accepted as passing. The additional boundary case checks durable proposal retention after parent checkout removal and
reload.

Installed Git is `2.43.0.windows.1`. Its [startup guard](https://github.com/git-for-windows/git/blob/v2.43.0.windows.1/setup.c#L849-L860)
uses `strlen` with `PATH_MAX - 40`; `core.longpaths` cannot bypass that earlier check. Git for Windows passes UTF-8
environment/argument strings, so JavaScript string length also misses some non-ASCII paths. The repair addresses this
same startup invariant across the existing adapter, retaining physical registration and ownership checks. Pinned
[Codex trust handling](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/git-utils/src/trust.rs#L139)
checks physical administration, registered checkout backlinks, and common-directory ownership. Alpha's temporary
invocation aliases must preserve those facts and durable proposals. These sources were inspected October 20, 2026.

The alias skip has a different cause: the same assertion passed in the complete extension run, while the confidence
launch forced a canonical F-drive temporary directory with no alternate short spelling. A fresh, owned native C-drive
temporary directory exposes a genuine short alias; the test's exact asynchronous realpath preconditions passed without
running a suite. The probe and child were removed, with evidence retained in
`artifacts/testing-2026-10-20/deterministic/windows-short-temp-probe.json`. The subsequent broad and confidence runs
used the verified native short TEMP/TMP style and executed the owning assertions successfully. No alias configuration
or test assertion was weakened.

The first actual C-native preflight passed 14 of 15 owning-suite cases, including both new Git boundary regressions.
The storage-junction characterization failed at its first filesystem directory creation, before artifact ownership or
Git effects. A separate native `CreateDirectoryW` probe reproduced failure through even short canonical junction paths
on this environment's C volume, while direct target writes succeeded. This does not justify a production Git or
filesystem workaround. The characterization retains all lifecycle and junction-preservation assertions while placing
its exclusive owned storage fixture on the supported workspace filesystem. Failed receipts and cleanup evidence remain
under `deterministic/after-worktree-20261020064018528-2cca5e/` and `worktree-path-repro/`.

The successful retry's [broad receipt][broad] records 15/15 owning non-Git cases, followed by all seven fresh package
suites and the static tail. The later [confidence][confidence] and [managed][managed] receipts supersede the first
failed strict attempt for their exact source: each ran all 4,766 strict cases with zero skips and retained every
manual integration row as pending. The original failed certificate and unsupported-junction attempt remain evidence
of the failures rather than current status.

## Execution conditions and failed attempts

- The first broad unit invocation used Turbo's strict environment, which discarded `VITEST_MAX_WORKERS=3` and spawned
  15 extension workers. Its verified owned tree was stopped and reaped. The corrected command uses loose environment
  forwarding and concurrency one, with an observed maximum of three Vitest workers.
- Evaluator Git/fixture operations timed out during that contention. The retained failures are followed by 82 focused
  passes and the complete passing offline rerun under bounded load; no production or test timeouts were relaxed.
- The first compiled-unit reporter invocation omitted its required repository-root setting and failed closed. No
  matching Node fixture remained. The corrected invocation supplies both receipt settings; no reporter behavior was
  changed to conceal the invalid invocation.
- A later pristine extension run passed 14,600 cases but failed during the search fixture's directory rename, before
  exercising production behavior. Its complete failure report is preserved. After direct seeding, the complete
  extension suite passed against a stable source fingerprint. The existing optional 1,000-ticket benchmark also passed
  once: 1,000 Markdown reads across five queries; the 1,913.45 ms case includes fixture setup and is not a before/after
  improvement measurement.
- Generated reports and measurement fixtures live under the ignored `artifacts/testing-2026-10-20/` directory. No
  prompts, credentials, or private benchmark contents belong in the aggregate summary.
- The first extended wrapper stopped in fixture setup because an explicitly persistent workspace lacked the temporary
  ownership marker its ancestor-instruction test requires. No behavioral assertion ran. The corrected invocation uses
  ordinary disposable mode, with the assertion unchanged. Successful temporary raw artifacts follow the existing
  cleanup contract; stdout and normal receipts are retained separately.
- Generated nested live status receipts are ignored under `artifacts/certification/live-full-*/`. No tracked source is
  hidden; transient readiness updates must not alter the harness's whole-source identity.
- Offline probe launch attempts stopped before workload admission on an unsupported pnpm CLI flag and then legacy
  isolated-HOME dependency metadata. No dependency install followed. The authorized corrected adapter invoked the
  actual project-installed Node/Vitest/tsx entrypoints with the original owner arguments and recorded their identities;
  no literal `pnpm exec` wrapper pass is claimed. The history benchmark then reproduced its stale virtual import/path
  fixture; its one-file adapter repair retains fail-on-use locking, known fixture IDs, and the original 10,000-entry
  workload/parity assertions. The [complete nine-owner pass][probes] retains each stopped attempt.
- The first fresh request-input campaign stopped at a real UI-readiness race. Eleven focused driver regressions passed
  after repair. Its subsequent reasoning stage exposed a separate fixture-only count error: two task calls plus a
  presentation title were counted as three agent turns. The five-case classifier regression and 701-case runner renewal
  passed after repair. These fixes do not erase either original failure or the later unresolved history-hover failure.
- The literal smoke wrapper's normal development bundle differed from the historical minified production package.
  Its 13-host/44-case pass remains labeled with `36be9a7d`. A subsequent canonical `pnpm --dir src bundle --production`
  restored all 1,813 mapped shipped bytes to the original package before native execution, without rewriting the VSIX.
  The excluded timestamp marker is separately qualified above; the original failed byte check is retained in the
  [mode-closure chain][driver-outer].

## Closure requirements

- **Repaired with source-bound evidence:** the two repeated-work paths, isolated tooling expectation, Windows
  worktree/fixture boundaries, actual-completion setup guard, exact local benchmark launch, per-ID accounting, bounded
  async effects, targeted IPC cancellation, terminal admission, transcript retention and CLI resource cleanup. Native
  readiness-driver and reasoning-request fixture repairs have their own focused/full-runner receipts. These statements
  do not certify the production repair now in progress.
- **In progress:** governed suppression/capability enforcement for both task-title and reasoning-synopsis model calls.
  Task/child cost receipts cannot establish total provider charges while auxiliary usage is unmetered. Fresh owning
  regressions, package/source fingerprints and applicable live/installed gates are still required after that repair.
- **Open or unrun:** history stage five has no established cause or passing retry; native stages six through 21,
  installed seven-host/eight-case persistence testing, successful corrected Copilot completion, and all 19 remote
  frameworks remain pending. Concrete findings must be reproduced at their owning boundary and compared with current
  Codex behavior before repair. Model-specific success cannot erase an earlier failure.
- **Not verified:** prolonged soak/repeatability, remote-provider cancellation and cost exhaustion beyond exercised
  cases, and genuine human-delegation provenance across reload. All eight manual certificate rows remain pending until
  their whole requirement has evidence. Component or scripted passes cannot silently complete them.
- **Out of scope:** sandbox replacement, weakened approvals, a parallel runtime, copying upstream prompts/source,
  release-version changes, unrelated historical data cleanup, and claims about every provider or installed-user cohort.

[broad]: ../artifacts/testing-2026-10-20/deterministic/after-worktree-20261020065123029-36a3a7/composed-validation-summary.json
[tooling]: ../artifacts/testing-2026-10-20/tooling-evals/tooling-final.node.json
[offline]: ../artifacts/testing-2026-10-20/tooling-evals/evals-offline-cli-teardown-final-source-receipt.json
[services]: ../artifacts/testing-2026-10-20/tooling-evals/isolated-services-receipt.json
[benchmark-admission]: ../artifacts/testing-2026-10-20/tooling-evals/benchmark-admission-receipt.json
[confidence]: ../artifacts/testing-2026-10-20/confidence-package-final/run-20261020072443116-fd3710c2/confidence/receipt.json
[managed]: ../artifacts/testing-2026-10-20/confidence-package-final/run-20261020072443116-fd3710c2/managed-certification/receipt.json
[package-closure]: ../artifacts/testing-2026-10-20/confidence-package-final/run-20261020072443116-fd3710c2/package-verification/closure-receipt.json
[smoke]: ../artifacts/testing-2026-10-20/native-final/driver-validation-08e70f2d/literal-smoke-1380/receipt.json
[driver-outer]: ../artifacts/testing-2026-10-20/native-final/driver-production-closure-5bc9ca33/outer-test-harness-handoff-complete.json
[fixture-validation]: ../artifacts/testing-2026-10-20/native-final/reasoning-fixture-validation-3dd02122/summary.json
[fixture-outer]: ../artifacts/testing-2026-10-20/native-final/reasoning-fixture-validation-3dd02122/outer-test-harness-handoff.json
[runner-units]: ../artifacts/testing-2026-10-20/native-final/reasoning-fixture-validation-3dd02122/e2e-runner-units/receipt.json
[native-first]: ../artifacts/testing-2026-10-20/native-final/summary-full-final-native-20261020-4ea219a7.json
[native-second]: ../artifacts/testing-2026-10-20/native-final/summary-full-final-native-20261020-145fd15b.json
[history-investigation]: ../artifacts/testing-2026-10-20/native-final/history-hover-investigation.json
[history-cleanup]: ../artifacts/testing-2026-10-20/native-final/history-offline-cleanup.json
[installed-admission]: ../artifacts/testing-2026-10-20/installed-final/prepare/admission-1792486647226-098724ca.json
[probes]: ../artifacts/testing-2026-10-20/offline-probes-final/run-20261020071934357-457bedea/final-summary.json
[candidate]: ../artifacts/testing-2026-10-20/candidate-t1/run-3bdeb78c-4623-4987-8c13-d530a4565aa6/candidate-closure.json
[cli-repair]: ../artifacts/testing-2026-10-20/candidate-t1/cli-teardown/repair-validation-freeze.json
[remote-plan]: ../artifacts/testing-2026-10-20/live-final/plan.json
