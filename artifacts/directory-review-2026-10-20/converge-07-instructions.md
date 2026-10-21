# Codex convergence review 07: instructions, skills, modes, and workspace context

Review date: 2026-10-20. Alpha checkout: `F:/roo-fork/Alpha-Code`. Upstream: `openai/codex` at **`d571eaf1f61d0d93a797506335a99a9950ffe37b`**, inspected from `C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-codex-directory-review-20261020`.

Read-only review of application code. Existing modified tests and untracked user documents were preserved. Only this review artifact was created. Sandbox architecture is excluded. Alpha's additional extension tools, built-in skills, and host-controlled Code/Plan contracts are accepted intentional differences.

## Assessment

**8/9 criteria = 88.9% in this review's bounded rubric.** This is an ordinal evidence score for this subsystem, not a measured percentage of the entire Codex feature set. Confidence is **medium-high** for default local instruction/skill behavior and **medium** for end-to-end provider/host behavior, which this review did not execute. The implementation is near the user's 90%-ish target in this area. No wholesale runtime rewrite is warranted.

The strongest evidence is concrete: root-to-cwd AGENTS discovery, preferred overrides, host-configured roots/fallbacks, role-aware instruction fragments, lazy skill loading, portable skill roots, explicit-only policy, exact selected skill identities, frozen child instructions, stable retry snapshots, and incremental environment capture already exist. The main behavioral divergence is opt-in loading of descendant AGENTS into a parent task. Machine-readable per-file provenance remains weaker than upstream.

## Scored criteria

Scores: 1 = observable contract substantially implemented; 0.5 = meaningful partial coverage or a remaining difference; 0 = absent. Each criterion has equal weight. Tests named below were either run in the verification section or explicitly inspected as source.

| Criterion                                                                  | Score | Alpha evidence                                                                                                                                                                                                                    | Current upstream evidence at pinned SHA                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host instructions retain higher authority than user/repository guidance    |     1 | `src/core/prompts/system.ts:330-396`; `src/core/prompts/sections/custom-instructions.ts:785-838`; roles and origins are separate; skill metadata is deliberately user-authority                                                   | `codex-rs/core/src/context/user_instructions.rs:13-40` uses user authority for AGENTS; `codex-rs/core/src/context/developer_instructions.rs:29` uses developer authority for host guidance                                                                      |
| Project ancestry, preferred override, fallback filenames, configured roots |     1 | `src/services/config-paths/index.ts:433-475`; `src/core/prompts/sections/custom-instructions.ts:495-516`; project-discovery/configured-discovery tests pass                                                                       | `codex-rs/core/src/agents_md.rs:189-289`; root-to-cwd traversal, configured markers excluding project-controlled marker overrides, and override-first selection                                                                                                 |
| AGENTS scope and boundedness                                               |   0.5 | Shared 32 KiB project budget at `custom-instructions.ts:83-90,595-618`; optional descendant `.roo` discovery at `:303-338` broadens scope; descendant/local supplements are outside this budget                                   | `codex-rs/core/src/agents_md.rs:68-94,142-178,223-240`; scoped ancestor chain and shared project budget; tests `agents_md_tests.rs:686,1264,1367`                                                                                                               |
| Progressive skill disclosure, portable discovery, bounded catalog          |     1 | `src/services/skills/SkillsManager.ts:869-938`; `src/core/prompts/sections/skills.ts:23-32,90-184,191-210`; Alpha retains its built-in and `.alpha` sources                                                                       | `codex-rs/ext/skills/src/host_roots.rs:73-130,137-184`; `render.rs:128-153`; `catalog_prompt.rs:7-23`                                                                                                                                                           |
| Explicit skill identity, implicit policy, path resolution                  |     1 | `SkillsManager.ts:462-505`; `skillInvocationProvenance.ts:94-110`; `src/core/mentions/__tests__/explicit-skills.spec.ts:31-204`; `SkillTool.ts:176-237`; selected paths are retained                                              | `codex-rs/skills/src/selection.rs:33-40,62-108,149-198`; `codex-rs/ext/skills/src/selection.rs:21-79`; skill instructions use user authority in `fragments.rs:87-126`                                                                                           |
| Child inheritance and retry instruction snapshots                          |     1 | `src/core/prompts/inherited-instructions.ts:4-35`; `src/core/agent/SubagentInvocationContext.ts:24-39`; `Task.ts:6200-6217`; `StepContext.ts:77-93`; focused capture/retry tests pass                                             | `codex-rs/core/src/agents_md_manager.rs:28-36`; `core/tests/suite/agents_md.rs:2400-2609` checks parent-applied snapshots and unchanged child instructions after source updates                                                                                 |
| Host-controlled modes and Plan workflow                                    |     1 | `packages/types/src/mode.ts:142-181,184-205`; `system.ts:340-342,423-429`; strict Plan remains controlling developer guidance despite saved user overrides                                                                        | `codex-rs/core/src/context/world_state/collaboration_mode.rs:27-80,157-175`; `models-manager/src/collaboration_mode_presets.rs:6-23`; Alpha's stricter Plan execution policy is intentional                                                                     |
| Dynamic environment refresh, changes/removals, cancellation-aware capture  |     1 | `src/core/environment/EnvironmentContext.ts:28-110,114-135`; `getEnvironmentDetails.ts:83-148`; per-task identity, changed/removed fields, durable commit receipts, and reset-race tests                                          | `codex-rs/core/src/context/world_state/collaboration_mode.rs:113-148` and other world-state sections implement captured state transitions; `agents_md_manager.rs:64-148` refreshes host instructions at request boundaries while retaining repository snapshots |
| Structured per-file instruction provenance                                 |   0.5 | Role/origin/text retained in fragments, but ordinary `Task.ts:6252-6265` supplies only a design handoff in `instructions.sources`; child step capture uses synthetic task/step references at `SubagentInvocationContext.ts:34-38` | `codex-rs/core/src/agents_md.rs:488-498,527-555` preserves exact file and environment provenance; `agents_md_tests.rs:1516-1550` verifies ordered source files                                                                                                  |

## Material gaps and code-quality concerns

### 1. P2 — Optional descendant discovery broadens AGENTS scope and bypasses the shared project budget

**Trigger:** `enableSubfolderRules=true` and a descendant/sibling package has a `.roo` folder plus AGENTS guidance. `captureInstructionDirectories()` adds every discovered descendant parent to the same agent-instruction list (`src/core/prompts/sections/custom-instructions.ts:325-336`). The entire content then enters the parent's user instruction fragment rather than remaining scoped to work in that subtree. `isProjectDirectory ? budget : undefined` at `:603-611` / `:638-644` also makes those descendant AGENTS unbounded by the project's 32 KiB aggregate limit.

This is verified existing compatibility behavior, not a newly introduced regression: `custom-instructions-discovery.spec.ts:69-85` explicitly expects descendant instructions in a root prompt, and `custom-instructions-project-discovery.spec.ts:78-104` expects an over-budget descendant file while a nearer project file is omitted. Upstream restricts automatic project instruction assembly to root through cwd (`agents_md.rs:223-240`) and shares the project budget (`:68-94`). Root repository AGENTS likewise describes nested guides as subtree-scoped.

**Impact:** conflicting sibling guidance can influence a parent task, and a large optional descendant guide can consume context after the canonical project budget is exhausted. Default `enableSubfolderRules=false` avoids descendant loading, so this does not invalidate normal convergence.

**Smallest fix:** keep the canonical AGENTS list on the ancestor chain; retain explicit Alpha rule-directory discovery as an extension capability with its own documented scoping and bounded supplemental budget. If automatic subtree AGENTS loading is retained, expose it as path-scoped evidence and apply it only when operating in that scope. Do not drop first-class Alpha rules or user overrides silently.

**Regression test:** root task plus two sibling packages with conflicting AGENTS; neither sibling becomes global guidance, a child rooted in one package receives only that package's applicable ancestors, and combined optional guidance has a deterministic cap. Existing tests that assert broad loading would need a deliberate compatibility-contract update.

### 2. P3 — Ordinary step capture discards structured AGENTS file provenance

**Trigger:** an ordinary primary task assembles AGENTS and creates a step snapshot. `Task.ts:6252-6265` stores fragment origins/text but `sources` is empty unless there is a design handoff. `captureInheritedStepInstructions()` then creates synthetic references (`SubagentInvocationContext.ts:34-38`) instead of carrying actual AGENTS file refs. A separate helper does capture real refs (`Task.ts:18296-18322`), but that is not the ordinary invoking-step capture path.

**Impact:** diagnostics and descendants cannot programmatically attribute a captured instruction to its exact contributing file/digest the way upstream's `LoadedAgentsMd.sources()` can (`agents_md.rs:488-498`). The body remains in the snapshot; this is an attribution/observability gap, **not evidence of instruction loss or unsafe replay**.

**Smallest fix:** return captured source records from the existing prompt assembly and thread their exact path/digest through the same step capture; do not reread mutable files merely to reconstruct provenance.

**Regression test:** root and nested AGENTS sources appear in ordered `StepContext.instructions.sources`; retries retain the exact paths/digests without rereading; the next new step reflects an intentional source change.

### 3. P2 implementation debt — Wholesale upstream prompt corpus violates the repository's stated native-implementation contract

`AGENTS.md:38-39` explicitly disallows copying prompts wholesale. `src/core/prompts/codex-model-instructions.ts:2-25` explicitly embeds eight complete verbatim model instruction bodies. Their combined literal content is 147,659 UTF-8 bytes; `:49-58` pins their digests and `src/core/prompts/__tests__/codex-model-instructions.spec.ts:120` tests byte identity. GPT-6.1 instead adapts a retained base locally (`:28-46`).

**Observed status:** a read-only TypeScript-AST/hash comparison against current upstream confirmed exact equality for the six retained bodies whose slugs still exist verbatim in the current catalog: GPT-6 Astra/Sol/Luna, Daybreak Blue/Red, and GPT-5.5. There is **no demonstrated current staleness** for those bodies. This concern is contract compliance and maintenance coupling, not a reason to mark those behaviors unconverged.

**Smallest robust direction:** preserve tested observable workflows in concise Alpha-owned instruction modules and keep source provenance/behavioral comparison tests. Replace whole-body digest assertions with focused requirements about authority, tools, completion, and Plan behavior. This should be a deliberate follow-up with prompt/token and representative task validation, not a blind text replacement during an audit. It is not included as a behavioral convergence deduction.

## Intentional differences and limits

- Alpha's Code/Plan host operations, fallback of retired saved modes into Plan, first-class Tickets/HTML/scheduling/skills, and provider-neutral native tool contracts are accepted extension choices, not gaps.
- Alpha puts untrusted skill metadata at user authority while current upstream puts its catalog fragment at developer authority (`ext/skills/src/fragments.rs:42-68`). The separation is deliberate and tested (`system-prompt.spec.ts:281`), with host usage guidance remaining higher authority. Do not increase metadata authority merely to imitate a wire shape.
- Alpha refreshes ordinary repository rules on prompt preparation; current upstream retains a repository snapshot while refreshing host/global/thread providers (`agents_md_manager.rs:87-136`). Alpha's fresh reads are a product choice; frozen retries and children are the relevant invariant and have focused coverage.
- Cloud/executor skill packages and multi-machine environment selection were source-inspected but are outside Alpha's local extension contract and were not assigned a missing-feature penalty.
- No claim is made that prompt similarity proves model task quality. No live provider run, real VS Code host run, upstream Rust suite, benchmark, or full repository typecheck was executed by this reviewer. No application code changed, so release/host gates were not newly triggered by this artifact.

## Verification executed

Both commands completed successfully using the existing installation and `--maxWorkers=1`:

```powershell
pnpm --dir src test core/prompts/sections/__tests__/custom-instructions-project-discovery.spec.ts core/prompts/sections/__tests__/custom-instructions-configured-project-discovery.spec.ts core/prompts/sections/__tests__/custom-instructions-read-failures.spec.ts core/prompts/sections/__tests__/skills.catalog-budget.spec.ts services/skills/__tests__/SkillsManager.explicit-selection.spec.ts core/mentions/__tests__/explicit-skills.spec.ts core/prompts/__tests__/inherited-instructions.spec.ts core/agent/__tests__/AgentStepContextBuilder.spec.ts --maxWorkers=1
# 8 files, 60 tests passed; Vitest duration 26.76 s

pnpm --dir src test core/prompts/__tests__/system-prompt.spec.ts core/prompts/__tests__/codex-runtime-instructions.spec.ts core/environment/__tests__/EnvironmentContext.spec.ts services/skills/__tests__/SkillsManager.nested-discovery.spec.ts services/skills/__tests__/SkillsManager.policy.spec.ts --maxWorkers=1
# 5 files, 113 tests passed; Vitest duration 10.59 s
```

Total: **13 files / 173 tests passed**. A separate in-memory Node/TypeScript AST script compared retained prompt string values to upstream catalog values using SHA-256; six current matching slugs were byte-identical. No generated fixtures or snapshots were updated.
