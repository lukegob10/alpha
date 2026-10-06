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

The first macOS run exposed two existing fixture defects: Node resolved a native package through `/private/var` while
its fixture compared the symlinked `/var` spelling, and an outer shell expanded PowerShell variables before `pwsh`
received them. The native fixture now records its canonical root. The PowerShell fixture passes a literal argument
array, with three regressions for quoting, normalized output and failed command/spawn status. Its existing large-output
test now requires an exact normalized match on every platform. These corrections stay in test fixtures.

The next macOS run passed the full unit suite and exposed the same temporary-path alias in three evidence fixtures.
Evidence and host-runner tests now canonicalize their freshly created temporary roots before calling strict path owners.
Production path checks still reject symlinks. A new provenance regression requires the canonical root to succeed, its
linked spelling to fail for the intended reason, and explicit filesystem resolution to preserve the source identity.
The receipt-path regression also verifies its canonical positive control before asserting symlink rejection.

## Candidate validation

Commit `561965bf46f76328cd076e2c1d34c6acd196dfca` passed the complete local `static`, `tooling`, `offline`, `host`,
`extended`, `confidence` and `outcomes` cycle with unchanged source. Strict matrix admission accepted all six required
lanes. Extended executed nine tests across its four selected files; confidence executed all 18 host files and all
3,138 certification tests across ten tracks, with no certification skips. Outcomes completed all three scenarios.
The first CI cycle passed every job except the two macOS fixture failures described above.

The change adds 29 tests: five scheduled-task host cases, 12 packaging cases, two manifest contracts, seven
discovery/evidence/workflow guards and three PowerShell fixture regressions. The corrections passed all 24 focused
native-package/PowerShell tests, all 42 focused harness/packaging tests and the extension type check. `pnpm bundle` and
`pnpm vsix` succeeded; content verification checked all 1,675 archive entries and matched all 16 document assets to
current source bytes. The final temporary-root corrections passed all 15 focused evidence/provenance cases and the
complete tooling lane: 204 repository checks and 551 runner checks passed, with two declared Windows-only runner skips.
The host-runner lint and ESM type check passed. CI validates the corrections through the same three-platform jobs.
Source-bound evidence from earlier revisions remains historical rather than being reused as current evidence for a
later correction.

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
