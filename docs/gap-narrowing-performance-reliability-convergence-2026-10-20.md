# Focused performance, reliability, and Codex convergence improvements

Implementation pass begun October 20, 2026, America/New_York. Mode: correctness cleanup, including measured bounded
performance improvements and specific behavioral convergence fixes. The objective is to close high-impact verified
boundaries from the directory review, not to rewrite the runtime or clear every historical finding.

## Reference and existing work

- Current Codex source/test reference:
  [`c7234c1174b27d9c55199fba0d546dc27d1b0415`](https://github.com/openai/codex/tree/c7234c1174b27d9c55199fba0d546dc27d1b0415),
  resolved from upstream HEAD at the beginning of this pass. This follows the original review's `d571eaf1` pin.
- Alpha source HEAD at start: `f67f53ee1f53929669cdda523d6cbd509ea0bfd1`, plus the existing working tree.
- Existing startup, Ticket-search, compaction, provider, shared-type, and UI work was captured before implementation.
  It must be preserved when a change touches the same file. The original review's approximately 88% convergence
  estimate and 83/100 quality judgment describe that earlier snapshot; this pass does not automatically rescore them.
- Sandbox architecture is excluded. Alpha's execution protections, native extension tools, skills, Tickets, HTML
  preview, scheduling, and shared kernel remain required. No Rust runtime or wholesale upstream prompt copy is added.
- Fourteen agents implemented bounded workstreams with explicit file ownership. Shared integration edits had one
  owner; the coordinating agent reviewed the resulting diff and ran cross-surface validation.
- Node `24.21.0`, pnpm `11.24.0`, Windows. Installs/upgrades, releases, and commits are outside this implementation pass.

## Convergence against the original rubric

The bounded reassessment is **88.5/98, approximately 90.3%**, versus the original **86.5/98, 88.3%**. It carries forward
the original unchanged criteria and upgrades only four repaired partial criteria after source/test review:

| Existing criterion                    | Before | After | Basis                                                                                              |
| ------------------------------------- | ------ | ----- | -------------------------------------------------------------------------------------------------- |
| Provider final-content reconciliation | 0.5    | 1     | Missing suffixes reconciled once; contradictory final content fails instead of silently succeeding |
| Provider usage accounting             | 0.5    | 1     | Cache-write counters preserved across streaming/nonstreaming and success/error terminals           |
| Persisted history identity/status     | 0.5    | 1     | Journal-backed failed/interrupted boundaries, cold caller and pagination coverage                  |
| Typed lifecycle terminal projection   | 0.5    | 1     | Generic terminal payload status preserved; removal/re-admission and stale-delivery coverage        |

The respective provider, persistence, and UI reviewers checked these exact original criteria against the implemented
code and evidence. Their domain totals become 9.5/10, 9.5/10, and 8.5/9. No criteria or extension-only capabilities were
added to inflate the denominator. Unchanged domains were not freshly re-audited; the upstream delta between the two
pins boxes rollout payloads without changing their serialized representation.

This supports the requested **90%-ish behavioral target** under this sampled rubric. It is not a task-success rate,
percentage of upstream source implemented, release certification, or proof that all high-priority defects are gone.
The old 83/100 clean-code grade is historical; this pass reports concrete closures and verification instead of inventing
a new aggregate quality grade. The remaining risks below still matter individually.

## Bounded workstreams

The linked reports retain the failing reproductions, source comparison, commands, test counts, compatibility decisions,
and limits. Their focused counts overlap with integration checks and must not be added as unique coverage.

| Workstream                                   | Implemented behavior                                                                                                                                                               | Evidence                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Command admission and captured timeouts      | Ordinary commands receive admission cancellation and captured timeout policy; started sessions transfer explicitly to task ownership                                               | [01](../artifacts/gap-narrowing-2026-10-20/fix-01-command-policy.md)      |
| Artifact regex search                        | Terminable workers, two active/eight queued, batch/overall deadlines, preserved ordered pagination and truthful failure                                                            | [02](../artifacts/gap-narrowing-2026-10-20/fix-02-bounded-regex.md)       |
| Scheduled direct commands                    | Owned process-tree cleanup and pipe settlement precede durable finish and lease release; output is bounded                                                                         | [03](../artifacts/gap-narrowing-2026-10-20/fix-03-scheduled-processes.md) |
| OpenAI final content and usage               | Full final text extends verified prefixes exactly once; incompatible final content fails; cache-write usage survives normalization                                                 | [04](../artifacts/gap-narrowing-2026-10-20/fix-04-openai-fidelity.md)     |
| Vertex error metadata                        | Shared wrapper preserves server retry delay, retry authority/category, and cancellation identity                                                                                   | [05](../artifacts/gap-narrowing-2026-10-20/fix-05-vertex-boundaries.md)   |
| Host admission, disposal, and API completion | Disposal closes/joins creation; shared admission capacity includes API/editor/prepared children; API publishes durable managed completion                                          | [06](../artifacts/gap-narrowing-2026-10-20/fix-06-host-lifecycle.md)      |
| File context tracking                        | Captured task root, conservative external-change signals, no retired watchers, folded metadata and adjacent work coalescing                                                        | [07](../artifacts/gap-narrowing-2026-10-20/fix-07-file-tracking.md)       |
| Public history                               | Journal-backed identity/status keeps failed/interrupted requests separate and steering within its canonical turn; legacy fallback retained                                         | [08](../artifacts/gap-narrowing-2026-10-20/fix-08-history-projection.md)  |
| UI task/image ownership                      | Authoritative membership prevents task resurrection; asynchronous image reads retain their originating draft and dispose cleanly; terminal fallback uses explicit status           | [09](../artifacts/gap-narrowing-2026-10-20/fix-09-ui-ownership.md)        |
| Custom-tool source catalogs                  | Per-request executable catalogs remove cross-workspace leakage and stale/deleted definitions; bounded immutable generations preserve captured environment resources across refresh | [10](../artifacts/gap-narrowing-2026-10-20/fix-10-custom-catalogs.md)     |
| Managed proposal validation                  | Runtime schema/requested identity and physical artifact-reference containment protect read/apply/discard/recovery paths                                                            | [11](../artifacts/gap-narrowing-2026-10-20/fix-11-artifact-validation.md) |
| Test and benchmark gates                     | Strict full gates reject grep/only; observed selection is bound into receipts; promotion input requires finite typed complete evidence                                             | [12](../artifacts/gap-narrowing-2026-10-20/fix-12-validation-gates.md)    |
| Skills authoring                             | Versioned host edits, dirty/stale/alias checks, protected save and exclusive creation preserve concurrent instruction edits                                                        | [13](../artifacts/gap-narrowing-2026-10-20/fix-13-skills-mutation.md)     |
| Native packaging and optional indexing       | Host-targeted VSIX/native inventory, six-target release matrix, lazy optional backend, packaged search worker, corrected install instructions                                      | [14](../artifacts/gap-narrowing-2026-10-20/fix-14-native-packaging.md)    |

## Measured performance boundaries

File tracking uses the same repeated-read workload before and after. At 64 observations, cumulative serialized metadata
fell from **315,552 to 11,136 bytes**; at 128, from **1,249,600 to 22,272 bytes**. Retained rows for that path fell from
64/128 to one. The wire representation remains compatible and preserves per-source dates/undated legacy reads.
This establishes bounded repeated-path metadata work; it is not an end-to-end task latency benchmark.

The hostile-regex harness uses an accepted pattern over the same 64 KiB nonmatching line. Three baseline samples blocked
the matcher thread for **4.27–6.53 seconds**. After offloading, the extension-side controller's event-loop delay was
**0.97–3.15 ms**, and each search returned an explicit timeout in **1.006–1.021 seconds**. The failed expensive search is
not counted as successful matching or a throughput win. The controller runs the original matching loop in an isolated
thread to keep the benchmark itself terminable; the after condition bundles the actual production helper and worker.
See the reports and executable harnesses for exact samples, cleanup checks, and workload limits.

The existing saved-profile read reduction and pending first-prompt UI remain separately documented in
[the startup repair](first-prompt-latency-2026-10-20.md). These local measurements do not establish live-model quality,
general network latency, or a whole-task speedup.

## Deliberate boundaries

Started unified-exec sessions remain task-owned on steering, consistent with the current upstream behavior.
Whole-task cancellation keeps Alpha's existing stronger cleanup. The command fix must not turn a newly forwarded
step signal into an accidental kill of a valid background process.

Provider-owned gateway transport remains a separate unresolved issue. The installed Gemini SDK does not expose a
supported request-scoped fetch/dispatcher seam. Repeatedly swapping global transport or removing only some callers
would not close the invariant. This pass fixes Vertex metadata loss and retains the existing transport behavior until
a complete supported design is available.

Native packaging must preserve core extension use on Intel macOS even when the installed indexing dependency lacks
its binary. Native target claims and optional-backend limitations must be explicit, and local packaging must not label
a host-only binary set as universal.

Custom-tool generation caches preserve the resources of already captured definitions. They use an isolated host
namespace, a 128 retained-TypeScript-generation ceiling and a 256 overall distinct-import ceiling. Reaching a ceiling
requires an extension-host reload rather than silently executing stale code. Refresh never prunes resources belonging
to a known live/unknown peer host; cleanup of old host namespaces requires an absent PID. Legacy caches are left alone.
This is registry-owned retention control, not a sandbox or a new tool runtime.

## Remaining risks and next bounded work

- **Unresolved:** process-global Vertex gateway fetch/CA pollution. The retry-metadata repair does not isolate transport.
- **Partly improved:** scheduled process cleanup now joins known owned trees, but a PTY Ctrl-C timeout still lacks
  physical-exit proof. Escaped/reparented Windows descendants cannot be proven stopped from a missing shell PID;
  the scheduled path reports that uncertainty as failure. Native worker Git/copy cancellation remains separate work.
- **Unchanged convergence gaps:** queued-item steering still needs its turn-identity guard; compaction overflow/model
  recovery, MCP OAuth/elicitation, cold nested-agent ergonomics and visible reasoning-summary policy remain as reviewed.
- **Compatibility limits:** uncorrelatable legacy histories retain a conservative fallback. Skill saves rely on the
  stable host's version/modified-since protection after dispatch. Persisted artifact validation does not authenticate
  arbitrary local metadata or eliminate hostile filesystem swaps between validation and use.
- **Not established by local checks:** live-provider task quality, general task latency, long-duration behavior, and
  execution of the new hosted release matrix on every platform. Intel macOS keeps core/Qdrant support; this LanceDB
  version has no matching local native binding.
- **Out of scope:** sandbox convergence, another runtime, Rust ports, dependency upgrades, publishing, historical-data
  deletion, unrelated refactors and repository-wide formatting.

Existing concurrent work was preserved: 26 of 30 captured baseline files remain byte-identical; four contain deliberate
integrations for provider admission/test fixtures, custom-tool refresh and image-draft ownership. See
[the preservation check](../artifacts/gap-narrowing-2026-10-20/integration-preservation.json). The initial raw patch backup
was removed after verification; the original hash manifest remains. No dependency or lockfile change is included.

## Validation commands and evidence

Each owner first adds a failing regression or deterministic reproduction, then records the passing check after the
fix. Performance owners compare the same workload and record what is timed; bounded failure is not successful work.
Focused tests run with limited workers. The coordinating agent serializes build/host/package gates after source
integration stabilizes.

Final component checks include the following. The commands use the normal assertions and deadlines; focused owner
checks are additional overlapping coverage, not extra unique tests.

| Check                     | Command                                                                                                  | Result                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Workspace lint            | `pnpm lint --env-mode=loose --concurrency=2`                                                             | 8 successful tasks                                                                     |
| Workspace types           | `pnpm check-types --env-mode=loose --concurrency=2`                                                      | 9 successful tasks                                                                     |
| Unused files/exports      | `pnpm knip`                                                                                              | Passed                                                                                 |
| Extension units           | `pnpm --dir src test --maxWorkers=4`                                                                     | 831 passed files, 3 skipped; 14,887 passed tests, 33 skipped                           |
| Reusable core             | `pnpm --filter @alpha-code/core test --maxWorkers=1`                                                     | 17 files, 246 passed tests                                                             |
| Webview units             | Full webview task during the initial workspace invocation                                                | 197 passed files; 2,461 passed tests, 2 skipped                                        |
| Runner units              | `pnpm --filter @alpha-code/vscode-e2e test:unit`                                                         | 711 passed tests, 2 skipped                                                            |
| Repository tooling        | `pnpm test:tooling`                                                                                      | 281 passed tests                                                                       |
| Offline evaluator         | `pnpm test:evals:offline`, `VITEST_MAX_WORKERS=1`                                                        | Unit: 542; contract: 20; certification: 5; all passed                                  |
| Exact reference host      | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`                                                   | VS Code 1.138.0; 13 files, 47 passed tests; full unfiltered selection verified         |
| Exact minimum host        | `pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250`                                           | VS Code 1.125.0; 4 files, 19 passed tests; full unfiltered selection verified          |
| Build                     | `pnpm bundle`; fresh host-wrapper bundle/webview builds                                                  | Passed                                                                                 |
| Targeted package          | `pnpm vsix`                                                                                              | `bin/alpha-3.2.6-win32-x64.vsix`; 1,817 files, 84.9 MB                                 |
| Archive/source validation | `node scripts/verify-vsix-contents.mjs bin/alpha-3.2.6-win32-x64.vsix --target win32-x64 --check-source` | Passed; 16 document assets match source; required payloads present; no packaged `.env` |

The webview and unchanged dependency-package components passed during the first broad invocation; that interrupted
invocation is not represented as a successful whole-workspace gate. No webview code changed after its full passing run.

The first broad run was interrupted after competing real-Git fixtures exceeded deadlines. The evaluator's first
offline unit run reported 537 passes and five deadline failures across three files, with `EBUSY` teardown errors;
contract/certification phases did not run because the unit command failed. Artifact-security fixtures were refactored
to share one generated proposal and separate three real capture lifecycles into independently bounded tests. Their
22 security/persistence tests and all 15 existing non-Git tests then passed; existing non-Git limits stayed at 30 seconds.
These initial unsuccessful runs are retained, not silently replaced by the passing reruns.

The serialized workspace retry used `VITEST_MAX_WORKERS=2`, Turbo `--env-mode=loose --concurrency=1`. It completed with
14,861 extension tests passing and 26 failures across four older fixtures. Those fixtures lacked the newly required
profile/admission, versioned host-edit, or current-source search-worker behavior. Their owners updated the fixture
boundaries without weakening the original assertions. The final full extension run passed all 14,887 active tests.
The full core suite then passed all 246 tests. The unchanged offline evaluator suites passed with one worker, including
the five previously failing cases; this does not establish a separate concurrency fix for those test fixtures.

Early pnpm invocations automatically re-entered its dependency-verification
install/bootstrap hooks after a scripts-only manifest change; no intentional dependency upgrade or lockfile edit was
made. Later checks set process-local `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn`.

Both exact-host gates used scripted providers and the registered VS Code LM fixture with disposable profiles; they
are deterministic contract evidence, not signed-in Copilot/live-model evaluations. The minimum-host held-tail failure
from the earlier directory review remains historical evidence; its passing rerun is not attributed to an unproven fix.

The final source-bound gate is `pnpm certify:managed-agents:automated`, with `VITEST_MAX_WORKERS=1`. Its deterministic
phase writes [the generated certification outcome](../artifacts/certification/managed-agent-milestone-evidence.json),
then its host phase runs the four managed-agent suites on exact VS Code 1.138.0. The generated record and
`artifacts/gap-narrowing-2026-10-20/managed-agents-final.log` are authoritative for that final outcome. This report is
itself included in the source digest and is frozen before the gate runs. The matrix's eight live/manual integration
rows remain separate pending evidence; a deterministic pass does not certify those rows.

The local Windows archive and exact-host checks do not execute the six-platform hosted release matrix, install a
release, or validate foreign-architecture native machine code. Live-model quality and whole-system latency claims
require separate paired evidence; no such improvement is inferred from local tests.

Evidence is under `artifacts/gap-narrowing-2026-10-20/`. The workstream table records implemented closures; the
deliberate-boundary and remaining-risk sections distinguish deferred, unverified, and out-of-scope work. No release,
installation, commit, dependency upgrade, or new aggregate clean-code grade is part of this pass.
