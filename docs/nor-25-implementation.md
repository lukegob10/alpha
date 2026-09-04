# NOR-25: verification debt and bounded progress

Implemented on the Stage 2 baseline `1a8e38dfb971e5b5c1b693921d7d2c47a75aad93`. This change extends the existing task loop, tool scheduler, and durable parent-verification ledger. It does not introduce another completion engine.

## Verification lifecycle

Primary file tools record actual before/after disk content, including creates, deletes, patch moves, and partial multi-file writes. Denials and identical writes do not create lasting verification debt. Commands receive a distinct physical execution ID after approval and terminal acquisition. Their evidence uses the terminal's actual cwd, authoritative exit status, and the content version captured at admission. Running, failed, timed-out, denied, cancelled, stale, or unsupported checks cannot complete a current obligation.

The primary task uses `primary-change:<taskId>` in the existing ledger. Applied Worker change-set IDs retain their existing explicit scope. Ancestor configuration fingerprints are stored separately from actual changed paths, so configuration freshness does not invent file edits or move a package's changes into its parent directory. Content changes, including A → B → A, advance the revision and invalidate previous checks. Editing an applied Worker's paths also invalidates its evidence.

Integration canonicalizes the actual command cwd and persisted workspace identity so Windows short paths and trusted workspace junction aliases refer to the same change scope. Real path containment still rejects escaping descendants. Unknown-scope debt retains its reserved identity if the workspace disappears. Admission failures preserve their actual error; only a real shell-integration failure can trigger the existing fallback.

Required check kinds come from the nearest bounded package manifest: `test`/`test:*`, `check-types`/`typecheck`, and `lint`. Code/configuration edits require all declared kinds; a lint pass alone cannot satisfy a package that also declares tests and types. Prose and static assets do not inherit unrelated code suites. With no declared kind, at least one supported check must cover each changed file. This is a deliberately small manifest contract, not an interpreter for natural-language instructions or arbitrary CI policy. Configuration and AGENTS.md bytes participate in freshness even though their prose is not interpreted as executable policy.

Checks accumulate by file and kind for the current revision. The store retains the latest receipt and the current coverage facts; stale receipts cannot restore old coverage after an edit. New runtime command receipts cannot use the compatibility reader for unversioned Worker records. Historical records remain readable, and a supported admitted verifier upgrades their scope.

The existing environment snapshot projects a compact `Workspace Verification` field with pending primary/Worker IDs, version, required kinds, and bounded file names. It reaches the model on the first step after a mutation, before validation. Environment deltas suppress unchanged facts, remove satisfied facts, and restore pending facts on a full snapshot after compaction/reload.

## Supported scope and limitations

Command recognition uses the existing conservative command classifier plus a bounded scope resolver. Recognition alone is not evidence: only a successful terminal receipt with unchanged captured content can contribute coverage. Supported command shapes include direct tools and `pnpm [--dir directory] exec …`, or the named `test`, `check-types`, and `lint` scripts when their manifest body resolves to a supported simple command. Shell composition, masking failures, redirection, watch/help modes, arbitrary scripts, and unknown flags receive no verification credit.

The supported subset checks explicit file types and structural coverage, rather than inferring coverage from a parent cwd:

- TypeScript supports `tsc --noEmit` with a bounded JSON tsconfig and simple `files`/`include`/`exclude` patterns. It rejects references, extends, JSONC, `noCheck`, excluded edits, and skipped declaration checks. A config listing only an unrelated file cannot verify an edited source file.
- Test commands include bounded whole-scope Vitest/Jest/Pytest forms and exact edited-test targets. A targeted test must directly name every edited file claimed by that receipt; there is no guessed source-to-test dependency mapping. Known nested package/module boundaries and unsupported scope configurations are rejected.
- Vitest/Jest configuration support is limited to inert JSON objects or equivalent literal exports with a small harmless option set. Imported, computed, spread, or function-based configuration is unsupported. **Alpha's current dynamic Vitest configuration therefore produces an explicit unverified result under this resolver.** Unit fixtures do not establish broad live-project coverage.
- ESLint requires supported file types and an inert flat configuration with active rules and supported `files`/`ignores` patterns. Imported or legacy configuration is unsupported. `eslint .` cannot verify an edited README. Other supported verifier families likewise restrict claimed file types. Prettier returns separate `format` evidence for supported text types, including Markdown; it cannot satisfy a declared lint requirement.
- Scoped receipts can jointly cover separate packages. Both the terminal cwd and resolved script scope must remain inside the workspace; the resolved package may be an ancestor of the terminal cwd.

**Command mutation observation is bounded and Git-visible, not a complete filesystem audit.** A Git workspace observes dirty/unignored untracked files and HEAD changes. A bounded `git ls-files -v -z` observation also hashes tracked paths marked assume-unchanged or skip-worktree; a real Git regression covers edits invisible to ordinary status. Explicit file tools observe their exact ignored targets. Arbitrary shell edits to previously unknown ignored files, files outside the workspace, or excluded filesystem surfaces are outside this guarantee. Unsaved editor buffers are not disk evidence. In non-Git workspaces a bounded file walk is used, excluding `.git` and `node_modules`.

As of preview 2.1.22, a HEAD transition uses a bounded, NUL-delimited tree diff with renames, external diff drivers, and text conversion disabled. Transitions to or from an unborn HEAD use the existing commit's tree listing. These paths join the before/after dirty-file paths before current bytes are captured. Committing already-observed bytes does not create fresh verification debt. Previously clean paths changed between commit trees conservatively require current validation because the initial dirty-file snapshot did not capture their bytes. A HEAD change after the final snapshot still rejects the observation.

Bounds are 256 observed paths, 4 MiB per file, 16 MiB total, 4,096 characters per path/command, 256 KiB per parsed manifest/config, 32 ancestor levels, and 512 non-Git directory entries. Git observations have a 1 MiB output bound and a five-second process timeout. Missing known configuration paths are fingerprinted, so adding one invalidates previous evidence. Their entries share the 256-path bound: sufficiently scattered edits can exhaust it. An unknown observation never silently becomes an empty change set. Before a command starts, unavailable mutation observation permits only the existing inspection subset; other commands are refused with an actionable unverified outcome.

## Write-ahead recovery and final completion

A durable mutation reservation is written before an admitted primary effect. Its final content receipt is persisted before the reservation is released. A proven no-op releases a provisional empty obligation; a completed write leaves pending verification debt. If the process dies after a write but before its final receipt, the reservation survives reload and blocks completion. It is not automatically treated as a no-op, even if the same path later looks unchanged. Scope/persistence failures also remain explicitly unverified. This change does not add an automatic repair procedure for an unresolved reservation.

Verification debt lives in `AgentControlStore`, independently of compacted provider history. Reload, rewind, and pre-completion reconciliation rehash known current content/configuration before crediting receipts. Compaction does not clear the progress window or verification debt.

Explicit completion and ordinary text completion share the existing completion decision. The final lifecycle commit rereads that decision after persistence, inside the existing workspace mutation boundary, and rolls back candidate completion if debt or guidance arrived. Active commands block completion. Three rejected completion attempts against unchanged debt, running receipts, active descendants, or unconsumed child results end the current attempt as incomplete and unverified. Actual waiting and polling do not count as rejected completion claims. The optional `attempt_completion.outcome = "blocked"` reports missing evidence without publishing successful completion.

## Outcome-aware progress

The scheduler observes actual terminal outcomes once, after every serial effect and before the next effect. Parallel reads are observed in model order; unavoidable overshoot is bounded by the already-admitted read cohort. Preflight failures count, duplicate tool receipts do not. Existing effect fences and final tool-result ordering remain authoritative.

The detector retains at most 128 digested observations. It combines status, scoped read identity, current content fingerprints, and admitted check coverage. A successful handler or changed command spelling is insufficient progress. Distinct scoped reads, new content, and fresh coverage reset stagnation. Alternating old states does not. Real unchanged polls neither consume nor reset the window; an initial background command launch counts as an outcome. The default issues one strategy-change instruction after six stagnant outcomes and stops after twelve. Explicit new user guidance resets the ephemeral attempt; compaction does not. No arbitrary command output is interpreted as evidence.

## Research and validation

The reference was the [Pi agent loop pinned at `6aedd1066e540642165aa30fa7b4a1b863778aa7`](https://github.com/earendil-works/pi/blob/6aedd1066e540642165aa30fa7b4a1b863778aa7/packages/agent/src/agent-loop.ts), inspected on 2026-09-04. Its completed-turn/tool-result boundary, next-turn preparation, and stop decision motivated keeping these decisions in Alpha's existing loop. Pi's ordinary no-tool exit is not itself a verification guarantee; Alpha's durable gate supplies that contract. Alpha-specific behavior above was checked against local source and deterministic tests, not inferred from Pi.

`ToolRepetitionDetector.stagnation.spec.ts` compares the retained legacy `check()` implementation with the new outcome policy on the same scripted streams and a 24-model-round ceiling:

| Scripted workload                                | Effects before → after | Model rounds before → after | Result                          |
| ------------------------------------------------ | ---------------------: | --------------------------: | ------------------------------- |
| Repeated failed checks                           |                18 → 12 |                     24 → 12 | Exhausted → explicit incomplete |
| Alternating failed commands                      |                24 → 12 |                     24 → 12 | Exhausted → explicit incomplete |
| Alternating successful commands without evidence |                24 → 12 |                     24 → 12 | Exhausted → explicit incomplete |
| Distinct-file exploration                        |                12 → 12 |                     13 → 13 | Completion preserved            |
| Legitimate polling                               |                12 → 12 |                     16 → 13 | Completion preserved            |
| Repair followed by a current check               |                  7 → 7 |                       9 → 8 | Completion preserved            |

The three productive fixtures complete under both policies; each stagnant fixture emits one strategy-change instruction before stopping. These are repeatable control-flow measurements, not live-model success rates or wall-clock performance claims.

Owner-worktree validation on 2026-09-04 (before the additional integration corrections):

- The affected Vitest run passed **519 tests across 22 files**: ledger, requirements/scope, scheduler/progress, Task, external mutation boundaries, command/completion tools, tool registry, completion persistence, native completion schema, Provider, and environment projection. It includes the 87 scope cases and the deterministic stagnation comparison above.
- The existing `AgentTurnEngine.spec.ts` suite passed **11 additional tests**, for **530 tests across 23 files** overall.
- `pnpm --filter @alpha-code/types build` passed, including entrypoint verification.
- `pnpm --dir src check-types` passed. `pnpm --filter @alpha-code/types --filter @alpha-code/core --filter @alpha-code/ipc --filter @alpha-code/vscode-webview check-types` also passed.
- `pnpm --dir src lint` and `pnpm --filter @alpha-code/types lint` passed. Touched-file Prettier and `git diff --check` passed.

The new regression suites can be rerun with:

```powershell
pnpm --dir src exec vitest run core/agent/__tests__/AgentControlStore.primary-verification.spec.ts core/agent/__tests__/ToolScheduler.progress.spec.ts core/agent/__tests__/VerificationRequirements.spec.ts core/agent/__tests__/VerificationScope.spec.ts core/tools/__tests__/ToolRepetitionDetector.progress.spec.ts core/tools/__tests__/ToolRepetitionDetector.stagnation.spec.ts core/webview/__tests__/ClineProvider.primary-verification.spec.ts core/environment/__tests__/getEnvironmentDetails.verification.spec.ts
```

Root integration owns the combined managed-agent and exact VS Code 1.122.1 host gates; see the [integration record](stage-three-core-harness-plan.md) for their final results. This owner-worktree run does not establish those results and does not change dependencies, lockfiles, release metadata, CLI, or vscode-shim.

## Preview 2.1.22 command-observation correction

The 2026-09-04 report from 2.1.20 displayed “Task remains incomplete and unverified because command mutations could not be fully observed.” Three real-Git cases also failed on the latest 2.1.21 source: an initial commit, committing previously observed edits/deletions, and editing files then committing them within one command. `compareGitMutationState` rejected every HEAD transition before comparing file content. `ExecuteCommandTool` consequently persisted unresolved mutation debt and suspended the task.

The bounded tree comparison above corrects this path. Regression coverage includes foreground/background command receipt settlement, edit/add/delete detection after a clean commit, stale HEAD snapshots, and more than 256 committed paths. Existing unknown-scope and interrupted mutation reservations remain fail-closed; this change does not retroactively remove debt from earlier failed observations.

The separate 2.1.16 report about missing approved-review/application metadata was reproduced with deliberately incomplete worker records, but no valid current lifecycle was found that creates those records. The remote computer's persisted state was unavailable. Worker approval validation remains enforced; primary-edit records introduced in 2.1.19 are accepted by the current schema. The command-observation correction does not establish the cause of that older report.

Validation commands for this correction:

```powershell
pnpm --dir src test -- core/agent/__tests__/VerificationScope.spec.ts core/task/__tests__/stageThreeCommandOutcome.integration.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm certify:managed-agents:automated
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs bin/alpha-2.1.22.vsix
```

Local validation passed 189 focused tests, extension typechecking/linting, all 1,405 deterministic certification tests and 26 automated contract rows, all eight exact-host smoke checks, bundling, packaging, and the 1,783-entry VSIX content check. The combined certification command's first host acceptance run failed on a Windows `EPERM` while atomically replacing unrelated Worker artifact metadata. The unchanged `pnpm --filter @alpha-code/vscode-e2e test:managed-agents:run` rerun passed the full scenario in 23.38 seconds. That intermittent artifact replacement failure is not attributed to this Git-observation fix.
