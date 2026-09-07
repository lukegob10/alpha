# Core agent loop and peripherals: overfitting review

Date: September 5, 2026. Mode: architecture review of the problem-solving loop.

Related same-day work:

- Incident review of admission/completion coupling: [agent-overfitting-review-2026-09-05.md](agent-overfitting-review-2026-09-05.md)
- Primary-path correction: [agent-execution-simplification-2026-09-05.md](agent-execution-simplification-2026-09-05.md)
- Pytest witness contract: [nor-33-python-verification.md](nor-33-python-verification.md)

This document is a broader crawl of the turn loop and its peripherals after a stretch of verification, delegation, and completion bug work. It asks whether the harness has become specialized to particular tasks or traces rather than remaining a general coding-agent kernel. Source baseline is the worktree after `a40d61b` (Fix command admission and simplify primary task completion).

## Conclusion

The turn engine is not overfit. `AgentTurnEngine`, immutable `StepContext`, retries, pacing, `ToolPolicy`, cancellation, and tool-call identity remain provider-neutral and task-agnostic. Ordinary assistant text can still complete a turn when no continuation is pending.

What has drifted is the evidence and managed-agent layer around that kernel. Recent verification work turned “did this command count?” into a small recipe book: an exact argv catalogue, a pytest-only runtime witness, and Worker/Explorer prompts that assume edit → one supported check → complete, or a fixed research playbook. That is structural overfitting, not a named SWE-bench or HumanEval gate. No production comment or branch in `src/core` special-cases those benchmarks by name.

`a40d61b` already removed the two primary-path overfits that made ordinary user tasks unlaunchable or uncompletable. Residual risk is Worker evidence credit, pytest uniqueness, and prompt recipes.

## Problem-solving loop

| Stage           | Owner                                                                                   | What it does                                                                          | Fit     |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- |
| Turn sequencing | `src/core/agent/AgentTurnEngine.ts`                                                     | Provider-neutral step loop. Host owns tools and completion.                           | Healthy |
| Step snapshot   | `StepContext`, `AgentStepRuntime`                                                       | Immutable per-step policy. No language recipes.                                       | Healthy |
| Effects         | `ToolScheduler`, `ToolPolicy`                                                           | Read parallelism, mutation serialization, approvals.                                  | Healthy |
| Command path    | `ExecuteCommandTool` + terminal                                                         | Policy then process. Pytest observer is bolted on here.                               | Mixed   |
| Evidence credit | `VerificationScope`, `VerificationRequirements`, `AgentControlStore`                    | Only exact runner argv and package-script names count.                                | Overfit |
| Pytest witness  | `PytestVerificationReceipt`, `PytestVerificationObserver`, `PytestVerificationLauncher` | Only pytest needs an in-process collection report.                                    | Overfit |
| Completion gate | `AttemptCompletionTool`, `ParentVerification`, `Task.getCompletionGateDecision`         | Primary receipts are advisory after `a40d61b`. Worker still needs a recognized check. | Mixed   |
| Delegation      | `SubagentDelegation`, `BoundedDelegationManager`                                        | Worker must emit a file delta. Explorer has a research script.                        | Overfit |
| Prompts         | `src/core/prompts/**`, `packages/types/src/mode.ts`                                     | Proportionate Code guidance. Debug and Explorer are recipes.                          | Mixed   |
| Stagnation      | `ToolRepetitionDetector`                                                                | Generic. Novel reads still count as progress.                                         | Watch   |

## Already corrected today

Do not re-litigate these as current primary-path defects. They are recorded here because they show how the harness overfit, and because the residual Worker/catalogue path still uses the same machinery.

1. Failed bounded workspace observation no longer substitutes the Plan command classifier for Code permissions or prevents launch. Incomplete observation is recorded as `observationIncomplete`; it is not a failed command and not an alternate permission mode.
2. Settled primary change receipts are advisory. Ordinary edits do not generate mandatory verifier kinds, change-set IDs, or completion blockers. Explicit unresolved reservations and `scopeUnresolved` still block. Applied Worker changes retain review and verification gates.

Acceptance for those two points lives in `src/core/agent/__tests__/primary-completion-policy.spec.ts` and the Stage-3 command/completion integration specs listed in the simplification note.

## Findings

### Critical — pytest is a first-class kernel path

Production, not a test helper:

- `src/core/agent/PytestVerificationObserver.ts` embeds a bounded pytest hook plugin (default `test_*.py` / `*_test.py` discovery, hook rejection, receipt write).
- `src/core/agent/PytestVerificationReceipt.ts` validates a structured collection report. Exit code alone is insufficient.
- `src/integrations/terminal/PytestVerificationLauncher.ts` overlays environment / shell transport for that observer.
- `ExecuteCommandTool` installs the receipt when captured versions have `runner === "pytest"`.
- `Task.completeCommandExecution` records `no_test_validation` when a succeeded pytest command lacks `testValidation === true`.
- `AgentControlStore.selectVerificationEvidence` discards succeeded pytest evidence unless `testValidation === true`.

Vitest, Jest, Go, and Cargo still get credit from exit plus scope digests. The kernel therefore has a language-specific definition of “verified.” NOR-33 documents this as deliberate. The architectural cost is that every later pytest-config failure (`903efc5`, collection overrides, PowerShell Unicode) extends the same special path instead of a runner-agnostic witness.

### High — verifier catalogue is a task specification

`VerificationScope.verifierKind` / `targetedVerifier` accept only exact argument vectors, including:

- `vitest run` (optionally with bounded `--maxWorkers`)
- `jest` with only `--ci` and/or `--runInBand`
- `tsc --noEmit`
- `eslint .` plus a tiny `--max-warnings` / `--ext` allowlist
- `prettier --check .`
- `go test ./...` or `go vet ./...`
- `cargo test|check|clippy --workspace`
- `pnpm` scripts named exactly `test`, `check-types`, or `lint` (and only if the script body itself tokenizes to a supported verifier)

Pytest coverage additionally walks default discovery and a literal `testpaths` / reporting-only `addopts` subset. Filtered runs, plugins, nested projects, and custom collection are unsupported.

A real project command can pass and still earn no evidence. The earlier incident review already observed that `pnpm --dir src test` and `pnpm --dir src lint` were rejected as unsupported configuration while `pnpm --dir src check-types` was accepted. After `a40d61b` this no longer blocks ordinary primary completion, but it still decides Worker satisfaction and any “supported check” messaging.

`VerificationRequirements` infers required kinds only from nearest `package.json` script names (`test` / `test:*`, `check-types` / `typecheck`, `lint`). Prose and assets are exempted by extension/basename allowlist. Python, Go, and Rust trees without that manifest get `[]`.

`hasVerificationCoverage` still requires at least one recognized check when the required-kind list is empty. That remains live for Worker obligations.

### High — Worker success requires a patch plus a recognized check

`getWorkerCompletionError` in `SubagentDelegation.ts` rejects `status === "completed"` when no authorized files changed:

```text
Worker reported completion, but no changes were captured in its approved write scope.
```

`ClineProvider` applies that error on the managed-child completion path. A Worker that correctly concludes “already implemented” or “no change needed” cannot report `completed`.

The Worker system prompt also encodes write-then-verify: prefer one shell-compatible verification command; do not run Git status or diff to enumerate the delta; call `attempt_completion` with `completed` only after at least one authorized change exists.

Parent completion for Worker origin still blocks on `pending` / `failed` and tells the model to rerun `execute_command` with exact `verification.change_set_ids`. That review gate is a sound harness idea. The credit recipe it consumes is the catalogue above.

### High — Explorer has a research playbook, not a role

`buildSubagentPrompt` for explore/review requires:

- Treat every path named by the objective as already located; read it directly.
- Do not use `list_files` or `search_files` to confirm an exact path.
- Never infer absence from listing or search output, especially truncated output.
- If more than eight named paths, use consecutive `read_file` batches of at most eight.
- For unnamed targets: at most one locate or search turn, then batched reads.
- When the research window ends, synthesize immediately instead of retrying a research tool.

`getEnvironmentDetails` repeats the named-path / batch-read rule for every sub-agent. The eight-file bound matches the real `read_file` batch limit and belongs in the tool schema. The research strategy does not. It matches prior Explorer failures (listing instead of reading, inferring absence from truncated listings, running out of turns) and will tax Explorers whose objective is a fuzzy search.

### Medium — Debug mode and leftover process fossils

`DEFAULT_MODES` Debug instructions: reflect on 5–7 sources, distill to 1–2, add logs, ask the user to confirm before fixing. That is a fixed diagnosis ritual, not a general debugger contract.

`rules.ts` still forbids starting messages with “Great”, “Certainly”, “Okay”, or “Sure”, requires `ask_followup_question` to offer 2–4 suggestions, and uses a Desktop `list_files` example. `attempt_completion` softly asks for one bounded end review of integration boundaries, UI states, and “test substance.” None of these is a hard pytest gate. They still steer every primary task toward a specific conversational and verification style.

Plan-mode command policy in `src/shared/plan-command.ts` is a large deny-list of output, plugin, cache, and write flags. That is reasonable Plan safety. It grows by runner spelling (`18630b5`, `d31aa9f`) the same way the evidence catalogue does.

### Low / watch

- `ToolScheduler.getVerificationCategory` tags commands with `(test|pytest|vitest|jest|mocha|ruff)` and similar build/lint/typecheck regexes for stagnation telemetry only.
- `ToolRepetitionDetector` treats a novel successful scoped read as progress. NOR-36 already noted that new activity can reset stagnation without repairing a stable capability failure.
- Eval smoke prompts under `evals/` often say “run the tests after the final edit.” Those stay in the eval layer and are not injected into the production system prompt. The risk is acceptance-fixture pressure, not runtime leakage.
- `CODE_MODE_INSTRUCTIONS` and `objective.ts` are mostly anti-overfit: proportionate verification, do not invent work, ordinary assistant completion is allowed.

## How this accumulated

Recent agent-loop history is a recognizer treadmill. Each concrete trace added a spelling, receipt, or prompt clause:

| Commit               | Change                                             | Overfit effect                                                             |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `39a4366`            | Enforce verification debt and bound stagnant loops | Coupled observation to launch; made primary edits need a recognized check. |
| `18630b5`, `d31aa9f` | Reject Plan output/profile flags                   | Plan allowlist grew by Go/Jest-style flag names.                           |
| `42c9977`            | Scope Python verification                          | Pytest coverage walk and config subset entered the evidence path.          |
| `0c901d8`            | Physical pytest collection receipts                | Exit zero stopped being enough for pytest only.                            |
| `903efc5`            | Reject pytest collection overrides                 | Another pytest-config special case after hidden-selection failures.        |
| `a40d61b`            | Fix admission; simplify primary completion         | Removed the two worst primary overfits. Worker and catalogue remain.       |

`a40d61b` is the first commit in this series that removed a general-case restriction instead of adding another special case.

## Healthy invariants

Do not treat these as overfit when simplifying:

- Explicit turn terminal statuses and ordinary-text completion in `AgentTurnEngine`.
- Transport / rate-limit / context / empty-response retries and token-aware pacing.
- Work vs Plan tool surface, sandbox roots, approvals, and output bounds.
- One terminal tool result per accepted call; denied and cancelled stay distinct from success.
- Worker Apply review as a parent-integration gate (the idea; not the catalogue it currently uses).
- Durable-before-effect persistence, reservation/receipt pairing, and reload of old primary records as advisory.

## Smell test for later changes

A change is overfit if it helps one of these and harms the others:

- a README typo with no suite
- a git diagnostic in a large non-git tree
- a Python repo whose real CI is `tox` or `hatch test`
- a Worker that should report “already implemented”
- an Explorer asked to find an unnamed symbol

If the patch is “add another accepted argv, config filename, or prompt paragraph,” it is extending the catalogue. If it is “execution authority stays on policy; evidence is optional and honest,” it is generalizing the harness.

## Recommended freeze

These are review recommendations, not an implemented contract change.

1. Do not add new runner recipes in `VerificationScope` without a runner-agnostic evidence object (process result plus optional host witness). The pytest observer should become an adapter, not the kernel’s notion of verification.
2. Keep Worker Apply review, but allow `completed` with zero files when the objective did not require a mutation, and stop requiring a catalogue check when no check was declared.
3. Move Explorer batch size and “named path is already located” into the tool contract and result errors. Remove the research playbook from the system prompt and `environment_details`.
4. Hold out acceptance cases that are not the last NOR trace: custom CI, “no change needed,” non-coding questions, and command spellings the catalogue does not know. A passing restriction test is not proof the extension can do ordinary work.

## Out of scope

This review did not rerun a live model, change production code, or re-measure lifecycle publication cost. It did not audit UI, providers, packaging, or the protected `apps/cli/` and `packages/vscode-shim/` trees. Eval fixtures were inspected only to confirm they do not inject into the production system prompt.
