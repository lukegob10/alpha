# Standalone CLI retirement

Date: 2026-09-17. Scope: contract alignment and deletion of Alpha's standalone CLI.

## Plan and boundaries

1. Remove `apps/cli`, its exclusive `packages/vscode-shim`, CLI release automation,
   stdin/event schemas, debug logger and core CLI entry point. Prune only dependencies
   no longer reachable from the remaining workspace packages.
2. Remove the `ROO_CLI_RUNTIME` branches from command timeouts, approval preparation
   and profile restoration. Preserve the existing VS Code behavior, shared execution
   kernel, tools, IPC, task history, skills, MCP, terminal sessions and all extension surfaces.
3. Keep the existing VS Code evaluation runner. Remove the CLI runner and execution
   selector. Reject CLI execution in new run requests. Keep historical database values
   readable; attempts to execute a retired CLI run must fail before launching an agent,
   with an actionable message. Do not relabel historical results or delete user data.
4. Run focused regressions, workspace lint/types/tests and dependency checks, then
   bundle, package inspection, the exact VS Code 1.122.1 smoke gate and the unattended
   live Copilot harness exercise.

The dependency search found no extension import of the shim or CLI protocol. Shared
packages remain; only their exclusively CLI exports are removed. Development commands
and the evaluation orchestrator under `packages/evals/src/cli` remain: these launch
tests and the real VS Code extension, not a second Alpha agent application.

The checkout already contained unrelated and earlier harness work. Its pre-removal
state was captured outside the repository in
`alpha-cli-removal-baseline-20260917-003553` under the local temporary directory.
Those changes must remain intact. This task does not publish a release, change a version,
remove installed software, delete home-directory data, or rewrite past release notes.

## Compatibility and verification

The intentional removals are the standalone `alpha` executable, its shim, CLI-only
package exports and CLI evaluation execution. Existing extension APIs and saved task
formats retain their contracts. Retired paths remain forbidden in automated patch
plans so subsequent extension maintenance cannot recreate a parallel CLI.

The implementation removes 223 tracked files (37,206 lines) and 26 exclusive dependency
versions. Remaining workspace importers and dependency versions are unchanged. The
lockfile change contains deletions only. Historical release notes remain as history;
unused CLI announcements and the CLI release/debug instructions are removed.

Regression tests verify that an inherited retired environment flag cannot suppress
command timeouts or saved provider restoration. Evaluation tests exercise VS Code
routing, cancellation, failure, budget-result classification, and rejection of legacy
CLI runs before launching a local agent or container. The server action validates new
run requests before creating database records. Historical database values remain readable.

## Validation record

Commands ran with Node 20.19.2 and pnpm 10.8.1. Logs and the changed-file inventory are
under `F:/alpha-vscode-e2e-runs/cli-retirement-20260917/validation`.

| Check                                        | Result                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | Passed; no remaining dependency versions changed                                                   |
| `pnpm lint`                                  | 10 workspace tasks passed                                                                          |
| `pnpm check-types`                           | 11 workspace tasks passed; web-evals rechecked after its final test changes                        |
| `pnpm knip`                                  | Passed                                                                                             |
| `pnpm test --env-mode=loose --concurrency=2` | Passed: extension 9,344; webview 1,828; core 167; types 313; IPC 3; web-evals 37; build 1          |
| Evaluation unit tests                        | 216 passed with current evaluator source and committed fixture/migration bytes in an isolated copy |
| Evaluation certification                     | 5 passed, including 20 serial and 5 concurrent scenario repetitions                                |
| Evaluation contracts                         | 16 passed; one existing Windows shell-glob limitation, described below                             |
| `pnpm bundle`, `pnpm vsix`                   | Passed; version unchanged at 2.1.44                                                                |
| VSIX contents and source-asset check         | 1,856 entries verified; 16 document assets match; no `.env` files                                  |
| `test:smoke:1221`                            | Passed on actual VS Code 1.122.1                                                                   |
| Removal diff whitespace check                | Passed; unrelated pre-existing changes preserved                                                   |

Workspace tests retain the existing 42 extension and 3 webview skips. Vitest worker
limits were set to four through `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS`, with minimums
of one, to avoid excessive Windows process contention.

The working checkout contains pre-existing CRLF bytes in content-addressed evaluation
fixtures and some migration files. The first evaluation unit run had five hash failures.
The committed bytes match the existing expected hashes. All 216 tests pass in an isolated
copy containing the current evaluator source and those exact committed fixture/migration
bytes; no fixture, migration, hash, or assertion in this checkout was changed.

The remaining evaluation contract failure is the existing calibration fixture command
`node --test test/*.test.js`: Windows does not expand that shell wildcard with this Node
20 toolchain. Docker's Linux daemon is unavailable, so database/Docker integration and
the evaluation image build were not run. Translation diagnostics are identical to the
pre-removal baseline, including its existing missing translations.

Automatic approval review rejected recursive cleanup of the retired packages' ignored
local build/dependency folders with a policy restriction. Their tracked sources and
manifests are removed; ignored local caches remain. No installed CLI or home-directory
data was removed.

Additional host checks passed on VS Code 1.122.1:

- Runner unit tests: 374 passed, 2 existing skips.
- Three simple-answer cases: one request, no tools, one durable completion each.
- Completion review: edit, commit, follow-up, a measured idle interval, then another
  follow-up in the same task, without an extra request during idle.
- Managed agents: nested Apply, discard, verification, projection and navigation,
  without manual input.
- Command paths: approved scripts execute automatically while each outside write
  still requires its own path approval.
- Docker Compose configuration validation and offline-certification script syntax pass.

The installed production bundle matches the VSIX bundle exactly (SHA-256
`39e2d43235898115a29df2a92c1b03701ac2278098989a1581ee69526221c471`). The archive's
SHA-256 is `35c8ddefc493177b8f6c3f3b6ff88b1d8339f11c67509a3681e11b2c4fd3aa2e`.
Both production and development bundles contain no retired runtime flag. Their hashes
differ because packaging minifies the production bundle.

## Live Copilot evidence

The installed VSIX was exercised on VS Code 1.122.1 with Copilot `gpt-5.6-luna`, high
reasoning effort, fresh owned workspaces and the existing unattended browser-approval
fixture. No manual browser approval was required.

| Scenario                                                  | Result                        | Model requests | Wall time |
| --------------------------------------------------------- | ----------------------------- | -------------: | --------: |
| Repair a failed declared check; persist reusable evidence | Passed                        |              8 |    46.6 s |
| Start, inspect and stop an owned delayed server           | Passed                        |              6 |    35.9 s |
| Compose two skills and preserve workflow constraints      | Passed                        |             10 |    54.0 s |
| Browser interaction, combined run                         | Failed: native click timeouts |             14 |   108.7 s |
| Browser interaction, isolated diagnostic rerun            | Passed                        |              9 |    53.5 s |

The first browser attempt opened pages successfully but the host's `click_element`
timed out waiting for a visible, enabled, stable button. The model stopped its server
and accurately reported a blocked outcome; the test rejected that outcome. One isolated
rerun with the same package, model, host and assertions passed. These results establish
passing coverage for each scenario, not a clean combined live run or a general reliability
improvement. No browser implementation or test assertion was changed for this retirement.

Both attempts are retained under `artifacts/cli-retirement-luna-1221-1` and
`artifacts/cli-retirement-luna-1221-2` in the run directory. `validation/live-summary.json`
records successes and the initial failure. Both test hosts exited, and server terminal
outcomes were observed.
