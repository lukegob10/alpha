# Built-in review skill

Alpha bundles `review-agent` separately from `debug`. Debug investigates a reported failure and verifies a correction;
review-agent inspects a specified change and reports actionable defects without editing. It is an on-demand workflow,
not a required stage of every model turn.

## Upstream reference

Checked OpenAI Codex CLI on 2026-10-17 at commit `8c076942cb70fba8e5c4732c23f1faabc4aed484`:

- [Review instructions](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/skills/src/assets/samples/review-agent/SKILL.md)
- [Explicit invocation policy](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/skills/src/assets/samples/review-agent/agents/openai.yaml)
- [Skill selection tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/skills/src/selection_tests.rs)

Alpha follows the upstream explicit-only policy, complete diff inspection, merge-base comparison, evidence-backed
findings, severity ordering, and prohibition on edits or onward delegation. The instructions are authored for Alpha;
they are not a copy of the upstream prompt. Alpha also allows direct user-requested loading in the parent task,
preserves its normal skill approvals, and uses its existing Code/Plan and managed review-agent policy boundaries.

## Extension behavior

The existing `SkillsManager` discovers `assets/skills/review-agent/SKILL.md` and reads
`agents/openai.yaml` with `allow_implicit_invocation: false`. No skill-specific runtime or registry is needed.

- Settings retains the built-in entry for inspection and disabling. Bundled content remains uneditable.
- Automatic prompt catalogs, skill-list pages, and missing-skill suggestions exclude explicit-only skills.
- Request `Use $review-agent to review the working changes` to select this workflow. The model loads it through
  `skill` with action `load` and skill `review-agent`, using the ordinary approval and loaded-skill provenance path.
- For an authorized delegated review, explicitly name the skill in the review child's objective. Selecting the
  `review` role alone does not automatically load the skill. Children inherit the existing frozen skill catalog and
  resolve the captured path and content digest; a hidden skill can still be loaded explicitly when inherited.
- Project/global overrides retain normal precedence. Disabling the built-in removes it from new effective catalogs;
  existing child snapshots retain their established frozen-context semantics.
- Loading the skill changes instructions, not execution authority. Managed review-role policy enforces its existing
  restrictions. A parent in Code retains its tool policy: the read-only workflow is an instruction, not a new sandbox.

The VSIX content verifier requires both the instructions and invocation policy. Omitting the policy would accidentally
make the packaged reviewer eligible for implicit selection.

## Validation

Focused coverage uses the actual bundled files in discovery and tool-load tests:

```sh
pnpm --dir src test services/skills/__tests__/SkillsManager.policy.spec.ts core/tools/__tests__/skillTool.spec.ts core/tools/__tests__/SkillTool.catalog-list.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs <path-to-vsix>
```

This establishes invocation and packaging behavior, not a measured improvement in model review quality or latency.

Validated on 2026-10-17: 81 focused skill tests and 22 VSIX-verifier tests passed, along with the extension typecheck,
focused ESLint, Prettier, and skill frontmatter validation. The full `test:smoke:1250` gate passed on exact VS Code
1.125.0 using scripted providers and the VS Code LM fixture. `pnpm bundle` and `pnpm vsix` passed;
`bin/alpha-3.2.3.vsix` passed content verification with `--check-source` (1,815 entries and 16 matching document assets).
