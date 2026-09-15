# Tool must-fix implementation and validation

This implements findings 1–4 marked **must-fix** in the
[tool quality review](tool-frontier-review-2026-09-14.md). The remaining search, read, command-session, and language
navigation roadmap items are separate enhancements.

## Changes

### Task-scoped TODO approvals

Pending TODO proposals now belong to a task instance and a unique approval ID. Approval edits require a live addressed
task, the matching pending ID, valid item data, and distinct item IDs. Missing identities, stale IDs, unknown tasks,
terminal tasks, and malformed edits are ignored. Approval completion, denial, errors, and cancellation discard the
pending proposal. A late cleanup cannot discard another invocation's proposal.

The current UI displays TODO changes without an active pending-list editor. The retained edit endpoint is validated
and scoped; it no longer accepts an unaddressed edit against shared module state. Existing saved TODOs and transcripts
retain their readers and formats. Old unscoped edit messages are intentionally ignored.

### Browser approval authority

The browser adapter no longer changes `chat.tools.global.autoApprove` or the internal
`vscode.chat.tools.global.autoApprove.testMode` context. It invokes the supported host API using the user's existing
approval configuration. If the host cannot approve the invocation, its error propagates; Alpha does not grant itself
authority. Calls already cancelled do not dispatch, and late host results after cancellation cannot become success.

This removes a workaround based on internal VS Code 1.131 behavior. It does not fabricate a chat invocation token for
extension-initiated calls. Availability remains feature-detected. Unit coverage verifies absent tools, successful and
failed invocation, cancellation, result conversion, cleanup, and unchanged approval settings. The general host gates
do not independently establish every integrated-browser confirmation interaction.

### GitHub review and cancellation

GitHub approvals now carry a shared, validated review shape and render a dedicated visible panel. It includes the
repository, action, PR/issue identifiers, branch/merge details, full title, body, and commit message when supplied.
Content is rendered as text, including embedded HTML. Existing flat approval messages and nullable historical fields
remain readable. The six action labels are translated in all 18 webview locales.

The tool checks cancellation before asking, after approval, and before dispatch. Both direct `fetch` and proxy `curl`
receive the request signal and a common **30-second deadline**, including response-body reading. Timers and abort
listeners are released on completion. A cancelled request cannot report success. Cancellation or timeout after a write
starts reports that its remote outcome may be unknown and requires checking GitHub before retrying; abort does not
undo an accepted remote operation.

No real GitHub comments, PRs, or merges are created by the regression tests.

### Literal replacement

The preceding review's one-line `search_replace` fix remains: replacement callbacks preserve literal dollar sequences.
Its 12 regression cases cover both direct-save and preview paths.

### Validation configuration

Knip initially reported `workers/sanitizeDocument.ts` and `AgentControlStore.benchmark.ts` as unused. The former is an
explicit esbuild worker entry used by the HTML document viewer; the latter is the runnable benchmark entry and is
fingerprinted by its report contract. Both are now explicit Knip entry points. The benchmark's `--help` command ran
successfully. No broad ignore pattern was added.

### UI regressions found by the full suite

The existing scroll-layout test expected a file-changes panel with no file edit in its transcript. Its fixture now
contains a completed edit, preserving the original layout assertions. The skill-binding editor was hiding saved
retired modes after the executable mode catalog was narrowed. It now shows existing saved bindings in that editor so
users can preserve or remove them. This does not add executable modes. Tests cover retired built-in and unknown custom
bindings, preservation, and removal.

A subsequent full run exposed a timing bug in the searchable dropdown: a 100 ms reset scheduled at mount or close
could erase newly typed text. Resets now occur at the corresponding value/close transition. A controlled-timer test
reproduced the empty input before the fix; all 17 dropdown tests pass, including rapid close/reopen behavior.

### Extension test setup corrected after the full run

The extension suite initially discovered a `node:test` example inside the generated document kit. Its Vitest
configuration now extends the standard excludes with `webview-ui/build/**`; source tests remain included. The activation
test mock now supplies the existing host serializer API. Environment and mode/prompt fixtures reflect the current
Code/Plan catalog. Six prompt snapshots were reviewed: the differences are the existing recoverable-error and bounded
verification guidance, plus the low-level retired-mode fallback to the default prompt.

Four existing compaction failures came from fixtures that did not model a reduction in context or apply replacement
history. The tests now supply measurable reduction and retain the real history replacement method. Their assertions
still require identical acknowledged context on retry, complete tool transactions, and independent queued messages.
No compaction runtime behavior changed. The six affected fixture suites passed **281 tests**.

The unrestricted full run also hit filesystem timing limits. Full-suite reruns use four Vitest workers per package,
without increasing timeouts. On this Windows host, the native `pnpm.cmd` launcher preserves Turbo's `--` separator:

```sh
pnpm bundle
pnpm.cmd exec turbo test --continue=always --log-order grouped --output-logs new-only -- --maxWorkers=4
pnpm --dir src test --maxWorkers=4
pnpm --dir webview-ui test --maxWorkers=4
```

## Regression evidence

- The TODO interleaving test failed before the fix with task A receiving task B's contents.
- Browser tests failed before the fix because it changed approval settings/context and dispatched already-cancelled calls.
- GitHub tool tests failed before the fix because bodies were absent and cancellation did not prevent approval/dispatch.
- GitHub UI tests failed before the fix because approval rows rendered no content.
- Focused backend checks after implementation: **120 tests across six files passed**.
- Focused initial UI checks: **four tests across two files passed**; historical-null coverage was subsequently added.
- Final focused UI checks: **41 tests across three files passed**, including the two regressions above.
- Full repository lint and typecheck: passed. Typecheck found and prompted correction of an incomplete response mock.
- Knip: passed after identifying the two explicit entry points above.
- Repository-wide translation audit: failed on existing missing keys outside this change; the new GitHub action keys
  are complete in every locale.

## Complete workspace test coverage

The final full workspace test command **passed with exit code 0**: all **11 Turbo tasks succeeded**. The extension suite
ran fresh and passed **8,950 tests**; the other ten tasks reused successful results from the same isolated snapshot.
The complete workspace counts are below. The final command took 4 minutes 37 seconds, recorded in
`F:\alpha-vscode-e2e-runs\tool-mustfix-snapshot-tests-green.log`.

The original checkout's earlier runs covered 12,032 passing tests. The isolated snapshot included additional tests from
concurrent work. Its first full Turbo command completed every package but returned nonzero for eight fixture failures:
six prompt snapshots had an extra final blank line, and two new inspection-batching cases needed temporary workspace
realpath normalization. Reviewed test-only corrections already present in the original checkout were copied into the
snapshot; the three affected suites then passed all 42 tests before the successful final full run. No production code
changed during that correction. The earlier red commands remain recorded as failures.

| Suite        | Passed tests | Existing skips |
| ------------ | -----------: | -------------: |
| Extension    |        8,950 |             42 |
| Webview      |        1,794 |              3 |
| Core         |          165 |              0 |
| Shared types |          301 |              0 |
| CLI          |          493 |              2 |
| VS Code shim |          407 |              0 |
| Web evals    |           33 |              0 |
| IPC          |            3 |              0 |
| Build        |            1 |              0 |
| **Total**    |   **12,147** |         **47** |

The telemetry package's configured `--passWithNoTests` check also succeeded. No tests were skipped as part of these fixes.
Final repository lint, typecheck, touched-file formatting, and scoped `git diff --check` passed. Knip passed; the
repository translation audit still reports pre-existing missing keys elsewhere.

Detailed local logs are under `%TEMP%`: `alpha-mustfix-tests-final.log` (Turbo run),
`alpha-mustfix-extension-final.log`, `alpha-mustfix-webview-final.log`, `alpha-mustfix-lint-verified.log`,
`alpha-mustfix-types-last.log`, and `alpha-mustfix-format-final.log`.

The isolated run also passed `pnpm bundle`, all 12 lint tasks, and all 13 typecheck tasks. Its logs are under
`F:\alpha-vscode-e2e-runs`: `tool-mustfix-snapshot-tests.log`, `tool-mustfix-snapshot-fixtures.log`,
`tool-mustfix-snapshot-lint.log`, and `tool-mustfix-snapshot-types.log`. The seven copied test files and their hashes
are recorded in `tool-mustfix-snapshot-test-sync.json`.

### Validation scope with concurrent work

The isolated snapshot is the validation target. At September 14, 22:00 EDT, comparison of 179 changed non-documentation
paths found 18 differences from later work in the shared checkout, including execution policy, outside-workspace
access, and approval settings. All 50 implementation/test/configuration files associated with these must-fixes matched
the snapshot after normalizing line endings. Both checkouts remained based on commit
`e10e1f62cdcdc8dce75efa790df6e7883d444755`. These results do not certify those later concurrent edits.

A final comparison at 22:09 EDT found 49 of those 50 files still identical. The sole difference was a later
`workingDirectory` prop in the command row of `ChatRow.tsx`; its GitHub approval panel was unchanged. The three GitHub
approval UI tests were rerun successfully in the current checkout after that edit. The comparison is recorded in
`F:\alpha-vscode-e2e-runs\tool-mustfix-source-validation-20260914.json`, and that focused run is in
`F:\alpha-vscode-e2e-runs\tool-mustfix-current-chatrow.log`.

## Live Copilot target

The prior successful campaign receipt verified **VS Code 1.136.1**, **Copilot 0.64.1**, exact model **gpt-5.6-luna**, and
**high** reasoning effort. Its dedicated profile is reused at
`F:\alpha-vscode-e2e-runs\20260906\profiles`; authentication data is not copied, inspected, or reset.

The isolated campaign is `tool-mustfix-live-1361-20260914-02`. It uses the core suite: Git inspection, refactoring, search
recovery, completion/idle, empty-response recovery, provider-error recovery, stream cancellation/recovery, reload
continuation, and background isolation. The sample count is one per scenario and the campaign request cap is 300.

```sh
pnpm --dir apps/vscode-e2e test:live:core --vscode-version 1.136.1 --model-id gpt-5.6-luna --effort high --root F:\alpha-vscode-e2e-runs\core-confidence --profile-dir F:\alpha-vscode-e2e-runs\20260906\profiles --id tool-mustfix-live-1361-20260914-02 --max-requests 300 --samples 1
```

This campaign's prerequisites retain the harness unit suite, core regressions, and exact **1.122.1** smoke/core gates.
The live target supplements that compatibility contract. The previously recorded 1.122.1 live-Copilot observer failure
is documented in [the live-profile investigation](vscode-live-test-profiles.md); this change does not migrate the
extension's baseline or patch the downloaded Copilot extension.

### Compatibility prerequisites: passed

Both campaigns completed these prerequisites successfully. The isolated campaign repeated them against its own build.

- Harness unit tests: **374 passed, two existing skips**.
- Core regressions: **309 extension tests and seven core persistence tests passed**.
- `test:smoke:1221`: **10 host tests passed** across activation, modes, and VS Code LM contracts.
- `test:core:1221:run`: **five host tests passed** across the core loop, completion/follow-up, and managed-agent acceptance.
- Every one of the six host receipts reports `actualVSCodeVersion: 1.122.1`, `execution: extension-host`,
  `hostExitObserved: true`, and `exitCode: 0`.

Prerequisite receipts and the live gate plan are retained under
`F:\alpha-vscode-e2e-runs\core-confidence\tool-mustfix-live-1361-20260914-01`.
The repeated isolated receipts are under the sibling `tool-mustfix-live-1361-20260914-02` directory.
The isolated live scenarios use artifact digest `1fb5c4d59a49282415bcff77c238d445f62defb113d6f82fad07ab40012892c0`,
recorded in that directory's `gate-plan.json`.

### First live campaign: invalidated by concurrent builds

Campaign `tool-mustfix-live-1361-20260914-01` passed Git inspection (six requests), refactoring (eight), and search
recovery (eight). The completion scenario was blocked before an Alpha task could start. Its host log records an
activation failure because `F:\roo-fork\Alpha-Code\src\dist\extension.js` was temporarily absent. Other processes were
running smoke/build commands in the shared checkout; generated extension, webview, and type artifacts changed during
the campaign. The final gate correctly reports `artifactsUnchanged: false` and failure. This is not a full live pass.

The original receipts remain intact. A stable working-tree snapshot was captured in the detached validation worktree
`F:\alpha-vscode-e2e-runs\tool-mustfix-snapshot-20260914`, with its HEAD, patch hash, and untracked-file hashes recorded in
`F:\alpha-vscode-e2e-runs\tool-mustfix-snapshot-20260914.json`. Capture checks verified the source did not change while it
was read. Dependencies were installed with `pnpm install --frozen-lockfile --offline`. The isolated rerun reuses the
same dedicated 1.136.1 profile and leaves the shared checkout's running processes alone.

### Isolated live campaign: passed

Campaign `tool-mustfix-live-1361-20260914-02` exited **0**. Its final gate reports **nine passed, zero failed, zero
blocked**, `stopReason: completed`, and `artifactsUnchanged: true`. Every scenario reports the actual host **1.136.1**,
exact model **gpt-5.6-luna**, and **high** reasoning effort.

| Scenario                     | Result | Model requests |
| ---------------------------- | ------ | -------------: |
| Git inspection               | Passed |              6 |
| Refactoring                  | Passed |              8 |
| Search recovery              | Passed |              8 |
| Completion and idle          | Passed |             19 |
| Empty-response recovery      | Passed |              3 |
| Provider-error recovery      | Passed |              3 |
| Stream cancellation/recovery | Passed |              5 |
| Reload continuation          | Passed |              6 |
| Background isolation         | Passed |              4 |
| **Total**                    |        |         **62** |

The campaign used one sample per scenario. Token usage and cost were unavailable; they are recorded as `null`, not
zero. This is a successful regression campaign, not evidence of a general performance or frontier-quality ranking.

The authoritative result is
`F:\alpha-vscode-e2e-runs\core-confidence\tool-mustfix-live-1361-20260914-02\gate-result.json`.
That directory retains per-attempt results, host identity/preflight receipts, evidence manifests, and the completed
retention receipt. The adjacent `tool-mustfix-live-1361-20260914-02.console.log` records the full invocation.

## Primary contracts consulted

Retrieved September 14, 2026:

- [VS Code's tool confirmation lifecycle](https://code.visualstudio.com/api/extension-guides/ai/tools).
- [Exact VS Code 1.122.1 API declarations](https://github.com/microsoft/vscode/blob/8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e/src/vscode-dts/vscode.d.ts).
- [Node 20.19.2 child-process cancellation](https://nodejs.org/download/release/v20.19.2/docs/api/child_process.html#child_processexecfilefile-args-options-callback).

The working tree already contained substantial unrelated changes. CLI/shim source, dependency versions, and release
versions were not edited. No live-model performance claim follows from a single campaign.
