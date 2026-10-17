# Extension loading and responsiveness review — 2026-10-16

## Scope and reference contracts

This performance optimization pass used 12 agents to inspect activation, first provider requests, provider discovery,
instruction collection, task navigation, history storage, settings, webview startup, state projection, history rendering,
command launch, and background services. The objective was to remove demonstrated work from interactive paths and fix
bounded correctness findings. This is an improvement pass, not a claim that every extension path is fully optimized.

Alpha baseline: `e3595d3da3966f8e137a1424f79880d9862c14ae`. Development measurements used Windows, Node 24.21.0 and
pnpm 11.24.0. Host validation targets exact VS Code 1.125.0. No production dependency, release version, public wire shape,
persisted format, execution policy, approval rule, or provider history format was changed.

Current Codex CLI source and tests were inspected at commit
[`221e4e7c05386d06aa7b91da2a9b04f7f2bd921f`](https://github.com/openai/codex/tree/221e4e7c05386d06aa7b91da2a9b04f7f2bd921f),
retrieved 2026-10-16:

- `core/src/agents_md.rs` and `agents_md_tests.rs`: ordered root-to-cwd instructions, override precedence and sequential
  content-budget consumption. Alpha overlaps independent source families while preserving ordering inside each family.
- `core/src/client.rs` and request trace tests: request identity/telemetry capture precedes dispatch without an awaited
  optional disk journal. Alpha still awaits canonical lifecycle publication and keeps its existing diagnostic flushes.
- Unified execution handlers/runtimes and tests: captured execution context, approval before launch, cancellation and
  separate launch outcomes. Alpha retains its existing VS Code terminal adapters and security boundaries.
- Rollout listing/resume and TUI session/history tests: workspace-scoped listing, durable resume and rejection of obsolete
  history completions. Alpha keeps its own history store and navigation-generation mechanism.
- `ext/skills/src/host_service.rs` and its tests: the service owns discovery, invalidation and immutable catalog snapshots;
  equivalent pending loads coalesce. Alpha retains provider/task-scoped catalogs and VS Code watchers.

The host activation contract was checked against the
[VS Code 1.125.0 extension service](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/api/common/extHostExtensionService.ts).
The language-model catalog change preserves live model selection and user consent as described in the
[VS Code LM guide](https://code.visualstudio.com/api/extension-guides/ai/language-model). React
[lazy loading](https://react.dev/reference/react/lazy), [conditional rendering](https://react.dev/learn/conditional-rendering)
and [state preservation](https://react.dev/learn/preserving-and-resetting-state) were checked on 2026-10-16.

## Fixed now

The performance findings are Medium / should-fix; the stale-selection/input navigation race is High / should-fix. Each
change has controlled baseline evidence and regression coverage.

| Path                                                                                     | Removed work or corrected behavior                                                                                                    | Same-workload evidence                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Optional development environment](../src/utils/loadEnvironment.ts)                      | Check `.env` asynchronously; initialize dotenvx only when present, before activation setup                                            | Isolated bundled setup median 6.295 → 0.797 ms; p95 8.291 → 3.034 ms                                                               |
| [Startup webview graph](../webview-ui/src/components/welcome/WelcomeViewProvider.tsx)    | Load provider setup when opened instead of importing it through the welcome landing                                                   | Static startup JS closure 5,822,962 → 5,604,184 bytes; module IDs 3,138 → 2,956                                                    |
| [Diagram loading](../webview-ui/src/components/common/MarkdownBlock.tsx)                 | Render Mermaid lazily; use automatic [chunk partitioning](../webview-ui/vite.config.ts) so shared helpers cannot pull it into startup | Same final config: eager vs lazy Markdown startup JS 3,077,501 → 2,439,221 bytes; Mermaid and provider options absent from startup |
| [App shell](../webview-ui/src/App.tsx)                                                   | Use the existing shell-state subscription                                                                                             | 100 transcript-only updates: 101 → 1 App subscription reads/renders                                                                |
| [Settings search initialization](../webview-ui/src/components/settings/SettingsView.tsx) | Index controls only in the 11 sections containing searchable controls; retain all 17 titles                                           | Opening Agents: four unrelated command/skill/worktree requests → zero                                                              |
| [Collapsed history groups](../webview-ui/src/components/history/TaskGroupItem.tsx)       | Mount descendants only while expanded; retain disclosure regions and parent-owned expansion/selection                                 | A collapsed 420-descendant tree: 420 → 0 mounted rows; expanding parent/one branch mounts 20/40                                    |
| [Workspace history query](../src/core/task-persistence/TaskHistoryStore.ts)              | Normalize the requested root once and filter before sorting                                                                           | 10,000 tasks / 100 workspaces: sort 10,000 → 100 selected rows; paired virtual median 21.90 → 12.81 ms                             |
| [History reconciliation/migration](../src/core/task-persistence/TaskHistoryStore.ts)     | Capture one configured storage root for all files in an operation                                                                     | 10,000-task reconciliation: storage resolutions 10,001 → 1; associated mkdir/access count proxy 20,002 → 2                         |
| [Host state projection](../src/core/webview/AlphaProvider.ts)                            | Query history once at the original late capture point, or skip it for transports that omit history                                    | Full projection queries 2 → 1; either history-omitting transport 2 → 0                                                             |
| [Instruction preparation](../src/core/prompts/sections/custom-instructions.ts)           | Overlap mode, AGENTS and generic rule reads in three fixed branches                                                                   | 10 ms per filesystem operation: 180 → 70 virtual ms; same 21 operations                                                            |
| [Provider dispatch](../src/core/task/Task.ts)                                            | Queue two additive diagnostic writes after mandatory canonical admission                                                              | Two injected 25 ms writes: optional-storage admission delay 50 → 0 virtual ms                                                      |
| [First terminal acquisition](../src/core/tools/ExecuteCommandTool.ts)                    | Read terminal settings through existing cached getters instead of building full UI state                                              | Injected 100 ms unrelated state load: acquisition 100 → 0 virtual ms; full projections 1 → 0                                       |
| [Pending VS Code LM discovery](../src/api/providers/vscode-lm.ts)                        | Share only the in-flight catalog request; later refreshes remain fresh                                                                | Eight overlapping refreshes: eight → one host model-selection calls                                                                |
| [Skill watcher refresh](../src/services/skills/SkillsManager.ts)                         | Coalesce overlapping events; invalidate active scans and serve pending changes                                                        | 50 same-turn events: root discovery and catalog publications each 50 → 1                                                           |
| [New Task navigation](../src/core/webview/AlphaProvider.ts)                              | Invalidate obsolete historical opens; stop superseded blank transitions after awaited stages                                          | Obsolete restores 1 → 0; scheduled transcript serialization proxy 410,783 → 0 bytes                                                |
| [Terminal preview preference](../src/core/webview/AlphaProvider.ts)                      | Include saved preview size in settings snapshots                                                                                      | Saved small/large survive hydration and unrelated Save; four persisted/default projection cases                                    |

Optional environment measurements use five warmups and 35 alternating samples in fresh VM contexts with precompiled
bundles and warm caches. Static ESM imports already ran before the former module-body environment loader, as specified by
[esbuild's import semantics](https://esbuild.github.io/content-types/#imports-follow-ecmascript-module-behavior); the change
preserves that behavior. Its bundle size is essentially unchanged, 414,916 → 414,985 bytes.

The webview comparisons run production Vite builds with output and source-map writing disabled. Each pair uses the same
workspace and config, replacing only the selected module with its baseline source for the first build. The welcome-only
measurement above predates the diagram chunk change; it removes provider options from startup and reduces initial
settings modules from 22 to the constants module alone. The final Markdown pair uses automatic chunk partitioning in both
variants: startup JavaScript falls from 3,077,501 to 2,439,221 bytes (20.74%), and module IDs from 1,085 to 877.

Removing forced Mermaid grouping and loading the component lazily together reduce startup JavaScript from the earlier
5,604,184-byte graph to 2,439,221 bytes (56.48%). This aggregate includes both changes. React.lazy alone does not account
for all of it: the former manual grouping also pulled shared preload/CommonJS helpers, math rendering and unused diagram
types into startup. The final graph excludes provider options and Mermaid, retains a dynamically reachable renderer and
engine, and preserves Mermaid's own diagram-type splitting. Graph assertions check actual module membership and
reachability instead of generated filename/facade assumptions.

This uses the existing Vite 6.4.3 / Rollup 4.59.0 toolchain. Its behavior was checked against the installed Rollup source
and [official chunking documentation](https://rollupjs.org/configuration-options/#output-manualchunks). Final paired builds
have zero `CIRCULAR_CHUNK` or `CYCLIC_CROSS_CHUNK_REEXPORT` warnings; their 22 input-source `CIRCULAR_DEPENDENCY` warnings
are unchanged. The benchmark retains warnings in its JSON output. The byte count follows static imports, excludes dynamic
imports, and measures uncompressed JavaScript reachability, not transferred bytes, parse time, or first paint. The render
fixture counts App subscriptions; it does not claim every Chat child previously rendered in production.

The history fixture transpiles the actual class from both revisions and replaces only external filesystem/storage
boundaries. It uses 10,000 entries across 100 workspaces, 100 matching rows, 20 warmups and seven samples of 100 queries,
alternating variants. Matching IDs are checked. Query timings are supplemental, machine-dependent VM measurements;
structural operation counts are the stable regression evidence. No new cross-request history cache was introduced.

Instruction reads retain instruction text, role/provenance, fallback/error priority, symlink/path checks, root-to-cwd byte
budgets and per-call freshness. Peak fixture I/O increases from two to six operations, bounded by three source branches.
Disabled or already-frozen AGENTS sources are still handled without rereading those files. Existing snapshots are unchanged.

Diagnostic writes retain their order and captured request/attempt identity. Existing completion/cancellation flushes still
wait for them; rejected writes remain handled and observable. An abrupt process kill can now omit those two optional
diagnostics before their flush. Canonical lifecycle and transcript durability barriers remain awaited.

Skill refresh tests cover edits during scans, queued/active disposal, failed discovery/publication followed by an already
queued event, and propagation of the latest failure. There is no unconditional retry or debounce timer. Settings inputs
still use `cachedState`; Save/Cancel, dirty drafts, profile identity and search navigation remain covered.

Ordinary Markdown gains no translation-context subscription. Only the pending diagram's loading fallback subscribes;
a regression proves translation-context updates leave an unchanged plain Markdown parser at one render. Partial diagrams
remain literal code, pending diagrams receive the latest code when loading resolves, and existing strict security and
render-generation protection are unchanged.

These workloads isolate particular costs. Their timings cannot be added together or presented as an end-to-end latency
improvement. No live model/provider speed or quality claim is made.

## Reproduction and validation

The standalone measurement entrypoints are:

```sh
node scripts/benchmarks/activation-environment.mjs
node scripts/benchmarks/task-history.mjs
node scripts/benchmarks/webview-startup.mjs
node scripts/benchmarks/webview-startup.mjs e3595d3da3966f8e137a1424f79880d9862c14ae markdown
pnpm --dir src test core/prompts/sections/__tests__/custom-instructions-performance.spec.ts --maxWorkers=1 --no-silent
pnpm --dir src test services/skills/__tests__/SkillsManager.spec.ts -t "refresh coalescing" --maxWorkers=1 --no-silent
```

The paired history and webview scripts accept an optional baseline Git ref, defaulting to the pinned Alpha baseline above.
The webview script also accepts `welcome` (default) or `markdown` as its second argument and enforces startup module and
output-cycle invariants. The final Markdown command above passed. Keep the checkout unchanged during a paired build.

Focused validation completed during implementation (commands overlap in some existing provider suites):

| Area                                              | Result                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Activation/environment                            | 13 passed / 2 files                                                                     |
| VS Code LM provider/contracts                     | 152 passed / 2 files                                                                    |
| History persistence                               | 74 passed / 4 files                                                                     |
| State/history/settings projection                 | 179 passed, 6 existing skips / 2 files                                                  |
| Navigation/host ownership/sticky mode             | 225 passed, 6 existing skips / 4 files                                                  |
| Instruction discovery/system/frozen context       | 155 passed, 2 existing skips / 11 files                                                 |
| Provider request admission/lifecycle/cancellation | 43 passed / 4 files                                                                     |
| Command launch/output/lifecycle/parallel reads    | 213 passed / 7 files                                                                    |
| Skill discovery and watchers                      | 212 passed / 9 files                                                                    |
| Settings draft and search interactions            | 97 passed / 3 files                                                                     |
| History components                                | 32 passed / 2 files; 21-test parent suite rerun after matcher type compatibility repair |
| App and welcome navigation                        | 38 passed, 2 existing skips / 2 files                                                   |
| Markdown and lazy diagrams                        | 17 passed / 4 files                                                                     |
| Complete webview suite                            | 2,404 passed, 2 existing skips / 196 files                                              |

Final typechecks passed: `pnpm --dir src check-types`, `pnpm --dir webview-ui check-types` and
`pnpm --filter @alpha-code/vscode-e2e check-types`. The webview check first
caught a new runtime-supported matcher absent from the repository's Jest type declarations; equivalent call-count and
argument assertions repaired that compatibility issue, and the affected 21-test suite passed again.

Touched-file ESLint and Prettier checks passed, as did syntax checks for the three benchmark scripts and `git diff --check`.
The complete webview suite passed with `pnpm --dir webview-ui test --maxWorkers=2`.

The final `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` rebuilt the extension and webview and passed all 42 tests
across 13 suites on exact VS Code 1.125.0, with zero failures or pending tests and verified profile ownership. The rendered
history fixture then passed through `pnpm --dir apps/vscode-e2e exec node out/runHistoryUi.js`, using the driver compiled
by that gate. It exercised New Chat, history search/keyboard navigation, reopening a persisted 1,200-message transcript,
and dark/light/high-contrast presentation. The three expanded-history screenshots were visually inspected. Its new
diagram check observed 12 additional JavaScript resources after adding a completed Mermaid fence and verified the actual
SVG's expected text; the diagram was outside the captured transcript viewport.

Rendered-host artifacts remain at
`C:/Users/LUKEGO~1/AppData/Local/Temp/alpha-code-history-ux/chats-c9795794-0b2f-4a25-85e4-1d61cae3e55b`.
The scripted provider's single navigation sample recorded New Chat DOM/paint at 42.6/50.6 ms and persisted-task reopen
feedback/DOM/paint at 1.7/112.1/140.2 ms. These are supplemental final-state measurements without a before comparison,
not a general speedup claim. The artifact records host, provider, transcript conditions and extension-bundle SHA-256.

`pnpm bundle` completed through the exact-host gate. `pnpm vsix` then produced `bin/alpha-3.2.1.vsix`, and
`node scripts/verify-vsix-contents.mjs bin/alpha-3.2.1.vsix` verified all 1,814 entries, required files and absence of `.env`.
The package was built for validation; it was not installed or published.

## Closure ledger

- **Fixed now:** the bounded issues above, including both navigation and saved-preview correctness defects. The final
  review also repaired lost pending watcher changes when an older discovery or publication failed.
- **Flagged for follow-up:** cold task-metadata saves await directory-size scans; profile that workload before changing
  size freshness. MCP catalog tools/resources/templates RPCs run serially; review pagination, cancellation and failure
  contracts before overlapping them. New Task remains on the shared message queue; any separate fast lane must preserve
  ordering with subsequent task creation. These are the next focused performance passes.
- **Not verified:** live-provider latency, real-user workspace distributions, total cold-start speedup, and behavior in
  every supported OS/theme. The isolated timing/count comparisons are not substitutes for those measurements.
- **Out of scope:** alternate runtimes, sandbox parity, provider/model changes, dependency upgrades and release publication.
  The unrelated speech-to-text investigation document present before this work was left untouched.
