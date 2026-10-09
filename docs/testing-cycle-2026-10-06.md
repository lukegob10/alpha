# Testing cycle: October 6, 2026

This cycle starts from `cd6d8ef4fa3f94b872af75f34016a7156658d689` with existing task-control, reasoning and history
changes in the working tree. Those changes are preserved. The local environment is Windows, Node 24.21.0,
pnpm 11.24.0, TypeScript 5.8.3 and Vitest 3.2.4. Real-host checks use exact VS Code 1.125.0 with owned profiles and
scripted providers or the VS Code LM fixture. Live provider quality and performance improvement require separate runs.

The scope is a broad testing review with bounded repairs. The existing package runners, harness receipts and evidence
admission remain authoritative; this cycle adds no test engine or agent runtime.

## Baseline

The initial `unit` lane passed 12,960 tests with 33 declared skips. Its receipt is
`artifacts/harness/2026-10-07T01-17-37-414Z-8bb61ea8/result.json`. Repository tooling separately passed 204 checks.
`pnpm lint:all`, `pnpm check-types:all` and `pnpm knip` passed; some Turborepo tasks used matching cache entries.
Benchmark validation accepted the 48-task corpus structure, and fixture checking verified 28 declared broken-state
fixtures. Those checks do not certify the 40 calibrating tasks as admitted or establish model quality.

The configured service endpoints were unavailable. Two newly owned containers instead provided loopback-only Postgres
15.4 and Redis 7, using ephemeral ports, no persistent mounts and a dedicated `evals_test` database. Migrations applied
only there. All 22 database tests and one Redis service test passed. The Docker infrastructure lane separately passed
ten tests. Existing databases, containers, profiles and evaluator history were preserved.

## Findings and repairs

| Finding                                                             | Impact and owning boundary                                                                                                                                          | Repair                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High, should-fix: qualified Windows IPC endpoints could not connect | The evaluator returns `\\.\pipe\...`, but node-ipc 12 prefixes server paths again. A real qualified-pipe handshake timed out while the logical-pipe control passed. | Normalize only the Windows server transport argument, preserving the public endpoint and wire format.                                                         |
| Medium, should-fix: authored webview tests were omitted             | The webview configuration selected `.spec` files exclusively. Focused execution of two existing `.test.ts` files found no tests.                                    | Include both suffixes and independently compare authored files with runner selection across all seven unit packages.                                          |
| Medium, should-fix: cancelled Node tests lost their receipt         | Node 24.21.0 can collapse cancelled child tests into failed-file cumulative counts. The reporter rejected the disagreement and wrote no receipt.                    | For unsuccessful runs, aggregate per-file outcomes while retaining the unsuccessful cumulative verdict. Successful runs retain their strict count comparison. |

The IPC path contract was verified against the installed, lockfile-pinned `node-ipc@12.0.0` source. Its server prefixes
Windows paths unconditionally; its client recognizes an existing qualified prefix. The installed `node-ipc.cjs`
SHA-256 is `62c95f191c490c7185d6b2011379243b6256a45902347baf2f6f7e2d356afd43`.
Version-specific reporting and discovery rules were checked against primary
[Node 24.21.0 documentation](https://nodejs.org/docs/v24.21.0/api/test.html#event-testsummary) and
[Vitest 3 configuration](https://v3.vitest.dev/config/#include), retrieved October 6, 2026. The cancellation mismatch
was also reproduced directly on the pinned Node runtime. Product agent behavior and persisted/wire schemas are unchanged.

## Added coverage

This change adds 32 tests on Windows and restores execution of ten existing webview tests:

- Seven independent discovery guards cover extension, webview, types, core, IPC, telemetry and build tests. Fixture
  repositories and copied document examples retain their separate ownership. Failure output lists missing/extra files.
- Four real Node controls cover failed, cancelled, mixed passing/cancelled and TODO assertions. They verify counts,
  non-passing hard-gate results and omission of private assertion names, output and failure details.
- Fifteen IPC client cases cover handshake readiness, legacy and observed identities, malformed messages, ordered
  events, command schemas, reconnect state, independent clients and cleanup errors.
- Four server adapter cases cover qualified/logical Windows endpoints and unchanged Linux/macOS paths.
- Two real Windows socket cases exercise both endpoint forms with two clients: identity capture, command delivery,
  recipient-specific events, disconnect state and bounded cleanup. Other platforms run their native socket case.

Before repair, the new Node/discovery set had three failing regressions and 14 passing controls. The qualified Windows
round-trip failed at the first acknowledgement while its logical control passed. After repair, all 17 Node/discovery
checks, 28 IPC tests and ten restored webview tests passed. All 12 affected evaluator IPC consumer tests passed, as did
IPC lint and type checking. Race-sensitive fixtures use events, explicit aborts and bounded deadlines.

## Complete-cycle commands and evidence

Run build-bearing lanes serially, with unchanged source throughout receipt collection:

```sh
pnpm harness run static
pnpm harness run unit
pnpm harness run tooling
pnpm harness run offline
pnpm harness run host
pnpm harness run extended
pnpm harness run confidence
pnpm harness run outcomes
pnpm harness run services
pnpm harness run infrastructure
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-3.1.6.vsix --check-source
```

Service commands require an explicitly owned isolated test database and Redis instance; the local cycle supplies their
endpoints through the process environment. The existing profile and container owners retain their cleanup rules.
Rendered UI checks use the existing exact-host runners for reasoning/task hotkeys, history, task navigation, Tickets
and file review. Their results supplement host contracts rather than replacing them.

The final local evidence index is written to `artifacts/harness/testing-cycle-2026-10-06/report.md`, with its strict
matrix beside it. Per-lane receipts stay in their timestamped harness directories. Source-bound earlier receipts remain
historical after edits; command exit codes alone cannot establish current execution evidence. Declared unit and runner
skips remain visible and are not promoted into fully executed strict acceptance.

## Closure ledger

- **Fixed now:** webview discovery omissions, failed Node cancellation reporting, and double-prefixed Windows evaluator
  IPC paths; the associated guards and transport coverage are included in ordinary CI test commands.
- **Flagged for follow-up:** remaining declared skips and the real language-server coverage gap in the existing matrix.
- **Not verified by local Windows results:** Linux/macOS execution, live provider behavior, model quality or variance,
  and representative before/after performance. Existing three-platform CI and separately budgeted live runs own these.
- **Out of scope:** historical evaluator data migration, live-provider experiments and agent architecture changes.

The final index records actual cycle outcomes, unresolved failures and retained evidence. A passing deterministic cycle
does not imply complete surface coverage or production readiness.
