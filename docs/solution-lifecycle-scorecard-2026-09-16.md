# Solution-lifecycle scorecard

**Date:** 16 September 2026
**Subject:** Alpha Code 2.1.44 release candidate
**Question:** Across the whole work-and-code lifecycle — small edits, single-file scripts, full web applications, design, skills, skill-authored workflows, tickets, PRs, and follow-through — which harness actually gets the job done?

This is a reviewer score of **product shape and public contracts**, not a live solve-rate. It is not SWE-bench, VSC-Bench, or a claim that Alpha beats Copilot on medium coding tasks. Luna file-tools 3/3 and read-evidence 4/4 are tool-contract samples on VS Code 1.136.1, not this score.

**Copilot column** is VS Code Copilot with Agent, Plan, and Agent Skills as documented on 16 September 2026 — not a tools-off Chat box. A Chat session that never uses Plan, Skills, or custom agents is a weaker product than this column.

## Verdict

No harness wins every job. On a weighted “get the work done” index they sit in one band:

| Harness                 | Index / 100 | What it is best at                                                      |
| ----------------------- | ----------: | ----------------------------------------------------------------------- |
| Claude Code             |      **87** | Skills, plan protocol, coding loop, language navigation                 |
| Cursor Agent            |      **86** | Building and editing in the editor, including UI surfaces               |
| **Alpha Code**          |      **84** | Native tickets, Plan/Code policy, follow-through, skill load in VS Code |
| Codex CLI / IDE         |      **84** | Trained `apply_patch`, sandbox, subagents                               |
| Copilot Agent (VS Code) |      **84** | GitHub-native ship, first-party Plan handoff, custom agents             |

Alpha is **not** behind Copilot because it exposes more tools. It is **tied** with Copilot and Codex on the full lifecycle, and **behind** Claude Code and Cursor. It leads the VS Code work-system jobs (ticket → skill → build → PR) and trails the jobs that are “just build the app in the editor” or “GitHub is the tracker.”

A smaller catalog would not raise this index. Removing tickets, GitHub, spawn, or `skill` would **lower** it, because those are how the loop finishes a person’s problem instead of ending after the first patch.

## How the index is built

Weights follow the jobs in the question, not a one-file coder ranking.

| Weight | Job                                                                |
| -----: | ------------------------------------------------------------------ |
|     15 | Multi-file / web-application build                                 |
|     12 | Using skills on a live request                                     |
|     10 | Follow-through (verify, ticket, PR, spawn — not eager to end)      |
|      8 | Small edits and single files (including Python)                    |
|      8 | Surfaces and design artifacts (docs, previews, UI-adjacent output) |
|      8 | Plan / design before mutate                                        |
|      8 | Authoring skill workflows (`SKILL.md`, scripts, iteration)         |
|      6 | Work tracking (tickets / issues / tasks)                           |
|      6 | Ship (commit, PR, GitHub)                                          |
|      6 | Verification (tests, command output)                               |
|      5 | Delegation / sub-agents                                            |
|      5 | Read and search honesty                                            |
|      3 | Policy (who may write, child authority)                            |

Each cell is closeness to the public frontier best on that job (0–100). Internals of Copilot, Cursor, and Claude are partly opaque. Treat ±3 as noise.

## Job scores

| Job                         | Alpha | Copilot | Claude Code | Codex | Cursor | Why Alpha sits there                                                                                                                                                                                                                 |
| --------------------------- | ----: | ------: | ----------: | ----: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Small edits / single file   |    86 |      88 |          90 |    93 |     90 | Luna `apply_patch` is live-sampled. Dual editor (`apply_diff` beside the family tool) still burns first patches. Codex is trained on one format.                                                                                     |
| Multi-file / web app        |    82 |      88 |          90 |    88 |     92 | Same file+command loop as everyone. No medium-task campaign. Cursor’s editor-native loop is the bar. Alpha HTML docs are **not** the running app.                                                                                    |
| Surfaces / design artifacts |    84 |      72 |          78 |    68 |     88 | Real: rich HTML document kit + `rich-documents` skill + in-editor preview. Not a React runtime. Cursor and Claude Artifact are stronger live canvases. Copilot Chat is weaker here.                                                  |
| Plan / design gate          |    78 |      86 |          88 |    85 |     84 | Host-enforced inspect-only Plan is strong. The plan is a `<proposed_plan>` block that dies in chat — Code cannot @mention a durable object. Copilot Plan handoff and Claude `EnterPlanMode` / `ExitPlanMode` are complete protocols. |
| Use skills                  |    86 |      84 |          92 |    88 |     86 | Mode-filtered catalog + `skill` load is first-class and eager. Missed check is still billed as an **error**. Claude invented the Skill tool and still leads. Copilot Agent Skills exist in 2026; they are not unique to Alpha.       |
| Author skill workflows      |    80 |      86 |          88 |    88 |     84 | The model can write `SKILL.md` with file tools. There is no `/create-skill` or bundled skill-creator UX. Copilot `/create-skill`, Codex skill creator, and Claude’s skill-authoring loop are easier.                                 |
| Follow-through              |    88 |      78 |          84 |    80 |     84 | Tickets, `github_api`, spawn, and skills stay eager so the loop can finish. Copilot Agent is still the product most willing to patch and stop.                                                                                       |
| Work tracking               |    90 |      82 |          74 |    68 |     72 | Native project tickets (Markdown store, revision, type, agent tools). Copilot’s tracker is GitHub Issues. Others are todos / Task lists / markdown.                                                                                  |
| Ship / PR                   |    84 |      92 |          82 |    80 |     84 | Native `github_api` is real. Copilot **is** GitHub. `gh` via shell remains the frontier default elsewhere.                                                                                                                           |
| Delegation                  |    86 |      82 |          90 |    90 |     86 | Bounded spawn/delegate; children cannot widen the parent. Claude Agent/Workflow and Codex subagents are more mature product surfaces. Copilot `runSubagent` / custom agents exist.                                                   |
| Verification                |    80 |      84 |          88 |    90 |     86 | `execute_command` + `read_command_output` cover `pnpm test`. No stable wait/stop for servers. Codex unified exec still leads.                                                                                                        |
| Read / search               |    88 |      86 |          93 |    88 |     88 | Honest 32k pages + `Continuation` (16 Sep 2026). Search modes live-sampled. Claude still has LSP + Grep.                                                                                                                             |
| Policy                      |    92 |      86 |          88 |    88 |     84 | Plan cannot mutate. Children cannot widen. Path-scoped command approval is the 2.1.40 contract. This is Alpha’s kernel, not a prompt.                                                                                                |

## What “full spectrum” actually means

These are different jobs. A harness that is best at one is not automatically best at all of them.

| You asked for                                         | Who usually finishes it                  | Alpha’s position                                                                                |
| ----------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fix a function / write one Python file                | Codex, Claude, Cursor                    | Close. Dual editor is the self-inflicted miss.                                                  |
| Build or change a complete web application            | Cursor, then Claude / Copilot            | Capable (files, commands, tests). Not measured. Not the HTML document viewer.                   |
| Design the approach, then build                       | Claude Plan, Copilot Plan                | Design gate is real; the handoff object is not.                                                 |
| Run an existing skill workflow                        | Claude, then Alpha / Codex               | Alpha is built for this if the skill exists. Error-tax on no-match.                             |
| **Create** a skill that becomes a repeatable workflow | Codex / Claude / Copilot `/create-skill` | You can write the files. The product does not specialize in skill authoring.                    |
| Ticket → implement → PR without leaving chat          | **Alpha**                                | This is the job Copilot Chat Agent still under-serves unless GitHub Issues/PRs are the tracker. |
| Split investigation across child agents               | Codex, Claude                            | Alpha’s children are policy-correct. The lifecycle chrome is large.                             |

## Copilot, specifically

Copilot in VS Code (16 Sep 2026 docs) is no longer “a small coding agent with no skills.” It has Agent mode, Plan mode with review-then-handoff, Agent Skills (`SKILL.md`), custom agents (`.agent.md`), subagents, and GitHub as the work system.

Where Copilot still beats Alpha: **shipping on GitHub**, first-party Plan handoff, `/create-skill` / custom-agent UX, host APIs on current VS Code, and medium-task evidence we do not have.

Where Alpha still beats Copilot Chat Agent: **workspace tickets**, **eager follow-through** (ticket + PR + spawn in the same Code turn), **host-enforced Plan that cannot mutate**, **rich HTML documents as a first-class design artifact**, and a skill tool that is part of the default Code surface rather than an optional customization.

If the comparison is “Chat, Agent on, default tools, no skills” — Copilot is a coding closer and Alpha is a work system. If the comparison is “full Copilot 2026” — they are **tied at 84**, with different peaks.

## Other frontier harnesses

- **Claude Code (87):** Widest public lifecycle: `Skill`, `EnterPlanMode` / `ExitPlanMode`, `Agent`, `Workflow`, artifacts, LSP, Task list. The bar for skill-based solution work. Weaker native tickets and GitHub-as-object than Alpha/Copilot.
- **Cursor Agent (86):** Best at building and editing the running project in the editor, including UI. Skills and subagents exist. Work tracking is not a ticket product.
- **Codex (84):** Best small-edit fidelity (`apply_patch` + training), sandbox, subagents, bundled skill creator. Tiny default catalog. Weakest native tickets/surfaces. Follow-through is shell + GitHub, not a work OS.

## What would move Alpha on this index

Do **not** hide tickets, GitHub, spawn, or `skill`. That shrinks the lifecycle.

1. **One family editor on Code** (drop the extra dialect for that model). Raises small-edit and app-build without deleting work tools.
2. **Durable plan object** Code can attach to. Raises design → build.
3. **Skill no-match is proceed, not error.** Raises use-skills.
4. **Skill-authoring loop** (create/revise `SKILL.md` as a product path, not only “write a file”). Raises author-skills.
5. **Command wait/stop** if server workflows stall. Raises verification and web-app work.

Streaming reads, LSP, MCP, and OS sandbox move this index less than those five for this product.

## Sources (retrieved 16 September 2026)

- This tree: Plan/Code in `packages/types/src/mode.ts`; Plan allowlist in `src/core/tools/validateToolUse.ts`; skills in `src/core/prompts/sections/skills.ts` and `SkillTool.ts`; tickets in `docs/alpha-tickets.md`; HTML documents in `docs/html-documents.md` and `src/assets/skills/rich-documents/SKILL.md`; reads in `docs/read-evidence-tests.md`; file tools in `docs/file-tools-live-tests.md`.
- [VS Code Copilot Agent / Plan](https://code.visualstudio.com/docs/agents/overview), [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills), [custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents).
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference).
- [Codex skills](https://developers.openai.com/codex/skills), [Codex subagents](https://developers.openai.com/codex/subagents).
- Cursor Agent: editor-native loop and surfaces as used in this environment; internals remain partly opaque.

`evals/frontier-v1.yaml` was not mutated. VS Code **1.122.1** remains Alpha’s release host. Live Copilot probes on **1.136.1** do not replace that gate.
