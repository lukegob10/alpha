# Instruction loading and explicit skills

Instructions and skills enter Alpha's shared harness through the existing instruction assembler and skill manager.
They do not require a provider-specific customization loader.

## Instruction selection

At each discovered scope, selection prefers override, standard, then configured fallback guidance. An empty selected
override remains authoritative; it does not enable weaker fallback guidance. Missing optional candidates/directories
may be skipped. Unexpected metadata, realpath, or preferred-file read failures fail with the selected path and a bounded
error code instead of selecting weaker instructions or exposing raw OS errors.

Root-through-working-directory discovery retains the project byte budget, UTF-8-safe truncation, source ordering, and
provenance. Alpha's constrained symlink trust root, `AGENTS.local.md`, and legacy instruction compatibility remain in force.
Repairing access permits a fresh load; captured instruction snapshots remain frozen.

## Explicit skills

Human input can select `$review`, source-qualified names such as `$project:review`, or
`[$review](/absolute/path/SKILL.md)`. Linked `skill://` paths are supported. Exact selection resolves an already discovered
identity; an unavailable linked path cannot borrow another skill with the same display name.

Existing slash invocation and source/mode precedence remain supported. Equally specific ambiguous identities fail.
Disabled or mode-incompatible identities produce safe host diagnostics. Unknown bare dollar names remain untouched so
ordinary shell variables do not become missing-skill warnings; linked/namespaced failures are actionable.
Markdown targets containing a closing parenthesis remain outside the bounded mention grammar.

Repeated selected paths attach once per input. Relative resources resolve from the selected `SKILL.md` directory.
The working record retains attached path/digest identities; complete attached instructions do not require another tool load.

Explicit-only skills require authenticated human input or feedback. External tool output and agent-origin text cannot
enable them through dollar syntax. Children resolve captured paths, content digests, and invocation policy. Loading a skill
cannot grant tools, change modes, or widen approval/workspace authority. Cancellation is checked around asynchronous
expansion. Existing optional metadata and `agents/openai.yaml` invocation policy remain compatible.

The [built-in review skill](review-agent-skill.md) uses this same path.

## Owning code and validation

- [Instruction assembly](../src/core/prompts/sections/custom-instructions.ts) owns source selection and bounded reads.
- [Explicit-skill tests](../src/core/mentions/__tests__/explicit-skills.spec.ts) cover mention expansion and provenance.
- Skill manager/tool tests cover discovery, invocation policy, approval, and captured child catalogs.

```sh
pnpm --dir src test core/prompts/sections/__tests__/custom-instructions-read-failures.spec.ts
pnpm --dir src test core/mentions/__tests__/explicit-skills.spec.ts services/skills/__tests__/SkillsManager.explicit-selection.spec.ts
pnpm --dir src test core/task/__tests__/Task.pending-queue-receipts.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

Use controlled read failures and promises for fallback/cancellation regressions. Scripted host checks establish instruction
transport and admission, not live-model task quality. Upstream behavior must be rechecked under the repository's source-first
rule when changing these contracts.
