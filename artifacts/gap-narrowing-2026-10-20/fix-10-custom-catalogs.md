# Fix 10: owned custom tool catalogs and bounded refresh

Mode: **correctness cleanup**, limited to the custom tool registry and its active task/refresh consumers. This closes findings 2 and 4 in `artifacts/directory-review-2026-10-20/clean-08-managed-packages.md` for direct tool definitions. It does not claim a repository-wide review or unrestricted transitive-module hot reload.

## Evidence and intended behavior

The prior registry accumulated every loaded directory into one process-global name map. `build-tools.ts` awaited the current workspace's directory load and then independently read that global map. A different workspace's tool therefore became both advertised and executable. Directory-only mtime checks missed in-place changes, native JavaScript imports reused their unchanged URL, and additive loading kept removed files/exports registered.

Read the review and its owned-temp reproduction `clean-08-repro.mjs`. Added native-Node regressions before production edits: all six initial registry scenarios failed for the reported ownership/freshness defects. Added a controlled-promise task-capture regression before its consumer edit: it failed while the nine existing catalog-name tests passed. The audit reproduction deliberately asserts defective behavior; it is historical evidence, not an acceptance test to keep passing.

Inspected current Codex CLI checkout at `C:/Users/Luke Goblirsch/AppData/Local/Temp/ac-c7234c1`; verified HEAD **`c7234c1174b27d9c55199fba0d546dc27d1b0415`**. `codex-rs/core/src/tools/router.rs` owns one finalized tool plan containing advertised specs and matching executable runtimes. `tools/handlers/dynamic.rs` captures each external tool's identity and spec. `tools/registry_tests.rs` checks external collision winners and trusted tool ordering. Alpha follows the same captured-surface invariant in its existing TypeScript registry; Alpha's custom TS/JS tools remain a first-class extension capability, with existing approval policy intact. No Rust, copied prompts, replacement runtime, or sandbox changes were introduced.

Native loader rules were checked against the official [ESM URL/cache documentation](https://nodejs.org/api/esm.html#urls) and [CommonJS require cache documentation](https://nodejs.org/api/modules.html#requirecache), retrieved 2026-10-20; their published current page identified Node 26.12.0. Compatibility behavior was actually exercised on development **Node 24.21.0**, pnpm **11.24.0**, Windows. Versioned ESM URLs produce separate module instances; deleting the exact CommonJS source's require-cache entry is also necessary for supported CJS-shaped `.js` definitions. A focused CJS regression first failed with query-only refresh, then passed after source-specific invalidation.

## Exact changes

- `packages/core/src/custom-tools/custom-tool-registry.ts`: canonical directory ownership, content fingerprints, replacement per-directory snapshots, immutable returned definition arrays/objects, atomic legacy getter projection, ordered per-request merge, explicit file/directory failures, per-source module-load serialization, source-change checks, native ESM/CJS refresh, immutable TypeScript resource generations and bounded retention. Successful exports from a file are published together only after all its candidate definitions validate. Missing/failed files contribute no stale current executable; already captured steps retain their own previous definitions and environment files.
- `packages/core/src/custom-tools/types.ts` and `index.ts`: additive `CatalogLoadResult` export with `{ loaded, failed, catalog }`. Existing registration, lookup, unregister, clear, serialization, extension-path and cache-clear methods remain available. Direct `register()` entries remain explicitly global; later requested directories retain override precedence. Duplicate names in `loaded` remain observable across distinct requested directories. `clear()` now invalidates directory snapshots so the next capture can restore unchanged source files.
- `src/core/task/build-tools.ts`: schema and executable capture uses the same owned `result.catalog`, with no post-await singleton read. Existing ToolRegistry/TaskToolSurface machinery and policy filters receive the scoped definitions.
- `src/core/webview/webviewMessageHandler.ts`: only the core import and `refreshCustomTools` branch changed; refresh serializes its owned catalog and returns explicit failed-source errors. Existing unrelated Ticket/startup edits were preserved.
- Registry/catalog tests: added `custom-tool-registry.catalog.spec.ts`; updated the previous clear/staleness characterization; added controlled overlapping task capture in `customToolCatalog.spec.ts`; updated existing catalog-load mocks in `tool-catalog-invalidation.spec.ts` and `TaskToolCatalogCache.spec.ts`; added `webviewMessageHandler.customTools.spec.ts` for owned refresh output and failure reporting.

## Boundedness and compatibility

Directory snapshot caches are capped at **64** entries per registry; compiled-source URL caches at **128**. Concurrent directory/module loads are capped at **64** with explicit overload failures. Per-source compile/import ownership serializes source staging. Disk pruning is serialized per process namespace, excludes all imported generation directories, and coordinates with in-progress removals. Only generated cache-directory names are candidates, and unrelated directories are retained.

Review of the first stable-slot implementation found a resource-lifetime defect: deleted `.env` files survived in the reused directory, and an older captured tool reading `import.meta.url` at execution would see the next generation's env files. The final implementation compiles in a staging directory, then derives an immutable generation directory from source identity, bundle content, and the exact env filenames/bytes. Deleted env files are absent from the new generation. An imported generation's files are retained for the host's lifetime, including during `clearCache()`; a focused regression covers both `.env` and `.env.local`, replacement, deletion, old captured execution, and cache clear.

There is a hard **128 retained TypeScript-generation ceiling**, shared across registry instances, plus at most **64 active staging directories**. Staging is removed in `finally`, and failed compilation also runs maintenance. Unreferenced generated slots are pruned to 128; imported generations are never silently evicted. The 129th new retained TypeScript generation fails explicitly with a reload-required error. Native ESM versions cannot be evicted through a supported Node API, so all registry-originated imports additionally have a **process-wide 256-URL ceiling**, including failed imports. Repeated identical versions reuse their URL. At either ceiling a new version contributes no current executable. `clear()`/`clearCache()` do not pretend to reclaim Node's permanent module map or reset the ceilings.

Compiled caches, including caller-configured roots, use a `host-<PID>-<random UUID>` namespace. One live VS Code window cannot prune another's env resources. Initialization removes only owned-format host namespaces whose PID is demonstrably absent (`ESRCH`); live, inaccessible, reused/unknown PID namespaces and historical flat cache directories remain untouched. Therefore the bound applies per active host, plus historical directories that cannot safely be proven unused; no global disk bound across arbitrary live or inaccessible hosts is claimed.

Owned process, staging and generation directories are created with mode `0700`; generated bundles and copied env contents with mode `0600`. This avoids broadening a private source env file's POSIX permissions when writing its captured bytes. Windows relies on its inherited filesystem ACLs; the POSIX mode assertions are platform-gated and were not exercised in this Windows run.

JavaScript keeps native relative import resolution, and TypeScript keeps the existing esbuild ESM bundling, Node externals, require shim and per-tool env directory. Native tests cover JavaScript relative imports, ESM top-level await, CommonJS updates, TypeScript top-level await/import.meta URL/env lookup, and dependency-only TypeScript edits through explicit force refresh. Static/transitive JavaScript dependency caching remains Node's native behavior; changing an imported helper without changing the definition itself may require an extension-host reload. Arbitrary dynamic imports and resources created by user tool implementations are outside the registry-owned cache bound.

## Validation actually run

Before edits:

- `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1`: **6 failed / 6**. Cases: A -> B -> A, overlapping directory loads, warm same-name precedence, unchanged-timestamp JS edits, explicit rename/delete/directory deletion, failed reload/recovery.
- `pnpm --dir src test core/task/__tests__/customToolCatalog.spec.ts --maxWorkers=1`: **1 failed, 9 passed**; the owned overlapping capture was the failing regression.
- Additional CJS-only regression with the first ESM-query implementation: **1 failed** (`first` remained executable instead of `second`), then **1 passed** after exact-source require-cache invalidation.

After implementation:

- `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.spec.ts src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1`: **43 passed / 2 files**, 184.41 seconds. This run collected the existing suite plus nine native scenarios before the final CJS scenario was added; the final native suite was then rerun separately.
- `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1`: **10 passed / 1 file**, 33.35 seconds, before resource-generation refinement. Real native imports are exercised in bounded child processes because Vitest/Vite changes dynamic-import behavior.
- `pnpm --dir src test core/task/__tests__/customToolCatalog.spec.ts core/task/__tests__/tool-catalog-invalidation.spec.ts core/task/__tests__/TaskToolCatalogCache.spec.ts core/webview/__tests__/webviewMessageHandler.customTools.spec.ts --maxWorkers=1`: **99 passed / 4 files**, 30.88 seconds.
- Focused native `-t 'relative imports'` run after extending the TypeScript dependency-only refresh assertion: **1 passed / 9 skipped**, 5.83 seconds.
- Initial immutable-generation native run: **12 passed / 1 file**, 53.12 seconds, including both captured/deleted env variants. Core `check-types` also passed after that refinement.
- Final immutable-generation native run: **14 passed / 1 file**, 58.35 seconds. This includes real ESM/CJS/TS imports, A -> B -> A, overlapping capture, edits/deletion/failure, preserved env resources, live-process namespace preservation, 256 root-import ceiling, and 128 retained compiled-generation ceiling. The last ceiling uses a copy-only esbuild test executable so its bound is tested without requiring 129 real TypeScript compilations; actual transpilation is exercised elsewhere in the same suite.
- Final affected extension tests: **99 passed / 4 files**, 16.40 seconds, using the four-file command above after production sources settled. Final `pnpm --filter @alpha-code/core check-types`: **passed**, 5.06 seconds. Each final pnpm invocation sets `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn`.
- Final original registry fixture rerun: `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.spec.ts --maxWorkers=1`: **34 passed / 1 file**, 141.81 seconds, against immutable generations. After a final permissions-only edit, core `check-types` passed again in 5.69 seconds; native env/dependency/retention checks were rerun separately.
- Permissions-only follow-up: `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1 -t 'env resources|deleted env|relative imports'`: **4 passed / 10 skipped**, 24.92 seconds. Final touched-file Prettier check passed. Production source is stable at handoff; only this evidence document was amended after the last checks.
- Touched-file Prettier and `git diff --check`: passed. No intentional installs, commits, dependency edits, broad formatting, ToolRegistry edits, or AlphaProvider edits. One pre-warning pnpm test invocation implicitly ran its verify-deps `Already up to date` path and bootstrap/husky lifecycle; subsequent commands explicitly set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn`. Lockfile status was checked before handoff.

The coordinating agent owns broad extension type/lint gates and the exact VS Code 1.138.0/1.125.0 gates. They were not run by this implementation agent. Native loader assertions are correctness/boundedness evidence; the elapsed times above are run records under concurrent repository work, not a before/after speed claim.

## Closure ledger and residual risk

- **Fixed now:** workspace executable leakage; stale direct JS/CJS/TS definitions after edits or deletion; warm-directory override order; failed reloads reported as current success; mutable global reads in task and refresh consumers; registry-owned cache version growth; captured TS env resources changing across refreshes; deleted copied env files surviving into new generations; cross-window cache pruning.
- **Not verified here:** exact VS Code hosts, broad extension typechecking, POSIX permission assertions (Windows host), all OS-specific filesystem error interleavings, and every possible arbitrary custom module dependency graph.
- **Out of scope:** recursive native JavaScript dependency hot reload, sandbox/runtime replacement, unrelated managed-worktree findings, production dependency changes, user-authored edits.

The principal intentional compatibility changes are owned per-request directory catalogs, `clear()` invalidating stale snapshots, `clearCache()` retaining resources referenced by imported generations, removal of failed/deleted current definitions, and explicit reload-required failure after 128 retained compiled generations or 256 distinct registry imports. Captured previous steps stay immutable and remain governed by the existing approval and cancellation path.

## Final recovery-edge follow-up

Parent review found that the first immutable-generation implementation marked a directory retained before its bundle/env writes finished. A one-shot injected failure on the second cache env write reproduced the defect: the next refresh skipped all writes because the directory already existed, imported a missing `.env.second`, and failed with `ENOENT` under the otherwise unchanged generation URL.

The registry now distinguishes pending generation reservations from retained imported generations. Pending reservations count toward the same hard 128 limit and protect filesystem writes from pruning/`clearCache()`. All bundle/env writes and source checks must finish before the retained marker is published. Failed pre-import output is removed and the reservation released, so retry reconstructs every file. Once native import starts, resources stay retained even if evaluation throws. This is confined to registry publication/recovery state; no new feature, public API, dependency, or runtime was introduced.

- Before fix: focused `-t 'unpublished generation'` regression **1 failed / 14 skipped**, retry failed with missing `.env.second`.
- After fix: the same regression **1 passed / 14 skipped**, 7.37 seconds; it also checks that incomplete output is never imported and the old captured executable still works.
- Added the complementary native case that exposes an env reader and then throws during module evaluation; resource retention remains required after that import failure.
- Core `check-types`: **passed**, 6.20 seconds. Focused ESLint for `custom-tool-registry.ts` and `custom-tool-registry.catalog.spec.ts`: **passed**, 4.04 seconds. Touched-file Prettier passed.

The final full native catalog suite passed **16 / 16**, 65.47 seconds, including interrupted-write recovery and preservation after module-evaluation failure. Production source is stable after the focused regression, full native suite, typecheck, ESLint, formatting and diff checks; only evidence documentation changed afterward.

## Release 3.2.7 Linux fixture-loader follow-up (2026-10-21)

The first Ubuntu release QA job at `9dd5287bb` reported **225 passed, 12 failed, 8 platform skips** in core, taking 691.95 seconds. All twelve failures were deadlines in `custom-tool-registry.spec.ts`; the first two forced full-fixture loads passed, later loads logged the expected `invalid.ts` validation error and then stopped completing. The independent native catalog cases passed. Evidence: `artifacts/harness/release-3.2.7/ubuntu-first-job.log`, lines 1560–1785. The production registry is unchanged between that source and the investigation baseline **`e768c567d94cca61154e09ab70f77a772f4726b1`**.

The legacy suite had loaded the registry through Vitest, which routes its dynamic tool imports through Vite's transformed module graph. The passing catalog scenarios load a fresh registry bundle through Node. [Vitest's feature documentation](https://vitest.dev/guide/features.html), inspected 2026-10-21 alongside the pinned Vitest 4.1.11/Vite 6.4.3 module-runner code, confirms that its transform/resolver infrastructure differs from Node's native ESM loader. The timeout pattern and native Linux reproduction below implicate that transformed import path; the exact unresolved internal Vite module-graph promise was not instrumented, and this is not a claim that every arbitrary custom dependency graph was proven safe.

The test-only correction compiles the current registry source once per suite and loads the resulting ESM bundle with Node's `createRequire` (supported by the development Node 24.21.0 host). This bypasses Vite's source transformation for that bundle. **Later evidence showed this was incomplete as a diagnosis and fix:** Vitest also installs process-wide Node loader hooks, including for native imports from that bundle. Every existing public-method assertion and deadline is preserved. No production runtime, module semantics, cache behavior, test skip, private-method spy, or timeout increase was added. The existing encoded-path/native-cache case now also imports a real `@alpha-code/types` Zod schema and parses it after each of its three forced loads, including the fresh-registry disk-cache path.

Retained diagnostic `registry-native-linux-probe.mjs` compiles the current source and exercises all original fixture modules through native Node: four forced directory loads, including a new registry sharing the cache; exact six-tool catalogs and the one intended validation failure; execution of the legacy, mixed, named and default definitions; schema parsing; and later-directory override precedence. It succeeded under WSL Ubuntu **Node v22.21.1**, with sources/dependencies on `/mnt/f`. This is an additional Linux-native diagnostic, not the pinned Node 24 release gate. The Windows dependency tree lacks Linux Rollup's optional binary; a complete Linux Vitest run was not attempted through dependency installation.

Exact WSL command (from the Windows workspace):

```powershell
wsl -d Ubuntu --cd /mnt/f/roo-fork/Alpha-Code/packages/core --exec /home/luke_goblirsch/.nvm/versions/node/v22.21.1/bin/node /mnt/f/roo-fork/Alpha-Code/artifacts/gap-narrowing-2026-10-20/registry-native-linux-probe.mjs /mnt/f/roo-fork/Alpha-Code
```

Observed exit **0** with four `Native Linux load N: six tools and one expected invalid definition` messages and final `Native Linux override load passed on v22.21.1 (linux)`. The script owns and removes only its newly created temporary directory.

Windows verification on the investigation baseline plus the test-only correction:

- Focused legacy registry suite: **34 passed / 1 file**, 107.44 seconds; all original deadlines unchanged.
- Full core `pnpm --filter @alpha-code/core test --maxWorkers=2`: **246 passed / 17 files**, 186.96 seconds.
- Separate native catalog `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1`: **16 passed / 1 file**, 40.15 seconds.
- Core `check-types`: **passed**, 3.825 seconds. Focused ESLint on the touched registry spec: **passed**, 3.29 seconds.
- Touched-file Prettier and `git diff --check`: **passed**. All pnpm invocations use `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn`.

Final follow-up files: `packages/core/src/custom-tools/__tests__/custom-tool-registry.spec.ts`, this report, and `artifacts/gap-narrowing-2026-10-20/registry-native-linux-probe.mjs`. No production, release, dependency, lockfile or unrelated source edits were made in this follow-up. Test sources are stable after validation; only this evidence report was amended with completed results.

The parent agent owns committing, publishing and rerunning Ubuntu release CI. Passing native Linux diagnostics and Windows tests do not substitute for that pinned release gate.

## Main-branch recurrence and stage investigation (2026-10-21)

After all ten PR checks passed, the identical merged tree at **`4f59e6084fda1463c08831a7a0ce4f99d108cdfa`** failed eight registry deadlines on Ubuntu run `39602069248`, job `119228804502`. Initial single-directory cases, including clear/cache reload, passed; the first multi-directory case and later directory calls stopped completing. The result was **229 passed, 8 failed, 8 platform skips** in 538.35 seconds. The parent cancelled release run `39602069449` before publication. Full log: `artifacts/harness/release-3.2.7/ubuntu-main-native-failure.log`.

The previous implication that Vite transformation was the root cause is withdrawn. Each later timed-out request still reached `invalid.ts`; this identifies only an unresolved later source, not its awaited stage. Source review found no demonstrated cache-lock cycle. Vitest 4.1.11's `dist/chunks/native.DPzPHdi5.js` installs `module.registerHooks` process-wide and sends non-`node_modules` resolutions to its module-graph RPC even when the registry bundle itself is loaded with native `createRequire`. That is a concrete difference from extension loading, not proof that it causes this hang.

An isolated WSL setup now uses the exact **Node 24.21.0 Linux x64** archive (verified against its official `SHASUMS256.txt`), matching Rollup 4.59.0 Linux optional package via `NODE_PATH`, and matching native esbuild 0.28.1 via `ESBUILD_BINARY_PATH`. The repository dependency tree, manifests and lockfile were not changed. On the unmodified merged production source:

- Existing focused registry suite under WSL Node 24.21.0: **34 passed**, 160.98 seconds.
- Full core with the harness's worker environment, `--maxWorkers=2`, and two-CPU affinity: **237 passed, 8 platform skips / 17 files**, 262.02 seconds.
- Full core with stage tracing, the harness's worker environment, CI dot/JSON reporters, `GITHUB_ACTIONS=1`, and four-CPU affinity: **237 passed, 8 platform skips / 17 files**, 178.44 seconds. Captured raw trace/report: `artifacts/harness/release-3.2.7/wsl-node24-core-stage.log` and `wsl-node24-core-stage.json`.
- Standalone fully native legacy workload, including fresh registries, repeated loads, clear/cache reload, overrides and stale loads: **passed**, with compiler/prune/import/cleanup stage tracing. This additional passing workload does not explain the hosted failure.

For hosted-run diagnosis, `registry-stage-trace.ts` instruments only the test's freshly generated temporary bundle when `ALPHA_TRACE_CUSTOM_TOOLS=1`. It logs paired source checks, cache initialization/pruning, compiler child spawn/exit/close/await completion, generation IO, native imports and staging cleanup, plus waits on a source lock. Production code and public assertions/deadlines remain unchanged. A Linux multi-directory test with this flag and the normal dot/JSON reporters passed **1 selected / 33 filtered** in 24.27 seconds, proving that every intended stage label is emitted. Types, focused ESLint, formatting and diff checks passed. The parent owns a temporary diagnostic-only hosted workflow and will restore the original workflow before proposing a real fix.

At this checkpoint **the first stalled await and root cause remain unproven**. No retries, timeout changes, skipped acceptance assertions, or speculative production workaround have been introduced. Stage diagnostics are investigation tooling, not a release-gate success or completed defect fix.

The first two hosted diagnostic runs also passed: `39605450917` / job `119240362153` (default workers/verbose) and `39605627689` / job `119240965043` (normal harness worker environment/dot+JSON). Each reported **237 passed, 8 platform skips / 17 files**; the latter took 164.24 seconds on Node 24.21.0, Linux, four available CPUs. Both traces completed all **102 compiler** and **114 native import** pairs. They did not capture the original failure.

To reduce instrumentation effects before further hosted sampling, the diagnostic helper now keeps only the latest **512 stage events** in a circular buffer. It performs no per-event console/RPC writes and flushes after a test failure or suite completion. The exact original `return import(url)` adoption path is retained; completion is recorded after the caller's already-existing await, with no added await. A selected Linux multi-directory test passed in 22.72 seconds and emitted one 240-event completion buffer with all eight compilation/import completions. Core types, focused ESLint, formatting and diff checks passed. Additional diagnostics remain explicitly outside release-gate evidence until the actual stalled stage is captured and corrected.

## Final native-process fixture correction (2026-10-21)

The lower-impact buffered hosted run `39607311403`, job `119246743635`, at **`9eb0579c184a9811e4bcc1e2f722384e254e902d`** completed three sequential samples using the normal harness worker environment, `ALPHA_HARNESS_REPOSITORY_ROOT`, and dot/JSON reporters. Each reported **237 passed, 8 platform skips / 17 files**; durations were **109.64**, **105.85**, and **108.67 seconds**. Each recorded 3,132 stage events and no failure flush. Together with the two earlier hosted samples and exact-Node Linux runs, this investigation did not reproduce a stalled await. These manual diagnostic samples are not release gates and do not establish a production root cause.

The final correction therefore addresses the demonstrated fixture mismatch only. `custom-tool-registry.spec.ts` compiles the current registry source once, then runs each of its sixteen original directory-loading/cache/order/staleness cases in a fresh **native Node process**, using the current test host's `process.execPath`. Basic registration, lookup, validation and serialization tests continue to import the source directly through Vitest. Loading an ESM bundle with `createRequire` inside the Vitest worker was insufficient isolation because the worker still has process-wide module hooks. Extension execution does not have those hooks; a child process exercises the actual native module-loader boundary without changing the production registry.

Every original test title and timeout is unchanged. An AST comparison against merged main `4f59e6084fda1463c08831a7a0ce4f99d108cdfa` found **34 original tests preserved**, no changed or missing deadlines, and all **64 original assertions preserved per case** as equivalent Vitest or `node:assert/strict` assertions. The native cases still check TypeScript/default/named exports, the exact invalid-definition error, absent directories and empty requests, skipped non-tool exports, legacy `args`, cache clear/reload, both directory precedence orders, duplicate loaded names, unchanged-source catalog restoration, and mixed stale/warm loads. The existing native encoded-path/cache test still covers repeated forced loads, real schema parsing and a new registry sharing the cache. The sixteen catalog regressions continue to cover concurrent workspace ownership, captured generations, refresh/recovery and hard lifetime bounds.

The parent owns the suite's temporary registry bundle and each child's private cache directory. `finally` removes those resources after the child closes. Each child receives the existing Vitest test's `AbortSignal` through Execa's `cancelSignal`, so the original deadline cancels the process rather than leaving a native scenario running. No retry, added timeout, test skip, private-method spy, production runtime edit or dependency change is part of this correction.

A new deterministic public-behavior regression registers a test-worker `module.registerHooks` loader hook that rejects generated tool bundles, then asserts that the fixture loads the expected tool and reports only the intended invalid definition. Against the former in-worker native fixture it was **red: 1 failed / 34 filtered**, 11.07 seconds, with six intercepted tool imports and no `simple` tool. With the native child fixture it was **green: 1 passed / 34 filtered**, 10.36 seconds. This proves process isolation from worker hooks; it does **not** prove that those hooks caused the intermittent hosted timeout.

Temporary `registry-stage-trace.ts` and `registry-stall-probe.mjs` are removed. The parent restored `.github/workflows/code-qa.yml` byte-for-byte to the normal main-branch workflow. No production registry or compiler source changed in this final follow-up. The earlier standalone `registry-native-linux-probe.mjs` remains as durable native-workload evidence.

Final validation against the fixture correction on security-updated baseline **`1be4ef984796435f12daf7a0d0734c2049638b93`**:

- Windows `pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.spec.ts src/custom-tools/__tests__/custom-tool-registry.catalog.spec.ts --maxWorkers=1`: **51 passed / 2 files**, 212.19 seconds. This includes the new hook-isolation regression and all sixteen native catalog regressions.
- Exact **Node 24.21.0 Linux x64**, full core, normal dot/JSON reporters and `--maxWorkers=2`: **238 passed, 8 platform skips / 17 files**, 219.17 seconds. The eight skips are existing platform-gated assertions; the fixture correction adds no skip. Linux catalog resource/permission assertions ran. Saved full output and JSON: `artifacts/harness/release-3.2.7/wsl-node24-final-native-core.log` and `wsl-node24-final-native-core.json`.
- Core `check-types`: **passed**, 6.02 seconds. Package-scoped `pnpm --dir packages/core exec eslint src/custom-tools/__tests__/custom-tool-registry.spec.ts --max-warnings=0`: **passed**, 3.54 seconds. An initial lint invocation from the repository root did not find a flat config; the package-scoped command above is the completed lint check.
- Touched-file Prettier and `git diff --check`: **passed**. All pnpm commands set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn`.

The final Linux command ran from `/mnt/f/roo-fork/Alpha-Code/packages/core` with the isolated tool paths above and no diagnostic tracing:

```sh
env NODE_PATH=/tmp/alpha-registry-linux-24/node_modules \
  ESBUILD_BINARY_PATH=/tmp/alpha-registry-linux-24/esbuild/bin/esbuild \
  VITEST_MAX_WORKERS=2 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 \
  VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 CI=1 GITHUB_ACTIONS=1 \
  /tmp/alpha-registry-linux-24/node-v24.21.0-linux-x64/bin/node \
  /mnt/f/roo-fork/Alpha-Code/packages/core/node_modules/vitest/vitest.mjs run \
  --maxWorkers=2 --reporter=dot --reporter=json \
  --outputFile=/tmp/alpha-registry-linux-24/final-native-core.json
```

Final owned files are the registry spec, this report, and deletion of the two temporary stage-diagnostic files. The normal workflow restoration and security follow-up belong to the coordinating agent. Production registry/compiler source has no diff. Source is stable after the completed focused/full-core, type, lint, formatting and diff checks; only this evidence report was amended afterward. The coordinating agent owns normal hosted CI and release gates; publication remains dependent on those gates. The precise cause of the original intermittent hosted hang remains unproven, and arbitrary user module graphs are not claimed deadlock-free.
