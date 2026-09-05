# Alpha Code Engineering Guide

This file is the repository-wide contract for coding agents working on Alpha Code. It applies to the entire tree unless a
more specific `AGENTS.md` or `AGENTS.override.md` exists below it.

## Mission and priorities

Develop Alpha Code as a reliable, fast coding-agent extension for VS Code. New features, structural improvements,
performance work, and bug fixes should strengthen the same coherent harness rather than add parallel implementations.

Use this priority order when requirements compete:

1. Correctness, data integrity, security, and the user's explicit intent.
2. Compatibility with the exact reference host: **VS Code 1.122.1**.
3. Provider-neutral behavior shared across all VS Code extension surfaces.
4. Deterministic lifecycle, cancellation, persistence, and tool-policy semantics.
5. Measured improvements to task quality, latency, token use, memory, and UI responsiveness.
6. Backward compatibility for saved tasks, settings, modes, messages, and public extension API contracts.
7. Small, reviewable changes that follow existing repository patterns.

Do not trade correctness or policy enforcement for benchmark gains. Do not preserve accidental behavior when a failing
test exposes a real bug; update the contract deliberately and document the compatibility impact.

## Required working method

Before changing code:

- Read this file, check `git status`, and preserve unrelated or user-authored changes.
- Identify the owning layer, its callers, its persisted or wire contracts, and the nearest tests.
- For a bug, reproduce it with a focused test or deterministic script when practical. Establish the root cause rather
  than patching only the visible symptom.
- For a performance change, capture a meaningful baseline and define the metric and workload before optimizing.
- Consult current primary documentation or source when comparing Alpha with Codex, VS Code, or another frontier
  harness. Record the upstream version, commit, or retrieval date in durable design work; do not implement from memory.
- Treat files in `docs/` as design history and context, not as proof of current behavior. Verify claims against current
  code, tests, and manifests.

While implementing:

- Make the smallest complete change at the layer that owns the invariant.
- Extend existing abstractions before creating a competing engine, registry, state store, or message path.
- Keep refactors behavior-preserving unless the requested behavior change requires otherwise.
- Keep model/provider selection independent from execution policy, tool availability, and approval authority.
- Add or update tests in the same change. Prefer observable behavior and stable contracts over private implementation
  details.
- Validate incrementally with the narrowest useful command, then widen validation according to risk.

Before finishing:

- Inspect the final diff for scope creep, generated artifacts, stale names, debug output, secrets, and accidental lockfile
  churn.
- Run the checks required by the validation matrix below.
- Report what changed, why, what was verified, and any residual risk. Never claim a check passed unless it ran.

## Runtime and toolchain baseline

- Package manager: `pnpm@10.8.1`. Use pnpm only; do not create npm or Yarn lockfiles.
- Development Node.js: `20.19.2`, as declared in the root and extension manifests.
- TypeScript: `5.8.3` through the workspace configuration.
- Formatting: tabs, width 4, 120-column print width, and no semicolons; see `.prettierrc.json`.
- Build orchestration: Turborepo. Prefer existing root or package scripts over hand-built command sequences.
- Install dependencies with `pnpm install --frozen-lockfile` when the lockfile should be authoritative. Do not upgrade or
  add production dependencies incidentally; justify additions and update `pnpm-lock.yaml` deliberately.
- Never edit generated or downloaded trees such as `node_modules/`, `dist/`, `out/`, `build/`, `.next/`, `.turbo/`,
  `.vscode-test/`, or generated certification artifacts unless the task specifically owns those outputs.
- Do not run repository-wide formatting for a focused change. Format only touched files or the owning package.

## Scope boundary

The command-line application and its VS Code compatibility shim are outside the scope of extension development. Do not
edit `apps/cli/` or `packages/vscode-shim/`, including their source, tests, manifests, documentation, builds, or public
contracts, unless the user explicitly asks to change this restriction. If extension work exposes an incompatibility in
either protected subtree, report it as a residual risk instead of modifying those files.

## VS Code 1.122.1 is the compatibility contract

VS Code **1.122.1** is the reference product and release-gating host, not merely a suggested minimum.

- Keep `src/package.json` compatible with `engines.vscode: ^1.122.1`.
- Do not use an API, contribution point, behavior, or webview assumption unavailable in VS Code 1.122.1. A feature that
  exists in the developer's newer editor is not sufficient evidence.
- Prefer stable APIs. The E2E runner's `--enable-proposed-api=Alpha.alpha` flag is a test facility, not permission to make
  production behavior depend on proposed APIs.
- Feature-detect optional newer APIs and provide a tested 1.122.1 fallback. Keep version-specific behavior isolated at a
  VS Code adapter boundary rather than spreading checks through the agent core.
- Treat VS Code Language Model behavior as a host contract. Preserve response-part ordering, opaque/provider state,
  reasoning metadata, tool-call IDs, usage accounting, late-cancellation behavior, and recovery semantics.
- Do not block extension activation or the extension-host event loop with avoidable synchronous I/O or CPU-heavy work.
  Defer nonessential initialization and dispose subscriptions, watchers, terminals, processes, and timers.
- A deliberate VS Code baseline migration must update the extension manifest, E2E runner/defaults, fixture manifest,
  exact-host tests, workflows, compatible VS Code types, and documentation as one reviewed change.
- Testing on latest stable is useful for forward compatibility, but it never replaces the exact-host gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

Run that gate for changes involving extension activation, VS Code APIs or contributions, commands, webviews, VS Code LM,
task lifecycle, cancellation, persistence/reload, modes, or extension packaging. If the gate cannot run in the current
environment, say so explicitly and run the closest lower-level coverage; do not silently substitute another VS Code
version.

## Repository map and ownership

- `src/extension.ts`: extension activation and top-level registration. Keep it thin and make all disposables explicit.
- `src/core/agent/`: provider-neutral turn sequencing, response normalization, immutable step context, retry policy,
  scheduling, policy, lifecycle journal, and event contracts. This is the execution-kernel boundary.
- `src/core/task/Task.ts`: integration host for the agent kernel and legacy compatibility. Avoid adding new orchestration
  concepts directly to this already-large class when they belong in focused `core/agent`, `core/tools`, persistence, or
  adapter modules.
- `src/core/tools/`: canonical tool registry, task tool surface, validation, and tool implementations. A tool's schema,
  visibility, policy, execution, result status, and telemetry must agree.
- `src/core/task-persistence/` and `src/core/context-management/`: atomic transcripts, task metadata, replay, compaction,
  and recovery. Persisted formats require backward-compatible readers or an explicit migration.
- `src/core/webview/`: extension-side session registry, lifecycle projection, message handling, and webview coordination.
  This layer adapts canonical runtime state; it must not become a second task engine.
- `src/api/providers/` and `src/api/transform/`: provider adapters. Normalize provider-specific streaming and metadata at
  this boundary and preserve information the provider needs on the next request.
- `webview-ui/`: React UI running inside the VS Code webview. It consumes typed messages and projected state; it must not
  own authoritative task lifecycle or policy.
- `packages/types/`: shared schemas and public contracts. Put cross-package message, lifecycle, configuration, and API
  types here rather than duplicating shapes.
- `packages/core/`: platform-agnostic reusable functionality. Do not introduce `vscode` imports here.
- `apps/vscode-e2e/`: real extension-host contract tests, including the exact 1.122.1 gate.
- `packages/evals/`, `evals/`, and `scripts/`: deterministic evaluation, certification, benchmark, and release tooling.
- `docs/`: architectural decisions, investigations, and plans. Update the relevant document when an architectural
  contract or benchmark methodology changes.

## Agent-harness architecture invariants

When improving Alpha toward Codex or other frontier harnesses, converge on behavioral principles, not vendor-specific
source structure or a copied prompt.

- One shared execution kernel must serve every extension task surface. Sidebar, editor-panel, background-session, and
  webview presentation layers adapt or project canonical runtime state rather than implementing separate task loops.
- `AgentTurnEngine` owns turn sequencing. Provider adapters produce canonical ordered `AgentResponseItem` values; UI
  messages and provider history are projections, not alternate sources of truth.
- Build one immutable `StepContext` snapshot per model step. Retries retain the logical boundary while recording retry
  state; children and compaction derive explicit new snapshots. Do not read mutable live settings halfway through a step.
- Use the canonical `ToolRegistry` and captured `TaskToolSurface`. Schema visibility and executable permission must derive
  from the same effective profile and policy snapshot.
- `ToolScheduler` is the effect boundary. Parallelize only independent, read-only, approval-free operations. Serialize
  mutations, approvals, terminal interactions, lifecycle barriers, and operations with overlapping scope. Preserve
  deterministic result ordering and enforce concurrency bounds/backpressure.
- Tool calls and results are structured data. Preserve call IDs, emit exactly one terminal result per accepted call, and
  distinguish `success`, `error`, `denied`, and `cancelled`. Never turn an error or cancellation into successful text.
- Ordinary visible assistant text may complete a turn when no continuation is pending. Completion, failure, exhaustion,
  cancellation, and awaiting-user states must be explicit and must finalize exactly once.
- Cancellation and timeout signals must propagate through provider streaming, scheduling, tools, subprocesses, child
  tasks, persistence, and UI projection. All terminal paths must release resources.
- Persist canonical response items and complete tool transactions atomically enough for deterministic reload/replay.
  Never leave an assistant tool call without its terminal result in persisted provider history.
- Compact only at safe step boundaries. Preserve tool call/result pairs, provider state, reasoning signatures, instruction
  provenance, task state, and the information needed to resume safely.
- Delegation is bounded and optional. Child authority can only equal or narrow the parent's policy and workspace scope;
  cancellation and budgets propagate; the parent integrates and verifies child work before completion.
- Enforce security, tool availability, approvals, path scope, limits, and lifecycle rules in code. Prompt text can guide
  strategy but is not a security or correctness boundary.
- Keep prompts lean, stable, and non-duplicative. Measure prompt or tool-schema changes against representative evals and
  inspect cache/token effects rather than assuming more instructions improve performance.

Relevant architectural context includes `docs/core-harness-comparison-final-phases.md`,
`docs/codex-harness-gap-investigation.md`, `docs/testing-harness-convergence-milestones.md`,
`docs/frontier-agent-eval-harness-convergence.md`, and `docs/multi-agent-concurrency-spec.md`. Reconcile those plans with
the current code before acting because completed phases may make older descriptions obsolete.

## State, concurrency, and messaging rules

- Do not reintroduce a global single-active-task assumption. Route state and events by stable task/session/agent IDs and
  account for foreground and background sessions.
- Treat lifecycle journals and reducers as canonical transition logic. Webview state should be a deterministic projection
  that is idempotent under replay, duplicate delivery, and out-of-order refreshes where the protocol permits them.
- Protect workspace mutations through the established mutation gate and content-version/stale-context checks. Never
  overwrite external or concurrent edits silently.
- Avoid check-then-act races. Serialize state transitions that share ownership, and make start/stop/dispose/retry methods
  idempotent.
- For race tests, use controlled promises, barriers, fake timers, or injected schedulers rather than arbitrary sleeps.
- Every event listener, file watcher, interval, cancellation source, terminal, process, and temporary resource needs a
  clear owner and cleanup path.
- Define shared wire shapes in `packages/types/` with discriminated unions and runtime validation at untrusted
  boundaries. Update all extension, webview, IPC, persistence, and fixture consumers when a contract changes.
- Reject or safely ignore unknown message variants according to the compatibility contract; do not crash a running task
  because a stale UI or persisted record contains an older shape.

### Settings view invariant

When working on `SettingsView`, bind form inputs to local `cachedState`, **not** directly to `useExtensionState()`.
`cachedState` is the edit buffer that isolates in-progress user input from the `ContextProxy` source of truth until the
user clicks **Save**. Direct live-state binding creates overwrite races and lost edits. Keep initialization/resync,
dirty-state, validation, cancel/reset, and save behavior explicit, and add a regression test for changes to this flow.

## Bug-fix standard

A complete bug fix should:

1. Reproduce the failure at the lowest stable boundary.
2. Explain the violated invariant and identify the actual owning layer.
3. Fix all equivalent extension paths, including retry, cancellation, reload, and background-task paths when applicable.
4. Add a regression test that fails for the intended reason before the fix and avoids timing or network flakiness.
5. Check adjacent state transitions for double completion, stale closure/state, dropped events, duplicate effects, and
   leaked resources.
6. Preserve external changes and user data. If a migration or repair is required, make it idempotent and test old and new
   representations.

Do not broadly swallow errors, add unexplained retries, reset state to hide a race, or weaken an assertion merely to make
a test pass. Errors should carry actionable context without exposing prompts, credentials, or sensitive file contents.

## Performance standard

Performance work requires evidence. Choose metrics that reflect the affected surface, such as extension activation time,
time to first token, model/tool round trips, tool parallelism, total wall time, input/cache/output tokens, retry
amplification, webview commit/render counts, indexing throughput, memory growth, or leaked handles.

- Compare before and after with the same workload, model/provider conditions, fixture, and warm/cold-cache state.
- Use deterministic scripted providers or offline fixtures for CI claims. Treat live-model runs as supplemental evidence
  and record model, configuration, rate-limit/retry effects, and sample count.
- Never describe a single successful run as a general quality or speed improvement.
- Optimize the dominant path: remove unnecessary model round trips and repeated work before micro-optimizing local code.
- Cap concurrency and queues; preserve backpressure and cancellation. Avoid unbounded `Promise.all`, retained transcripts,
  tool output, caches, watcher sets, or event buffers.
- Keep the extension host responsive and the webview render path incremental. Memoization is valid only with correct keys
  and invalidation.
- Token optimizations must preserve instruction authority, tool transactions, provider state, reasoning continuity, and
  recovery evidence.
- Add a benchmark or regression threshold when practical, and document the measurement command and result.

## UI, localization, and accessibility

- Use existing component and VS Code theme-token patterns. Do not hardcode colors that break light, dark, or high-contrast
  themes.
- Keep authoritative state in the extension/runtime and ephemeral presentation state in React. Avoid copying the same
  lifecycle logic into components.
- Prevent unnecessary whole-tree rerenders during streaming; use stable selectors, keys, and subscriptions.
- Preserve keyboard navigation, focus restoration, readable labels, ARIA semantics, reduced-motion behavior, and narrow
  sidebar layouts.
- Localize new user-visible text through the appropriate extension `package.nls*.json` or webview i18n locale files.
  Do not add English-only UI strings. Run `node scripts/find-missing-translations.js` for localization changes.
- Add focused Testing Library/Vitest coverage for interaction and state behavior. For material visual changes, also verify
  the result manually in the Extension Development Host on VS Code 1.122.1 when available.

## Security and privacy

- Treat user prompts, repository content, webview messages, provider output, MCP/tool output, persisted history, and remote
  configuration as untrusted input.
- Validate paths against the intended workspace and account for traversal, symlinks, multi-root workspaces, case
  differences, and platform separators before reading, writing, or executing.
- Use argument-safe process APIs. Never build shell commands by concatenating untrusted text.
- Preserve the approval and policy boundary for file writes, commands, browser actions, MCP calls, network access, and
  external side effects. A provider, model, prompt, mode, skill, or child task cannot widen authority.
- Do not log or persist API keys, authorization headers, raw secrets, or unnecessarily sensitive prompt/file contents.
  Keep telemetry bounded, redacted, and schema-validated.
- Keep webview CSP and URI restrictions intact; sanitize rendered content and avoid unsafe HTML or command URI paths.
- Do not weaken `.alphaignore`, protected-file handling, workspace mutation checks, or tool-output limits for convenience.

## Validation matrix

Use the smallest relevant checks during development and the full affected-surface checks before completion.

| Change                   | Minimum validation                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Documentation only       | Review rendered Markdown, links, commands, and claims against current files                              |
| Extension/core unit      | Focused `src` Vitest file, then `pnpm --dir src check-types`                                             |
| Webview                  | Focused webview Vitest file, then `pnpm --dir webview-ui check-types`                                    |
| Shared package           | Package tests and typecheck, plus affected consumer tests                                                |
| Provider/stream/history  | Provider transform tests, task persistence/turn tests, and cancellation/error cases                      |
| VS Code integration      | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`                                                   |
| Managed agents           | Focused lifecycle/delegation tests and `pnpm certify:managed-agents:automated` when the contract changes |
| Performance              | Focused correctness tests plus a recorded before/after benchmark on the same workload                    |
| Release/package contents | `pnpm bundle`, `pnpm vsix`, then `node scripts/verify-vsix-contents.mjs <path-to-vsix>`                  |

Useful focused commands:

```sh
pnpm --dir src test -- core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm --dir webview-ui test -- src/path/to/component.spec.tsx
pnpm --filter @alpha-code/core test -- path/to/spec.ts
```

Repository-wide gates, used when risk and scope justify them:

```sh
pnpm lint
pnpm check-types
pnpm test
pnpm knip
pnpm bundle
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

`pnpm test` bundles the extension and runs workspace tests, so it is intentionally broader and slower than focused
package tests. Run lint/typecheck for every touched package; run repository-wide equivalents for cross-cutting changes.

## Change hygiene and completion criteria

- Keep public and persisted contracts backward compatible unless the task explicitly includes a migration.
- Update tests, schemas, fixtures, localization, and docs in the same change as their owning behavior.
- Prefer exhaustive typed handling over `any`, unchecked casts, or parallel ad hoc message shapes.
- Do not edit release versions, changelogs, generated artifacts, benchmark goldens, or snapshots unrelated to the requested
  behavior. Snapshot changes must be inspected, not blindly regenerated.
- Keep code and scripts cross-platform across supported Windows, macOS, and Linux environments. Prefer Node/pnpm scripts
  to shell-specific assumptions.
- Comments should explain invariants, ownership, or non-obvious compatibility constraints, not restate the code.
- A task is done only when the requested behavior works, relevant regressions are covered, required validation passes,
  VS Code 1.122.1 compatibility is preserved, and the final diff contains no unrelated changes.

## Maintaining these instructions

Keep this root guide focused on durable, repository-wide rules. Add a nested `AGENTS.md` only when a subtree has materially
different commands or invariants, and keep the override close to the code it governs. Update this file when the reference
VS Code version, workspace layout, canonical architecture, or required gates change. Prefer concise rules with the reason
and safe path over style advice already enforced by tooling.
