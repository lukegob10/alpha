# NOR-67 Rich documents validation

Date: 2026-09-14. Baseline: `bc66591b605f9ffa77ae40b210c074b525210e4d`, Alpha 2.1.36, VS Code 1.122.1. Core implementation: `59cc84448174ec38d189628b4eec9c03f9e2a141`. Integration fix: `a30482de858cbd3bafe2439aa049c95b1da5c14f`. Release status remains In Progress until the integrated visual and reload gates are closed.

## Scope

The installed `assets/skills/rich-documents/SKILL.md` participates in normal skill discovery. Project and personal overrides take precedence, mode eligibility remains intact, and persisted disablement suppresses future built-in discovery. Settings controls edit `cachedState` until Save. Built-in inspection uses a read-only content provider, and backend mutation guards also reject symlink aliases into installed skills.

Progressive references point to four packaged kit files. The real host exposed a scheduler rejection for these outside-workspace reads. The fix admits only `read_file` for the exact installed reference and three examples, after physical-path validation. It preserves ordinary tool availability and approval checks; it does not add workspace roots or grant write, search, directory-listing, traversal, arbitrary asset, or symlink-escape access. No CLI or shim source was changed.

## Automated evidence

| Check                                     | Result                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills manager                            | 64 tests pass, including precedence, disablement, captured paths, and read-only aliases                                                                          |
| Skill webview handlers                    | 27 tests pass                                                                                                                                                    |
| Built-in inspection provider              | 15 tests pass                                                                                                                                                    |
| Settings UI                               | 23 SkillsSettings and 22 SettingsView tests pass, including cached edits and Save                                                                                |
| Scheduler after packaged-reference fix    | 60 tests pass                                                                                                                                                    |
| Final kit runtime                         | 26 tests pass                                                                                                                                                    |
| Actual examples through sanitizer and kit | 7 tests pass; semantic data, source references, filters, sorting, charts, and disposal verified                                                                  |
| Extension typecheck                       | Pass                                                                                                                                                             |
| E2E compile and lint                      | Pass                                                                                                                                                             |
| Monorepo precommit lint                   | 12 packages pass                                                                                                                                                 |
| `pnpm bundle` and `pnpm vsix`             | Pass                                                                                                                                                             |
| Archive verification                      | 1,855 entries; required skill, kit, viewer, sanitizer worker present; no `.env` files                                                                            |
| Actual 1.122.1 development-host workflow  | Both built-in and project tests pass in run `0b3eb623-6f5d-4887-a8ed-91635ecdbe79`                                                                               |
| Actual installed VSIX workflow            | Both tests pass in run `ae3fe457-d2cb-4394-b639-5e07f6aafc8a`; exact installed identity, host version, process ownership, and complete evidence capture verified |

The workflow runs `skill`, `read_file`, and `write_to_file` through the captured task tool path. Each source case performs seven successful tool transactions over three turns: create version 1, write unsupported version metadata, and repair the same file to version 1. It checks real instructions/reference content in provider inputs, one task and canonical file, accepted viewer titles on revisions 1 and 3, automatic refresh, one panel, close/reopen, and balanced persisted tool receipts. The project case also removes its override and verifies the disabled built-in does not reappear.

These title observations establish extension-to-viewer acceptance, not DOM paint or visual quality. Completion review is explicitly acknowledged and persistence settles before follow-up. Earlier test attempts caught inactive-extension export enumeration, Windows newline normalization, and completion-settlement assumptions; the assertions were corrected without weakening the successful-tool requirement.

The installed artifact was `bin/alpha-2.1.36.vsix`, SHA-256 `e19d2047cba34e0095eddfe3087609457b8de0d88916d0720cb595361bf138c1`. It includes the final static-table example guidance and stable filter/disclosure IDs. Installation and execution used a dedicated marked profile under the system temporary directory, not the user's regular editor profile. The installed run records ten provider requests and seven successful tool calls/results per source, accepted revisions 1 and 3, same-file refresh/reopen, and the actual installed extension path. Persistent run artifacts include `host-preflight.json`, `host-completion.json`, `manifest.json`, and both `rich-documents-*.json` receipts. The first installed run failed because the expected-version environment variable was omitted; the successful run supplied `ALPHA_E2E_INSTALLED_EXTENSION_VERSION=2.1.36` and retained the identity assertion.

The translation checker reports existing common/chat/package translation gaps. All new built-in controls, read-only errors, and kit keys are localized across the 18 supported locales; the unrelated translation backlog remains.

## Independent authoring evaluation

An independent authoring agent read the installed skill and reference, then produced a review, a CSV-export specification, and a quantitative report. The inputs were explicitly fictional fixtures, and outputs retain that distinction.

The review identifies premature completion from `forEach(async ...)`; a controlled-promise check reproduces it and verifies the proposed sequential behavior. The specification distinguishes requirements from unresolved spreadsheet-formula policy. The report preserves exact supplied observations (210 ms, 190 ms, missing; 1,000, 1,200, 1,100 requests), separates units, retains tables, and correctly derives a 20 ms difference and 3,300 requests without claiming an aggregate percentile or throughput.

Browser inspection covered wide and 420 px layouts, keyboard chart focus with exact accessible values, and native disclosure activation. It caught an unnecessary row count on a static spec table; the same artifact and skill guidance were corrected. These browser screenshots preceded the kit's final dark-chart contrast update and do not substitute for actual-host theme validation. Local evaluation files and hashes are recorded under `.tmp/nor67-authoring/`, excluded from source control and extension packaging.

## Remaining release evidence

Second-process installed reopen passed in run `c34b4e60-e0c3-43d5-8286-fef85586d4fc`, with a new VS Code process (39744) and extension host (59668), compared with the first run's 44228 and 60452. The same persisted authored source retained SHA-256 `e73066ea03bcc3d60b2d0ffffbfd4d9f30e6cd293da08de43e0af017788ef5db`, opened cleanly with the accepted revision-3 title, and was not regenerated. The receipt explicitly leaves DOM paint and source-anchor clicks unverified for this fixture, which contains no source anchors.

Separately, NOR-66 observed **Developer: Reload Window** restore all three reference documents, including review filter/disclosure state. Clicking the restored review source reference opened `src/export/resolveDestination.ts` at line 7, column 1. Its actual-host screenshot is `source-after-reload.png` in NOR-66's local `.nor66-visual/` evidence. This direct UI proof is distinct from the installed authored-file identity test.

Reproduce the second-process test after the authoring run with the same marked profile and workspace (the HTML must already exist):

```powershell
$fixtureRoot = Join-Path $env:TEMP 'alpha-nor67-installed-20260914'
$env:ALPHA_E2E_INSTALLED_EXTENSION_VERSION = '2.1.36'
$env:ALPHA_RICH_REOPEN_PATH = Join-Path $fixtureRoot 'workspace/rich-document-builtin-8586a868-5d47-4017-b59f-51b97caf6bbd.html'
$env:ALPHA_RICH_REOPEN_SHA256 = (Get-FileHash -LiteralPath $env:ALPHA_RICH_REOPEN_PATH -Algorithm SHA256).Hash.ToLowerInvariant()
pnpm --dir apps/vscode-e2e exec node out/runTest.js --vscode-version 1.122.1 --provider scripted --file rich-documents-reopen.test --installed-extension "$fixtureRoot/profile/1.122.1/extensions/alphainc.alpha-2.1.36" --profile-dir "$fixtureRoot/profile" --workspace "$fixtureRoot/workspace" --artifacts-dir "$fixtureRoot/artifacts"
```

The exact retained receipt is `$fixtureRoot/artifacts/c34b4e60-e0c3-43d5-8286-fef85586d4fc/rich-documents-reopen.json`; its sibling manifest records verified process ownership, exact host version, successful completion, and complete evidence capture. A fresh authoring run generates a different file name; select that persisted output and retain its first-run hash before restarting.

Final actual-host visual/theme/focus checks, same-content Alpha Markdown comparison, and final package reconciliation remain required before marking the issue Done. See the NOR-65 and NOR-66 validation records for their own evidence and limitations; do not infer those gates from unit tests or command dispatch.
