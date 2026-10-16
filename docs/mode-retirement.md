# Code and Plan execution modes

Alpha executes only Code (`code`) and Plan (`architect`). The historical `architect` identifier remains stable for saved
tasks and integrations. Ask, Debug, and Orchestrator are no longer built-in modes. Custom mode definitions remain readable
as configuration data, including Code customizations, but cannot introduce another executable mode.

The model-facing `switch_mode` tool is retired: it has no native schema, parser case, or executable registry entry. The
host still owns user-requested Code/Plan transitions, preserving the current task, transcript, and model. Model-authored
follow-up mode suggestions require a user click; auto-approved replies cannot change modes. Plan continues to enforce its
existing read-only policy. The current Plan handoff contract is described below.
Model-invoked slash commands load their instructions without applying mode metadata; user-entered commands may still
select a supported mode through the host.

## Plan handoffs and questions

Plan mode remains conversational. Clarification, limitation, empty, and malformed final output retain their original text;
the host does not reconstruct a proposed plan from them. Only one explicit, exact, complete, non-empty
`<proposed_plan>...</proposed_plan>` result can create or replace the persisted implementation handoff. Official-plan
prompt instructions apply only when the model presents a decision-complete specification.

Implement plan requires an explicit user click on a completed, stored plan in the same visible primary task. The host
validates task identity, mode, current handoff digest, and active execution boundary before switching Plan to Code and
continuing the task. A later conversational response preserves the prior handoff. Existing saved handoffs and transcripts
remain readable, including historical inline wrappers.
No migration fabricates missing plans or answers; retired and unknown saved modes still resume in Plan as described below.

The reference is Codex commit `bb64b894fd67158be0f874872e6d7bfe717e7368`:
its [Plan template][codex-plan-template] makes official plans conditional, and the [TUI tests][codex-plan-tests] require
proposed-plan output before offering implementation. Alpha retains its stricter exact, explicitly closed handoff contract.
Codex's [display parser][codex-plan-parser] also accepts surrounding prose and closes an unterminated block at EOF;
Alpha preserves those responses without creating a handoff.

Unanswered primary-task followups remain pending in Ask and Auto approval modes regardless of whether the task is on screen.
Explicitly configured autonomous followup timeouts, including Full Access, continue through the shared approval policy.
A visibility change alone never supplies a user answer.

[codex-plan-template]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/collaboration-mode-templates/templates/plan.md
[codex-plan-tests]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/tui/src/chatwidget/tests/plan_mode.rs#L937-L982
[codex-plan-parser]: https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/utils/stream-parser/src/proposed_plan.rs

## Existing data

- Saved Code and Plan tasks retain their modes. Tasks saved before mode persistence retain the historical Code default.
- A saved retired or unknown mode resumes in Plan. This is intentionally conservative: removal must not grant an old Ask
  or restricted custom task Code's editing and command capabilities. The user can explicitly select Code to implement.
- History and transcript schemas still read old mode strings, tool transactions, and `switch_mode` usage counters. Old
  transcript rows remain displayable; historical records do not register executable tools.
- Existing mode-specific instructions, skills, and provider mappings are not deleted or merged into Code. Rules belonging
  to retired modes are no longer selected when the task resumes in Plan.
- New task requests, user mode changes, and delegation targets accept only Code and Plan. Unsupported targets fail before
  changing configuration, persisting a transition, or suspending a parent. Existing schedules targeting a retired mode
  must be updated to an available mode; execution cannot silently fall back to Code.

## Orchestration

Managed Explore, Review, and Worker children continue to use Code with their existing role and authority restrictions.
The turn engine, scheduler, managed lifecycle, cancellation, and transcript transaction machinery are unchanged.
`new_task` remains a separate legacy delegation mechanism, restricted to Code/Plan targets. Retiring that mechanism and
its saved parent/child recovery paths is a separate change.

## Verification

The affected coverage includes mode catalogs, retired tool exclusion, historical restoration and usage schemas,
unsupported-target rejection before side effects, task-local concurrent transitions, retained provider identity,
delegation, prompt/tool filtering, mode selectors, and approval settings. The release-gating host command remains:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

## Validation record (2026-09-14)

Repository-wide lint and typechecking passed. Focused tests cover the shared schemas, tool registry and parser,
Code/Plan policy and restoration, provider identity, concurrent task transitions, delegation, automatic replies,
mode selectors, and settings save/cancel behavior.

`pnpm --filter @alpha-code/vscode-e2e test:core:1221` passed on the final runtime, including the required
`test:smoke:1221` gate and the core-loop, completion-idle/follow-up, and managed-agent acceptance suites. All six host
launches reported VS Code 1.122.1 and exit code 0.

The broader `src/core/task/__tests__/Task.spec.ts` run has four existing compaction failures: the two successful-restore
truncation cases under "preserves acknowledged context across empty retry", plus "keeps queued message after condense
completes" and "does not cross-drain queues between separate tasks". All four reproduce using the saved pre-removal
`Task.ts` from the user's working tree; 190 other cases pass on the final implementation. This removal does not change
that compaction logic or weaken those assertions.

The subsequent validation on 2026-09-14 corrected those four test fixtures:
they now model a measured context reduction and retain real history replacement. The acknowledged-context and
per-task queue assertions pass without changing compaction runtime behavior.
