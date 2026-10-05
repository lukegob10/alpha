# Coding agent harness features worth building in Alpha

Research date: October 5, 2026

**The three strongest capabilities in this evaluation are a project knowledge engine, an automated verification engine, and a
runtime debugging engine.** Each gives the agent a substantial capability with durable state and feedback, much as
Alpha Tickets gives it durable work records. These are product systems that could support an entire development workflow.

**For Alpha, automated verification is already a substantial existing capability.** Its completion hooks, declared
acceptance checks, and content-bound execution evidence implement much of item 2. Treat that item as an existing strength
with possible application-level extensions, rather than a missing engine or an equally novel feature to build.

This is a source-based feature evaluation covering **36 product and harness profiles**, eight complementary integrations,
named developers' accounts, community feedback, and Alpha's current code. It is not an executed performance comparison of
those products. The ranking is an assessment of practical value and fit for Alpha; proposed gains still need measurement.
Steering, diff viewers, undo, chat controls, model selection, pricing tiers, and enterprise administration are outside the
top ten. Paid products supply ideas, but the proposed capabilities do not depend on copying a paid tier or exclusive model.

## The top three

| Priority | Substantial capability                  | Why explore it first                                                                                                                                                                              |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | **Project knowledge and memory**        | Give every task access to the project's architecture, relevant code, decisions, working procedures, and lessons from previous work. Reduce repeated discovery and repeated mistakes.              |
| 2        | **Automated verification**              | Give the agent a reliable way to reproduce a problem, test its changes, exercise the application, and produce evidence of the result. Reduce human checking and false completion.                 |
| 3        | **Runtime debugging and investigation** | Connect errors, logs, traces, application state, and source code so the agent can investigate what actually happened and verify a repair. Reduce the developer's role as a copy-and-paste bridge. |

The shared design idea is to externalize something useful beyond the conversation. Tickets externalize work; knowledge
records externalize understanding; verification records externalize evidence; investigations externalize observations
and hypotheses. **Our hypothesis:** those systems can improve task quality and efficiency by reducing rediscovery,
guessing, and manual intervention. A ticket engine alone does not establish that these other systems will improve speed.

## The top ten

The order weighs repeated developer needs, documented implementations, professional usefulness, side-project usefulness,
and fit with Alpha's existing foundations. It is not a market-share or benchmark ranking. The objects below are proposals.

| Rank | Feature                                              | What the native system would maintain                                                       | Everyday developer payoff                                                                          |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1    | **Project knowledge engine**                         | Code relationships, architecture notes, decisions, verified memories, and source provenance | The agent understands where a change belongs and remembers why the project works that way.         |
| 2    | **Verification engine**                              | Reproductions, test plans, runs, browser journeys, and evidence tied to a code revision     | Ask for working behavior and inspect the evidence without supervising every check.                 |
| 3    | **Runtime debugging engine**                         | Incident timelines, observations, hypotheses, traces, and reproductions                     | Investigate a real failure using application evidence rather than guessing from a screenshot.      |
| 4    | **Reusable workflow engine**                         | Versioned playbooks, inputs, execution stages, run history, and learned improvements        | Teach a process once and reuse it for CI repair, releases, audits, documentation, and maintenance. |
| 5    | **Specification and architecture system**            | Requirements, acceptance criteria, design decisions, dependencies, and coverage             | Keep a large implementation aligned with what the user intended as the project evolves.            |
| 6    | **Project orchestration system**                     | Work packages, agent assignments, dependency state, budgets, and integration evidence       | Delegate a substantial project while preserving ownership and a coherent final result.             |
| 7    | **Visual development and design system integration** | Design references, component mappings, UI journeys, and visual acceptance evidence          | Build interfaces that fit the actual product and check them in a running browser.                  |
| 8    | **Continuous code review and PR delivery**           | Review findings, CI failures, remediation state, and review evidence                        | Move a change through review and validation with less repetitive human coordination.               |
| 9    | **Codebase modernization campaigns**                 | Migration inventories, transformation rules, batches, exceptions, and aggregate validation  | Upgrade a framework or remove a deprecated API across a large project systematically.              |
| 10   | **Development environment engine**                   | Setup recipes, toolchains, service state, fixtures, ports, and environment health           | Make the project runnable and testable consistently, including in isolated agent workspaces.       |

## What developers actually value

There is good evidence for practical needs, but substantially less evidence that any specific complete engine is
universally indispensable. Product documentation establishes capabilities. Firsthand accounts establish individual
preferences. Community posts provide useful leads, with unverified demographics and substantial selection bias.

| Evidence                                                                                                                                                   | What the source establishes                                                                                                                                                                                                                  | Implication for Alpha                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Mitchell Hashimoto's adoption account](https://mitchellh.com/writing/my-ai-adoption-journey), February 2026                                               | He describes becoming unwilling to return to his old workflow after delegating suitable work. Fast verification tools and project instructions are central to his approach. He also reports preferring one background agent for normal work. | Prioritize successful delegation and verification. More agents should be an optional capability, not the definition of progress.                         |
| [Simon Willison on red/green TDD](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/)                                            | He recommends demonstrating a failing test before implementation, then confirming the fix, to catch ineffective or unnecessary generated code.                                                                                               | A verification system should preserve evidence of the failure and the repair.                                                                            |
| [Armin Ronacher's agentic coding recommendations](https://lucumr.pocoo.org/2025/6/12/agentic-coding/), June 2025                                           | His practical workflow gives agents usable commands, logs, and browser access, including enough runtime information to exercise a sign-in flow.                                                                                              | Runtime visibility and reliable execution procedures can remove recurring human assistance.                                                              |
| [Mario Zechner's Pi account](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), November 2025                                                     | He values control over context, inspectable execution, and tools loaded when needed. He also explicitly rejects much built-in orchestration for his own workflow.                                                                            | Large capabilities should be optional and discoverable. Shipping more systems does not itself improve the harness.                                       |
| [Community discussion of indispensable MCP servers](https://www.reddit.com/r/mcp/comments/1njy19g/any_mcp_server_you_cannot_live_without/), September 2025 | Users nominate current documentation, GitHub, browser testing, databases, and memory tools. Other users report context overhead and prefer direct commands or saved documentation.                                                           | Investigate those workflow needs while measuring integration overhead. This is anecdotal feedback, not a representative professional or hobbyist survey. |
| [Stack Overflow's 2025 AI survey](https://survey.stackoverflow.co/2025/ai)                                                                                 | Respondents report substantial frustration with nearly correct outputs and extra debugging work. The survey does not rank the ten proposed systems.                                                                                          | Correctness, context, and verification deserve more weight than feature count.                                                                           |

The older accounts above support workflow needs, not October 2026 product availability. Current capability checks are
linked below. The [February 2026 METR update](https://metr.org/blog/2026-02-24-uplift-update/) also matters: it explains why
selection effects make its follow-up productivity estimates unreliable. Neither enthusiastic adoption nor an older
slowdown result proves the performance of today's harnesses. Measure Alpha's changes directly.

## What each feature could become

### 1 Project knowledge engine

Combine understanding of current code with durable knowledge of the project: symbol relationships, service boundaries,
architecture decisions, recurring failure patterns, and known working commands. Documented precedents include
[Augment's Context Engine](https://www.augmentcode.com/context-engine), [Aider's repository map](https://aider.chat/docs/repomap.html),
[Claude Code's memory](https://code.claude.com/docs/en/memory), and [Devin Knowledge](https://docs.devin.ai/product-guides/knowledge).
These sources establish different parts of the capability, not equivalent implementations.

**Alpha proposal:** build a browsable, queryable knowledge system over the existing index and persistence foundations.
Every retained fact has a source, scope, and freshness condition. Derived code facts refresh when code changes; learned
decisions remain distinguishable from explicit user instructions. Example: a professional asks for a payment change and
gets the relevant cross-service flow; a hobbyist returns after a month and resumes with the important decisions intact.

**Measure:** correct file and dependency discovery, repeated corrections, irrelevant context, and stale-memory errors.
Confidence is strong for the underlying context need and moderate for this complete proposed system.

### 2 Verification engine

Professional developers repeatedly value agents that can check their own work. Willison's TDD guidance and Hashimoto's
account support that need. [OpenCode feeds language-server diagnostics back to its agent](https://opencode.ai/docs/lsp/),
while [Lovable documents browser, frontend, and backend verification](https://docs.lovable.dev/features/agent-mode).
The latter also says most verification tools run when requested; tool availability does not guarantee automatic coverage.

**Already in Alpha:** configured [Stop and SubagentStop hooks](../src/core/agent/CompletionHooks.ts) run at completion
and can return feedback that sends the agent back into the loop. The
[task working record](../src/core/agent/TaskWorkContext.ts) already maintains declared acceptance checks and execution
receipts, matches commands and working directories, and rechecks declared input bytes. Both ordinary final answers and
`attempt_completion` use the [shared completion gate](../src/core/task/Task.ts), which rejects missing, failed, or stale
declared acceptance evidence for applicable work. These are implemented capabilities, not a new feature proposal.

The boundary matters: hooks are optional user configuration, and a successful process does not establish meaningful
test coverage. Ordinary changes do not automatically require an inferred test campaign, and optional Worker process
evidence is advisory once review and effect settlement are resolved; see
[ParentVerification](../src/core/agent/ParentVerification.ts). Existing browser tools and test commands can already
exercise application behavior.

**Remaining candidate:** make relevant application checks easier to select, maintain, and reuse, including substantive
browser journeys and failure-before/fix-after evidence. A professional could inspect a regression's reproduction and
repair; a hobbyist could verify login, saving, and reload. Establish a concrete gap in the existing workflow before
adding structure, and extend the current loop and evidence records. Much of the original proposal is already present,
so item 2 should receive less weight when choosing a new Alpha feature.

**Measure:** false completion, missed regressions, human checking time, and total time to an accepted change. Keep checks
proportional to the work; a prose edit should not trigger a large test campaign. Demand confidence: strong.

### 3 Runtime debugging engine

Ronacher's workflow illustrates the value of logs plus a running application. The
[Sentry MCP server](https://mcp.sentry.dev/) exposes error search, performance investigation, and triage to assistants.
[Devin's documented use cases](https://cognitionai.mintlify.app/enterprise/use-cases/menu) include investigation with
production logs and database context. These establish possible inputs and workflows, not independently measured repairs.

**Alpha proposal:** give an investigation its own durable timeline of observed facts, competing explanations, experiments,
and remaining uncertainty. Connect a stack trace to source, inspect relevant runtime evidence, produce a local
reproduction, and verify a repair. Professionals gain an incident investigation workflow; hobbyists can use local server
logs and browser errors without adopting an observability service.

**Measure:** time to a valid reproduction, correct root-cause identification, unnecessary edits, and human information
handoffs. Keep application investigation separate from Alpha's own harness diagnostics. Need confidence: strong;
confidence in the full automated system: moderate.

### 4 Reusable workflow engine

[Codex skills](https://learn.chatgpt.com/use-cases/reusable-codex-skills),
[Claude Code skills](https://code.claude.com/docs/en/skills), and
[Devin playbooks](https://docs.devin.ai/product-guides/creating-playbooks) package repeatable development procedures.
They vary in execution semantics. A reusable prompt alone does not establish a resumable workflow engine.

**Alpha proposal:** extend skills and scheduled tasks with explicit inputs, stages, reusable scripts, execution receipts,
and resumable runs. A successful CI repair could become a maintained procedure that gathers logs, applies a bounded fix,
checks it, and prepares the review result. Professionals can standardize team maintenance; hobbyists can automate their
own build, release, backup, and documentation routines.

**Measure:** repeated-task success, human interventions, recovery after interruption, and instruction overhead. Learn
improvements through reviewable updates to the procedure, not silent changes to execution authority. Demand confidence:
strong for reusable procedures; moderate for the additional engine semantics.

### 5 Specification and architecture system

[Kiro Specs](https://kiro.dev/docs/specs/) formalizes requirements, design, and implementation tasks.
[Qoder Quest](https://docs.qoder.com/user-guide/quest/overview) also documents specification-oriented development and
project knowledge. These are substantial product precedents; their documentation alone does not establish broad demand
for specification-first development on every task.

**Alpha proposal:** maintain a living requirement and design record with acceptance criteria and links to implemented
behavior and validation. When requirements change, show the affected assumptions and work. Tickets can reference this
record while continuing to own the work items. Professionals gain continuity across a large feature; hobbyists gain help
turning a vague app idea into a coherent product.

**Measure:** omitted requirements, conflicting decisions, change-request rework, and unnecessary planning overhead.
Demand confidence: moderate. Most useful for ambiguous or substantial work; small fixes should remain lightweight.

### 6 Project orchestration system

[Cursor worktrees](https://cursor.com/docs/configuration/worktrees),
[Cline Kanban](https://docs.cline.bot/cline-overview), and
[Warp's agent orchestration](https://www.warp.dev/blog/oz-orchestration-platform-cloud-agents) document isolated or
coordinated agent work. Hashimoto's preference for one normal background worker is useful counterevidence to treating
larger swarms as a universal need.

**Alpha proposal:** evolve the existing managed-agent system into project execution with scoped work packages,
dependencies, bounded budgets, workspace ownership, and explicit integration verification. The valuable outcome is an
integrated project, not a screen containing many running agents. Professionals could delegate separable migration or
full-stack work; hobbyists could delegate an optional research or testing task while keeping their main task simple.

**Measure:** accepted integrated work per unit of human time and cost, conflict rate, duplicate work, and cancellation
recovery. Alpha already has delegation and worktrees; this is a maturity opportunity. Demand confidence: moderate.

### 7 Visual development and design system integration

[Figma's MCP documentation](https://developers.figma.com/docs/figma-mcp-server/) exposes structured design context and
component mappings. [Cursor's browser tools](https://prod.cursor.com/docs/agent/tools/browser) support application testing,
design implementation, and visual inspection. [Antigravity](https://www.antigravity.google/docs/ide/overview/) also
integrates editor, terminal, and browser work.

**Alpha proposal:** connect design references to the project's real components and theme tokens, implement the interface,
and verify representative states and responsive layouts in the browser. Maintain the design-to-component relationship
for future changes. Professionals gain consistency with a shared design system; hobbyists can start from screenshots
or a local style guide. Figma access should be an optional input.

**Measure:** visual acceptance, component reuse, accessibility failures, and manual correction rounds. This is a complete
UI engineering workflow extending Alpha's browser and HTML capabilities. Demand confidence: strong within frontend work.

### 8 Continuous code review and PR delivery

[GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
documents review with project guidance and agent capabilities. [Devin Review](https://cognition.com/blog/devin-review)
focuses on understanding and reviewing larger changes. Hashimoto also describes useful delegated issue and PR triage.

**Alpha proposal:** maintain findings through investigation, repair, validation, and reviewer disposition. Combine
repository-wide context, CI evidence, and explicit review criteria; detect duplicates and retire findings when the
underlying code changes. Professionals can reduce repetitive review coordination; solo developers can obtain a separate
review pass before publishing a project.

**Measure:** useful findings accepted by developers, false positives, escaped defects, review time, and remediation
success. Treat review output as evidence for a developer's decision; merge authority remains separately controlled.
Demand confidence: strong for review assistance, moderate for full delivery automation.

### 9 Codebase modernization campaigns

[Amazon Q's Java transformation workflow](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/transform-java.html)
creates a transformation plan and rebuilds and runs tests during an upgrade. Devin's documented migration examples
include phased framework and database changes. These are precedents for an organized campaign rather than an enormous
single conversation.

**Alpha proposal:** inventory affected code, establish transformation rules, trial a small batch, process bounded batches,
track exceptions, and verify the combined result. Prefer deterministic transformations where possible, using the agent
for ambiguous cases. Professionals can upgrade APIs across services; hobbyists can modernize an older project without
losing track of partial progress.

**Measure:** correctly transformed sites, missed references, exception workload, regression rate, and campaign cost.
Use existing tickets, skills, delegation, and verification as the foundation. Demand confidence: moderate overall,
high relevance for developers facing substantial migrations.

### 10 Development environment engine

[Devin environment setup](https://docs.devin.ai/onboard-devin/environment) makes repositories, dependencies, and tools
available at session startup. [Amp's orbs](https://ampcode.com/docs) provide an environment per thread.
[Development Containers](https://containers.dev/) and [Dagger](https://docs.dagger.io/getting-started/introduction/)
provide established approaches to reproducible development and execution.

**Alpha proposal:** understand and operate a project's approved setup recipe: prepare an isolated workspace, start its
services, expose health and logs, supply test fixtures, and clean up owned resources. Reuse a healthy setup when its
inputs have not changed. Professionals gain consistent agent workspaces; hobbyists gain help running a multi-service
project without repeatedly diagnosing its setup.

**Measure:** successful cold starts, setup time, reproducibility, leaked processes, and environment-related task failures.
Extend Alpha's execution protections and adapters; this does not propose adopting Codex CLI's sandbox architecture.
Demand confidence: moderate, with strong practical relevance to projects that are difficult to run.

## Existing Alpha foundations

These observations come from current source inspection, not the existence of older design documents. The proposals above
extend these foundations; they should not introduce competing runtimes or duplicate stores for the same authoritative state.

| Existing foundation                                                                 | Source inspected                                                                                                                                                                                          | Opportunity to extend it                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native tickets with context, success criteria, revisions, hierarchy, and task links | [Ticket schema](../packages/types/src/ticket.ts), [TicketStore](../src/services/tickets/TicketStore.ts)                                                                                                   | Link knowledge, specifications, investigations, and verification to existing work records. A general dependency graph is a proposal, not a claim about the current ticket schema. |
| Semantic and lexical code retrieval with source validation                          | [Index search](../src/services/code-index/search-service.ts)                                                                                                                                              | Add code relationships and curated project knowledge while preserving freshness checks.                                                                                           |
| Verification obligations, content fingerprints, and completion hooks                | [AgentControlStore](../src/core/agent/AgentControlStore.ts), [VerificationScope](../src/core/agent/VerificationScope.ts), [CompletionHooks](../src/core/agent/CompletionHooks.ts)                         | Build richer test and application verification over existing completion invariants.                                                                                               |
| Bounded delegation and managed worktrees                                            | [Delegation manager](../src/core/agent/BoundedDelegationManager.ts), [Managed worktrees](../packages/core/src/worktree/managed-subagent-worktree.ts)                                                      | Improve project coordination, integration, and environment preparation.                                                                                                           |
| Skills, scheduled execution, and browser adapters                                   | [SkillsManager](../src/services/skills/SkillsManager.ts), [ScheduledTaskService](../src/services/scheduled-tasks/ScheduledTaskService.ts), [Browser tools](../src/services/browser/VSCodeBrowserTools.ts) | Add maintained procedures and richer visual verification through those same surfaces.                                                                                             |
| Redacted evidence about Alpha's own execution                                       | [Diagnostic evidence tool](../src/core/tools/ReadDiagnosticEvidenceTool.ts)                                                                                                                               | Preserve harness diagnostics and add application investigation as a distinct capability.                                                                                          |

The inspected modules do not establish complete implementations of all ten proposed systems. This is an opportunity map,
not an exhaustive absence audit or certification of existing behavior.

## Platforms reviewed

The capability column describes documented features. The value column is **our assessment of the developer need they
serve**, not a claim that surveyed users named that product indispensable. Coverage includes related product surfaces,
editor hosts, and research harnesses; the 36 entries are not 36 independent companies or directly comparable benchmarks.

### Major agent products and IDE systems

| Product or harness                                                                                 | Documented system worth studying                                                                                                                              | Developer value to investigate                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Codex](https://learn.chatgpt.com/use-cases/reusable-codex-skills)                                 | Reusable skills; [isolated worktree tasks](https://learn.chatgpt.com/docs/environments/git-worktrees)                                                         | Repeatable work and background delegation.                                                                                    |
| [Claude Code](https://code.claude.com/docs/en/memory)                                              | Project instructions and auto memory; [skills](https://code.claude.com/docs/en/skills)                                                                        | Project continuity and reusable expertise.                                                                                    |
| [Cursor](https://prod.cursor.com/docs/agent/tools/browser)                                         | Browser development and testing; [agent worktrees](https://cursor.com/docs/configuration/worktrees)                                                           | A running-app feedback loop and isolated work.                                                                                |
| [Devin cloud](https://docs.devin.ai/product-guides/knowledge)                                      | Knowledge, [playbooks](https://docs.devin.ai/product-guides/creating-playbooks), and [prepared environments](https://docs.devin.ai/onboard-devin/environment) | Repeatable delegation with project context.                                                                                   |
| [Devin Desktop and legacy Windsurf Cascade](https://docs.devin.ai/desktop/cascade/memories)        | Cascade memories, rules, and workflow customization                                                                                                           | Learning what durable knowledge must preserve through product transitions.                                                    |
| [GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) | Cloud implementation tasks and [agentic code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)     | Background changes integrated with PR workflows.                                                                              |
| [Google Antigravity](https://www.antigravity.google/docs/ide/overview/)                            | Asynchronous agents, browser work, and verification artifacts                                                                                                 | Coordination and application-level evidence.                                                                                  |
| [Augment and Auggie](https://www.augmentcode.com/context-engine)                                   | Context retrieval across code and project information                                                                                                         | Understanding an existing codebase with less discovery.                                                                       |
| [Factory Droid](https://docs.factory.com/)                                                         | Coding sessions and automation for review, QA, and documentation                                                                                              | Repeated engineering workflows across repositories.                                                                           |
| [Kiro](https://kiro.dev/docs/specs/)                                                               | Feature and bugfix specifications, designs, and tasks                                                                                                         | Coherent implementation of substantial requirements.                                                                          |
| [JetBrains Junie](https://junie.jetbrains.com/docs/junie-ide-plugin.html)                          | IDE-integrated coding tasks and project guidelines                                                                                                            | Agent work inside an established professional IDE.                                                                            |
| [Qoder](https://docs.qoder.com/user-guide/quest/overview)                                          | Quest, expert collaboration, Repo Wiki, knowledge cards, and memory                                                                                           | Project knowledge plus longer delegated tasks.                                                                                |
| [TRAE and SOLO](https://www.trae.ai/blog/new_solo_beta_0331)                                       | Agent work across product development; IDE and standalone surfaces                                                                                            | Connected product work beyond code generation. Publicly readable capability evidence; access and reliability were not tested. |
| [Zed](https://zed.dev/docs/ai/overview)                                                            | Native agent, skills, MCP, and external agents through ACP                                                                                                    | Integration of agents into an editor workflow.                                                                                |

### Terminal agents and extensible local harnesses

| Product or harness                                                                   | Documented system worth studying                                   | Developer value to investigate                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [Gemini CLI](https://geminicli.com/docs/)                                            | Skills, extensions, hooks, project context, and automation         | A configurable terminal workflow. Experimental features should be evaluated separately. |
| [Amp](https://ampcode.com/docs)                                                      | Local CLI and per-thread cloud environments called orbs            | Delegate work into a prepared environment.                                              |
| [Aider](https://aider.chat/docs/repomap.html)                                        | Repository maps containing important symbols and signatures        | Codebase context without reading every file.                                            |
| [Cline](https://docs.cline.bot/cline-overview)                                       | Shared agent core and Kanban tasks with worktrees and dependencies | Extensible local work and coordinated task execution.                                   |
| [Roo Code](https://docs.roocode.com/)                                                | Model-neutral tools, MCP, and orchestrated task delegation         | Adaptation to different development workflows.                                          |
| [Kilo](https://kilo.ai/docs)                                                         | Coding agents, automation, review, and integrations                | A broader engineering workflow around agent execution.                                  |
| [OpenCode](https://opencode.ai/docs/lsp/)                                            | Language-server diagnostics used as agent feedback                 | Fast feedback from the development toolchain.                                           |
| [Goose](https://github.com/aaif-goose/goose)                                         | Local desktop, CLI, API, and extensible tools                      | Reusable automation beyond a single coding interface.                                   |
| [Continue](https://docs.continue.dev/)                                               | Custom code agents, model configuration, rules, and tools          | Tailored agent workflows in existing editors.                                           |
| [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) | Minimal core extended through skills, tools, packages, and SDK     | A small harness that developers can adapt. Built-in subagents are deliberately omitted. |
| [Crush](https://github.com/charmbracelet/crush)                                      | Terminal coding, multiple providers, LSP, and MCP                  | Extensible terminal development with toolchain context.                                 |
| [Warp and Oz](https://www.warp.dev/blog/oz-orchestration-platform-cloud-agents)      | Coordinated cloud agents and repeatable automation                 | Scaling background engineering procedures.                                              |

### Cloud development and app building

| Product or harness                                                                                 | Documented system worth studying                                          | Developer value to investigate                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Jules](https://jules.google/docs/)                                                                | Asynchronous GitHub-connected development tasks                           | Delegate contained work without blocking local development.                 |
| [OpenHands](https://docs.openhands.dev/overview/introduction)                                      | Agent SDK, execution servers, workspaces, and Agent Canvas                | Customizable development automation with persistent control.                |
| [Ona](https://ona.com/stories/gitpod-is-now-ona)                                                   | Software engineering agents with prepared cloud workspaces and IDE access | A runnable environment for delegated development.                           |
| [Replit Agent](https://docs.replit.com/features/agent/overview)                                    | Project setup, implementation, infrastructure, testing, and deployment    | A complete path from idea to running project, especially for solo builders. |
| [Bolt](https://support.bolt.new/building/intro-bolt)                                               | App generation with integrated database, authentication, and hosting      | Remove setup friction for a working full-stack prototype.                   |
| [Lovable](https://docs.lovable.dev/features/agent-mode)                                            | App implementation and browser, frontend, and backend verification tools  | Iterate on an application with direct execution feedback.                   |
| [Amazon Q Developer](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/transform-java.html) | Planned Java transformation with rebuilds and test execution              | Structured modernization of existing applications.                          |

### Research and programmable reference harnesses

| Harness                                                       | Documented system worth studying                                        | Developer value to investigate                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent)           | Configurable issue-solving agent and evaluation trajectories            | Historical reference for tool interfaces and reproducible evaluation. Its maintainers recommend mini-SWE-agent going forward. |
| [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) | Small, inspectable shell-based agent and evaluation support             | Establish what a simple baseline can accomplish before adding systems.                                                        |
| [Open SWE](https://github.com/langchain-ai/open-swe)          | Asynchronous coding with engineering integrations and durable execution | Study reliable integration of agents into team workflows.                                                                     |

Current naming matters. Windsurf documentation now redirects to Devin Desktop; its documentation explicitly limits
auto memories to legacy Cascade and says the default Devin Local agent does not persist those memories. Goose's repository
now lives under AAIF. These are recorded as observed transitions, not treated as independent new products.

## Useful integrations beyond ticketing

These tools expose the needs an integrated Alpha system could serve. They are not all proven necessities, and an MCP
installation alone does not supply the durable objects, execution semantics, or user experience proposed above.

| Integration                                                    | Capability it supplies                                            | Natural Alpha system                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Serena](https://github.com/oraios/serena)                     | Symbol-aware code retrieval, references, editing, and refactoring | Project knowledge and modernization. Its agent-generated testimonials are not human demand evidence.                   |
| [Context7](https://context7.com/docs/overview)                 | Version-specific library documentation                            | Project knowledge with explicit dependency versions and freshness.                                                     |
| [Playwright](https://github.com/microsoft/playwright-mcp)      | Browser automation and structured application inspection          | Verification and visual development. Its current README also suggests CLI plus skills for some coding-agent workloads. |
| [Sentry](https://mcp.sentry.dev/)                              | Application errors, performance evidence, and issue investigation | Runtime debugging.                                                                                                     |
| [Figma](https://developers.figma.com/docs/figma-mcp-server/)   | Design context and mappings to real components                    | Visual development and design consistency.                                                                             |
| [GitHub CLI](https://cli.github.com/manual/gh_pr)              | PR investigation and delivery operations                          | Review and reusable engineering workflows.                                                                             |
| [DBHub](https://github.com/bytebase/dbhub)                     | Database exploration through a small MCP surface                  | Runtime investigation and environment validation.                                                                      |
| [Dagger](https://docs.dagger.io/getting-started/introduction/) | Portable, cached execution pipelines and service environments     | Verification and reproducible development environments.                                                                |

For professionals, the most useful connections often reach code, CI, runtime evidence, and team design conventions. For
hobbyists, local equivalents matter: project files, terminal logs, a local database, browser testing, and a saved style
guide can support the same workflows. Those audience mappings are our assessment, not measured adoption statistics.

## A focused evaluation for Alpha

Start with the first three systems. Establish a baseline using today's shared harness, then compare one added capability
at a time. Keep the repository fixture, model, provider settings, task scope, and cache conditions fixed. Repeat paired
runs and include human review time, rather than reporting only model time or generated lines of code. A minimum pilot of
five paired runs per scenario is a proposed starting point, not enough by itself to establish a general performance claim.

| Scenario                                                           | What it tests                                                    | Primary evidence                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Resume an unfamiliar project after a context reset                 | Project knowledge and memory                                     | Correct decisions retained; current source found; repeated human explanations.            |
| Change an API across modules after a relevant file changed         | Retrieval freshness and relationships                            | Missed callers, stale facts, irrelevant context, and accepted behavior.                   |
| Fix a seeded behavioral regression                                 | Verification                                                     | Correct failing reproduction, passing repair, adjacent regressions, and false completion. |
| Investigate a failure visible only in logs and a browser journey   | Runtime debugging                                                | Valid root cause, reproducibility, verified repair, and human information handoffs.       |
| Implement and verify a responsive UI from a local design reference | Visual development                                               | Design fit, interaction success, accessibility, and correction rounds.                    |
| Execute a multi-module upgrade with an interruption                | Workflows, orchestration, campaigns, and environment preparation | Recovery, conflicts, missed migrations, reproducible checks, and total accepted work.     |

For every scenario record acceptance, wall time, human effort, input/cache/output tokens where observable, retries, tool
calls, and cost where available. Test wrong and expired memories, insufficient evidence, unavailable integrations,
cancellation, and restart as correctness cases. Use deterministic providers for lifecycle assertions; use recorded or
live model runs to assess task quality without conflating those two forms of evidence.

Alpha's integration baseline remains **VS Code 1.125.0**. Any implementation touching lifecycle, browser/host APIs,
persistence, or webviews must pass the repository's exact-host gate and affected-surface checks. These research notes
introduce no extension behavior and make no benchmark improvement claim.

## Source and implementation provenance

Web sources were retrieved October 5, 2026. Capability pages are linked next to the relevant claims; publication dates are
included for older firsthand accounts. Some products were inspected more deeply than others. Public documentation and
readable source were used; private accounts, enterprise deployments, and advertised benchmark results were not tested.

Codex CLI was inspected at upstream commit
[3f1ccb7ceb814e54314826f68d61c892e2f5a48e](https://github.com/openai/codex/commit/3f1ccb7ceb814e54314826f68d61c892e2f5a48e),
including [skill integration](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/core/src/skills.rs),
[skill tests](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/core/tests/suite/skills.rs),
[review execution](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/core/src/tasks/review.rs),
and [review tests](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/core/tests/suite/review.rs).
The inspected tests include skill instruction injection, review isolation from parent history, permission updates, and
review cancellation. They were read, not executed. Desktop worktree behavior is supported separately by official product
documentation and is not inferred from those CLI tests.

Alpha was inspected at HEAD `3240aba5f3205b87e3997b54624d1f5c7a14ec5d` with pre-existing local changes. Source inspection
establishes the listed foundations; it does not certify them. Codex CLI remains the behavioral reference. The ten engines
are optional Alpha product proposals informed by other systems, implemented through Alpha's TypeScript kernel and host
adapters. No parallel runtime, sandbox replacement, new executable mode, or model-controlled authority expansion is proposed.
