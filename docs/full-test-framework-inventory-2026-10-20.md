# Full testing framework inventory

Inspected on 2026-10-20 against the current manifests and runner source. This inventory records available coverage and
execution conditions; it makes no test outcome or performance improvement claim. Root `AGENTS.md` is the applicable guide.

All host evidence requires exact VS Code **1.138.0**. Use the pinned Node 24.21.0 and pnpm 11.24.0. Serialize host launches
and any command rebuilding `apps/vscode-e2e/out`, extension bundles, webviews or shared package outputs. Test-owned paired
hosts within one controller remain permitted. Preserve the existing signed-in profile at `F:/alpha-e2e/profiles`; use
separate fresh profiles for scripted acceptance and renderer fixtures.

## Deterministic and infrastructure frameworks

Source owners: [`package.json`](../package.json), [`catalog.mjs`](../scripts/harness/catalog.mjs),
[`run.mjs`](../scripts/harness/run.mjs), [E2E manifest](../apps/vscode-e2e/package.json),
[evaluator manifest](../packages/evals/package.json) and the evaluator `vitest.*.config.ts` files.

| Framework                    | Command                                                                                                   | Coverage and conditions                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| All retained static packages | `pnpm lint:all`, `pnpm check-types:all`, `pnpm knip`                                                      | Default lint/type gates cover the extension, webview, E2E and dependencies; `:all` includes evaluator/tooling packages.                    |
| Full aggregate               | `pnpm test:all`                                                                                           | Bundle and extension/dependency/webview tests, tooling, E2E runner units, full evaluator tests. Stops when an aggregate stage fails.       |
| Tooling                      | `pnpm test:tooling`                                                                                       | Root, harness and evaluation script Node tests.                                                                                            |
| Evaluator without services   | `pnpm test:evals:offline`                                                                                 | Evaluator units, contracts and golden certification; no provider requests, Postgres, Redis or Docker.                                      |
| Evaluator services           | `pnpm test:evals:services`                                                                                | Readiness, Postgres query integrations and Redis contracts; use dedicated local test services.                                             |
| Real Docker                  | `pnpm test:evals:infrastructure`                                                                          | Linux Docker engine and `redis:7-alpine` / `postgres:15.4`; outages, limits, isolation, cleanup and image/context contracts.               |
| Benchmark admission          | `pnpm --filter @alpha-code/evals benchmark:validate`, `benchmark:fixture-check`, `benchmark:author-check` | Manifest, initial fixture and authoring checks; configured private bundles are needed where referenced.                                    |
| Strict host smoke            | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1380`                                                    | Thirteen real host launches including activation, modes, approval, tools, Tickets, input, compaction, LM contract and background commands. |
| Extended host                | `pnpm --filter @alpha-code/vscode-e2e test:extended:1380`                                                 | Instructions, HTML previews, storage recovery, schedules and rich documents.                                                               |
| Core host                    | `pnpm --filter @alpha-code/vscode-e2e test:core:1380`                                                     | Smoke plus core loop/boundaries, idle completion, managed agents and long-context fanout.                                                  |
| Cross-task host              | `pnpm --filter @alpha-code/vscode-e2e test:cross-task:1380`                                               | Separate cross-task orchestration acceptance.                                                                                              |
| Managed certificate          | `pnpm certify:managed-agents:automated`                                                                   | Strict deterministic matrix plus four managed-agent host suites, including non-Git and automatic application.                              |
| Core confidence              | `pnpm test:core:confidence`                                                                               | Runner units, smoke, core regressions, five core hosts and strict certification using this run's real idle-completion projection replay.   |
| Local repository outcomes    | `pnpm harness run outcomes`                                                                               | Three scripted task outcomes: Git inspection, bootstrap, edit/test/local commit/follow-up; independent filesystem/Git assertions.          |
| Final package                | `pnpm bundle`, `pnpm vsix`, `node scripts/verify-vsix-contents.mjs bin/alpha-3.2.4.vsix --check-source`   | Verify final artifact against the frozen source after implementation.                                                                      |

`pnpm evals:offline-certify` and its `:full` variant are **model-offline**, not infrastructure-free: the
[script](../scripts/offline-certify.mjs) invokes Redis/Docker infrastructure tests, admission checks and optional private
tests. Evaluator integration [global setup](../packages/evals/vitest-global-setup.ts) truncates all public base tables.
The [target guard](../packages/evals/src/db/testDatabaseTarget.ts) requires loopback `/evals_test` without URL parameters;
use an owned ephemeral instance and never an existing development/shared database or queue.

For already-compiled runner units, `node apps/vscode-e2e/out/runUnitTests.js` avoids a rebuild. The
[runner](../apps/vscode-e2e/src/runUnitTests.ts) selects all `.spec.js` outside `suite/**`, runs two Node files concurrently
and removes the host receipt destination from child environment. It launches owned Node/shell fixtures rather than VS
Code. Fake sidecar-launch tests call [`prepareLiveSidecar`](../apps/vscode-e2e/src/liveHostProtocol.ts), which may
materialize `out/package.json`; after matching live-sidecar preparation it returns without changing bytes. Keep unit
reports separate from host receipts and do not compile concurrently.

## Actual renderer and local acceptance frameworks

The following E2E package commands build and exercise trusted input in the actual webview:

| Surface                     | `pnpm --filter @alpha-code/vscode-e2e` command / compiled owner                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Composer                    | `test:composer-ui:1380` / `runComposerUi.ts`                                                                           |
| Request input wizard        | `test:request-user-input-ui:1380` / `runRequestUserInputUi.ts`                                                         |
| Reasoning and model changes | `test:reasoning:1380` / `runReasoningUi.ts`                                                                            |
| History                     | `test:history-ui:1380` / `runHistoryUi.ts`                                                                             |
| Task navigation             | `test:task-navigation-ui:1380` / `runTaskNavigationUi.ts`                                                              |
| Tickets                     | `test:tickets-ui:1380` / `runTicketsUi.ts`                                                                             |
| File review                 | `test:file-review-ui:1380` / `runFileReviewUi.ts`                                                                      |
| Native editor chat reopen   | `node apps/vscode-e2e/out/runEditorChatReload.js`; set `VSCODE_EXECUTABLE_PATH` and fresh `ALPHA_EDITOR_RELOAD_OUTPUT` |

Owners are under [`apps/vscode-e2e/src`](../apps/vscode-e2e/src). Native editor reopen uses two actual processes, a separate
owned profile and a loopback provider. It verifies serialized chat/draft restoration and fresh input routing; it does not
establish abrupt-crash or arbitrary remote-provider recovery.

Installed-artifact suites are separate: `installed-extension.test` requires `--installed-extension` inside the owned
profile's extensions directory; `rich-documents-reopen.test` requires the authored path/hash and installed identity;
`rich-documents-preferences.test` requires explicit prepare/verify phases and matching phase selection so intentional
opposite-phase skips cannot masquerade as acceptance. `profile-persistence.test` needs two owned launches with
`ALPHA_E2E_PERSISTENCE_PHASE=prepare|continue` and one fresh `ALPHA_E2E_PERSISTENCE_NONCE`; it checks only a synthetic
public marker in real global/workspace/secret storage and never enumerates authentication keys.

[`local-acceptance.mjs`](../scripts/harness/local-acceptance.mjs) exposes seven further strict host drivers:

```text
pnpm harness:acceptance <case> --output <fresh-absolute-external-directory> --vscode-executable <1.138.0-Code.exe>
```

| Case               | Evidence sought                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancellation`     | Parent Stop, non-cooperative local HTTP stream, Worker process tree, canonical terminal results and cleanup.                                                    |
| `budgets`          | Scripted role/output/root token limits, including Worker process cleanup.                                                                                       |
| `nested-restart`   | Abrupt termination/restart, capacity denial/reuse, partial/empty Worker recovery, nested discard and preserved identity; two phases capped at 150 seconds each. |
| `rendered-ui`      | Actual compact tree, attention, navigation and Settings edit buffering.                                                                                         |
| `history-churn`    | Two phases with two hosts per phase; 64 scripted requests per window, global-state bounds and reload; ten-minute runtime budget per phase.                      |
| `host-termination` | Orderly owned-window closure; externally observed stream disconnect and process death, recovered results and released capacity.                                 |
| `shared-workers`   | Two real hosts sharing storage, mailbox claim race, recipient/acknowledgment and Worker state; five-minute runtime budget.                                      |

These controllers acquire the build lease, prepare existing outputs, record zero live requests and require real-host
execution plus shutdown evidence. Their child processes and local workspaces are disposable; an unknown host must never
be killed to force a green result. Specialized storage restart is also exposed by
`pnpm --dir apps/vscode-e2e test:campaign --storage-recovery-root <fresh-root> --vscode-version 1.138.0 --vscode-executable <exe>`.
Its controller quarantines only its own offline fixture lock after proving quiescence.

## Live frameworks and complete sampling

Sources: [`developmentSuites.ts`](../apps/vscode-e2e/src/campaign/developmentSuites.ts),
[`liveGate.ts`](../apps/vscode-e2e/src/campaign/liveGate.ts),
[`reliabilityCatalog.ts`](../apps/vscode-e2e/src/scenarios/reliabilityCatalog.ts) and
[`runCampaign.ts`](../apps/vscode-e2e/src/runCampaign.ts).

```text
pnpm test:live:gate --root <run-root> --init-root --profile-dir F:/alpha-e2e/profiles --model-id <exact-id> --effort <supported-effort>
pnpm test:live:reliability <same-options>
pnpm test:live:core <same-options>
```

| Suite            |  Default required cells | Request cap | Campaign / attempt duration cap |
| ---------------- | ----------------------: | ----------: | ------------------------------- |
| Development gate | 12 scenarios × 1 sample |       1,200 | 2 hours / 10 minutes            |
| Reliability gate |                  11 × 1 |       1,200 | 2 hours / 10 minutes            |
| Core gate        |                   9 × 1 |         300 | 2 hours / 10 minutes            |
| Smoke campaign   |                   3 × 1 |         300 | 30 minutes / 10 minutes         |
| Soak campaign    |             12 × 3 = 36 |       3,000 | 6 hours / 10 minutes            |

One executed sample of **every** declared scenario is a full default development/reliability/core matrix. It is not a
soak, repeated reliability estimate or prolonged-load result. Every required gate cell must pass with model/effort/source
identity, positive bounded requests, retained evidence and no hidden failed retry. Each live gate repeats runner units
and smoke preparation; core additionally prepares core regressions and five host suites. Overlap does not erase the
separate gate outcome.

Independent live file/tool/quality owners are `live-quality.test`, `file-tools-live.test`,
`command-file-diff-live.test`, `read-evidence-live.test`, `harness-quality-live.test`, `alpha-tickets-live.test` and
`approval-github-live.test` under [`src/suite`](../apps/vscode-e2e/src/suite). Run each with compiled `runTest.js`, exact
host/model/effort/profile/workspace/artifacts and `--file <name> --require-all-tests`. The GitHub approval case permits
only `gh --version`; development cases permit disposable local commits and prohibit pushes/remotes/installations. The
browser/server probe uses loopback HTTP. Provider requests consume quota. Bare `test:copilot` globs unrelated gated and
scripted suites and permits skips, so it is not an all-live acceptance aggregate.

Additional compatible suites are `task.test` and `markdown-lists.test`, plus:

- `vscode-lm-empty-recovery.test`: one 210-second case, six-request cap, exactly two real task requests expected after
  no-choices injection; no Continue or tool auto-approval.
- `command-settlement.test`: receipt failure plus execa and integrated-terminal revision cases; caps 12 + 60 + 60
  requests at the default three revisions. `ALPHA_E2E_SETTLEMENT_TURNS=3..12` extends churn. These files own their request
  budgets; top-level `--request-limit` is unsupported outside guarded workflow scenarios.

Long-context stress is deliberately outside ordinary reliability. Use `test:campaign --config <path> --root <root>
--init-root --profile-dir <owned-profile-root>` with:

- [`long-context-recovery.json`](../apps/vscode-e2e/campaigns/long-context-recovery.json): two scenarios × one sample.
- [`compaction-recovery-validation.json`](../apps/vscode-e2e/campaigns/compaction-recovery-validation.json): three × two.

Both configurations cap requests at 180, campaign duration at 45 minutes and attempts at 20 minutes. The config owns the
exact model/effort; config mode rejects suite model overrides. Do not silently count a reduced sample as the full config.

Problem-solving is separately excluded from the named gates. The existing
`pnpm --filter @alpha-code/evals benchmark:problem-solving-live` accepts `PROBLEM_SOLVING_*` environment for explicit
profile, host, model, effort, task IDs, repetitions and prompt variants. Override its historical default profile. It uses
the real extension through Copilot, defaults to 40 requests per task and bounds an attempt at 1,100 seconds.

The Windows-only portable diagnostic is [`run-portable-alpha-repro.mjs`](../scripts/run-portable-alpha-repro.mjs):
`node scripts/run-portable-alpha-repro.mjs --host <portable-Code.exe> --workspace <disposable-workspace> --artifacts-dir
<separate-output> --run-id <unique-id> --mode probe|task`. It requires the host's portable `data` directory and existing
configured Copilot model; task mode reads the explicit `--prompt-file` or workspace `SPEC.md`. It defaults to 15 minutes
(allowed 1–30 minutes), denies protected writes/browser approvals unless explicitly configured, and can mutate task
files in task mode. Use a dedicated portable host/profile and preserve its settings; this diagnostic is distinct from
the strict campaign acceptance gate and cannot substitute for it.

## Governed API benchmark preflight and operator contract

The separate `benchmark:run-model` owner is [`cli.ts`](../packages/evals/src/benchmark/cli.ts),
[`modelCampaign.ts`](../packages/evals/src/benchmark/modelCampaign.ts),
[`budgets.ts`](../packages/evals/src/benchmark/budgets.ts) and
[`frontier-t1.yaml`](../evals/subsets/frontier-t1.yaml). It uses OpenAI-compatible API credentials, database lifecycle,
Redis and the real extension; Copilot sign-in does not supply its API credential.

A read-only environment-presence probe on 2026-10-20 used the same `.env.development` / `.env.local` loader. It reported
only booleans: API key, configured model/provider, database, Redis and private-root declarations present; custom API base
URL absent; configured model equals `gpt-5.6-luna`; provider alias allowed. This proves configuration presence only,
not authentication, model availability, service readiness or host isolation. No provider request was made. The safe
metadata receipt is `artifacts/harness/.full-test-inventory/benchmark-configuration-preflight.json`.

The smallest complete named API campaign is T1 visible: eight selected tasks, one iteration, concurrency one, $0.06
reservation per task ($0.48 total) and a $0.50 campaign cap from the checked-in subset. The bounded command is:

```text
pnpm --filter @alpha-code/evals benchmark:run-model --role luna-high --model-id gpt-5.6-luna --tier t1 --partition visible --iterations 1 --concurrency 1 --evidence-output <fresh-absolute-evidence-directory>
```

Before execution, an operator must provide owned ephemeral `DATABASE_URL` and `REDIS_URL` process overrides, migrated
schemas and separate scratch/log roots; retain the credential in the child loader without copying or printing it. Do
not use the existing development database/queues. Source enforces finite reservations, no model fallback and concurrency
one. A single stable-core task such as `--task repo-cache-invalidation` is a smaller diagnostic sample, not full T1.
T4/T5/frontier runs expand repetition/spend and are outside this bounded campaign.

The local versioned benchmark adapter now requires an absolute native `VSCODE_EXECUTABLE_PATH`, reuses the existing
owned-profile adapter to create separate user-data/extensions/shared-data directories, and loads the current development
build. [`runTaskInVscode.ts`](../packages/evals/src/cli/runTaskInVscode.ts) verifies actual 1.138.0 identity, runner ancestry,
extension identity/version and bundle/manifest digests before starting paid work. It uses a unique IPC namespace and
removes inherited Electron/CLI/portable routing variables. The legacy container host keeps its separate installed-host
contract; see [the launch investigation](benchmark-exact-host-launch-2026-10-20.md).

Governed tasks require known finite nonnegative run prices and a positive task reservation, apply the smaller configured
cost limit, observe actual usage, cancel at that observed limit, and reject unavailable/invalid accounting. Receipt
metadata explicitly permits an in-flight response to overshoot; the campaign cap governs admission, not provider billing
at an exact dollar boundary. These source contracts do not establish a successful API run. Execution remains conditional
on owned migrated services, a selected exact executable, available model/authentication and verified cleanup.

## Performance measurements and integration limits

Use the same workload/model/cache state before and after a change. Existing measurement owners include:

- `test:task-navigation:1380` for extension New Chat/cold/warm navigation, and `test:task-navigation-ui:1380` for actual
  first-frame/settled renderer timing, repeated warm cycles and process/system activity.
- `test:history-ui:1380` for one explicit scripted New Chat/cold history sample; `test:reasoning:1380` for model changes.
- `checkpoint-init.perf.test` for three service/task-ready/nested-Git-scan samples plus actual save/restore.
- `proportional-context.test` for two scenarios × three actual request-size/round-trip samples;
  `proportional-completion.test` for two × three settlement/repair samples. Both require source/build/config/cache
  `ALPHA_SCOPE_RUN_METADATA`; completion also requires `ALPHA_COMPLETION_EXPECTATION=reference|candidate`.
- Live campaign and command-settlement receipts for requests, usage, elapsed time and retry/failure attribution.

The eight pending rows in the [managed certificate matrix](../scripts/certification/managed-agent-milestone.matrix.json)
must retain their full requirements:

| Pending requirement                     | Existing host evidence sought; remaining limit                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Human delegation provenance             | Scripted/API cases and real conversations; synthetic ingress cannot establish genuine human authority across reload. |
| Nested crash/reload                     | `nested-restart`; require its actual two-phase assertions, capacity, mailbox and cleanup conditions.                 |
| Real-provider budget/Stop               | `budgets` covers host mechanics; real billed usage/cost and remote stream termination remain provider work.          |
| Worker review/apply/verification/reload | Managed auto-apply, rendered review and restart cover portions; preserve any combined-contract gap.                  |
| Actual tree/settings                    | `rendered-ui` exercises renderer state and buffered edits.                                                           |
| Process/provider cancellation           | `cancellation` and `host-termination`; local HTTP does not establish every remote provider's abort behavior.         |
| Shared writers/mailbox                  | `shared-workers` exercises real multiprocess shared storage and claims.                                              |
| Global-state churn/size                 | `history-churn` exercises actual serialization and reload.                                                           |

Do not promote an entire row using partial or mock evidence. Report each executed case, actual host/model/profile,
sample count, limits, cleanup and source identity. For behavioral findings, compare current Codex CLI source/tests before
changing Alpha; keep Alpha's security and additional tools within the shared harness.
