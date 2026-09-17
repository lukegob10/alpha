# Built-in debugging skill

Alpha bundles `debug` for focused investigation of a concrete, unresolved failure. It uses the existing skill catalog,
invocation, settings, override resolution, and task tools. It adds no mode, service, automatic command hook, or permissions.
The full workflow enters model context only on invocation; normal prompts contain its name, description, and location.

## Selection boundary

The model selects the skill from its description when the task calls for investigation. It can also be requested explicitly
with “Use the debug skill to investigate …”. A command failure alone is not an activation rule. The skill stops applying
when the investigation ends or the user changes tasks.

| Request or situation                                 | Intended behavior                                             |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| “Debug why save sometimes loses the newest edit.”    | Select debug; collect evidence about the failing sequence.    |
| “The same crash still happens after that fix.”       | Select debug; revisit the cause with new evidence.            |
| “Investigate why tests only fail when run together.” | Select debug; reproduce the interaction.                      |
| “Run the build.”                                     | Run the build normally.                                       |
| A build reports a plainly misspelled import.         | Correct it within the requested scope and verify normally.    |
| “Add logging to this handler.”                       | Implement the requested logging normally.                     |
| “Review this diff for bugs.”                         | Review normally; this skill investigates an observed failure. |
| “Explain how breakpoints work.”                      | Answer normally.                                              |
| “Fix this typo in the error message.”                | Make the straightforward correction normally.                 |
| After a debugging task: “Now update the README.”     | Follow the new request normally.                              |

Selection is model behavior guided by metadata, not a deterministic classifier. Discovery tests establish catalog and
invocation behavior; they cannot prove a model will always select correctly. Behavioral checks should inspect both useful
selection and over-selection using the actual description, including ordinary tasks containing “error”, “test”, or “log”.

## Alpha adaptation

The workflow uses reproduction, falsifiable hypotheses, focused observations, a causal correction, and verification after
cleanup. Existing evidence can skip unnecessary instrumentation or human reproduction. A diagnosis-only request remains
diagnosis-only. Plan retains host-enforced restrictions; the skill never changes modes itself.

Evidence comes from existing test commands, command output artifacts, application logs, and available integrated browser
tools. No logging server, debugger attachment, or endpoint is implied. Commands that return early may still be running;
output reads are immediate and must not turn into a busy polling loop. Temporary instrumentation stays bounded and owned,
and cleanup must preserve external edits. Investigation notes stay in the existing task context.

Users can disable the built-in through Skills settings or supply a same-name personal/project skill through the existing
hub. Project overrides take precedence over personal skills, then the bundled fallback. Disabling the bundled default
does not disable an installed override. Removing an override does not resurrect a disabled default.

## Upstream baseline

Reviewed on 2026-09-14:

- [Cursor Debug Mode documentation](https://cursor.com/docs/agent/debug-mode): hypothesis-driven investigation, runtime
  observations, reproduction, targeted correction, and cleanup.
- [Introducing Debug Mode](https://cursor.com/blog/debug-mode), published 2025-12-10 (Cursor 2.2): user-assisted
  reproduction and verification when the agent cannot observe the relevant interaction itself.

These are public workflow descriptions, not Cursor's internal skill source. Alpha's instructions are original and use
Alpha's current tool contracts. Bugbot's automated PR-review workflow is outside this skill's scope.

## Validation

- `pnpm --dir src test -- services/skills/__tests__/SkillsManager.spec.ts services/skills/__tests__/skillInvocation.spec.ts services/skills/__tests__/builtinSkillInspection.spec.ts core/tools/__tests__/skillTool.spec.ts core/prompts/sections/__tests__/skills.spec.ts`
- `pnpm --dir src lint`
- `pnpm --dir src check-types`
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`
- `pnpm bundle`, `pnpm vsix`, then `node scripts/verify-vsix-contents.mjs <path-to-vsix>`

The discovery regression loads the actual shipped skill and checks Code/Plan availability, deferred instruction loading,
disablement, and project override/removal behavior. The VSIX content gate requires the packaged skill file. Behavioral
evaluation should separately check an unfamiliar bug in an isolated workspace, observing baseline reproduction,
evidence, scope, regression coverage, cleanup, and honest verification reporting.

### Validation record — 2026-09-14

- Node 20.19.2 and pnpm 10.8.1. Skill frontmatter validation, touched-file formatting, and diff whitespace checks passed.
- The new discovery test first failed for the absent bundled file. After implementation, all 111 tests across the five
  focused skill suites passed. Extension lint and the final extension typecheck passed.
- The exact VS Code 1.122.1 smoke gate passed its activation, modes, and VS Code LM contract suites. Bundle and VSIX
  generation passed; the content verifier checked 1,855 entries, and the packaged debug skill matched the source bytes.
- An independent evaluator classified 14 requests from the description alone. All matched the intended boundary,
  including inspecting an unread build failure normally before deciding whether investigation was needed.
- In an isolated search-suggestion example, the evaluator reproduced stale results using controlled promises. Three
  new regressions failed before correction; all four tests passed afterward. Existing developer notes were preserved,
  and no temporary instrumentation was needed. The primary agent inspected the result and independently reran the tests.

The independent exercise used equivalent shell/file tools, not a live Alpha provider session. It supports the workflow
and selection wording on these examples; it does not establish general model accuracy or eliminate over-selection risk.
