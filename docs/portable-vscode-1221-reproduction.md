# Portable VS Code 1.122.1 reproduction

This setup tests Alpha on the exact release-gating host without changing the normal VS Code installation. On Windows,
use the official VS Code **ZIP** distribution and create a `data` directory beside `Code.exe`. VS Code then stores its
profile and extensions there. Do not add `data` to a User or System installer. The portable directory overrides
`--user-data-dir` and `--extensions-dir`, so the automated E2E runner must continue using its separate cached archive.

Reference: [VS Code portable mode](https://code.visualstudio.com/docs/setup/portable), checked 2026-09-28. The cached
1.122.1 build is commit `8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`; its bundled Copilot Chat is 0.50.1.
The portable window's About dialog reports Electron 39.8.8 (build 13870025), Chromium 142.0.7444.265, embedded
Node.js 22.22.1, V8 14.2.231.22-electron.0, and Windows NT x64 10.0.26200.

## Local setup on 2026-09-28

- Portable host: `F:\alpha-portable-hosts\vscode-1.122.1\Code.exe`
- Isolated profile: `F:\alpha-portable-hosts\vscode-1.122.1\data`
- Baseline Alpha VSIX: `F:\alpha-portable-hosts\vsix-baseline\alpha-3.1.0.vsix`, SHA-256
  `7B2717DD6A626E529C0C5486BFF3163ECF96C69E98AE2559D0318F76DF7D9289`
- Portable `Code.exe` SHA-256:
  `FFDE0FC858E4A7E938A399DDFBCF34D7D28630441AC906A36209FB1C37D7177D`
- Workload: `F:\alpha-portable-hosts\repro-workspace\SPEC.md` and sample inventory
- GUI shortcut: `F:\alpha-portable-hosts\Open Alpha VS Code 1.122.1.lnk`

The baseline VSIX was copied from `bin/alpha-3.1.0.vsix` before rebuilding. That `bin/` path now contains the live
Copilot candidate described below; use the hashes to distinguish same-version builds.
The **OpenAI Max candidate** is `F:\alpha-portable-hosts\vsix-candidate\alpha-3.1.0-openai-max.vsix`, SHA-256
`18E8F7701ECC5ECA104F0AE2F14A8D94A654810021410DB20AD8F4AD0D83C281`. It is installed in the separate
`F:\alpha-portable-hosts\vscode-1.122.1-openai-max\data` profile, launched with
`F:\alpha-portable-hosts\Open Alpha VS Code 1.122.1 OpenAI Max.lnk`. Both hosts use the same `Code.exe` bytes. The
candidate shortcut opens an identical starting fixture at `F:\alpha-portable-hosts\repro-workspace-openai-max`, so
live task edits do not change the original fixture. The candidate uses the current repository source, including
changes already in the working tree; it is a separate build
from the original VSIX and must be labeled as such in comparisons. The candidate VSIX passed
`node scripts/verify-vsix-contents.mjs` with 1,671 entries and no packaged `.env` file.

The extension is installed in `data/extensions` as `alphainc.alpha@3.1.0`. The portable host opened the fixture
workspace with its own user data. Its VS Code LM picker was initially empty; after Copilot sign-in in this persistent
profile, the user selected GPT 6 Luna through **VS Code LM (Copilot)**. An authenticated read-only sidecar probe in the
same portable profile returned the exact model ID, family, and version `gpt-6-luna` from the VS Code LM API. Alpha's
model picker reports a standard 272,000 input-token context window. The saved Alpha configuration did not contain an
explicit reasoning-effort value, despite the intended Max selection, so the automated live task sets `max` in its
task-local configuration and records it. The orange model-availability paragraph in Settings is static guidance, not
an empty-catalog error when the model appears above it. This sequence points to profile setup for the initial empty
picker, without establishing which authentication step was missing. Do not copy credential stores from another profile.

The terminal's Node 24.14.1 builds Alpha and runs test scripts. The 1.122.1 extension host uses its embedded Node
22.22.1; a separate terminal Node installation does not replace it. Match the host and extension bytes before
attributing a behavior difference to Node.
This computer reports Windows NT `10.0.26200.0`; record the other computer's exact OS build separately. Matching
`Code.exe` bytes and bundled runtimes does not make the OS builds identical.

A fresh authenticated probe on 2026-09-28, after the user changed Settings, returned `vsCodeLmContextSize: 1050000`,
`enableReasoningEffort: true`, `reasoningEffort: max`, `autoCondenseContext: true`, and
`autoCondenseContextPercent: 36`. The live VS Code LM model reports `maxInputTokens: 871793`. Alpha clamps the
configured context size to that live input limit, so the automatic trigger is
`floor(871,793 × 0.36) = 313,845` tokens, subject to the lower allowed-input cap. On this reported limit, 40% would
trigger at 348,717 tokens. Post-turn compaction remains disabled (`postTurnCondenseContextPercent: 0`). The receipt is
`F:\alpha-portable-hosts\automation-runs\settings-probe-20260928-01\sidecar\settings-probe-20260928-01-probe-result.json`.

## Test sequence

1. Run the deterministic 1.122.1 smoke gate: `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`.
2. Run `pnpm --dir apps/vscode-e2e test:task-navigation:1221`. Its `[task-navigation-latency]` log line records elapsed
   time for the title-bar New Chat command after a twelve-command task, a cold persisted-task reopen, and a warm
   reopen. The default disposable profile is cleaned up after a passing run. To retain the JSON artifact, invoke the
   compiled `apps/vscode-e2e/out/runTest.js` with `--profile-dir`, `--workspace`, and `--artifacts-dir` pointing to
   three separate, initially empty directories outside the checkout, plus `--init-profile` on the first run. The
   New Chat timing stops when its command returns; reopen timing stops when the completed transcript is available in
   the extension host. Neither includes webview paint.
3. Run `pnpm --dir apps/vscode-e2e test:history-ui:1221` for rendered history on the exact host. This verifies the
   forty-row history UI, but it does not measure reopening latency.
4. In the portable GUI, sign in to GitHub Copilot and inspect Alpha's actual model picker. Record the exact model ID,
   family, and reasoning effort. An empty model catalog, a missing exact model, a consent failure, a provider request
   failure, and a successful request are different outcomes. Alpha's GPT-5.6 version message is issued only when the
   exact selector has **no** match on a pre-1.128.0 host; it is not proof that every model is unavailable.
5. Run the portable automation command below. It starts an Alpha task for `SPEC.md`, waits for the final review,
   invokes New Chat and cold/warm reopen, and writes a receipt. Those timings stop at the extension boundary. For the
   reported visible lag, capture click-to-visible-change times in `NAVIGATION-RECORD.md` on each machine as well. Keep
   the same Alpha build, model, effort, workspace, and profile when repeating the workflow on another host.

### Automated live task

After signing in to Copilot once in the portable profile, use a unique run ID for each invocation:

Keep the signed-in, ordinary portable VS Code window open while launching the sidecar. After reinstalling a VSIX,
starting an Extension Development Host as the first window exposed only the sidecar extension in this profile; an
ordinary window loaded Alpha and Copilot, after which the same probe succeeded. The sidecar reports its visible
extension IDs when Alpha is unavailable. The runner passes the workspace folder on VS Code's launch command. In the
persistent portable profile, an Extension Development Host can initially activate without that folder, so the sidecar
waits briefly and adds it through the VS Code workspace API if needed. The receipt records whether it did so and
whether VS Code created an Untitled workspace.

```powershell
node scripts/run-portable-alpha-repro.mjs --host 'F:\alpha-portable-hosts\vscode-1.122.1\Code.exe' --workspace 'F:\alpha-portable-hosts\repro-workspace' --artifacts-dir 'F:\alpha-portable-hosts\automation-runs' --run-id inventory-1221-01 --timeout-ms 900000 --protected-writes allow --browser-approvals allow
```

This opens an Extension Development Host that shares the portable profile without copying credentials. The sidecar
adds the fixture folder to that window, confirms VS Code 1.122.1 and the selected Copilot model, then uses Alpha's
public API to create a Code task. Its temporary test-profile policy auto-approves reads, writes, and commands, keeps
out-of-workspace writes disabled, and requests Max reasoning. The explicit `--protected-writes allow` flag permits the
fixture's `.alpha/skills` file; the default is `deny`. A tool approval that remains pending for 20 seconds fails the
run with its request ID instead of silently waiting for the full task timeout. Alpha's public task API applies the
automation policy to the test profile while the task runs; the sidecar restores those settings afterward. The result
is `automation-runs/<run-id>/sidecar/<run-id>-task-result.json`; a probe receipt and stage events live
beside it. Each run gets its own sidecar directory. A failed or timed-out run stays available for diagnosis.

For browser work, `--browser-approvals allow` temporarily enables VS Code's browser chat tools and grants only its
`open_browser_page` host tool in this exact-host test window using the existing E2E test context. The sidecar restores
the previous host settings and context after the task. The default is `deny`.

The script checks that its artifact directory is separate from the host, workspace, and repository. It never reads or
copies Copilot tokens. It waits up to the requested bound plus 30 seconds for a correlated result. The sidecar writes
receipts and logs, then asks VS Code to close its test window. On Windows, the runner snapshots visible portable windows
before launch and closes only its new Extension Development Host after the correlated receipt. It dismisses that
window's generated Untitled-workspace save prompt only when the receipt reports zero dirty editors. Ambiguous windows
or other save prompts are left open. The runner writes `window-cleanup.json` alongside each new run's sidecar. Supply
`--prompt-file <absolute-path>` to run a different project task; otherwise
a task uses `SPEC.md` in the workspace. Probe mode reads the provider and context settings without requiring a task
prompt.

If a same-version VSIX reinstall is blocked while the signed-in portable profile is open, extract the verified VSIX
and pass its `extension` folder with `--alpha-development-path <absolute-path>`. VS Code then loads that exact packaged
extension in the new test window alongside the automation sidecar. The probe receipt records the loaded extension path
and SHA-256 of `dist/extension.js`; compare it with the VSIX entry before attributing a live result to the new build.
This does not replace the installed extension in the persistent portable window.

On 2026-09-28, a Win32 top-level-window inventory found 11 visible VS Code windows, nine from the portable binary.
Six finished portable test windows were closed individually, reducing the count to five total and three portable.
The persistent signed-in `repro-workspace` window and both normal-install windows were preserved. Two older portable
Untitled workspaces raised save prompts on normal close; those prompts were cancelled and their windows remain open
with unsaved work intact. A later authenticated probe using the new per-window guard returned `gpt-6-luna` at Max and
finished with the same five visible windows (three portable) as before launch. Its receipt is under
`F:\alpha-portable-hosts\automation-runs\candidate-window-probe-20260928-06\sidecar`.
The first live task used a manually launched sidecar, so its receipts are under
`F:\alpha-portable-hosts\automation-sidecar` rather than `automation-runs`.

For an empty Copilot catalog, inspect VS Code's **Chat: Manage Language Models** in that same portable window. If VS
Code itself has no Copilot models, check the **GitHub Copilot: Sign in** command and the account assigned to Copilot
Chat in **Accounts → Manage Extension Account Preferences**. If VS Code lists models but Alpha does not, capture the
Alpha and extension-host logs as an Alpha enumeration defect. VS Code's
[Language Model API guide](https://code.visualstudio.com/api/extension-guides/ai/language-model) documents empty
`selectChatModels` results and user consent; its [Copilot setup guide](https://code.visualstudio.com/docs/setup/copilot)
describes account selection. Check that these commands exist in the pinned 1.122.1 host before treating the current
documentation as an exact-version UI contract.

### OpenAI API path for the live workload

For a provider comparison, the live workload can also use **OpenAI Compatible**. In Alpha's provider
settings, enter the API key yourself, use `https://api.openai.com/v1` as the Base URL, set the Model ID to
`gpt-6-luna`, enable **Set Reasoning Level**, select **Maximum**, and save. The key belongs in Alpha's credential field,
not in this document or a test fixture. Leave Azure and custom headers disabled for the official OpenAI endpoint.
The custom-model effort selector needs the candidate build that adds `max`; the original VSIX above does not offer it.

The [official GPT-6 Luna model card](https://developers.openai.com/api/docs/models/gpt-6-luna) lists the API model ID,
Max reasoning, and tool use through the Responses API. Alpha routes this exact model on the official endpoint through
its Responses adapter. API-key access and available quota must be checked in the user's OpenAI API account; a ChatGPT
or Codex subscription does not establish API access. Using this provider exercises Alpha's shared task lifecycle,
tools, persistence, and webview paths, but it cannot verify VS Code LM discovery or Copilot-specific behavior.

For a guarded live E2E run with durable receipts, use the existing dedicated profile workflow in
[Dedicated VS Code live-Copilot test profiles](vscode-live-test-profiles.md). It discovers the exact Copilot model and
checks Alpha-owned authorization before a task. That runner has a different persistent profile from the portable GUI,
so it needs its own sign-in. Its existing live harness-quality suite exercises multi-step skill work and host browser
actions. Do not count setup/preflight as a completed task.

## Interpreting results

One scripted run per host on 2026-09-28 used the same workspace bundle and a 13-request, 12-command task. These are
diagnostic samples, not a speed comparison claim; timings exclude webview rendering and live-provider latency.
Both evidence manifests record bundle SHA-256 `0c8adfeb0b872a564cf509fcde84837dbdfd2751dcf0736d5d48f9ad73f288cf`.

| Host            | New Chat command | Cold reopen to hydrated transcript | Warm reopen to hydrated transcript |
| --------------- | ---------------: | ---------------------------------: | ---------------------------------: |
| VS Code 1.122.1 |           101 ms |                              56 ms |                             3.5 ms |
| VS Code 1.139.1 |           189 ms |                              17 ms |                              13 ms |

The raw JSON is under `F:\alpha-portable-hosts\bench-artifacts\nav-1221-20260928-hydrated\` and
`F:\alpha-portable-hosts\bench-artifacts\nav-1391-20260928-hydrated-fixed\`. Because the measured extension-host
paths are under 200 ms in both runs, the reported multi-second visible pause requires a click-to-render measurement
in the portable GUI and the slower computer before assigning a root cause.

A separate renderer-level history workload on 2026-09-28 used the same Alpha bundle SHA-256
`9ad23157aee55b14c234a2fe4071641379b8c72478f2285aedee6e0b76fb1ec7` on both hosts. Each run reopened a
persisted task with 1,200 messages, verified that only 80 were initially rendered, and measured from the UI action to
the first visible webview frame. Three isolated runs per host passed:

| Host            | New Chat first-frame median (range) | Cold reopen first-frame median (range) | Opening indicator median |
| --------------- | ----------------------------------: | -------------------------------------: | -----------------------: |
| VS Code 1.122.1 |              200.3 ms (196.7–268.6) |                 239.6 ms (219.0–249.7) |                   1.3 ms |
| VS Code 1.139.1 |              244.7 ms (198.1–246.4) |                 200.9 ms (177.9–202.8) |                   1.0 ms |

The fixture did not reproduce a multi-second pause, and these samples do not isolate a host-version cause. Reports
are in `%TEMP%\\alpha-code-history-ux\\chats-{8f7e1d66,248ecb3e,e9bfb762,b4cce881,ec35734c,1403a21e}\\navigation-renderer-latency.json`.
The slow computer still needs the same cold/warm workload and a click-to-frame trace in its own profile.

A dedicated 1.122.1 task-navigation run used a fresh extension-host process to reopen a persisted 1,200-message task,
then ten warm New Chat/reopen cycles in the same window. The test verified that the task object was absent at the start
of the fresh process, the later cycles reused the same task object, both processes used the same bundle, and every
click was a trusted pointer event. "First visible" is the first qualifying UI state followed by two animation frames;
"settled" additionally requires the final UI state to remain stable for at least 150 ms. The saved report is
`%TEMP%\\alpha-code-task-navigation-ux\\run-Ds2K75\\task-navigation-ui-benchmark.json`.

| Action                    | Samples | Click to first visible frame |           Click to settled UI |
| ------------------------- | ------: | ---------------------------: | ----------------------------: |
| Fresh-process task reopen |       1 |      26 ms opening indicator |             349 ms transcript |
| Warm New Chat             |      10 |  35 ms median, 49 ms maximum | 207 ms median, 242 ms maximum |
| Warm task reopen          |      10 | 96 ms median, 118 ms maximum | 296 ms median, 316 ms maximum |

This one-window scripted-provider workload did not reproduce the reported multi-second dead click. It does not measure
contention from several open VS Code windows or the other computer. The prior failed benchmark attempts were harness
setup faults: one fresh profile showed onboarding because it lacked a provider; another completed the interactions but
read a receipt field from the wrong location. They produced no accepted latency report.
During the completed run, the extension-host event-loop delay had a 19 ms 95th percentile and 163 ms maximum; its RSS
rose from 287 MB to 424 MB while handling the large transcript. These are one-run observations, not a leak or capacity
trend.

### Live Copilot task observations

The original `3.1.0` VSIX ran an inventory implementation task in the signed-in portable profile with Copilot
`gpt-6-luna` at Max reasoning. The task created the dashboard, tests, and `.alpha/skills` guide and passed its Node
checks, but the 15-minute automation deadline interrupted it before its final report. Its persisted transcript has
46 matched tool calls/results and 27 main model requests, all first-attempt completions. The largest single request
used 61,297 input tokens, well below the automatic compaction trigger. The history token totals also include 21
reasoning-summary calls, which explains why they exceed the main-request journal totals. This run is a task-quality
and lifecycle sample, not a successful browser or completion sample.

A later direct browser workflow in the same original VSIX opened the inventory page using VS Code's integrated
browser tools, selected **Peripherals**, added a synthetic item, and reloaded to confirm persistence. Its automated
receipt is under `F:\\alpha-portable-hosts\\automation-runs\\inventory-browser-direct-1221-20260928-01\\sidecar`.
The first browser follow-up was incorrectly classified as a read-only lookup because its prompt also said not to
modify an unrelated CSV file; Alpha consequently omitted browser tools from that task. Current source now classifies
explicit browser interaction as a full workflow, with a failing-before/passing-after regression. The direct prompt
worked on the original VSIX because it used the already-recognized browser-workflow phrasing. VS Code 1.122.1 also
requires a URL for `open_browser_page`; current source now enforces that exact host contract before invocation.

The direct browser task's extension-host New Chat, cold reopen, and warm reopen times were 133 ms, 31 ms, and 19 ms
respectively. They exclude webview paint. The test app displayed a stale load alert despite successful rows and
persistence; that is a fixture-app finding, not evidence of an Alpha browser transport failure.

The verified **live Copilot candidate** VSIX is
`F:\alpha-portable-hosts\vsix-candidate\alpha-3.1.0-live-20260928.vsix`, SHA-256
`7842C6FC28913876D9C022C129204A12E779A98BE8512F7E19A32165BC38C8D6`. Its installed `dist/extension.js`
hash matches the source bundle. The authenticated candidate probe returned VS Code 1.122.1, `gpt-6-luna`, Max effort,
the saved 1,050,000 context setting, and the live 871,793 input-token limit. Its receipt is under
`F:\alpha-portable-hosts\automation-runs\candidate-pip-probe-20260928-05\sidecar`.

Alpha caps the configured context window at the selected live model's advertised input limit before calculating the
automatic compaction trigger. This profile currently saves 36%, so the effective trigger is about 313,845 input
tokens (36% of 871,793), despite the 1,050,000-token setting. A 40% setting would put it near 348,717 tokens on the
same model. No live task in this investigation approached either trigger, so compaction quality was evaluated by
deterministic tests rather than inferred from these live runs.

The candidate completed a 4-minute-41-second live task in the 37-file `F:\vault\archives\PIP` archive. It fixed
`add-evidence --dry-run` so the synthetic JSON entry prints before any directory creation, added four focused tests,
and ran them passing. An independent `python -m pytest -q -p no:cacheprovider tests/test_ftk.py` run passed 4/4; a
non-writing CLI smoke check printed its synthetic JSON entry. The existing evidence logs retained their January 2026
modification times. Alpha initialized its shadow Git repository in 3,170 ms (the sidecar observed readiness at about
3,814 ms) and saved three checkpoints; save durations in the Alpha log were 168, 183, and 183 ms. The checkpoint diff
from the initial commit to the final commit contains only `scripts/utilities/ftk.py` and `tests/test_ftk.py`.
Python test runs also left `.pytest_cache` and generated `__pycache__` folders in the archive. An automatic approval
review rejected their recursive deletion, so they were preserved. The root `__pycache__` predates this run.

A separate deterministic checkpoint workload ran three samples on VS Code 1.122.1 and its embedded Node 22.22.1,
using a disposable 45-file copy of the PIP archive and Git 2.43.0. Shadow repository initialization took 2,818,
2,728, and 2,806 ms (median 2,806 ms). Two samples spent about 2.4 seconds in the `git init` subprocess; the third
spent 2.34 seconds resolving/running ripgrep and only 78 ms in `git init`. Exclude-pattern discovery was 0–1 ms and
the initial snapshot was 218–287 ms. The test also saved and restored tracked and untracked files and verified that
a file created after the checkpoint was removed. These three samples show a variable subprocess wait on this host;
they do not establish a general checkpoint-speed defect or identify its operating-system cause. The report and phase
definitions are in
`F:\alpha-portable-hosts\bench-artifacts\checkpoint-host-1221-20260928-04\artifacts\b6a5af5e-213e-4e8b-99b1-e033c9ae803c\checkpoint-init-perf.json`.
The task reached `completion_result`, stayed in history, and reopened after New Chat. The receipt recorded 163 UI
messages and extension-side New Chat, cold reopen, and warm reopen times of 172, 33, and 29 ms. The receipt is under
`F:\alpha-portable-hosts\automation-runs\candidate-pip-task-20260928-01\sidecar`. These are diagnostic measurements
from one live run and do not include webview paint or establish performance on the slower computer.

The same run's event log records 17 model-request start-to-assistant-commit intervals totaling 205.7 seconds (median
8.405 seconds, 90th percentile 21.763 seconds) and 16 tool batches totaling 29.1 seconds (median 1.672 seconds,
90th percentile 3.952 seconds). Request-to-commit includes provider streaming and persistence; the log has no
first-token event, so it cannot isolate provider latency. All 37 accepted tool calls have one matching result. Fourteen
`exec_command` results were errors from model command choices: Git commands in the non-Git archive, PowerShell commands
in a different active shell, missing program lookups, one `rg` invocation, and exploratory test failures. The task
recovered and completed; these observations do not identify a terminal adapter or command-transport failure.

The candidate also completed a fresh, authenticated browser task on the exact host. It opened a local inventory page,
read it, selected **Peripherals**, added `Candidate Browser Widget 20260928` for $19.99, and reloaded. The persisted
transcript reports that the item remained visible after reload. The receipt records 14 completed browser actions,
including open, read, click, type, and navigation, and the task reached `completion_result` and remained in history.
Extension-side New Chat, cold reopen, and warm reopen took 120, 27, and 13 ms; these exclude webview paint. The page
continued to show an erroneous load alert while the inventory rendered and persisted, which is a fixture-app defect.
The runner restored browser host settings and the visible window count remained five total, three portable. The receipt
is under `F:\alpha-portable-hosts\automation-runs\candidate-browser-workflow-20260928-01\sidecar`.

### Final packaged build

The final VSIX is `F:\alpha-portable-hosts\vsix-candidate\alpha-3.1.0-final-20260928.vsix` (SHA-256
`0B666BE1D6F8A1AAEA2A481CBBEC47FF013F8C6EE9C76C8697EFC7C6217EC7B5`). Packaging verification found 1,671
entries, all required files, and no `.env`. Reinstalling the same `3.1.0` version into the open portable profile returned
"Please restart VS Code before reinstalling"; the signed-in and two older Untitled windows were preserved. The VSIX
was instead extracted to `F:\alpha-portable-hosts\vsix-candidate\alpha-3.1.0-final-unpacked\extension` and loaded
as a development extension for the final live task. Its `dist/extension.js` SHA-256,
`55F862FFE4040DA72A168712912B709EF4DF9EAB2DB0BB2D03CE91749950D5AA`, matched the packaged entry and source
bundle. The authenticated probe recorded that exact path, VS Code 1.122.1, and Copilot `gpt-6-luna` at Max.

Using the formerly misclassified wording, "Test the inventory category filter and add-item flow in the browser; do
not edit source files," the final VSIX completed 12 browser actions, selected **Peripherals**, added
`Final VSIX Widget 20260928`, reloaded, and confirmed the item persisted. Its 19 accepted tool calls have 19 matching
results. The journal ended with `turn_completed` and `task_completed` and no later cancellation event, correcting the
older candidate's cleanup artifact. The fixture's six Node tests also passed independently. Extension-side New Chat,
cold reopen, and warm reopen took 174, 30, and 21 ms; webview paint is excluded. The same fixture app still displayed
a stale load alert despite an HTTP 200 inventory response and working controls. The final receipt is under
`F:\alpha-portable-hosts\automation-runs\final-vsix-browser-regression-20260928-01\sidecar`. The runner and one
extra plain Welcome window created by the rejected install were closed; the preexisting five windows remained.

On this frozen source, `pnpm lint`, `pnpm check-types`, the bounded `src` Vitest run (9,143 passed, 42 skipped),
`pnpm certify:managed-agents:automated`, and the exact-host smoke gate (12 suites, 32 tests) passed. The smoke log is
`F:\alpha-portable-hosts\smoke-1221-final-20260928.log`. The deterministic certification matrix reports 26 passing
checks and eight pending real-integration scenarios; its managed-agent extension-host acceptance case passed.

The candidate passed the focused shared-type, provider, and webview tests; the affected type and lint checks; and
packaging verification. The first `test:smoke:1221` run exposed a race in its explicit-only sub-agent fixture:
default `wait_agent` may return on an update before terminal child completion, while the scripted model assumed the
child was finished. The fixture now requests `until_terminal: true`. The focused case passed, and the complete
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` rerun passed all twelve suites (32 tests) on the exact host.
Logs are `F:\alpha-portable-hosts\smoke-1221-candidate.log` (initial failure) and
`F:\alpha-portable-hosts\smoke-1221-terminal-wait.log` (passing rerun). This validates deterministic host behavior,
not live Copilot service availability or visible navigation latency.

Compare the same workload on 1.122.1 and the newer host, with the same Alpha VSIX hash. A quick scripted New Chat
result with a slow visible click suggests a renderer or message-delivery delay; a slow command result points to
extension-side finalization. A slow cold reopen with a quick warm reopen points toward persistence or task
construction. If both are slow, also inspect state projection and webview rendering. These are diagnostic inferences,
not conclusions until the corresponding timings and logs agree.

Past exact-host live evidence in [the profile guide](vscode-live-test-profiles.md) showed that Copilot model discovery
and Alpha authorization can work on 1.122.1, while a later task failed in that release's bundled Copilot 0.50.1 Git
observer. The same error is recorded in [upstream issue #318772](https://github.com/microsoft/vscode/issues/318772),
which was closed as a duplicate by 2026-09-28. The 1.122.1 bundle remains the release-gating binary; a later upstream
fix does not alter its bundled extension. Capture a fresh failure stack before attributing a new incident to it.

When comparing the other computer, record the exact VS Code commit, Electron/Node/OS build, Copilot Chat version,
Alpha VSIX SHA-256, active VS Code profile, exact model ID/effort, browser-tool availability, cold/warm task timings,
and any Alpha or extension-host errors. A list of recent workspaces is separate from the active VS Code profile and
is not by itself evidence of an Alpha navigation bottleneck.
