# Codex alignment and settings cleanup

Implemented October 11, 2026 (America/New_York), on `codex/cli-settings-cleanup-20261011`.

## Completed scope and reference

The user authorized two cleanup sets: the five source-mapped Codex CLI gaps and applicable findings from
“Settings Codex alignment and provider…”. All eight work packages are integrated into Alpha's native TypeScript
VS Code extension and shared harness.

The exact inspected upstream is [openai/codex `27065a91ccbf5ba8532844be3777fcf83b77820d`](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed October 11 at 17:43:08 UTC. Thirteen implementation and follow-up notes connect verified upstream functions and tests to
Alpha's owning modules, contracts and regression tests. A final check found all 70 unique linked source paths in the
reference checkout. Upstream Rust tests were inspected, not executed.

- Starting checkpoint: `14fc29614911d0d3b88670135a8a5c11abb75103`, preserving 117 pre-existing changed files.
- Before implementation, 19 verified merged stale local branches were removed; active, unmerged and remote branches were preserved.
- Historical [Codex comparison](codex-cli-divergence-audit-2026-10-11.md): `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`.
- Historical [settings review](settings-review-2026-10-10-codex-alignment.md): `cc7ba33601286a751477832b01de7b6f8de0dd9c`.
- Settings source chat: `01a12900-e971-7300-b086-be3e8b696f6d`.

Codex sandbox architecture stays outside the target. Alpha's embedding/codebase search, Tickets, schedules, built-in
skills, HTML previewer, MCP and command tools remain supported. The VS Code 1.125.0 baseline, toolchain, dependency
versions and lockfile are unchanged. No Rust, retired standalone CLI, parallel runtime, release-version change,
push, publication or editor installation was introduced.

## Parallel implementation and integration

Eight new chats each used three implementation subagents in an isolated managed worktree based on the checkpoint.
The coordinating chat used three additional read-only reviewers for tool policy, lifecycle and provider/settings
contracts. Leads reviewed and committed their combined changes; the coordinator reconciled shared files, incorporated
the review findings and ran the integrated gates. The chats and worktrees remain available for continuation.

| Set       | Work package and detailed source mapping                                                 | Lead chat                              | Source commit                                                                          | Integrated commit      |
| --------- | ---------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| Alignment | [Complete, bounded MCP pagination](codex-alignment-mcp-pagination-2026-10-11.md)         | `01a12c44-021b-7860-a1f2-db438e107396` | `e3bf5bffb39272973e591785fe4e17e011dfa365`                                             | `290f76c6`             |
| Alignment | [Argv-token command approval matching](codex-alignment-command-matching-2026-10-11.md)   | `01a12c44-109b-7c62-814d-30e261edb8c5` | `2dc8760348094e2c925c7d778ef672322e013a54`                                             | `b70c5971`             |
| Alignment | [Assistant phases and message boundaries](codex-alignment-response-phases-2026-10-11.md) | `01a12c44-1919-71c3-a561-85112f3972f0` | `6ea9d342bb833d96b78b6a8fc8b52ba330897f3d`                                             | `e28316d3`             |
| Alignment | [Portable explicit-only skills](codex-alignment-explicit-skills-2026-10-11.md)           | `01a12c44-22c2-7ca3-9932-28aa81ddf9ae` | `c37cf20b08482605c2b5f0731f6a48f659ed55da`                                             | `0ba2a020`             |
| Alignment | [Native persistent goals](codex-alignment-native-goals-2026-10-11.md)                    | `01a12c44-2b61-7323-892b-3004758f73c2` | `c9a23e5c018216d0932aad8a783cabbe25afac27`                                             | `78e9b918`             |
| Settings  | [Profile rename and acknowledged Save](settings-profile-buffer-fix-2026-10-11.md)        | `01a12c44-3737-7fe0-a7f6-78869f6dd785` | `1435cd185419b034309eb9282dc6a2f09f4265e8`, `a3b37eef00c0c99fc5d5cdc2dc64fde93e2dd22f` | `f9a23a7a`, `3a67501a` |
| Settings  | [Applicable provider parameters](settings-provider-parameter-fixes-2026-10-11.md)        | `01a12c44-41e3-7de2-9986-d7d753bcceeb` | `32363ad2fbab62b60f6d8ea21ceffae56959b5b5`                                             | `3857aecb`             |
| Settings  | [Agents controls and effective approvals](settings-agents-approvals-fixes-2026-10-11.md) | `01a12c44-4f44-7c31-aea7-3fb89931eed7` | `fc7816b9ca9d46b96c652f2e0b849821af60f3dd`                                             | `ded0795e`             |

Coordinator commits `29b7a599` corrected stale tests that classified restored `codebase_search` as retired, and
`d1dfc41c` extended the existing rendered settings acceptance probe to cover the Agents controls without saving
settings. The shared response/request, task/child-context, localization and settings-buffer changes were reconciled
at their owning contracts.

Independent review found and resolved stale MCP grant revocation, conservative legacy command-policy compatibility,
legacy provider capability handling, mixed human/child-notification skill authority, goal startup/steering and child
budget races, and queued Rename/Save identity and acknowledgement races. Reviewers accepted all eight final handoffs and the bounded integration follow-ups.
Read-only method probes are supplemental evidence, distinct from the recorded test-suite gates.

## Intentional Alpha behavior and limits

- Goals use the existing task loop, tool scheduler, completion gate and atomic persistence. Only the root controls a
  goal; managed descendants contribute captured usage. Plan exposes goal reads without automatic continuation.
  Creation and model-requested pause require explicit human approval even in Auto mode. Host/system controls own
  resume and budget changes.
- Automatic goal continuation defaults to 20 iterations, with a finite host-controlled bound. Recovered active goals
  require explicit resume. Alpha retains its existing empty-response guard and does not add Codex's sandbox or a
  maximum-token-budget setting.
- Explicit-only skills are omitted from automatic discovery after override resolution. Explicit named reads remain
  supported; child notifications cannot borrow authority from an unrelated human message.
- Provider parameter applicability follows both the route and the model capability contract. Unsupported routes
  preserve their documented fallback; assistant phases are retained where the provider can represent them.
- Profile Rename is metadata-only; Save uses stable identity and a correlated acknowledgement before clearing the
  matching draft. Storage can commit before a later projection or acknowledgement failure. The retained draft permits
  an explicit stable-ID retry; the operation does not claim a universal transaction across all stores and projections.

Alpha also intentionally retains conservative review of opaque inline interpreter code under finite saved command
denials. A configured executable or Auto mode does not prove that indirect execution excludes every denied command.
The live fixture correction preserves this boundary and directs read-only probes toward observable bounded source reads.

## Integration follow-ups

The integrated host and full-unit checks exposed issues at shared boundaries. These were reproduced and fixed in
separate reviewable handoffs while preserving the original observable assertions:

| Follow-up and evidence                                                                                                      | Source commit                                                                          | Integrated commit      |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------- |
| [Freeze and forward command policy to both catalog and execution](codex-alignment-command-policy-capture-2026-10-11.md)     | `6ef5b78667379d8c52630b99d9dde9e682483ddf`                                             | `9b058b60`             |
| [Keep task protocol distinct from text-only completion](provider-protocol-followup-2026-10-11.md)                           | `b10c80628094b1c414edae02408fd15d9c3a98d7`                                             | `f0117ed1`             |
| [Join cancellation after provider EOF and preserve canonical history](post-eof-cancellation-persistence-2026-10-11.md)      | `c40e34aa866a35e5da3bef1e8297979e3b832310`                                             | `7513b4e8`             |
| Real task-store fixtures, truthful provider initialization and controlled teardown                                          | `241cc05734bfd5196d47bcab1ceeb20526c9fc6d`                                             | `4b90c173`             |
| [Goal continuation requires a completed, current host boundary](codex-alignment-native-goals-2026-10-11.md)                 | `5893fd38b087abbcc49a28bc55d972082b665a41`                                             | `d514d0b4`             |
| [Project scheduler preflight refusals into bounded command evidence](codex-alignment-command-denial-evidence-2026-10-11.md) | `12579fb4f74c3519a6cd3032316ebf7bb4a92220`                                             | `ceaa4c3c`             |
| [Anchor read-overlap timing to actual barriers and a one-shot save](command-read-stream-overlap.md)                         | `5ceca17b923b0e214f4de508d25575da0057b5b0`                                             | `48203206`             |
| [Await stable owned rendered targets and bound pending browser frames](rendered-settings-probe-fix-2026-10-11.md)           | `7a7e9d23b275b9d0345811237fadfe6d3dfa2483`, `d6d1c36ef376a52c5e41160755d4d742bf687d0f` | `14e66b44`, `5b60b408` |
| [Recognize live command review and use bounded source inspection](codex-alignment-live-read-review-boundary-2026-10-11.md)  | `661050f54424750cfd60bdead1c5ebf20decbc58`                                             | `f70872ac`             |

The fixture correction shares the real filesystem mock between `fs/promises` and `node:fs/promises`, uses isolated real
task directories, joins task shutdown, and waits for actual initialization before fake-clock advancement. Existing
1,000-request assertions and timeouts were retained. The goal fix checks completion and current ownership at both
reservation and consumption; interrupted or replaced hosts cannot consume an automatic continuation allowance.

Earlier broad unit attempts encountered resource contention, then a runaway recovery path in an obsolete test
fixture. A diagnostic heap increase identified that fixture; it was not retained as a workaround. The integrated
full-unit gate subsequently passed with the default Node heap, one workspace test task at a time and two Vitest
workers. The earlier exact-host run also exposed uncaptured policy in the tool catalog and missing post-EOF
cancellation history. Both were fixed at their native owners.

A later exact-host run at `d514d0b4` proved that scheduler preflight denied `rm --help` with exactly one canonical denied
result and no effect, but command execution evidence omitted the refused attempt. The original Full Access host
assertion was preserved; the resulting evidence fix and final retest are recorded below.

The first certification at `ceaa4c3c` passed 3,440 of 3,441 tests but measured 800 ms in the original exact-400 ms read-overlap
fixture. A deterministic probe established that the assistant-save mock armed its delay twice; the full-run source of the
additional 400 ms was not proven. The corrected fixture waits for actual read/provider/save barriers with a frozen clock,
retains all 200/300/100 ms delays and the exact 400 ms assertion, uses a real bounded watchdog and joins task teardown.
The complete certification then passed at `48203206`.

The first final rendered probe captured both Agents layouts but missed the moving output-preview option before any
deliberate host refresh. The driver omitted `awaitPromise` for its frame wait; a specific event-target explanation remains
unproven. The fix awaits stable connected targets, current document ownership and both inner/outer hit tests, then uses
one trusted pointer press. Review caught a pending-frame deadline gap; the follow-up owns deadline/abort settlement,
cleans listeners/timers, handles late transport settlement and sends release only after a press dispatch was attempted.
Existing assertions and 15-second control, 60-second stage and 360-second outer limits remain intact.

## Integrated validation

The production snapshot `ceaa4c3c7efbd3edbfc77076a1b63c0b2d974e82` passed the root unit, lint, type, exact-host smoke, bundle and VSIX checks below. Subsequent fixture-only commits are identified separately; the final coordination-record commit is documentation-only. Test counts from independent reviewer probes and overlapping focused runs are not added to the root suite total.

| Gate                                                                                           | Result and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test --concurrency=1 -- --maxWorkers=2`                                                  | **15,170 passed, 33 skipped, 0 failed** across seven packages; 8/8 Turbo tasks successful. Alpha's source suite executed **12,227 passed / 31 skipped**; the other six unchanged packages used previously verified cache entries. Default Node heap. [Log](../artifacts/cleanup-integrated-final-unit-ceaa.log).                                                                                                                                                         |
| `pnpm lint`                                                                                    | 8/8 tasks passed. [Log](../artifacts/cleanup-integrated-final-lint-ceaa.log).                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm check-types`                                                                             | 9/9 tasks passed. [Log](../artifacts/cleanup-integrated-final-types-ceaa.log).                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm knip`                                                                                    | Unused-file check passed (`knip --include files`). [Log](../artifacts/cleanup-integrated-final-knip-ceaa.log).                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`                                         | **42/42 passed across 13 serial host launches**. Every receipt verifies actual **1.125.0**, owned host, complete capture and observed exit. The original command-denial assertion passed. [Log](../artifacts/cleanup-integrated-final-exact-host-ceaa.log).                                                                                                                                                                                                              |
| `pnpm bundle`, `pnpm vsix`                                                                     | Both passed; version remains **3.1.10**. [Bundle log](../artifacts/cleanup-integrated-final-bundle-ceaa.log), [VSIX log](../artifacts/cleanup-integrated-final-vsix-ceaa.log).                                                                                                                                                                                                                                                                                           |
| `node scripts/verify-vsix-contents.mjs bin/alpha-3.1.10.vsix --check-source`                   | **1,675 entries** verified, required assets present, no `.env` or Linux ripgrep payload, **16 document assets** identical to current source. [Log](../artifacts/cleanup-integrated-final-vsix-verify-ceaa.log).                                                                                                                                                                                                                                                          |
| `pnpm certify:managed-agents:automated` at `4820320601c8f229df976eb548b6f93de4e13f17`          | **3,441/3,441 deterministic tests**, **26 automated requirements**, followed by **2/2 tests across two exact 1.125.0 hosts**. Stable clean checkout fingerprint `882bc3563b650cecaefd9443867b5dc503f3f043d07c6e13ec82dc841bf214d9`. [Log](../artifacts/cleanup-integrated-final-managed-cert-482.log), [deterministic receipt](../artifacts/certification/managed-agent-milestone-evidence.json).                                                                        |
| Fixture policy regression at `f70872ac`                                                        | **20/20 passed**; production approvals unchanged. [Log](../artifacts/cleanup-live-fixture-source-f708.log).                                                                                                                                                                                                                                                                                                                                                              |
| Root lint and types at `f70872ac`                                                              | Lint **8/8**, types **9/9** tasks passed, including the live fixture changes. [Lint](../artifacts/cleanup-integrated-final-lint-f708.log), [types](../artifacts/cleanup-integrated-final-types-f708.log).                                                                                                                                                                                                                                                                |
| `pnpm --filter @alpha-code/vscode-e2e test:unit` at `5b60b408ad7949b1e3ca85418f09f14f4ab3125e` | **588 passed, 2 skipped, 0 failed**, including all 22 rendered-control cases and 8 live-boundary cases; ordinary runner compile passed. [Log](../artifacts/cleanup-integrated-final-runner-5b60.log).                                                                                                                                                                                                                                                                    |
| Runner lint/types and `pnpm knip` at `5b60b408`                                                | All passed. [Runner lint](../artifacts/cleanup-integrated-final-runner-lint-5b60.log), [runner types](../artifacts/cleanup-integrated-final-runner-types-5b60.log), [unused-file check](../artifacts/cleanup-integrated-final-knip-5b60.log).                                                                                                                                                                                                                            |
| Corrected rendered settings acceptance at `5b60b408`                                           | **1/1 passed through 12 stages**, actual **1.125.0**, trusted input, owned host, complete capture and observed exit. Dirty edits survived refresh; cancellation/discard and nested Apply/navigation passed. Both Agents screenshots were inspected in the narrow dark sidebar. [Log](../artifacts/cleanup-integrated-final-rendered-5b60.log), [receipt](F:/alpha-e2e/cleanup-rendered-settings-final-20261011-2240/ui-probe-6240944a-94ab-43f2-a9ff-e94dda102258.json). |

`git diff --check` passed. A direct source comparison verified production `src`, shared `packages/types`, `packages/core`
and `webview-ui` remain byte-identical to `ceaa4c3c` after the final fixture/runner-only commits, excluding only the two
identified test files. Thus the production smoke, full-unit and package gates are reported at their actual production
snapshot, and the new fixture/runner checks at their actual later commits. No gate is represented as testing a future
commit. The final coordination-record commit changes only this document.

The certification receipt explicitly retains **eight pending integration rows**: human instruction provenance,
nested-process reload, billable budget/stream stopping, the complete worker review workflow, live tree convergence,
OS-process/provider cancellation, multi-process storage writers, and multi-window global-state serialization. The two
managed-agent host tests, rendered settings probe and single live read sample are supplemental evidence; they do not
claim completion of that entire manual matrix.

## Live Copilot availability

A final owned development-sidecar run at `f70872aca1ccaafd178982a493577d845f7f1e91` passed the real read-only
`exported-symbol` case on exact **VS Code 1.125.0**, Copilot **`gpt-6-luna`**, **`max`** effort, and dedicated signed-in
profile **`F:/alpha-e2e/profiles/1.125.0`**. It used **two task requests** under the fixture's **eight-request cap**, plus
**one separate readiness request**. It performed one bounded `rg` read, selected the exported function over the decoy,
answered `250`, completed exactly once, and left fixture file hashes unchanged. Groundedness and trajectory checks
passed for this sample. Capture and ownership were verified, and the host exit was observed.

- [Run receipt](F:/alpha-e2e/cleanup-live-final-20261011-2236/artifacts/cleanup-live-final-exported-symbol-f708/run-result.json).
- [Task evidence](F:/alpha-e2e/cleanup-live-final-20261011-2236/artifacts/cleanup-live-final-exported-symbol-f708/exported-symbol.json).
- [Scoring evidence](F:/alpha-e2e/cleanup-live-final-20261011-2236/artifacts/cleanup-live-final-exported-symbol-f708/exported-symbol.quality.json).
- [Log](../artifacts/cleanup-integrated-final-live-exported-symbol-f708.log).

Earlier attempts are retained: an uninitialized fresh workspace failed profile validation before launch, and the
runner's global request-limit flag rejected a suite without a workflow scenario before task dispatch. The corrected
suite invocation uses its existing `WorkflowRequestBudget` guard. A subsequent executed run dispatched one task
request and correctly stopped for opaque inline Node approval under the saved finite deny list, then reached the
original fixture deadline. The fixture now recognizes that settled review promptly; all four read-quality cases use
generic bounded source-inspection guidance while preserving denials, command availability, answers, scoring, budgets,
deadlines and configuration restoration. No approval was clicked or policy widened.

This is one availability and grounded-read sample, not evidence of a general model-quality, latency or token-use
improvement. No broader live campaign or full manual certification matrix is claimed.

## Completion state

All five selected Codex alignment improvements and the three applicable settings packages are implemented, reviewed,
locally committed and integrated. This establishes the selected source-mapped behaviors, not whole-product parity with
Codex CLI. The generated VSIX is local; no push, PR, publication or editor installation was performed. Existing user work,
Alpha's additional tools, and the continuation chats/worktrees are preserved.
