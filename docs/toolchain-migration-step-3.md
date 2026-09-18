# Roadmap step 3: Node, pnpm, and npm migration

Date: 2026-09-18  
Branch: `codex/toolchain-migration`  
Starting commit: `b4cedc88c3db6ced8737f646629f3333a93040bf`

## Target contract

- Node.js `24.14.1`
- npm `11.11.0`
- pnpm `11.24.0`
- VS Code `1.122.1` remains the extension compatibility host

The repository remains pnpm-managed. The root package manager, engines, `.nvmrc`, `.tool-versions`, extension manifest,
bootstrap script, GitHub Action, hooks, tasks, evaluator container, and current setup documentation now agree on the
target versions. Registry URL and scope are optional inputs to the shared CI setup action; no registry endpoint or
credential was committed.

pnpm 11 workspace configuration now owns build approvals and dependency overrides in `pnpm-workspace.yaml`. The
explicit `allowBuilds` values preserve the previous ignored-build policy while allowing the required ripgrep build, and
the lockfile remained unchanged.

## Pre-migration investigation

Before changing versions, the known Windows final-QA failure from job `35348726933` was investigated with a bounded,
read-only Astra xhigh diagnosis. The failure was in `AgentControlStore.queue-diagnostics.spec.ts`, where a 75 ms
file-persistence admission deadline expired during test setup. The production default is 30 seconds; the test fixture
uses real Windows file I/O.
This is a timing-sensitive test-fixture failure rather than evidence of a Node 24 or pnpm 11 regression. The local
Node 20 baseline also passed the full suite, while the exact pre-migration CI failure was recorded separately.

## Validation

Under Node `24.14.1`, npm `11.11.0`, and pnpm `11.24.0`:

- `pnpm install --frozen-lockfile` passed with the existing lockfile.
- `pnpm test --env-mode=loose` passed: 589 source files passed, 3 skipped; 9,428 source tests passed, 42 skipped;
  the webview suite passed with 1,829 tests passed and 3 skipped.
- `pnpm lint` passed.
- `pnpm check-types` passed.
- `pnpm test:tooling` passed: 9 tests passed.
- `pnpm --filter @alpha-code/vscode-e2e test:unit` passed: 374 tests passed and 2 skipped.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed all 3 runs against VS Code `1.122.1` (10 smoke tests).
- `pnpm vsix` completed, and `node scripts/verify-vsix-contents.mjs bin/alpha-2.1.49.vsix` verified all 1,857
  packaged entries and no `.env` file.

The only code-adjacent test adjustment makes deferred Windows directory deletion explicit in the cleanup fixture. It
keeps the test focused on retry behavior across Node versions instead of depending on whether a particular Node/Windows
combination allows `rmdir` while a read handle remains open.

External corporate registry authentication, Docker evaluator execution, live provider evaluation, merge, publish, and
deployment were not part of this migration and were not performed.

Upstream migration references: [pnpm v11 migration guide](https://github.com/pnpm/pnpm.io/blob/main/docs/migration.md)
and [pnpm 11 release notes](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md).

## Follow-up review

The follow-up review found and corrected a testing-command problem: the documented `pnpm ... test -- <file>` examples
passed a literal separator to Vitest under pnpm 11.24.0 and ran the whole suite. The examples now pass file filters
directly after `test`. The corrected command ran exactly two selected files, with all 58 tests passing. An isolated
argument check confirmed that pnpm 10.8.1 also forwards that separator, so this was an existing documentation problem.

Additional checks run during review:

- Command approval and outside-workspace path checks passed in the actual VS Code 1.122.1 host.
- `pnpm test:evals:offline` passed: 217 unit tests, 17 contract tests, and 5 certification tests.
- VSIX verification with `--check-source` passed: 1,857 entries and all 16 document assets matching source bytes.
- Added six offline installer tests covering the exact pnpm version, missing/outdated pnpm, frozen installation,
  lifecycle recursion, and failure exit codes. `pnpm test:tooling` now runs these plus the existing installer tests;
  all 15 passed.
- Formatting was corrected for the edited setup/configuration files. Unrelated snapshot line-ending changes were removed.
- Dependency versions and the lockfile remain unchanged. No extension runtime implementation was changed.

The whole-suite run triggered by the old example had 9,427 source tests pass, 42 skipped, and one 20-second timeout
in `Task.ticket-progress.spec.ts` (selective-parallel deletions). The file then passed all seven tests with
`--maxWorkers=2`. That rerun does not erase the timeout; it remains evidence of test reliability to investigate in
roadmap step 5.

The final full `pnpm test --env-mode=loose` rerun used the worker limits from `.github/workflows/code-qa.yml`
(`VITEST_MAX_FORKS=2`, `VITEST_MIN_FORKS=1`, `VITEST_MAX_THREADS=2`, `VITEST_MIN_THREADS=1`). It passed all eight
build/test tasks without cache hits: 9,428 source tests passed with 42 skipped, and 1,829 webview tests passed with
3 skipped. This supports the local migration result without treating the earlier timeout as resolved.

The migration task used `nvm use 24.14.1`, so the machine's active Node installation is now the new version; it did not
use a worktree-only runtime. The original `main` checkout still declares the old versions until this branch is integrated.

These are local results. The revised GitHub setup action, corporate Artifactory access, and full Docker evaluator image
still need their own environment checks. At review time, the edits were uncommitted and had not been merged or published.

The migration was subsequently moved into `F:\roo-fork\Alpha-Code` on `codex/toolchain-migration`. Frozen installation
passed there with the pinned tools. The user tested the development extension and approved committing and pushing the
migration branch. Merging and releasing remain separate steps.
