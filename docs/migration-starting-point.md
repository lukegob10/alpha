# What works before the migration

Reviewed on 2026-09-18 using the release task, GitHub job results, and saved local test results.
No tests were rerun for this review.

**Step 2 is complete:** we have a recorded starting point, including failures and untested areas.
This does not mean every test passes or the migration is finished.

## Version we are starting from

- Alpha **2.1.49**, commit `b4cedc88c3db6ced8737f646629f3333a93040bf`.
- [Published release](https://github.com/lukegob10/alpha/releases/tag/vsix-v2.1.49-b4cedc8).
- Current local tools: Node **20.19.2**, pnpm **10.8.1**, npm **10.8.2**. CI configuration pins the same Node and pnpm versions.
- Reference VS Code version: **1.122.1**.
- The checkout was clean before this documentation update.

## Results for the released commit

| Check                                                          | Result                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| Build, package, and publish the extension                      | Passed                                                     |
| VS Code 1.122.1 smoke tests                                    | Passed                                                     |
| Command approval and outside-workspace path tests              | Passed                                                     |
| Packaged file checks                                           | Passed, including the release workflow's source comparison |
| Lint and TypeScript checks                                     | Passed                                                     |
| Translations and unused-file checks                            | Passed                                                     |
| Linux unit tests, repository-tool tests, and test-runner tests | Passed                                                     |
| Windows unit tests                                             | Failed in the extension's `src` test command, exit code 1  |
| Windows repository-tool and test-runner steps in that job      | Skipped after the unit-test failure                        |
| Separate VS Code core-confidence job                           | Passed                                                     |
| CodeQL analysis                                                | Passed                                                     |

Sources: [release/build results](https://github.com/lukegob10/alpha/actions/runs/35348727078),
[final automated test results](https://github.com/lukegob10/alpha/actions/runs/35348726933),
[CodeQL results](https://github.com/lukegob10/alpha/actions/runs/35348726909).

## Problems to carry forward

1. **Investigate the final Windows test failure before changing versions.** The job identifies the failing extension
   test command, but this review did not establish a failing assertion or root cause. Do not label it a flaky test yet.
   The earlier pull-request run passed Windows tests; that does not replace the failed run on the released commit.
2. **Resolve the skipped managed-agent UI test.** A separate local run on the released commit recorded 1,993 passing
   tests, no failing tests, and one skipped test. Its strict checking rules rejected that skip in `live-tree-ui`, leaving
   three dependent checks unsuccessful. Eight additional real-environment checks remained pending. These local results
   are separate from the successful final CI core-confidence job.
3. **Explain inconsistent results when reviewing the tests in step 5.** The
   [earlier pull-request run](https://github.com/lukegob10/alpha/actions/runs/35347549457) passed both platform test jobs
   but failed core confidence. The final run passed core confidence but failed Windows unit tests. The release notes
   describe the earlier results; use the final commit's job results for this starting point.

The local managed-agent report was generated at `2026-09-18T13:18:56.329Z` and recorded a clean, unchanged checkout of
`b4cedc88`. Its file is `artifacts/certification/managed-agent-milestone-evidence.json`; future runs may replace it.
Its recorded totals are preserved above. GitHub CI artifacts also have limited retention.

## Not established by this release

- Live-model task success, speed, or token-use improvements: no new comparative live runs were established by this review.
- Full evaluator coverage, including optional PostgreSQL/Redis-backed tests: not included in the inspected release/QA workflows.
- Installation and development inside the corporate environment: still step 9.
- Whether all important behavior has a strong test: still steps 5–6.

Proceed with planning steps 3–5. Investigate the recorded Windows failure before the toolchain upgrade so an existing
problem is not mistaken for a new one. Keep the skipped UI test and pending coverage on the test-improvement list.
