# Instruction loading and explicit skill invocation

This focused change is based on Alpha commit `ee2cea46c93bded3aecf22ae202b3723f3651795`.
Codex source was retrieved on October 17, 2026 and pinned to
[`8c076942cb70fba8e5c4732c23f1faabc4aed484`](https://github.com/openai/codex/tree/8c076942cb70fba8e5c4732c23f1faabc4aed484).
The behavior applies to Alpha's shared harness, including GitHub Copilot models through VS Code LM.
It requires no provider-specific API or Copilot Chat customization loading.

## Instructions

Codex's [agents_md.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agents_md.rs)
and [tests](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/agents_md_tests.rs)
select override, standard, then configured fallback at each scope. An empty override still selects that file;
it does not enable weaker fallback guidance. Missing candidates and directories are optional. Unexpected metadata
or read failures propagate rather than selecting a weaker candidate.

Alpha previously swallowed unexpected metadata, realpath, and preferred-file read failures. A controlled regression
reproduced fallback to AGENTS.md after EACCES in any of those phases. Local EIO also differed between rendered
instructions and source capture. Both assembly paths now fail with the selected source path and a bounded error
code, without exposing raw OS error text. Repairing access allows a fresh load; frozen captured sources remain frozen.

Existing root-through-cwd discovery, configured safe fallback filenames, 32 KiB project budget, UTF-8-safe
truncation, source ordering, and provenance are retained. Alpha intentionally keeps its constrained symlink trust
root, AGENTS.local.md, and legacy instruction compatibility. This patch does not redesign legacy .alpha/.roo rules.

## Explicit skills

Codex's [mentions.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/skills/src/mentions.rs)
and [selection.rs](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/skills/src/selection.rs)
resolve explicit names and linked paths; an unavailable linked path cannot fall back to its display name.
[Official skills guidance](https://developers.openai.com/codex/skills/) also documents dollar invocation,
progressive disclosure, and explicit-only invocation policy.

Alpha now expands `$review`, `$project:review`, `$global:review`, `$builtin:review`, and
`[$review](/absolute/path/SKILL.md)` through the existing skill manager before model dispatch. Linked
`skill://` paths are accepted. Exact selection reads only an already discovered identity. Existing slash commands
and slash skill invocation retain their behavior. Repeated selected paths attach instructions once per parsed input.
Relative resource references retain the selected SKILL.md base directory.

Alpha deliberately preserves its source and mode override hierarchy for plain names, rather than treating every
same-name skill across sources as ambiguous. Equally specific remaining identities are rejected. Disabled and
mode-incompatible identities produce safe host-authored diagnostics. Unknown bare dollar names remain untouched
without diagnostics, so ordinary shell variables do not create missing-skill warnings. Linked/namespaced failures
are actionable. Markdown targets containing a closing parenthesis remain outside the bounded mention grammar.

Explicit-only skills can be loaded from host-authenticated human input and authenticated human feedback. External
tool output and agent-origin text cannot use dollar syntax to enable them. Children continue to resolve only captured
paths and content digests, with captured invocation policy. A skill never grants tools, changes modes, or widens
approval/workspace authority. Cancellation is checked before and after asynchronous expansion.

The host records attached skill path/digest identities using the existing working-record persistence. Guidance accepts
complete attached instructions without a duplicate tool load; absent instructions still require normal skill loading.

## Compatibility and integration

Existing bundled skills and the concurrent review-agent frontmatter fit the current Alpha format. Optional metadata
is already tolerated and invocation policy is already read from agents/openai.yaml. No format relaxation, plugin
marketplace work, .github/skills convention, or prompt-template rewrite is included. Unknown Copilot model-family
prompt fallback remains a separate evaluation item; no measured quality claim is made here.

The original checkout's review-agent tests/assets and rich-document/release edits were inspected read-only and were
not copied into this worktree. They must be integrated separately; no source dependency on those uncommitted assets
is introduced. This patch leaves saved readers and public wire contracts unchanged.

## Validation

Focused instruction regressions failed against the baseline for the intended reason, then passed with the fix.
Commands and final affected-surface results are recorded with the delivery notes for this worktree. Tests use bounded
workers and controlled failures/promises rather than live model calls. The exact-host smoke gate uses VS Code 1.125.0;
a scripted host run does not establish live Copilot model quality.

Focused reproduction and regression commands (run from the worktree root):

```sh
pnpm --dir src test --maxWorkers=2 core/prompts/sections/__tests__/custom-instructions-read-failures.spec.ts
pnpm --dir src test --maxWorkers=1 core/mentions/__tests__/explicit-skills.spec.ts services/skills/__tests__/SkillsManager.explicit-selection.spec.ts
pnpm --dir src test --maxWorkers=2 core/task/__tests__/Task.pending-queue-receipts.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The instruction campaign passed 78 tests (2 skipped). The mention/provenance campaign passed 97;
the manager/policy/discovery/tool campaign passed 68 before its additional fifth selector case also passed.
Guidance/catalog/work-context/persistence coverage passed 113 tests. Task admission passed 32 tests after
initializing its existing persistence mock, including two new pre-dispatch persistence success/failure cases;
the adjacent cancellation/resume suites passed 48 tests. These are overlapping focused campaigns, not a unique
repository-wide test total. The final extension typecheck passed.

Final source lint passed for the changed extension source files. The commit hook also passed the full
extension-focused `pnpm lint` gate and formatted the 17 staged files. This normalized the existing CRLF lookup
interface file to the formatter's LF default; its only semantic change is the optional explicit-selector method.
Whitespace validation passed.

The full `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` gate passed on actual VS Code
1.125.0, using disposable owned profiles and scripted providers (VS Code LM fixture for its contract suite).
This includes 43 executed tests across its 13 host invocations. No live Copilot account/model evaluation was run.

Additional exact-host checks passed: `instruction-discovery.acceptance.test`, followed by all three
`test:managed-agents:run` invocations (managed-agent acceptance, long-context fanout, and non-Git acceptance).

`VITEST_MAX_WORKERS=2 pnpm certify:managed-agents:automated` was attempted. Its deterministic tracks executed
3,979 tests: 3,978 passed and one failed with EBUSY while removing the unchanged Windows long-storage worktree
fixture (`uses long Windows storage length 202 with spaces for nested Workers without changing Git configuration`).
The single failing case subsequently passed in isolation (1 executed, 20 filtered out) with:

```sh
pnpm --filter @alpha-code/core test --maxWorkers=1 src/worktree/__tests__/managed-subagent-worktree.spec.ts -t 'uses long Windows storage length 202'
```

Certification also rejected source-state stability because the lead updated the task persistence fixture and these
validation notes during its run. The full certification is therefore **not green** and needs a stable-tree rerun after
integration. The managed host leg, normally short-circuited by that failure, was run separately and passed as described
above. The certification's eight explicitly manual/live integration obligations remain pending; scripted checks do not
close them. No assertion or certification evidence was weakened or manually rewritten.
