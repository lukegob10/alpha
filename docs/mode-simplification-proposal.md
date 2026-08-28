# Mode Simplification Proposal

> **Status:** Superseded by the Plan/Code implementation. The normal product surface now exposes only Plan and Code; legacy modes and custom-mode data remain available solely for compatibility with existing tasks and configurations.

## Question

Does it make sense to keep all current user-facing modes, or should the product simplify them?

## Short Answer

Yes, modes still make sense, but not all current modes need to remain visible as separate user choices.

The strongest model is:

- Keep **Ask** as a protected read-only mode.
- Keep **Debug** as a specialized troubleshooting mode.
- Rename **Architect** to **Plan** and make its purpose clearer.
- Compress **Code** and **Orchestrator** into one implementation flow.
- Treat orchestration as behavior inside the agent, not as a mode users must manually choose.

## Why Simplify

The current mode set creates useful boundaries, but it also asks users to understand too much internal workflow.

The main issue is not that the capabilities are wrong. The issue is that some capabilities are exposed as separate modes when they may work better as automatic behavior.

- **Ask** is clear because it answers without editing.
- **Debug** is clear because diagnosis often needs a different posture.
- **Architect** is conceptually useful, but the name feels heavier than the actual user need.
- **Code** and **Orchestrator** overlap because real implementation work often needs both execution and task breakdown.

## Recommended Mode Set

### Ask

Purpose:

- Answer questions.
- Explain code.
- Investigate without modifying files.
- Give the user confidence that no edits will happen.

Why keep it:

- The read-only boundary is valuable.
- It supports low-risk exploration.
- It creates trust when the user wants analysis, not action.

Expected behavior:

- Read files and inspect context.
- Provide concise explanations or recommendations.
- Avoid edits unless the user explicitly moves into an implementation-capable flow.

### Plan

Purpose:

- Replace **Architect** with a clearer planning mode.
- Produce implementation plans, design options, tradeoffs, and task breakdowns.
- Stay focused on what should happen before execution.

Why rename Architect:

- "Architect" can sound broader and more formal than needed.
- "Plan" describes the user intent directly.
- It makes the mode easier to understand for everyday tasks.

Expected behavior:

- Gather context.
- Ask clarifying questions when necessary.
- Produce short, actionable plans.
- Avoid long documents unless the user asks for one.
- Hand off naturally into implementation when the user approves.

### Debug

Purpose:

- Diagnose failures, regressions, broken workflows, failing tests, and unclear runtime behavior.

Why keep it:

- Debugging benefits from a specific process.
- It should prioritize reproduction, evidence, logs, and root-cause analysis.
- It is different enough from normal feature work to justify a visible mode.

Expected behavior:

- Investigate before changing code.
- Narrow likely causes.
- Validate assumptions with logs, tests, or targeted inspection.
- Fix only after the diagnosis is clear enough.

### Build

Purpose:

- Replace the visible split between **Code** and **Orchestrator**.
- Act as the normal implementation mode.
- Decide internally whether to execute directly or break work into subtasks.

Why compress Code and Orchestrator:

- Most coding tasks need some amount of orchestration.
- Users should not have to decide whether a task is "code" or "orchestration."
- The agent can make that decision based on task size, risk, and complexity.
- This avoids users getting stuck in a coordinator mode that cannot directly execute normal work.

Expected behavior:

- For small tasks, inspect, edit, verify, and finish directly.
- For larger tasks, create a plan and split work into subtasks.
- Use specialized workers only when parallelism or separation improves the outcome.
- Keep the user informed without exposing unnecessary internal complexity.

## What Happens To Orchestrator

The orchestration capability should not disappear.

It should move from a user-facing mode to an internal execution strategy.

In practice:

- The agent starts in **Build** for implementation work.
- It evaluates whether the request is simple, medium, or complex.
- It executes directly when the task is straightforward.
- It delegates or stages subtasks when the task is broad, risky, or naturally parallel.
- It synthesizes results before final response.

This keeps the useful part of Orchestrator while removing the need for users to pick it manually.

## Suggested User-Facing Modes

| Mode  | Main Promise                      | Edit Access     | Best For                           |
| ----- | --------------------------------- | --------------- | ---------------------------------- |
| Ask   | Understand without changing files | No              | Questions, explanations, analysis  |
| Plan  | Decide what should be done        | Limited or none | Specs, approach, task breakdown    |
| Debug | Diagnose and fix issues           | Yes             | Failures, regressions, test errors |
| Build | Implement work end to end         | Yes             | Features, refactors, normal coding |

## Decision Rules

The product can guide mode choice with simple rules:

- Use **Ask** when the user asks "what," "why," or "how" and does not ask for changes.
- Use **Plan** when the user wants a proposal, design, or staged approach before implementation.
- Use **Debug** when the user reports something broken.
- Use **Build** when the user wants code changed, files created, or work completed.

Inside **Build**:

- Execute directly if the change is small and well-scoped.
- Plan first if the task touches many files or has unclear requirements.
- Delegate subtasks if work can be split without creating coordination overhead.
- Ask for clarification only when a reasonable assumption would be risky.

## Product Benefits

- Fewer choices for users.
- Clearer trust boundary around read-only work.
- Less confusion between planning, coding, and coordinating.
- Better default behavior for real implementation tasks.
- Orchestration becomes a strength of the agent instead of another mode to understand.

## Risks

- Removing visible Orchestrator may feel like a loss of power for advanced users.
- Build mode must be good at explaining when it is delegating or staging work.
- Plan mode needs strict output discipline so it does not produce overly long documents.
- Debug mode must avoid becoming just Build with extra wording.

## Recommendation

Move toward four visible modes:

- **Ask**
- **Plan**
- **Debug**
- **Build**

Keep orchestration as an internal capability of **Build**.

This preserves the real value of the existing system while reducing mode clutter. The product should feel less like users are choosing between agent internals and more like they are choosing the level of permission and intent they want for the current task.
