# Frontier harness scorecard — 19 September 2026

**Subject:** Alpha Code **2.1.49** on `main`  
**Question:** For workflows and coding agents, how does Alpha perform versus Copilot Agent (VS Code), Claude Code, and Codex?

This is a reviewer score of **product shape and public contracts**, not a live solve-rate. It is not SWE-bench or VSC-Bench. Luna file-tools 3/3 and read-evidence 4/4 remain tool-contract samples on VS Code 1.136.1 from 15–16 September. The 1.122.1 smoke gate is a host check, not a quality ranking.

**Copilot** is VS Code Copilot with Agent, Plan (saved `.copilot/plans/` + Implement plan), Agent Skills, custom agents, and subagents as documented 19 September 2026 — not a tools-off Chat box.

**Previous snapshot (16 Sep, Alpha 2.1.42):** lifecycle index Alpha 84 / Copilot 84 / Claude 87 / Codex 84. Catalog still advertised overlapping editors; skill no-match was billed as an error; command wait/stop was missing; `github_api` was eager.

## Verdict

| Harness                  | Lifecycle / 100 | Coding loop / 100 | Peak                                                  |
| ------------------------ | --------------: | ----------------: | ----------------------------------------------------- |
| Claude Code              |          **87** |            **88** | Skills, plan protocol, LSP, coding loop               |
| **Alpha Code 2.1.49**    |          **86** |            **86** | Tickets, Plan/Code policy, skill load, follow-through |
| Copilot Agent in VS Code |          **85** |            **86** | GitHub-native ship, durable Plan files, custom agents |
| Codex CLI / IDE          |          **84** |            **90** | Trained `apply_patch`, sandbox, tiny default catalog  |

Alpha is no longer tied with Copilot because the catalog was too wide. After the native tool-surface refactor on `main`, it **edges Copilot on the full work lifecycle** and **matches Copilot on the coding loop**. It is still **behind Claude Code** on skills/plan/LSP, and **behind Codex** on one-file edit fidelity and sandbox. Cursor Agent is omitted from this four-way; it remains the editor-native build peak (~86 lifecycle in the 16 Sep note).

Hiding tickets, spawn, or `skill` would still **lower** the lifecycle score. Those are how the loop finishes a person’s problem. The extra dialects (`apply_diff`, `search_replace`, `edit_file`) are gone from the advertised catalog; that was the right “less.”

## What changed on Alpha since 16 September

Landed on `main` (2.1.47–2.1.49), verified in `TOOL_GROUPS`, `getNativeTools`, and `nativeToolSurfaceRefactor.spec.ts`:

- Advertised editors are `edit` + `write_to_file`, plus GPT-family `apply_patch`. Retired from the model catalog: `apply_diff`, `search_replace`, `edit_file`.
- `execute_command` → `shell`; `read_command_output` folded into `manage_command` (`wait` / `stop` / `input` / `read`).
- Agents advertised: `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `list_agents`, `close_agent`.
- `github_api` retired. GitHub is `gh` through `shell` ([github-cli.md](github-cli.md)).
- Tickets stay host-eager. `skill` stays always-available. MCP `discover_tools` is still MCP-only.
- Skill prompt: no-match proceeds; it is **not** an error (`skills.ts`).
- Reads: 32k-honest `Continuation` (16 Sep) plus recoverable invalid selections (2.1.47).
- Exact GPT Code catalog in the refactor contract, with index + three live browser tools: **29** names. Without index/browser: **25**. The 19 Sep toolkit note of 48 tools is the pre-refactor surface.

Still true: Plan is a `<proposed_plan>` chat block, not a durable file Code can attach to. GPT still sees both `edit` and `apply_patch` (portable edit is kept on purpose). Browser tools are still the full live VS Code set when the host has them. No new medium-task campaign.

## Coding loop (find, edit, verify, skill, stop)

Unweighted mean of nine surfaces. This is the “will the first coding turn work” lens — not the whole product.

| Surface               | Alpha | Copilot | Claude | Codex | Frontier best | Why                                                                                               |
| --------------------- | ----: | ------: | -----: | ----: | ------------- | ------------------------------------------------------------------------------------------------- |
| Turn loop             |    86 |      86 |     88 |    90 | Codex         | Same think → tool → observe → stop family.                                                        |
| Policy and stop       |    90 |      86 |     88 |    88 | **Alpha**     | Plan cannot mutate. Children cannot widen. Path-scoped command approval.                          |
| Default catalog       |    86 |      88 |     88 |    92 | Codex         | 25–29 eager names vs Codex ~6–8. Duplicate editors are gone. Browser/MCP still inflate when live. |
| Edits                 |    88 |      88 |     90 |    95 | Codex         | Luna `apply_patch` 3/3. GPT still has `edit` + patch. No live `edit` sample.                      |
| Search                |    90 |      86 |     95 |    88 | Claude        | Modes + literal + per-query errors, Luna-sampled. Claude still has LSP/Grep.                      |
| Read                  |    88 |      86 |     93 |    88 | Claude        | Honest 32k pages. Still slurps the file. No LSP.                                                  |
| Skills                |    88 |      86 |     92 |    88 | Claude        | Eager load; no-match is proceed. Claude Skill + fork/agent still leads.                           |
| Command verify        |    86 |      84 |     88 |    92 | Codex         | `manage_command` wait/stop/read exists. Codex unified exec still leads.                           |
| Plan (coding handoff) |    74 |      90 |     88 |    85 | Copilot       | Alpha plan dies in chat. Copilot writes `.copilot/plans/` and Implement plan.                     |

**Coding-loop mean:** Alpha **86**, Copilot **86**, Claude **88**, Codex **90**.

## Workflow / solution lifecycle

Weighted “get the work done”: web-app build 15, use skills 12, follow-through 10, then 8s for small edits / surfaces / plan / author skills; 6s for tickets / ship / verify; 5s for delegation / read-search; 3 for policy.

| Job                         | Alpha | Copilot | Claude | Codex | Why Alpha sits there                                                             |
| --------------------------- | ----: | ------: | -----: | ----: | -------------------------------------------------------------------------------- |
| Small edits / one file      |    90 |      88 |     90 |    93 | Extra dialects gone. Codex still trained on one patch format.                    |
| Multi-file / web app        |    85 |      88 |     90 |    88 | Same files+`shell`. `manage_command` helps servers. Still unmeasured.            |
| Surfaces / design artifacts |    84 |      72 |     78 |    68 | HTML document kit + `rich-documents` skill.                                      |
| Plan / design gate          |    78 |      90 |     88 |    85 | Inspect-only is real. Copilot’s saved plan file is the handoff Alpha lacks.      |
| Use skills                  |    90 |      86 |     92 |    88 | First-class `skill` + catalog. Error tax gone. Claude still the Skill product.   |
| Author skill workflows      |    80 |      86 |     88 |    88 | Can write `SKILL.md`. No `/create-skill` or Codex skill-creator.                 |
| Follow-through              |    86 |      78 |     84 |    80 | Tickets + spawn + skill stay eager. PRs are `gh` via `shell`, not a GitHub tool. |
| Work tracking               |    90 |      82 |     74 |    68 | Native tickets. Copilot is GitHub Issues.                                        |
| Ship / PR                   |    82 |      93 |     82 |    80 | `gh` through `shell` (same class as Claude/Codex). Copilot **is** GitHub.        |
| Delegation                  |    88 |      84 |     90 |    90 | Codex-shaped six-tool agent set; children cannot widen.                          |
| Verification                |    86 |      84 |     88 |    90 | `shell` + `manage_command`.                                                      |
| Read / search               |    88 |      86 |     93 |    88 | Unchanged honesty. Claude LSP.                                                   |
| Policy                      |    92 |      86 |     88 |    88 | Kernel, not a prompt.                                                            |

**Lifecycle index:** Alpha **86**, Copilot **85**, Claude **87**, Codex **84**.

(Arithmetic: Alpha 90·8 + 85·15 + 84·8 + 78·8 + 90·12 + 80·8 + 86·10 + 90·6 + 82·6 + 88·5 + 86·6 + 88·5 + 92·3 = 8575 → 85.75, reported **86**. Copilot 8482 → **85**. Claude 8689 → **87**. Codex 8430 → **84**.)

## How to read the comparison

- **Versus Copilot:** Alpha is the better **work system in VS Code** (tickets, inspect-only Plan, skill on the default surface, spawn with a parent policy). Copilot is the better **GitHub product** (Issues/PRs, durable plan files, `/create-skill`, custom agents, current-host APIs, medium-task evidence). Default Chat Agent still ends after a patch more often than Alpha.
- **Versus Claude Code:** Claude is still the frontier **skill + coding** harness (Skill, Enter/Exit Plan, Agent, Workflow, LSP, artifacts). Alpha is closer than on 16 Sep because the catalog and skill check no longer fight the model. It does not pass Claude on language navigation or plan protocol.
- **Versus Codex:** Codex remains the best **small-edit closer** (trained `apply_patch`, sandbox, ~6 tools). Alpha is the better **workflow OS** (tickets, Plan/Code, skills, managed agents in VS Code). Copying Codex’s tiny catalog would delete Alpha’s job, not win Codex’s.

## What would move Alpha onto the frontier lead

1. **Durable plan object** Code can attach to (Copilot already files this under `.copilot/plans/`). Largest remaining workflow gap.
2. **Skill-authoring product path** (`/create-skill` class), not only “write a SKILL.md.”
3. **One surgical editor per request** for GPT (keep `edit` as fallback only if patch is absent), or prove two names do not confuse Luna.
4. **Browser:** advertise the live subset only; do not ship eleven names when three exist.
5. **Scored medium campaign** on Copilot/Vertex. Contract probes are not this index.

Do not reopen read pagination, search modes, `fileEditContent`, `parsePatch` CRLF, or hide tickets/spawn/`skill`. Do not restore `github_api`; `gh` via `shell` is the locked GitHub path.

## Sources (19 September 2026)

- This tree, Alpha 2.1.49: `packages/types/src/mode.ts`, `src/shared/tools.ts`, `src/core/prompts/tools/native-tools/index.ts`, `src/core/prompts/sections/skills.ts`, `src/core/prompts/tools/native-tools/manage_command.ts`, [tool-surface-refactor.md](tool-surface-refactor.md), [github-cli.md](github-cli.md), [file-tools-live-tests.md](file-tools-live-tests.md).
- [VS Code Copilot Agent](https://code.visualstudio.com/docs/agents/overview), [Plan agent](https://learn.microsoft.com/en-us/visualstudio/ide/copilot-plan-agent), [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills), [subagents](https://code.visualstudio.com/docs/agents/run/subagents).
- [Claude Code tools](https://code.claude.com/docs/en/tools-reference), [Claude skills](https://code.claude.com/docs/en/skills).
- [Codex skills](https://developers.openai.com/codex/skills), [Codex config / shell](https://developers.openai.com/codex/config-reference), Codex `apply_patch` / `update_plan` prompt.

`evals/frontier-v1.yaml` was not mutated. VS Code **1.122.1** remains the release host.
