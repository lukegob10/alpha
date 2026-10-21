# Alpha panel loading after VS Code 1.125 to 1.138

Investigated on 2026-10-20. The reported symptom is slow Alpha panel loading after upgrading VS Code from **1.125 to
1.138**, with affected users on the most recent released Alpha. At retrieval time that release was
[3.2.4, source `f50b702`](https://github.com/lukegob10/alpha/releases/tag/vsix-v3.2.4-f50b702).

## Result and release impact

**No critical Alpha loading defect or severe host-upgrade regression was reproduced.** The same published 3.2.4 package
loaded its sidebar in approximately 0.3–0.6 seconds on both hosts. Repeated editor opens and a synthetic 5,000-task history
also completed without long stalls. These local results do not resolve the affected users' report or establish that all
profiles, machines, and remote environments are unaffected.

The release chat, **Begin VS Code 1.138 Migration**, received the findings before publication. No production change is
justified by these results. The suspected upstream webview queue issue remains a lead requiring an affected-machine
trace, rather than a confirmed Alpha release blocker.

## Package identity and method

The GitHub asset was downloaded directly, rather than trusting the version printed on a local build:

- Published `alpha-3.2.4.vsix`: 88,970,131 bytes; SHA-256
  `b312b8b5f419d729b5fddd6b3e806fdaa951c0bfc742f86a022a54a63ee1c9b2`; manifest requires `^1.125.0`.
- Local 3.2.5 candidate: SHA-256 `fd26c637aa2f68ac6cbf75e491340eed6159b0e94121b9151bc9ca2a9b45a0be`;
  manifest requires `^1.138.0`. This identifies the measured local candidate, not a future published asset.
- The pre-existing local `bin/alpha-3.2.4.vsix` was a later rebuild requiring `^1.138.0`, with a different checksum.
  Its preliminary results are excluded from published-package conclusions. Thus an Alpha update is not necessary to
  compare the reported upgrade: the actual published 3.2.4 supports both hosts.

Measurements used Windows x64, the cached exact Microsoft hosts, isolated profiles and extension directories, the
packaged production Alpha webview, an empty diagnostic workspace, and the same local machine. No user profiles,
credentials, or historical tasks were copied. No tasks or model requests were initiated. The synthetic returning-user
configuration selected VS Code LM/Copilot without authentication or a live request. File and module caches were warm;
these are fresh-profile launches, not cold-disk benchmarks. Samples ran serially and variant order alternated.

The primary metric is the elapsed time from requesting the panel to observing rendered content through the owned
Electron debugging connection. Polling adds approximately 50 ms of observation granularity. Whole-process launch time
includes VS Code startup and is reported separately. Alpha itself ran in production extension mode.

The fresh-profile matrix used an extension-test driver. The history and editor-cycle matrices used an ordinary driver
extension and normal persistent storage, without `--extensionTestsPath`. A synthetic profile stored its memento under
the exact `AlphaInc.alpha` key; the file directory is `alphainc.alpha`. Both the selected provider and loaded history
count were checked in the final returning-user matrix.

## Measurements

All times below are milliseconds. Each editor series opened and closed 40 panels in one host process. Those 40
observations are correlated repetitions, not 40 independent host launches.

| Workload                                                             | Published 3.2.4 / VS Code 1.125.0 | Published 3.2.4 / VS Code 1.138.0 | Local 3.2.5 / VS Code 1.138.0 |
| -------------------------------------------------------------------- | --------------------------------- | --------------------------------- | ----------------------------- |
| Fresh profile: three sidebar opens                                   | 331, 336, 309                     | 346, 330, 516                     | 334, 307, 327                 |
| Fresh profile: median process launch to content                      | 3,789                             | 3,757                             | 3,835                         |
| Saved Copilot selection and 5,000 completed tasks: two sidebar opens | 580, 537                          | 514, 586                          | 602, 684                      |
| Repeated editor panels: median of 40 opens                           | 371                               | 376                               | 376                           |
| Repeated editor panels: slowest observed open                        | 1,089                             | 823                               | 826                           |

The final evidence comprises 18 host launches, including 120 repeated editor opens. Every retained primary sample
completed normally with exit code zero. The fresh-profile sample count is too small to infer a general speed change;
the important result is the absence of the reported long delay in these workloads.

## Relevant differences between the hosts

Host identities and runtime versions were read from the installed product files and running extension hosts:

| Contract                                 | VS Code 1.125.0                            | VS Code 1.138.0                            |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Microsoft commit                         | `93cfdd489c3b228840d0f86ec77c3636277c93ea` | `7debcd0e2acdea1c52de81bf9ee1620444407dda` |
| Electron                                 | 42.2.0                                     | 42.10.0                                    |
| Embedded Node                            | 24.15.0                                    | 24.18.1                                    |
| Chromium                                 | 148.0.7778.97                              | 148.0.7778.280                             |
| Native module ABI                        | 146                                        | 146                                        |
| Webview service worker version           | 5                                          | 6                                          |
| Active host-resource response-body limit | No corresponding semaphore                 | 32, for Electron webviews                  |

The installed `@types/vscode` 1.125.0 and 1.138.0 declarations were compared directly. Their differences are comments,
including inlay-hint ordering and a test-token parameter description. This rules out a stable API declaration change
as the demonstrated cause; it does not prove identical runtime behavior. The runtimes also retain the same Electron
and Chromium major versions and native ABI, rather than making a major runtime jump.

The most relevant confirmed implementation change is in Microsoft's webview service worker. Exact 1.138.0 acquires a
permit before creating the host-resource request; its existing 30-second request timeout starts after acquisition.
Permits are held until the response stream finishes or cancels, plus cache completion for cacheable responses.
The permit acquisition has no timeout. Exact 1.125.0 lacks this semaphore. This was verified against the cached host
files at `resources/app/out/vs/workbench/contrib/webview/browser/pre/service-worker.js` and the
[upstream change, PR 326272](https://github.com/microsoft/vscode/pull/326272), commit `17d3b86b9361`.

[Upstream issue 340126](https://github.com/microsoft/vscode/issues/340126) reports long webview stalls in another
extension, particularly editor panels over Remote SSH. Its proposed semaphore explanation is a report, not a proven
diagnosis of Alpha. The issue is closed; a closed issue alone does not establish a fix in 1.138.0. Alpha's local
repeated-panel workload did not reproduce that stall. Service-worker counter introspection did not produce usable
counter values, so this investigation does not claim to have excluded permit exhaustion under other conditions.
Do not patch the installed host or remove its resource limit on this evidence.

The SDK downloads described in the [1.138 release notes](https://code.visualstudio.com/updates/v1_138) belong to the
built-in Agents window. Alpha's inspected panel startup does not invoke that download path. They are not an established
explanation for Alpha loading delays. The [1.125 release notes](https://code.visualstudio.com/updates/v1_125) and exact
host files were retrieved on the investigation date.

## Alpha's loading path and diagnostic gap

The owning boundaries were traced in current source and checked against the published source revision:

1. [Activation](../src/extension.ts) loads the extension bundle, migrates settings and awaits
   [ContextProxy](../src/core/config/ContextProxy.ts), including secret-storage reads, before registering the sidebar.
   Configured settings auto-import is also awaited during activation.
2. [Webview HTML](../src/core/webview/webviewHtml.ts) starts the packaged JavaScript and styles through VS Code's local
   resource loader. The HMR probe is development-only and is not on the measured production path.
3. [The launch handshake](../src/core/webview/webviewMessageHandler.ts) awaits custom modes and the initial state.
   [State assembly](../src/core/webview/AlphaProvider.ts) awaits task-history initialization and recovery.
   [TaskHistoryStore](../src/core/task-persistence/TaskHistoryStore.ts) reads the index and reconciles task files at startup.
4. [App](../webview-ui/src/App.tsx) returns no visible content until state hydration completes.

Slow storage, settings import, recovery, or local webview resource loading can therefore delay visible content. These
are confirmed dependencies, not measured causes of the users' complaint. The initial state already computes VS Code LM
reasoning from cached model metadata rather than awaiting live model preparation. Workspace file enumeration and theme
loading start after the first state publication; MCP initialization is launched in the background.

The current timing events do not cover the entire user wait. `extension_activation` starts inside `activate()`, after
static module loading. `webview_ui_ready` starts when the App module executes, after resource download and earlier
module evaluation. A delayed JavaScript request can therefore coexist with a short UI-ready measurement. A useful
follow-up is correlated timing for panel request, HTML assignment, first handshake, state publication, and visible
content, plus a startup latency check. That is a diagnostic improvement, not a confirmed critical runtime fix.

## Evidence, exclusions, and next capture

Local, ignored evidence is retained under `artifacts/testing-vscode-panel-2026-10-20/`:

- `summary.json`: package identity and primary sample summary.
- `matrix-1792500616986/results.json`: actual published-package fresh-profile comparison.
- `history-1792501006113/results.json`: final correctly seeded saved-provider/5,000-task comparison.
- `cycles-1792500915782/results.json`: completed 40-editor-panel series for each variant.
- `run-probe.cjs`, `driver/`, and `host-probe.cjs`: diagnostic launch and observation code.

Earlier attempts remain as diagnostic history and are excluded where invalid: sandbox-denied file locks, an interrupted
launch, local rebuilt packages, test-mode persistence, an incorrectly cased synthetic memento key, and a tab-target
selection error. In particular, the earlier history runs verified file-history loading but did not establish a saved
provider configuration. No failing diagnostic harness attempt is presented as a production failure or repaired Alpha bug.

No production source was changed. This investigation did not rerun the complete `test:smoke:1380` gate and does not
substitute these probes for release certification. It did compare exact hosts directly, inspect package/source identity,
and retain normal host exits and rendering observations.

The next decisive evidence is a trace while an affected user experiences the delay: exact Alpha package and host build,
OS, local versus SSH/WSL/container workspace, sidebar versus editor panel, and whether the delay precedes the first
webview message. Capture Alpha's performance events alongside the webview's pending `index.js`/CSS timing and
[VS Code's startup or extension-host profile](https://github.com/microsoft/vscode/wiki/Performance-Issues). A long resource
wait with a fast state response points to the host/webview path; a long initial-state response points to Alpha's storage
or recovery path. Remote operation, signed-in Copilot, concurrent windows, real long-lived profiles, and the affected
machines were not reproduced here.
