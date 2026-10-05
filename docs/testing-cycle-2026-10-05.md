# Testing cycle: October 5, 2026

The baseline is main commit `478f60804bbde28e0092bd475871addb85b50062`, after [PR #135](https://github.com/lukegob10/alpha/pull/135). The local environment is Windows,
Node 24.21.0 and pnpm 11.24.0. Extension-host checks use exact VS Code 1.125.0, disposable owned profiles, scripted
providers and the VS Code LM fixture where required. No live model capacity was used.

## Baseline evidence

| Check                                                     | Observed result                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm lint:all`, `pnpm check-types:all`, `pnpm knip`      | Passed                                                                                 |
| `pnpm harness run static`                                 | Passed with unchanged source                                                           |
| `pnpm harness run unit`                                   | 12,905 passed, 33 declared skips across extension, React and shared packages           |
| `pnpm harness run tooling`                                | 185 repository checks and 551 runner checks passed; two platform-specific runner skips |
| `pnpm harness run offline`                                | 384 unit, 20 contract and five certification tests passed                              |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`    | All 13 required host files passed                                                      |
| `pnpm harness run confidence`                             | Passed: all 18 host files and strict managed-agent certification                       |
| `pnpm harness run outcomes`                               | Passed: all three independently asserted scripted workflows                            |
| `pnpm --filter @alpha-code/evals test:docker`             | All 10 infrastructure tests passed                                                     |
| `pnpm --filter @alpha-code/evals test:services`           | 22 database tests and one Redis test passed                                            |
| `pnpm --filter @alpha-code/evals benchmark:validate`      | Two suites and 48 task definitions valid; eight admitted, 40 calibrating               |
| `pnpm --filter @alpha-code/evals benchmark:fixture-check` | All 28 fixture states valid                                                            |
| NOR36 request preflight Vitest probe                      | One deterministic test, nine request samples passed                                    |
| Managed-agent live preflight                              | Playbook validation passed; this is not a live evaluation                              |

The normal configured service endpoints were unavailable. Database and Redis tests instead used temporary loopback-only
Postgres 15.4 and Redis 7 containers, with a dedicated `evals_test` database and no persistent mounts. Test migrations ran
only against that owned database. Existing services and saved evaluator history were preserved.

Local receipts remain under `artifacts/harness/`; their source digests and execution inventories distinguish observed
passes from discovery. Ordinary unit skips are retained rather than promoted to full execution. They include Windows
symlink cases, disabled Swift parsing/performance experiments, legacy provider tests and two welcome-view placeholders.

## Coverage changes

The existing runners and evidence admission remain the owners. The new `extended` lane runs four additional host files:
instruction discovery, HTML document previews, offline storage recovery and scheduled tasks. It uses the same exact-host
receipt checks as smoke/confidence and requires every selected test. QA and both release workflows execute the lane and
require its evidence.

Scheduled-task host coverage exercises real activation and production persistence, edits/duplication/pause/resume/delete,
workspace rejection, an overlapping manual run, successful command output, explicit deny rules before any effect and
nonzero exit preservation. A controlled file barrier makes overlap deterministic. Fixtures, command effects and profiles
are owned by the test; no provider request is needed.

The coverage matrix now explicitly includes Tickets, skills, scheduled tasks and HTML previews. Existing unit/UI tests
and actual selected host tests are mapped to their owners. Offline lock recovery has a separate record: it cannot imply
that the phased cross-host storage restart campaign ran.

New CLI packaging regressions exercise missing critical assets, credential-file exclusions, platform-incompatible
ripgrep binaries, invalid archives and stale copied document assets. Their portable archive fixtures validate the content
checker; a real `pnpm vsix` package and `--check-source` verification remain separate validation.

Manifest regressions resolve every contributed localization reference and enforce English-only extension resources.
Evaluator discovery independently enumerates test files and requires exactly one configured suite owner for each, so
new tests cannot silently disappear between unit, contract, certification, services and infrastructure selection.

The existing CI unit/tooling matrix adds macOS alongside Windows and Linux. All platforms use the same harness commands
and retain execution reports; the local Windows cycle alone does not establish a macOS pass.

## Repeat the cycle

```sh
pnpm harness run static
pnpm harness run unit
pnpm harness run tooling
pnpm harness run offline
pnpm harness run host
pnpm harness run extended
pnpm harness run confidence
pnpm harness run outcomes
pnpm harness matrix --output artifacts/harness/matrix-cycle.json --require static --require offline --require host --require extended --require confidence --require outcomes
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-<manifest-version>.vsix --check-source
```

Run build-bearing lanes serially and keep source unchanged during receipt collection. Services and Docker remain optional
lanes with their existing prerequisites. The cycle establishes deterministic contracts and scripted task outcomes;
live-provider quality, live UI acceptance, full task-bank admission and broad performance improvement need separately
declared experiments and budgets. No quality or speed increase is inferred from this single cycle.
