# Skill reference path correction — 2.1.21

## Evidence and cause

The reported 2.1.20 error came from `read_file` resolving
`skills/evaluate-pulse-intakes/references/evaluation-contract.md` under the task workspace and receiving `ENOENT`.
The original project is not present in this checkout, so its actual reference-file installation could not be inspected.

`SkillsManager` already returns the selected skill's absolute `SKILL.md` path. However, `buildSkillResult` discarded
that path and emitted only the source category, description, arguments, and instructions. The linked-file prompt did
not explain the relative-path base either. The same lossy formatter served the skill tool, slash-command fallback,
and user slash-command mentions. File reads correctly continued to interpret relative paths against the workspace.

## Correction and boundaries

- Keep the selected `SKILL.md` path and its containing directory in every shared skill result.
- Derive the directory using the captured path's syntax, preserving Windows drive, UNC, extended-length, and POSIX
  paths, including spaces. Do not reconstruct skill locations from names or source categories.
- Tell the model to resolve skill-relative references from that directory and use absolute paths with file tools,
  while respecting an explicitly different base in a skill.
- Preserve instruction text, mode-specific overrides, inherited path/digest checks, file-read approvals, ignore
  rules, and ordinary workspace-relative file semantics. Do not silently search for or substitute another file.
- No provider-specific changes, saved-task migration, managed-agent policy changes, dependency changes, or protected
  CLI/shim edits are included. Existing transcripts gain the location guidance when the skill is loaded again;
  missing physical reference files still require correcting the skill installation.

## Validation

The updated regressions were run before the implementation: 14 failed and 53 passed across five files. All failures
were missing location/base-directory metadata or linked-file guidance, not environmental or timing failures.

After implementation, 169 tests passed across eight files using:

```sh
pnpm --dir src test -- services/skills/__tests__ core/tools/__tests__/skillTool.spec.ts core/tools/__tests__/runSlashCommandTool.spec.ts core/tools/__tests__/readFileTool.spec.ts __tests__/command-mentions.spec.ts core/prompts/sections/__tests__/skills.spec.ts core/prompts/__tests__/system-prompt.spec.ts
```

The extension's direct lint and typecheck passed. Repository-wide `pnpm lint` and `pnpm check-types` also passed
(12 and 13 successful tasks, respectively; unchanged package checks reused Turborepo's cache).
Touched files passed Prettier with their existing line endings preserved. Diff whitespace checks use
`git -c core.whitespace=cr-at-eol diff --check` because three existing source files are stored as CRLF in Git.

`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed after bundling the extension and rebuilding the webview.
The exact 1.122.1 host passed two activation/command tests, two mode tests, and four VS Code LM contract tests covering
tool transactions, follow-ups, late cancellation, and provider-error recovery. All three host processes exited zero.

`pnpm vsix` and explicit `pnpm --dir src exec vsce package --no-dependencies --pre-release --out
../bin/alpha-2.1.21-prerelease.vsix` passed. Both archives passed `scripts/verify-vsix-contents.mjs` with 1,783 entries
and no packaged `.env` files. The prerelease JSON/XML confirms version 2.1.21, identity `AlphaInc.alpha`, host range
`^1.122.1`, and `Microsoft.VisualStudio.Code.PreRelease=true`. The local prerelease is 82,941,148 bytes with SHA-256
`afb0a66854bf6a6955d531590a5616291d8116401eb89d0f8f88ab9231b6c747`.

## Release scope

Publish through the existing `main-v2` GitHub VSIX prerelease workflow as 2.1.21. Do not publish to the Marketplace,
change stable `main`, install the extension locally, or overwrite an existing release asset.
