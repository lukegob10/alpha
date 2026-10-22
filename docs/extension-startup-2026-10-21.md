# Extension startup investigation

Investigated October 21, 2026, using Windows Node 24.21.0 and pnpm 11.24.0. Six agents reviewed activation,
background services, renderer startup, module loading, and startup races in two waves. This is a focused performance
optimization, with existing workspace edits preserved. The target is a single readiness handshake, bounded shared
configuration loading, and no initialization of document parsers until their format is requested.

## Confirmed causes and fixes

### Duplicate webview initialization

Both `App` and `ExtensionStateContextProvider` sent `webviewDidLaunch` on mount. Every launch handler reloads modes,
publishes state, and starts workspace, theme, and profile work. React development effect replay amplified the duplication.
The context provider now owns the notification, after installing its message listener. Its mount-local ref prevents
effect replay from announcing again; a real unmount/remount still starts a fresh handshake. The host continues accepting
replacement launches, preserving sidebar and editor reload behavior.

Telemetry initialization also called `getStateToPostToWebview()` solely to obtain one preference after the initial state
had already been assembled. It now reads that preference from the same ContextProxy cache, retaining the unset/enabled
default, disabled behavior, and error containment.

| Deterministic workload                      | Before | After |
| ------------------------------------------- | -----: | ----: |
| Launch requests per normal mounted app      |      2 |     1 |
| Launch requests with development StrictMode |      4 |     1 |
| Full UI state assemblies per launch handler |      2 |     1 |

The real-provider renderer regression synchronously responds to launch, proving the state listener is installed in time.
It also checks a fresh remount. Native tests exercise enabled, disabled, unset, and missing preferences and a telemetry
initialization failure. These are work counts, not measured renderer paint or whole-extension speedups.

### Concurrent cold configuration loads

`CustomModesManager` cached completed loads for ten seconds but did not share a pending load. Skills startup, MCP checks,
view resolution, and initial state projection can request modes concurrently before that cache exists. Each caller then
reads and parses the same files and writes the same global state.

The existing manager now shares its pending promise. Cache invalidation advances a generation so an older read cannot
restore an invalidated cache; failed loads remain retryable. Controlled reset tests cover invalidation during both file
loading and state publication. Cache age starts when loading finishes.
The exact [1.125.0 Memento source](https://raw.githubusercontent.com/microsoft/vscode/1.125.0/src/vs/workbench/api/common/extHostMemento.ts)
and [1.138.0 source](https://raw.githubusercontent.com/microsoft/vscode/1.138.0/src/vs/workbench/api/common/extHostMemento.ts),
retrieved October 21, confirm that updates assign the in-memory value before awaiting persistence; late persistence
completion does not itself publish an older value.

| Eight concurrent cold callers, held at a read barrier | Before | After |
| ----------------------------------------------------- | -----: | ----: |
| Settings-file reads                                   |      8 |     1 |
| Project modes-file reads                              |      8 |     1 |
| Global-state writes                                   |      8 |     1 |

An adjacent lifecycle regression showed that disposing the manager while watcher setup awaited its settings path still
created two watchers afterward. A disposal flag checked after that await prevents those unowned watchers from being
created. Race tests use controlled promises, without sleep-based ordering.

### Eager document parsers

`extract-text.ts` is imported by terminal, diff, mention, and file-reader paths. Its static PDF, DOCX, and XLSX imports
initialized document dependencies even when startup only needed text helpers or the supported-format catalog.

Format-specific dynamic imports now live inside the existing extractors. The CommonJS extension bundle still includes
these dependencies; their initialization moves to the first request for the corresponding format. Cancellation is
checked after module loading and before parser invocation. The regression verifies no document parser initializes for
module loading, format listing, plain text, or notebooks; each document format initializes only its requested parser.
Existing tests also read real PDF, DOCX, XLSX, and notebook fixtures and exercise extraction errors and bounds.

An isolated Windows Node 24.21.0 benchmark alternated precompiled minified CommonJS variants over five warmups and forty
measured fresh VM contexts per variant, with the same dependencies and warm filesystem/builtin caches. Importing the
extraction module took a median 15.50 ms before and 1.58 ms after, with p95 27.97 ms and 2.57 ms respectively. Parser
initializations fell from three to zero. The bundles remained about 5.40 MB. These measurements exclude bundle parsing
and full activation; the cost of the requested parser moves to its first document read. The permanent lazy-parser
regression suite enforces the initialization boundary independently of timings.

### Synchronous translation discovery

Importing the extension synchronously enumerated locale directories and read ten translation files before `activate()`
started. Alpha ships English only. Static JSON imports now bundle those resources and remove twelve synchronous
filesystem operations from module initialization. Existing test-mode translation-key behavior is preserved; dedicated
tests explicitly exercise production resources, namespace completeness, English fallback, and interpolation.

The reproducible isolated benchmark compares the same current dependencies and build settings, substituting only
`src/i18n/setup.ts` from baseline commit `b3427641ac61d5cbe273fca50819888940b4b998`:

```sh
node scripts/benchmarks/extension-i18n.mjs b3427641ac61d5cbe273fca50819888940b4b998
```

It alternates variants, uses ten warmups and seventy measured fresh VM contexts per variant, and runs precompiled
minified bundles against warm filesystem caches in production mode. It verifies a real translated string and requires
zero synchronous filesystem calls from the current initializer.

| Isolated translation initialization |  Before |   After |
| ----------------------------------- | ------: | ------: |
| Median                              | 1.68 ms | 0.59 ms |
| p95                                 | 2.83 ms | 0.75 ms |
| Synchronous file reads              |      10 |       0 |
| Synchronous directory scans         |       2 |       0 |
| Isolated JavaScript bytes           |  42,241 |  80,031 |

Bundling trades about 38 KB of JavaScript for avoiding runtime discovery and file reads. This is a small local
improvement; it does not explain a multi-second delay by itself.

## Startup boundaries and remaining limits

The activation sequence first imports extension modules, then loads the optional environment, configures debug proxy
behavior, performs settings migrations, initializes ContextProxy, constructs providers, and registers the view.
Configured automatic settings import precedes command registration. These ordering constraints remain intact.
Indexing, scheduled tasks, and MCP connections already initialize in the background; their network completion does
not gate the first webview snapshot.

The first snapshot intentionally waits for task-history migration and managed-task recovery. Publishing stale recovery
state would violate the persistence/lifecycle contract. Large or slow profiles may still spend time here. Other eager
provider/tokenizer dependencies and configured automatic imports are further profiling candidates, not proven causes
of the reported delay. MCP's enabled check also obtains broader provider state than it needs; its mode reads now share
the manager's pending load.

The manifest's generic `onLanguage` event activates before language use, even though `onStartupFinished` is also present.
It remains unchanged because removing it affects early code-action readiness. The existing `extension_activation`
observability timer starts inside `activate()` and therefore excludes module parsing/evaluation. Any remaining
affected-profile investigation should include VS Code's extension load/startup profile and the webview readiness span.

Primary references retrieved October 21, 2026:
[VS Code activation events](https://code.visualstudio.com/api/references/activation-events),
[extension bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension), and
[React StrictMode](https://react.dev/reference/react/StrictMode).
These changes concern host initialization and resource loading; agent execution, tools, policy, and saved formats are
unchanged. No current Codex agent behavior is inferred or modified.

## Validation

The focused suites cover extension lifecycle/manifest, native webview messages and provider readiness, custom modes and
skills, renderer startup/state, production translations, and document extraction. Exact-host verification uses the
scripted provider rather than a signed-in live model:

```sh
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

Across focused runs, 658 extension tests passed with six existing skipped tests. The three renderer suites passed all
92 tests. Touched extension/webview lint, both typechecks, formatting, and scoped diff checks passed. Custom-mode files
retain their existing CRLF line endings. The VS Code 1.138.0 gate rebuilt the extension and production webview and passed
all 47 tests in thirteen required files, with no failed or skipped tests. Its first activation run was
`9ad0c5f5-1f23-4ad5-98f5-02a043acd3f4`; its final background-completion run was
`03353917-bd36-4b1a-a350-22297723866c`. Each runner used its own temporary profile/workspace and verified the exact host.

The exact 1.125.0 command rebuilt successfully, but Windows VS Code refused to launch before extension activation:
`vscode-updating` remained held after its 30-second wait. The runner recorded `host-preflight-missing` in run
`fdedd4f7-1e90-4039-b9db-c1ecfc491818`; no compatibility tests executed. Read-only process inspection confirmed two active
VS Code installer processes. The [1.125.0 startup guard](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/code/electron-main/main.ts#L480),
retrieved October 21, confirms this behavior. The installer and host protections were left intact. Minimum-host runtime
compatibility therefore remains unverified in this run; the 1.125.0 type baseline and lower-level coverage passed.

Local detailed output and run summaries are retained in `/tmp/alpha-startup-review-20261021/` for this investigation.

The user's affected signed-in profile was not traced. Overall startup time and live-provider readiness remain
unmeasured; the work-count regressions and isolated timings establish the specific improvements above.
