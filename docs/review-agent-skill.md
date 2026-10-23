# Built-in review skill

Alpha bundles `review-agent` as an explicit workflow for inspecting a specified change and reporting actionable defects
without editing. It is separate from failure investigation and is not an automatic stage of every turn.

## Invocation and authority

`SkillsManager` discovers `assets/skills/review-agent/SKILL.md` with
`agents/openai.yaml: allow_implicit_invocation: false`. Settings exposes the built-in for inspection/disabling; bundled
content remains uneditable. Automatic catalogs and missing-skill suggestions exclude explicit-only skills.

Request `Use $review-agent to review the working changes` to select it. The ordinary skill load/approval and provenance
path applies. For an authorized delegated review, name the skill in the child's objective; choosing the Review role alone
does not load it. Children resolve the captured skill path/digest and invocation policy.

Project/global overrides retain normal precedence. Disabling the built-in affects new effective catalogs; existing child
snapshots retain frozen context. Loading changes instructions, not execution authority: current parent-derived tool policy,
mode, approvals, and any narrower historical grant remain enforced by the shared harness.

The workflow asks for complete diff inspection, merge-base comparison where appropriate, evidence-backed findings, severity
ordering, and no edits or onward delegation. These are workflow instructions, not an additional security boundary.

## Packaging and validation

The VSIX verifier requires both instructions and invocation policy. Omitting the policy would make a packaged explicit-only
skill eligible for implicit selection.

```sh
pnpm --dir src test services/skills/__tests__/SkillsManager.policy.spec.ts core/tools/__tests__/skillTool.spec.ts core/tools/__tests__/SkillTool.catalog-list.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm bundle
pnpm vsix
node scripts/verify-vsix-contents.mjs <path-to-vsix>
```

These checks validate invocation and packaging; they do not measure model review quality.
