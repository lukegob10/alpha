# General command evidence and objective-based managed roles

Date: September 5, 2026. Mode: contract alignment.

This implements the critical and high-priority findings in
[the core loop overfitting review](core-agent-loop-overfitting-review-2026-09-05.md), plus its bounded Debug and prompt
cleanup. It preserves the existing primary completion and blocked-handoff work in the checkout.

## Contract

Execution authority remains in tool policy, approvals, workspace containment, and mutation ownership. Evidence collection
does not classify a command into an alternate permission policy. Parent review and Apply/Discard still control integration
of actual Worker patches. A Worker can complete an objective without a patch when no change is needed.

Command evidence records the physical process outcome, execution identity, actual working directory, explicit change-set
association, and captured content version. New receipts carry `assurance: "process"`. A successful receipt means the
associated process exited successfully against a current captured snapshot. It does not establish that tests ran, semantic
coverage, or the complete transitive dependency closure. Custom CI, filtered checks, prose checks, and language-specific
runners share this contract. A successful command that collected no tests is still only process evidence.

The exact argv/configuration catalogue and automatic pytest instrumentation are removed. No new runner registry or
collection-witness framework replaces them. Stronger optional witnesses would require a separately designed host contract
and honest assurance semantics; they must not become an implicit language-specific completion requirement.

The snapshot scope is the canonical workspace root. The actual process cwd must be contained in that workspace, but it
does not define source coverage: an approved script in one directory can inspect a sibling directory. Associated paths,
content bounds, filesystem identity, and stale-content checks still constrain evidence credit.

## Completion and compatibility

- Settled primary receipts remain advisory.
- Approved, applied Worker patches do not acquire mandatory checks from package-script names or file extensions.
- Missing or failed optional evidence does not itself block completion. Failures remain recorded as failures.
- Unresolved mutation scope, active mutation reservations, active descendants, and unread child terminal results retain
  their existing completion barriers. Optional observation cannot settle any of those barriers.
- If an optional snapshot cannot be reread, its evidence is invalidated without creating mutation debt. The content version
  advances so replay cannot restore an obsolete receipt. Persistence and ownership failures still propagate.
- Legacy verifier kinds, inferred requirements, and receipts remain readable. Old pending/failed records are not rewritten
  as passing records. Their current blocking projection follows the same review and effect-settlement contract.
- The webview consumes the runtime's `blocking` projection rather than inferring a required Verify/Fix action from evidence
  status alone.

Repository instructions and the user's requested validation still define the work. Removing an inferred completion gate
does not establish that unperformed requested validation was completed.

## Role and prompt changes

Worker instructions describe objective completion, authorized scope, proportionate checks, and honest results. They no
longer prescribe edit-first reconnaissance, one verification command, or a mandatory changed file. Explorer/Reviewer
instructions retain read-only authority, evidence quality, and budget limits without a named-path or single-search recipe.
The real eight-file `read_file` limit remains in the tool contract.

Debug guidance asks for evidence-driven diagnosis and appropriate regression coverage without a fixed hypothesis count,
mandatory logging, or a diagnosis-confirmation ritual. General rules no longer duplicate question-count constraints or
forbid particular opening words. Completion guidance remains proportional to the assigned outcome.

## Validation and closure

Acceptance coverage includes custom CI spellings, no-test process success, no-change Worker completion, missing/malformed
manifests, sibling-directory associations, failed/cancelled/stale process results, optional snapshot failures, durable reload,
and UI attention driven by the authoritative blocking flag. These are deterministic contract tests, not model-quality or
speed benchmarks.

Validation completed during implementation:

- Repository-wide `pnpm lint` and `pnpm check-types` passed.
- Focused agent suites passed 113 tests; terminal, command, role, and managed-child suites passed 298 tests.
- The final completion, evidence, and ledger integration run passed 121 tests. The broader earlier integration run also
  covered Apply/reload recovery; the managed-agent certification matrix now includes those suites explicitly.
- Three focused webview suites passed 39 tests. Shared schema tests, types build, lint, and typecheck passed.
- The final observation-race and completion-diagnostics run passed 77 tests, including UI refresh after stale primary or
  Worker evidence is invalidated. Live Run C was advanced to V5 to replace its obsolete forced-check rejection; Windows
  playbook preflight and the certification matrix self-check passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` bundled successfully but could not start the exact host:
  Windows held the `vscode-updating` setup mutex. The runner found VS Code 1.122.1, then exited before executing tests.

Run `pnpm certify:managed-agents:automated` for the source-stable certification artifact and the managed extension-host
scenario. Its generated artifact records the exact source state and per-track results. An unavailable host gate must not
be reported as passed; rerun both host gates after the editor update finishes.

The Plan command allowlist remains an execution-policy boundary and is unchanged. Stagnation telemetry, novel-read progress
heuristics, live-model behavior, and the protected CLI/shim trees remain outside this change. This pass does not claim a
repository-wide audit or measured improvement in model quality or latency.
