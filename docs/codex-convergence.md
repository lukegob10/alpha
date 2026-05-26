# Codex Convergence For Alpha/Roo Code

This document compares Alpha/Roo Code's current prompt and mode architecture with Codex-style agent behavior, then defines a phased path to converge on that behavior without changing runtime code in this branch.

The target is behavioral convergence, not a wholesale rewrite. Alpha/Roo Code already has a capable task loop, native tool schemas, mode-based tool filtering, context condensation, `AGENTS.md` loading, and child-task delegation. The main gap is how those pieces are framed to the model and surfaced to users.

## Reference Points

Primary Codex references:

- OpenAI's agent-loop writeup: <https://openai.com/index/unrolling-the-codex-agent-loop/>
- Codex default base instructions: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md>
- Codex repository: <https://github.com/openai/codex>

Existing Alpha/Roo Code references:

- Current prompt and mode map: `docs/orchestrator-prompt-flow.md`
- Existing simplification proposal: `docs/mode-simplification-proposal.md`
- Prompt assembly: `src/core/prompts/system.ts`
- Mode definitions: `packages/types/src/mode.ts`
- Mode resolution: `src/shared/modes.ts`
- Tool filtering: `src/core/task/build-tools.ts` and `src/core/prompts/tools/filter-tools-for-mode.ts`
- Delegation: `src/core/tools/NewTaskTool.ts`
- Dynamic context: `src/core/environment/getEnvironmentDetails.ts`
- CLI state loop: `apps/cli/docs/AGENT_LOOP.md`

## Current Alpha/Roo Code Flow

Alpha/Roo Code builds the model request from three main layers: the generated system prompt, native tool metadata, and conversation history with dynamic environment details.

The system prompt is assembled in `SYSTEM_PROMPT`. Its current order is:

1. Current mode role definition.
2. Markdown formatting rules.
3. Shared tool-use policy and tool-use guidelines.
4. Capabilities.
5. Full mode list.
6. Skills section.
7. Rules section.
8. System information.
9. Objective.
10. Custom instructions, mode instructions, rule files, ignore rules, and `AGENTS.md`.

Modes are configuration rather than separate engines. Built-in modes live in `DEFAULT_MODES` and include `architect`, `code`, `ask`, `debug`, and `orchestrator`. Custom modes and prompt overrides can replace or extend those definitions. Tool permissions come from mode groups plus always-available tools.

The current Orchestrator mode is intentionally a coordinator. Its `groups` array is empty, so it does not receive normal read, edit, or command capability from mode groups. It relies on always-available tools such as `new_task`, `switch_mode`, `update_todo_list`, and `attempt_completion`. This is clean architecturally, but it makes Orchestrator a poor default for normal implementation work because it cannot directly inspect, edit, run commands, and verify.

Code mode is the primary implementation surface. It has read, edit, command, and MCP groups. In practice, the user experience the product wants is closer to "Code mode with internal orchestration behavior" than "Orchestrator mode that delegates everything to Code."

The CLI is not a separate agent engine. It observes extension messages, tracks state, routes approvals and follow-up answers, and mirrors the extension task loop. That means Codex convergence should focus first on shared prompt and mode behavior rather than CLI-specific branching.

## Codex-Style Behavior

Codex's public architecture emphasizes a single coding-agent posture with strong operating discipline:

- Persist until the task is handled end to end.
- Explore the repository before making assumptions.
- Explain meaningful next actions with concise preambles.
- Use structured plans or checklists for multi-step work.
- Keep edits scoped to the user's request.
- Prefer existing project patterns over invented abstractions.
- Validate with focused tests or checks when available.
- Respect `AGENTS.md` scope and precedence.
- Keep tool definitions as native tool metadata instead of prose prompt catalogs.
- Manage context as the conversation grows.

Codex can still plan, inspect, edit, run commands, and coordinate work. The important product distinction is that orchestration is an execution strategy inside the coding agent, not usually a user-facing mode that blocks direct work.

Alpha/Roo Code already has many of the same primitives:

- Native tool schemas are passed as metadata rather than pasted into the prose prompt.
- `AGENTS.md` and related rules are loaded into the prompt.
- `update_todo_list` exists for plan/checklist state.
- `new_task` exists for delegation.
- Context management and condensation exist.
- The CLI and extension share task state through `clineMessages`.

The convergence work is therefore mostly about prompt posture, mode simplification, diagnostics, and regression coverage.

## Gap Analysis

### Already aligned

- Native tools are separate from prose prompt content.
- Tool availability is mode-filtered and model-aware.
- Project and user instructions are injected into the model context.
- The task loop can run tools, persist conversation history, condense context, and continue.
- Child-task delegation exists through `new_task`.
- Prompt preview already exists through `src/core/webview/generateSystemPrompt.ts`.

### Partially aligned

- Alpha/Roo Code has `AGENTS.md` support, but the model-facing precedence and scope rules are less explicit than Codex's documented instructions.
- Alpha/Roo Code has planning through Architect and `update_todo_list`, but Code mode does not currently carry a strong Codex-like default planning and persistence contract.
- Dynamic `environment_details` is useful, but it includes volatile time, cost, editor, terminal, mode, model, and workspace context. This helps awareness but can weaken prompt cache stability and make behavior harder to reason about.
- Context condensation exists, but prompt/debug surfaces do not make it easy to understand what prompt sections and context items drove behavior.

### Divergent

- The visible mode model makes Orchestrator and Code peers, even though normal coding work needs both implementation and light orchestration.
- Orchestrator mode has no normal execution tools, so users can enter a powerful-sounding mode that cannot directly do common work.
- The mode list is inserted into every generated system prompt, increasing behavioral surface area and encouraging mode switching instead of a single capable implementation posture.
- The current Code role definition is generic. It does not encode enough of the operating discipline that makes Codex feel persistent, scoped, and rigorous.
- Planning behavior is split across Architect and Orchestrator instead of being available as a normal Code-mode behavior when task complexity warrants it.

## Convergence Strategy

Do not rewrite the orchestrator engine first. The fastest and lowest-risk convergence path is to change the model-facing contract before changing runtime architecture.

The first implementation should preserve the existing task loop, provider support, custom modes, and tool permissions. It should make Code or a new Build-like mode behave more like Codex:

- Start from a coding-agent role definition, not a generic software-engineer persona.
- Require repository grounding before non-trivial claims or edits.
- Encourage concise progress updates before grouped tool work.
- Use todo/checklist state for multi-step work.
- Continue through implementation and verification when the user asks for changes.
- Keep edits narrow and avoid unrelated cleanup.
- Treat delegation as optional and bounded, used only when it materially improves large or parallel work.
- Keep Orchestrator available for advanced workflows, but stop presenting it as the normal path for implementation.

## Phased Plan

### Phase 1: Documentation and prompt audit

This branch is Phase 1.

Deliverables:

- Add this convergence report.
- Use the existing prompt-flow and mode-simplification documents as inputs.
- Make no runtime behavior, API, schema, provider, or UI changes.

Outcome:

- The team has a concrete map from Alpha/Roo Code's current architecture to Codex-style behavior.
- Future branches can make prompt changes with clear acceptance criteria.

### Phase 2: Codex-like Code or Build prompt profile

Create a prompt profile that moves Codex-like behavior into the implementation mode.

Recommended default:

- Keep the `code` slug for compatibility.
- Strengthen Code's `roleDefinition` and `customInstructions` rather than adding a new mode first.
- Optionally rename the UI label later from Code to Build if product wants the simplified mode model.

Prompt changes should cover:

- persistence until the user's task is complete,
- repository exploration before assumptions,
- scoped edits,
- progress updates,
- checklist usage for substantial work,
- validation expectations,
- no unrelated fixes,
- delegation only when useful and bounded.

Acceptance criteria:

- Code mode can directly plan, inspect, edit, run commands, and verify.
- Orchestration behavior exists inside Code mode without requiring the user to select Orchestrator.
- Tool permissions for Code remain unchanged.

### Phase 3: Mode visibility and prompt diagnostics

Reduce confusion without removing power.

Recommended direction:

- Keep Ask as read-oriented.
- Rename Architect to Plan in user-facing UI if compatibility allows.
- Keep Debug as diagnosis-oriented.
- Make Code or Build the default implementation mode.
- Move Orchestrator to an advanced or explicit delegation workflow, or keep it visible with clearer copy that it is a coordinator without direct normal tools.

Diagnostics to add:

- Prompt preview should show named sections and source files.
- AGENTS/rules content should preserve source provenance.
- Mode prompt overrides should be visibly distinguishable from built-in defaults.
- Prompt snapshots should make accidental prompt churn obvious.

### Phase 4: Regression coverage

Add tests before deeper behavior changes.

Recommended coverage:

- System prompt snapshots for Code/Build behavior.
- Tool filtering tests proving Code/Build permissions remain stable.
- `AGENTS.md` precedence tests, including nested or subfolder rules if enabled.
- Prompt preview parity tests between extension runtime and webview preview.
- `new_task` tests proving delegation remains valid and isolated.
- Context condensation tests proving summaries do not re-expand condensed history.

## Future Interface Candidates

This branch does not implement new interfaces, but future work may need:

- A Code/Build prompt setting or migration path for users with custom Code prompts.
- A prompt-section tracing format for UI preview and tests.
- A stricter documented precedence model for global instructions, mode instructions, rules, `AGENTS.md`, and direct user instructions.
- A compatibility policy for renaming modes while preserving mode slugs.

## Recommendation

Converge Alpha/Roo Code toward Codex behavior by changing the implementation-mode contract first.

The product should not start with an Orchestrator rewrite. Orchestrator already performs a narrow coordination role, and `new_task` already provides delegation. The main user-facing improvement is to make the normal implementation mode act like a persistent, disciplined coding agent that can plan and coordinate when necessary while still directly doing the work.

The practical next branch after this one should update Code mode's prompt, add prompt snapshots, and verify that tool permissions and custom mode compatibility remain unchanged.
