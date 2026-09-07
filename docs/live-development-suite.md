# Live Copilot development acceptance suite

## Goal and scope

Build on the existing VS Code extension-host runner, persistent Copilot profiles, workflow driver, and campaign evidence
collector. The acceptance path is **real GitHub Copilot → Alpha tools → disposable local Git repository → independent
outcome and trace review**. Scripted providers validate the harness only; their passes are never live-model acceptance.
VS Code 1.122.1 is the reference gate and 1.136.1 is the forward-compatibility target. No GitHub.com repositories, pushes,
pull requests, external databases, or production migrations are in this suite.

This is an operational-hardening improvement, not a guarantee of zero agent errors. It does not repair the unresolved
normal-profile lock incident or the separately observed bundled-Copilot host exception.

Latest continuation: [2026-09-07 live startup investigation](ripgrep-live-failure-2026-09-07.md) records the reproduced
host-ripgrep defect, the correction, normal-PATH exact-host validation, two passing live workflows, an additional failed
refactor trace, and the separate normal-profile Copilot sign-in blocker. Earlier validation entries below are historical
checkpoints, not the current aggregate result. The stale lock was quarantined offline as recorded in the
[storage incident](ownerless-lock-incident-2026-09-06.md); crash-safe prevention remains separate.

## Implementation plan and acceptance matrix

| Scenario                           | Development task                                                                                     | Independent evidence required                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `dev-repo-bootstrap`               | Create a small dependency-free Node project, initialize Git, test, commit                            | Actual repository and app exist, behavior checks and executed tests pass, initial commit contains the app |
| `dev-git-inspect`                  | Inspect status, history and changes without editing                                                  | Git command receipts; HEAD, index entries, tracked and untracked contents unchanged                       |
| `dev-refactor`                     | Create a feature branch, extract shared logic across files, preserve the public API, test and commit | New branch, real multi-file change, retained API behavior and tests, correct commit scope                 |
| `dev-selective-commit`             | Fix one defect while unrelated work is staged, unstaged and untracked                                | Only requested files committed; unrelated bytes and staged entries preserved                              |
| `dev-merge-conflict`               | Resolve an actual divergent-branch merge conflict and test both changes                              | No unresolved index stages, both behaviors retained, true two-parent merge commit                         |
| `dev-local-migration`              | Implement/run a JSON fixture migration, then run it again                                            | Version upgraded, IDs and data preserved, second execution is idempotent                                  |
| `review-edit-test-commit-followup` | Review → bug fix → tests → commit → follow-up                                                        | Existing independent repository, transcript and lifecycle checks                                          |
| `cancel-resume`                    | Cancel at a known approval boundary, resume the same task                                            | Cancelled lifecycle recorded; no premature mutation; resumed task succeeds                                |
| `reload-continuation`              | Close/reopen the host and continue a retained task                                                   | Correlated checkpoint and same-task persistence; prepare alone is not a pass                              |
| `long-thread`                      | Repeated dependent follow-ups using accumulated state                                                | Earlier cases preserved and exercised; all turn boundaries complete                                       |

Implementation order:

1. Add the six fixture scenarios and negative oracle tests. Keep model-facing requirements separate from grading.
2. Integrate them into the existing task driver and live/scripted provider path, with per-phase command approval.
3. Require persisted command receipts for requested actions, tool-call/result integrity, correct lifecycle terminals,
   new tool work on each phase, and independent filesystem/Git/behavior checks.
4. Provide bounded smoke/development/soak presets through the existing campaign entrypoint.
5. Run focused tests, owning-package lint/typecheck, the exact-host smoke gate, and actual scripted fixture workflows.
6. Run live smoke, inspect retained traces, address confirmed defects, rerun the failing scenario and adjacent scenarios;
   only then expand live samples and hosts. Record blocked and unexecuted cells explicitly.

## Pass, diagnose, fix, rerun

A development scenario can pass only when the actual requested host/model/effort match, required commands have fresh
persisted non-error receipts, all accepted tool calls have correctly ordered terminal results, all required task turns
complete without an unexpected failed terminal, and the independent repo checks pass. Assistant statements such as
“tests passed” or “committed” are not evidence. The new development flows also fail on unexpected error tool receipts;
intentional failure/cancellation behavior remains in explicitly designated recovery scenarios.

Command receipts do not by themselves prove command exit codes or correct effects. The separate behavior, Git, data,
and executed-test checks provide that evidence. The grader does not accept a model's rewritten assertions as its sole
oracle. It accepts behaviorally correct alternative implementations; it does not compare app source with one golden
solution. Static command allowlists constrain terminal authority, not the order of file inspection or implementation.

For each live attempt:

1. Preserve the workflow result, host completion/preflight, canonical task history/lifecycle trace, and failed workspace.
2. Inspect failed check names alongside tool calls/results, retries, task terminals, Git changes, and test results. Keep
   credentials, raw private output, and arbitrary command text out of summary reports.
3. Classify the cause: extension defect, harness defect, model mistake, authentication/quota, or external host/provider.
4. For a confirmed extension/harness defect, reproduce at its owning boundary and add a regression before the fix.
   Apply a small reviewed patch; do not reset task storage, relax assertions, or add arbitrary sleeps to produce green.
5. Run the regression, rerun the same live scenario, then neighboring scenarios. Historical failures remain in reports.
6. Expand to the remaining matrix only while request, time, storage, evidence, and ownership checks permit.

The campaign is report-only by default. It collects/runs/reproduces; it is not a second autonomous source-editing agent.
The coordinating engineering agent performs diagnosis and reviewed fixes under the user's authorization. The existing
opt-in reviewed-patch protocol is available for pre-reviewed changes, not model-generated shell authority.

## Run it

For the complete on-demand acceptance command, use [the live harness gate](live-harness-gate.md). It builds and runs
deterministic prerequisites, then grades the entire live matrix and returns nonzero for incomplete or failed acceptance.
The lower-level commands below remain useful for focused diagnosis and scripted harness validation.

Use Node 20.19.2 and pnpm 10.8.1. Build the extension/webview and compile the harness using the commands in
[persistent live profiles](vscode-live-test-profiles.md). Prepare/sign in once per exact-version dedicated profile.
Normal VS Code user data is never adopted or copied. Setup success is not a workflow pass.

From the repo root, a harness-only development run:

```powershell
pnpm --dir apps/vscode-e2e test:development --provider scripted --root F:/alpha-development/scripted --init-root
```

Live smoke, using the exact model ID returned by the profile's discovery result:

```powershell
pnpm --dir apps/vscode-e2e test:campaign --suite smoke --provider live-copilot --model-id EXACT_DISCOVERED_ID --effort high --root F:/alpha-development/live --profile-dir F:/alpha-development/profiles --init-root
```

Use `--suite development` for all ten scenarios or `--suite soak` for repeated samples. Both hosts run by default,
reference version first. To isolate a host, add `--vscode-version 1.122.1`; an installed binary can be supplied with
`--vscode-executable` and its matching exact version. Run IDs are generated uniquely; `--id` permits an explicit unique ID.
Keep the same `--profile-dir` across runs. `--init-root` applies only to an empty or already marked campaign root, not to
authenticated profile data. Do not put profiles in an unmarked campaign root and then ask the runner to adopt it.

Add `--dry-run` to print the selected scenarios, hosts, model and budgets without creating directories, launching VS Code,
or making model requests. Its status is `planned`, never `passed`. Remove that flag only when ready to execute.

No provider is assumed: `--provider` is mandatory for presets. Live also requires an exact model and explicit effort;
unsupported/unavailable options block rather than substitute. Scripted presets reject model/effort labels. Presets do
not permit source-repair flags. Use an explicit `--config` instead for custom budgets or a reviewed patch campaign;
configuration mode and preset mode cannot be combined.

See [campaign budgets and result semantics](vscode-test-campaigns.md) for exit codes, immutable reports, resource limits,
evidence retention, and stop conditions. There is no background overnight scheduler: soak is an explicitly started,
bounded foreground campaign, and each persistent profile has at most one owned host at a time.

## Evidence boundaries and remaining coverage

- **Automated outcome checks:** independent repo/Git/data/test assertions and persisted trace/lifecycle integrity.
- **Engineering review:** interpret live failures and broader trace quality, implement and validate confirmed fixes.
- **Not yet proven by these checks:** rendered webview typing/clicking/focus, arbitrary normal-profile health, crash-safe
  lock creation, every language/project shape, hosted GitHub interactions, or every possible long-horizon task.
- Exact command approvals bound the harness's terminal surface but are not an OS sandbox for generated Node code.
  Use only the disposable fixtures; a policy refusal of an equivalent but unlisted command is a harness constraint to
  diagnose, not automatically an extension defect. No normal repositories or production data belong in these runs.
- The known normal-profile ownerless lock must remain an open operational incident until separately repaired offline
  and the user's actual F5 flow succeeds. Dedicated profile greens do not close that incident.
- The previously observed Copilot exception on 1.122.1 is an external-host blocker until an actual rerun proves otherwise.
  A blocked reference-host run must not be silently replaced by a passing newer-host run.

## Primary references

Retrieved 2026-09-06: [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
supports actual extension-host execution and explicit host versions;
[Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) defines the host-managed model
selection/request boundary. This suite retains the existing exact-host adapters rather than adding new production APIs.
[Git commit documentation](https://git-scm.com/docs/git-commit) distinguishes committing the index from path-limited
commits; selective-commit acceptance must verify both committed content and unrelated staged work.

## Validation record

Do not interpret passing harness tests as live acceptance.

- Owning-package unit suite: **306 passed, 2 platform-specific skips** (`pnpm --dir apps/vscode-e2e test:unit`).
- Owning-package typecheck and lint passed. Extension bundle, webview build, and the exact
  `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` gate passed, including a final gate rerun completed at
  2026-09-06T23:14:03.910Z.
- The initial actual-host scripted Git-inspection run passed on 1.122.1 (40 checks, 8 scripted requests).
- Campaign `development-scripted-matrix-20260906-01` completed the six-scenario/two-host matrix with 10 passes and
  4 retained bootstrap-grader failures (initial plus reproduction on each host), using 126 scripted requests.
  Git inspection, refactor, selective commit, merge conflict, and two-turn migration passed on **both exact hosts**.
  Report: `F:/alpha-vscode-e2e-runs/20260906/development-scripted-campaign/development-scripted-matrix-20260906-01/report-00017.json`.
- Campaign `development-scripted-regression-20260906-02` reran the corrected bootstrap and neighboring
  inspection/refactor scenarios on both hosts: **6 passed, 0 failed, 0 blocked**, 50 scripted requests, retention complete.
  Across the original matrix and this rerun, all six new scenarios have passed on both hosts. Historical failures remain
  in the original report; this is not a claim that the original campaign was green.
  Report: `F:/alpha-vscode-e2e-runs/20260906/development-scripted-campaign/development-scripted-regression-20260906-02/report-00009.json`.
  These runs use the real extension host and Alpha tools but **scripted responses**, not live Copilot. They do not
  establish live-model acceptance. The existing four recovery/long-thread flows remain available in the development
  preset; no new live acceptance is claimed for them in this change.

### Harness findings corrected before acceptance

- Fixture initialization had to seed the protected `.alphaignore`; asking the model to write it contradicted policy.
- The selective-commit baseline must contain the actual defect and lack its regression. Otherwise a scripted "fix"
  restored HEAD bytes and produced no commit. The oracle checks both actual committed paths and the unrelated index blob.
- Merge preparation needs a scoped local committer identity even with `--no-commit`; it must prove a real conflict,
  not treat any Git error as successful fixture creation. Final grading separately requires the two seeded parents.
- The migration reference script needed correct escaping. Independent grading starts from fresh v1 data, checks
  preserved metadata/records, executes tests, and compares actual phase-one/phase-two bytes. A no-op script against
  already-upgraded data is a covered false-pass regression.
- Trace grading requires assistant-owned calls and fresh per-phase command receipts. An earlier turn's successful
  migration command, fabricated tool roles, missing actions, and error receipts cannot satisfy a later phase.
- Outcome grading uses executable behavior and retained tests instead of requiring one source-code spelling. Fixture
  scans and reads are bounded; in-memory baselines are disposed with the owning suite, with no global oracle store.
- Actual Windows host runs reproduced a false failure for CRLF `.gitignore` files. The new regression first failed on
  exact text equality, then passed after switching to Git's ignore semantics. A negated protection rule still fails;
  the correction does not accept an unprotected controller marker. Original failed runs remain retained.

These are harness corrections, not evidence that the separate production storage incident is repaired. The
operational-hardening review shaped the negative grading tests, phase-scoped command authority, and evidence retention.

### Live attempt: 2026-09-06, reference host

Run `live-dev-inspect-1221-01` attempted the read-only Git inspection using actual VS Code 1.122.1 and
`gpt-5.6-luna` with `high` effort. Saved authentication, exact model discovery, Alpha access, and effort configuration
passed. The host then reported an uncaught exception inside bundled Copilot before an Alpha task was created:
`TypeError: e is not iterable`, at `copilot/dist/extension.js:1167:19963` (`g3e.setItems`).

This is a **failed host run / blocked live acceptance**, not a model workflow failure or pass. The retained manifest
contains no task IDs or task trace; no request/token/cost total can be inferred from that absence. No repeat was launched
after confirming the same signature as the prior live review attempt.

Evidence is retained under
`F:/alpha-vscode-e2e-runs/20260906/development-artifacts/live-dev-inspect-1221-01/`:
`host-preflight.json`, `host-completion.json`, `live-copilot-preflight.json`, `manifest.json`, and the referenced host logs.
The attempt ran from 22:57:59.754Z to 22:58:11.008Z; host closure and ownership were verified.

The stack and bundled versions match an [open upstream report](https://github.com/microsoft/vscode/issues/319423)
checked on 2026-09-06. This is corroborating evidence, not proof of every proposed cause or workaround in that report.
Do not edit downloaded Copilot code, suppress uncaught exceptions, or substitute a newer host to declare 1.122.1 green.
Next live acceptance requires a verified compatible provider/host remediation followed by the same bounded scenario,
then neighboring workflows and the remaining matrix. Normal-profile storage repair remains a separate unresolved item.

### Live continuation: saved 1.136.1 profile and request guard

After the user signed in through Copilot and closed the dedicated setup window, `live-dev-inspect-1361-01`
reopened the same persistent profile. Discovery found 23 models, selected exact `gpt-5.6-luna` with `high` effort,
and applied Alpha's configuration. No profile reset or credential copying was needed.

The first workflow failed before a guarded send: the test-only request-budget proxy replaced a fixed `sendRequest`
property on VS Code's model object, violating JavaScript proxy invariants. Its retained result reports
`unexpected_resume_task`; the underlying renderer log identifies the proxy `TypeError`. The same issue affects
binding other frozen methods, such as `countTokens`. This is a harness defect, not evidence of an agent task defect.

The correction intercepts reads on a separate facade, preserving the original host receiver without modifying the
shared model. A frozen-client regression failed before the correction and passed afterward. It checks metadata and
opaque state, argument/cancellation-token identity, unchanged response identity, propagated provider errors,
predispatch limits, cached wrappers, and idempotent restoration. Existing mutable-client and API-replacement tests
remain green. Owning-package validation: **307 passed, 2 platform-specific skips**; typecheck and lint passed.

Retry `live-dev-inspect-1361-02` reached the first actual request but displayed VS Code's modal asking the user to
allow Alpha access to Copilot. Although the preflight reported `canSendRequest: true`, this did **not** establish
prompt-free dispatch. UI inspection confirmed the modal; user approval is required and must not be automated or
inferred from the preflight. At this checkpoint the live retry is pending, not passed, and the exact-host gate has
not been rerun for this guard correction because the live host is still using the compiled harness.

Both runs retain evidence under `F:/alpha-vscode-e2e-runs/20260906/development-artifacts/`. Complete the live retry,
inspect its actual trace/outcome, then rerun the exact-host gate after the owned host closes. A newer-host result
does not resolve the separate 1.122.1 Copilot exception or the user's normal-profile storage-lock incident.
