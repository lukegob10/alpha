# Agent execution and verification overfitting review

Date: September 5, 2026. Mode: follow-up audit / contract alignment.

Implementation follow-up: [execution and verification contract correction](agent-execution-simplification-2026-09-05.md).
The findings below describe the pre-fix behavior; the follow-up records the replacement and its acceptance coverage.

## Conclusion

Alpha has made a small, incomplete approximation of verification into a prerequisite for ordinary execution and
completion. It can prevent an approved tool from obtaining the evidence the model needs, then encourage indirect
workarounds. Separately, the public batched-read contract does not survive the canonical execution path. More command
recipes, another task classifier, or a different model will not repair those boundaries.

The latest trace also contains a model error: it confidently equates a `.git` directory with a working repository after
the authoritative command failed to launch. The harness did not force that false assertion. It did obstruct the proper
check and provide weaker substitute information. Both matter.

The preceding unshipped Git/JSON postcondition patch is the wrong architectural direction. Its tests establish narrow
behavior but do not demonstrate that the extension can complete ordinary tasks. Withdraw that patch as the proposed
solution; simplify the execution and completion contracts before implementing the two-stage model/workflow approach.

## Evidence and scope

- Latest real task: `01a072aa-eedd-707e-b815-1f3ed8095dc9`, workspace `F:/vault/archives/project-manager-v2`.
- Initial request: “have we created a local git?” at 17:43:20.034 UTC. User correction at 17:45:22.551 UTC.
- Sources: `ui_messages.json`, `api_conversation_history.json`, `agent_turn_events.jsonl`,
  `agent_lifecycle_events.jsonl`, `history_item.json`, and task metadata in Alpha's global task storage.
- Source baseline: `98e8c93940882b61466d44c452a56ef10ea5f5d7`, plus the explicitly unshipped local patch.
- Reviewed: shell admission, execution policy, native argument dispatch, file reading, completion/evidence rules,
  prompt guidance, lifecycle publication, relevant test design, and change history. This is not a full UI, provider,
  security, packaging, or repository-wide cleanup audit.
- Disposable probes exercised the actual current scope resolver, command classifier, requirements resolver, and
  `AgentControlStore`. They did not launch commands in or change the user's project.

The trace contains the old plain-string observation rejection, not the new local diagnostic. It therefore does not
exercise the preceding patch. The separate development bundle at `F:/roo-fork/Alpha-Code/src/dist/extension.js` still
has the old rejection and a 02:50:42 UTC modification time. That is consistent with an older build; this review did not
independently identify a currently running extension host or establish an exact loaded source commit. The architectural
problems below are confirmed in the current source too, so build age does not dispose of them.

## What actually happened

| Phase                                           | Model requests | Tool calls | Outcome                                                                                                                                                      |
| ----------------------------------------------- | -------------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial status question                         |              4 |          3 | An approved Git command was rejected before launch; two listings followed; Alpha answered “Yes” incorrectly.                                                 |
| User supplies contradictory `git status` output |              3 |          4 | A second approved Git command was rejected; two requested read batches returned one file each; Alpha retracted its answer and told the user to run commands. |
| Total                                           |              7 |          7 | Zero shell processes launched; no writes, plans, delegation, or non-null verification associations occurred.                                                 |

The initial answer reached completion after about 43 seconds. The correction took another 77.6 seconds, excluding the
user's intervening time. Reported usage was 79,244 input tokens and 3,491 output tokens, with zero reported cache reads.
The profile label was “GPT-5.6 Luna Max (Github Copilot)”; that label alone does not prove every provider effort setting.

The first command was `git rev-parse --is-inside-work-tree && git status --short --branch`; the second was
`git -C . rev-parse --show-toplevel`. Both received approval. Their result was the same pre-launch observation error.
This latest task did not end in the earlier task's blocked-completion error. It completed with an incorrect answer and
then a correction. Mandatory verification debt is not the direct cause of its false answer; its admission prerequisite
is the shared defect.

## Findings

### 1. Critical / must-fix: bookkeeping availability controls ordinary command execution

In [`ExecuteCommandTool`](../src/core/tools/ExecuteCommandTool.ts), `executeCommandInTerminal` calls
`captureWorkspaceMutationState(task.cwd)` for every primary command after approval. Failure falls back to
`classifyPlanCommand`, even in Code mode, and permits only its `inspection` category. A classifier result of
`verification` is still rejected. Actual execution policy and approval have already been checked.

[`VerificationScope`](../src/core/agent/VerificationScope.ts) limits a non-Git walk to 256 files, 512 visited entries,
bounded depth and bytes, and refuses symlinks/special files. It excludes `.git` and `node_modules`, but not `.venv`.
Invalid `.git` metadata makes Git observation fail too. The scope is the whole task workspace, not the small operation.

Actual-source probes in a disposable 257-file non-Git workspace produced:

| Command                                          | May launch through the current fallback? |
| ------------------------------------------------ | ---------------------------------------- |
| `git status`                                     | No: missing `--no-pager`.                |
| `git -C . rev-parse --show-toplevel`             | No: option classification rejects it.    |
| `git --no-pager rev-parse --is-inside-work-tree` | Yes.                                     |
| `node --version`                                 | No.                                      |
| `python --version`                               | No.                                      |
| `python -m pytest tests`                         | No, although classified as verification. |
| `git init`                                       | No.                                      |

The same one-file workspace could be observed before the extra files were added. Thus unrelated workspace size changes
whether a trivial authorized command can execute. An environment/version diagnostic can be blocked by the bookkeeping
for mutations it does not perform.

History identifies commit `39a4366b14e62019e26047d443b0632475ed0378` (“Enforce current verification debt and bound stagnant
tool loops”, September 4) as the introduction of this dependency. The Plan classifier predates it. The defect is their
coupling, not merely an inadequate list of accepted spellings.

**Direction:** execution authority must come from the actual policy, approval, and sandbox capability. Keep bounded
observation as evidence about changes, with an explicit completeness state, rather than a universal launch prerequisite.
Do not silently claim that incomplete observation proves no mutation. Do not route Code commands through Plan semantics
because an observer failed. Raising limits, adding `.venv` exceptions, or expanding Git syntax alone leaves the defect.

The existing observer is not a complete filesystem security boundary: the repository's own
[NOR-25 implementation document](nor-25-implementation.md) explicitly excludes unknown ignored files, outside-workspace
shell effects, and other surfaces from its guarantee. An incomplete diff observer cannot replace actual containment.

### 2. High / must-fix: completion imposes a verifier catalogue as a task specification

[`VerificationRequirements`](../src/core/agent/VerificationRequirements.ts) infers required kinds from package-script
names. [`AgentControlStore.hasVerificationCoverage`](../src/core/agent/AgentControlStore.ts) requires at least one
recognized check even when the required-kind list is empty. The resolver accepts only supported executable, argument,
configuration, and coverage patterns.

A disposable README edit returned `{"README.md":[]}` from the requirements resolver, yet the real completion decision
was blocked and demanded a supported command plus an exact `primary-change:` identifier. A Python command asserting the
actual README contents was unrecognized; a Prettier format check was recognized. That is a description of the current
recognizers, not a claim that a formatting check proves the requested wording is correct.

More significantly, the current resolver rejected Alpha's own `pnpm --dir src test` and `pnpm --dir src lint` as unsupported
configuration when associated with a source change. `pnpm --dir src check-types` was accepted. These were scope-resolution
probes, not failed executions of the test/lint commands. A successful real project test can still receive no credit.

**Direction:** separate tool outcome, change receipt, and evidence for the user's requested result. The model should
choose proportionate validation from the task, repository instructions, and observed risk. Hard completion gates should
cover explicit unresolved operations and explicitly required checks, not requirements inferred from an incomplete
catalogue. Preserve stronger Worker Apply/review and recovery contracts where required, rather than generalizing them
to every primary edit. Any change here must deliberately update the existing contract, persisted readers, and tests.

### 3. High / must-fix: advertised read batches are silently reduced to a single file

The native [`read_file` description](../src/core/prompts/tools/native-tools/read_file.ts) tells the model to provide
`path` plus `files` for a batch. The trace does exactly that:

- `.git/HEAD` and `.git/config` requested; only HEAD returned.
- `.git/config`, `.git/description`, and `.git/index` requested; only config returned.

[`ToolScheduler`](../src/core/agent/ToolScheduler.ts) constructs `nativeArgs` directly from the canonical call arguments.
[`BaseTool`](../src/core/tools/BaseTool.ts) forwards them. [`ReadFileTool.execute`](../src/core/tools/ReadFileTool.ts) chooses
the batch path only when `isLegacyReadFileParams` finds the private `_legacyFormat: true` discriminant in
[`tool-params.ts`](../packages/types/src/tool-params.ts). The public schema does not require that flag.

[`NativeToolCallParser`](../src/core/assistant-message/NativeToolCallParser.ts) knows how to add the flag, but that
normalization is bypassed by the canonical scheduler path. Its parser tests do not establish production batch behavior.

**Direction:** normalize and validate the public argument contract once at the execution boundary. Every requested batch
entry needs content or an explicit terminal error/denial. Test public JSON through the real scheduler and handler; do not
test only the private flag or legacy parser. This is a tool defect, not poor model batching judgment.

### 4. High / must-fix: lifecycle persistence delays already-generated results

Across the latest seven requests, usage-to-assistant-commit intervals total 38.9 seconds. On the final response alone,
the interval was 31.8 seconds. Within that final interval the journal contains 688 assistant-reasoning fragments,
74 assistant-text fragments, and one usage item. These are application event intervals, not an isolated disk profiler.

[`Task.publishCanonicalLifecycleResponseItems`](../src/core/task/Task.ts) awaits journal publication for each response
item and repeatedly obtains lifecycle snapshots; it runs under the before-effect persistence barrier.
[`AgentLifecycleJournal.append`](../src/core/agent/lifecycle/AgentLifecycleJournal.ts) performs locked durable work and
snapshot handling. The trace and source identify a concrete critical path even when no tool remains to run.

**Direction:** publish ordered fragments in bounded batches/coalesce compatible text fragments while preserving provider
metadata, tool boundaries, durable-before-effect semantics, and cancellation. Benchmark the recorded fragmentation shape.
An additional model round trip makes this worse, but reducing model calls alone will not eliminate it.

### 5. Medium / should-fix: guidance competes with the task and hides capability mismatches

The final response's recorded reasoning spends substantial attention on whether `.git` and the absolute workspace path
must be clickable, whether a path is verified, and how to format the link. This matches the emphatic universal rule in
[`markdown-formatting.ts`](../src/core/prompts/sections/markdown-formatting.ts). It does not explain all output tokens,
and the complete transmitted system prompt was not recovered, so no isolated causal token saving is claimed.

[`rules.ts`](../src/core/prompts/sections/rules.ts) and the normal shell tool describe command chaining, while the observer's
fallback rejects it. The old error recommends file tools without explaining which capability failed. The prior trace
demonstrated why this invitation can be damaging: the model manufactured incomplete application metadata.

**Direction:** replace conflicting and absolute workflow/formatting rules with concise guidance. Explain actual tool
capabilities in the schema and actual failures in results. Formatting must not invite extra factual investigation.
Do not add more compulsory process to compensate for an unavailable tool.

### 6. High / must-fix: our tests and proposed fix validated the restrictive design, not ordinary usefulness

The preceding patch adds an exact Git argument vector, four special administrative filenames, a JSON-specific recognizer,
a new persisted verification kind, and additional revalidation. It leaves the whole-workspace admission dependency intact.
Its regression intentionally asserts that a non-Git mutation cannot launch above the observation bound. Passing that
test proves the restriction; it does not prove the extension can perform a small requested task.

The earlier reported 265 focused tests, type/lint checks, and host suites did run and pass. They did not replay the user's
workflow with a live model or cover the batched-read canonical-dispatch mismatch. The build was also not loaded into the
user's active instance. “Fixed” overstated the product result.

**Direction:** withdraw the Git/JSON specialization as the remedy. Add acceptance cases from normal user requests and
hold out variations in commands, repository size, files, configuration, and model wording. A safety test and a usefulness
test are both needed; prohibiting work is not automatically a correctness win.

## Reference harnesses: relevant distinction

At Codex commit `588b781ab4924ce7352488394028e63d74cf807f`, the inspected
[execution handler](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
and [unified-exec runtime](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/core/src/tools/runtimes/unified_exec.rs)
separate command execution from permission/sandbox orchestration and process management. Codex does have command policy,
approval logic, and hooks; the lesson is not to remove those. Its
[base prompt](https://github.com/openai/codex/blob/588b781ab4924ce7352488394028e63d74cf807f/codex-rs/protocol/src/prompts/base_instructions/default.md)
guides planning and validation proportionately rather than making every edit require a recognized test configuration.

At Pi commit `da840b6216578c2a571d0374ac6a2091a83f9d91`, the inspected
[shell implementation](https://github.com/earendil-works/pi/blob/da840b6216578c2a571d0374ac6a2091a83f9d91/packages/coding-agent/src/core/tools/bash.ts)
accepts a command, runs it through a process interface, and returns output/exit information with timeout and cancellation
handling. It does not impose Alpha's universal file-verifier catalogue in that path. Pi has different permission and
extension assumptions; copying its default execution authority would not be an appropriate Alpha fix.

These sources were inspected September 5, 2026. This is source comparison, not a measured product speed comparison, and
does not claim that either entire harness lacks other restrictions or continuation hooks.

## Replacement direction and acceptance criteria

1. Restore a coherent primary command path: public arguments → effective execution policy/approval → process → honest
   terminal result. Observation completeness must not create a hidden alternate permission mode. Preserve actual policy,
   cancellation, output bounds, denied outcomes, mutation serialization, and interrupted-effect recovery.
2. Make verification a proportionate evidence workflow. Keep explicitly required gates and managed-change review; remove
   unconditional primary-file verification and unsupported-config-as-task-failure semantics. Avoid model-supplied magic
   IDs and exact command recipes as requirements for ordinary work. Preserve legacy saved records deliberately.
3. Make advertised primitives reliable: correct public batch handling and bounded lifecycle publication. Replace
   contradictory prompt guidance instead of appending more instructions.

The proving workloads should include:

| Request / condition                                                          | Required observable behavior                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ask whether a repository is usable, including malformed metadata             | A normal approved diagnostic reaches Git; its real output supports the answer; no metadata writes.   |
| Ask for an installed program's version in a non-Git workspace over 256 files | The authorized command runs without requiring a project-wide snapshot.                               |
| Request several known files using the advertised batch shape                 | Every file has a result through the real kernel/scheduler/handler path.                              |
| Correct a README typo with no separately required suite                      | Apply the change and report it without inventing a formatter requirement.                            |
| Request a custom project test or use dynamic Vitest/ESLint configuration     | Report the real process outcome; unsupported inference is not recast as a failed test.               |
| Cancel, deny, or interrupt a real operation                                  | Preserve explicit outcomes, resource cleanup, and unresolved effects; never convert them to success. |
| Repeat the above after reload and with different ordinary command spellings  | Behavior remains consistent without adding operation-specific exceptions.                            |

Use scripted providers for deterministic execution-contract tests and a small live-model acceptance set for task
understanding. Record model, actual loaded build, tool/process counts, tokens, and timing. Keep live speed claims separate
from deterministic guarantees. Implement this correction before relying on either stage of the previously proposed
workflow/model changes.

## Closure ledger

| State                 | Work                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed now             | No production changes in this review. Corrected the prior patch's recommendation/status in the review documentation.                                                         |
| Confirmed and flagged | Admission/observation coupling; unconditional primary verification; native batch mismatch; lifecycle publication cost; conflicting guidance; inadequate acceptance coverage. |
| Verified              | Latest trace reconstruction, actual-source disposable scope/ledger probes, relevant dispatch and persistence code, introducing commit, pinned Codex/Pi sources.              |
| Not verified          | A live-model rerun on the current patch; exact active host commit; an isolated profiler attribution for publication time; a completed replacement implementation.            |
| Out of scope          | Repairing the user's project, changing model settings, two-stage implementation, protected CLI/shim edits, broad UI or dependency cleanup.                                   |

Temporary reproduction script: `%TEMP%/alpha-overfitting-audit.mts`, run from this worktree with `pnpm exec tsx`.
It creates and removes its own fixture directory. No live task, project file, setting, or production source was changed.
