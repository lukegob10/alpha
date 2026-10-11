# Command approval token matching — 2026-10-11

Command approval rules must match an executable and complete leading argument tokens. A saved `git` rule must not grant
authority to `git-impostor`; a `pnpm test` rule must not match `pnpm test-extra`. Matching denials take precedence over
matching allows, including a longer allow and the allow-all wildcard. The same interpretation must govern live approval,
captured step policy, managed-child ceilings, and command timeout exemptions.

## Reference and reproduced defect

This work starts from Alpha checkpoint `14fc29614911d0d3b88670135a8a5c11abb75103`. The official Codex checkout examined
read-only is pinned to [27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed 2026-10-11 at 17:43:08 UTC and reviewed on 2026-10-11. Relevant functions and tests were checked at that
revision; the earlier divergence audit's `a07c8ebd57feedc4cf5dfe854c8e9101de54186b` reference is historical context.

The implementation lead launched three subagents: upstream/contract review (`contract_review`), native implementation
(`implementation`), and observable regressions/independent review (`regressions`). Work remained in the assigned isolated
worktree, with disjoint file ownership and integration review by the lead.

The checkpoint's `findLongestPrefixMatch` was extracted with `git show`, stripped in memory with Node's
`stripTypeScriptTypes`, and called without installing dependencies or executing any candidate command:

| Command               | Saved rule  | Checkpoint result | Required match result |
| --------------------- | ----------- | ----------------- | --------------------- |
| `git-impostor status` | `git`       | `git`             | No match              |
| `pnpm test-extra`     | `pnpm test` | `pnpm test`       | No match              |
| `rm target-extra`     | `rm target` | `rm target`       | No match              |

Reproduce the baseline with Node 24.21.0 by passing this body to `node --input-type=module -e`:

```js
import { execFileSync } from "node:child_process"
import { stripTypeScriptTypes } from "node:module"

const source = execFileSync(
	"git",
	["show", "14fc29614911d0d3b88670135a8a5c11abb75103:src/core/auto-approval/commands.ts"],
	{ encoding: "utf8" },
)
const matcherSource = source.match(/^export function findLongestPrefixMatch\([\s\S]*?^\}/m)[0]
const match = Function(
	stripTypeScriptTypes(matcherSource).replace("export function", "function") + "; return findLongestPrefixMatch",
)()
for (const [command, rule] of [
	["git-impostor status", "git"],
	["pnpm test-extra", "pnpm test"],
	["rm target-extra", "rm target"],
])
	console.log(JSON.stringify({ command, rule, actual: match(command, [rule]), expected: null }))
```

The defect belongs to command policy matching. It is not an executable lookup failure: authorization was granted before
the unrelated executable or argument was resolved. Lowercasing the entire string also merged distinct case-sensitive
arguments, while character-count specificity let quoted or differently spaced rules affect allow/deny precedence.

## Verified upstream contracts

| Source at the pinned revision                                                                                                                                                                                                              | Verified behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [execpolicy/src/rule.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/src/rule.rs), `PrefixPattern::matches_prefix`, `PatternToken::matches`                                          | The command must contain at least the pattern's token count. The executable and every leading argument match by complete token equality. Additional arguments are permitted.                                                                                                                                                                                                                                                                                                                 |
| [execpolicy/src/policy.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/src/policy.rs), `matches_for_command_with_options`, `check_multiple_with_options`, `Evaluation::from_matches` | Collect matching rules for every command. Use the strictest decision; fallback applies when no explicit rule matches.                                                                                                                                                                                                                                                                                                                                                                        |
| [execpolicy/src/decision.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/src/decision.rs), `Decision`                                                                                | Ordering is Allow, Prompt, Forbidden. A matching forbidden rule cannot be overridden by a more specific allow.                                                                                                                                                                                                                                                                                                                                                                               |
| [execpolicy/tests/basic.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/tests/basic.rs)                                                                                              | `basic_match`, `match_and_not_match_examples_are_enforced`, `strictest_decision_wins_across_matches`, and `strictest_decision_across_multiple_commands` verify token prefixes and strictest-decision aggregation.                                                                                                                                                                                                                                                                            |
| [shell-command/src/bash.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/shell-command/src/bash.rs), `try_parse_word_only_commands_sequence`, `parse_shell_script_into_commands`                 | Parse literal argv without running the shell. Quoted words, quote concatenation, and quoted newlines retain their argument boundaries. Malformed operators and unsupported runtime expansion do not become trusted plain commands. Tests include `extracts_double_and_single_quoted_strings`, `accepts_double_quoted_strings_with_newlines`, `accepts_mixed_quote_concatenation`, `rejects_trailing_operator_parse_error`, and `rejects_empty_command_position_with_empty_pipeline_segment`. |
| [core/src/exec_policy.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/exec_policy.rs), `commands_for_exec_policy_for_platform`                                                         | Recognized Bash/PowerShell wrappers can be lowered into plain commands. Unrecognized syntax remains the original invocation rather than fabricated trusted argv.                                                                                                                                                                                                                                                                                                                             |

Upstream exact token matching remains case-sensitive on every platform. Its optional absolute host-executable lookup
uses [execpolicy/src/executable_name.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/src/executable_name.rs)
for Windows basename case and executable suffix normalization. `Policy::match_host_executable_rules` runs only after
exact matching fails and checks an explicit path mapping when one exists. `basic.rs` covers resolution, explicit empty
allowlists, paths outside the mapping, and exact-match precedence. This optional basename behavior is separate from
`PrefixPattern::matches_prefix` and is not adopted as an implicit Alpha authority grant.

GNU Coreutils' official [env documentation source](https://github.com/coreutils/coreutils/blob/master/doc/coreutils.texi),
retrieved 2026-10-11, confirms that `-S`/`--split-string` parses a separate argument language with escapes and environment
expansion. A quoted split operand cannot be treated as one literal child executable. Alpha marks split-string lowering
unresolved, including attached/equals spellings, combined short options, and long-option abbreviations; finite denial
ceilings require review unless a recognized denial already blocks the action.

Windows expansion forms were checked against native `cmd.exe` help and Microsoft's
[cmd](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd) and
[call](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/call) documentation on 2026-10-11.
Paired percent/delayed expansions, variable modifiers, and positional/batch substitutions retain uncertainty even inside
single quotes; the matcher cannot assume a PowerShell literal interpretation.

## Native ownership and equivalent routes

| Alpha owner                                                                                                               | Route and invariant                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/auto-approval/commands.ts`                                                                                      | `getSingleCommandDecision`, the legacy boolean exports, and `getCommandDecision` share the matcher. Top-level chains and extracted substitutions require every parsed command to be allowed; any recognized direct or indirect denial blocks the whole command.                                                                                                                |
| `src/core/auto-approval/shellCommand.ts`                                                                                  | Existing shell analysis owns tokenization, literal/source boundaries, substitutions, and parse validity. `analyzeShellCommandTokens` returns argv alongside failure evidence and original command source; approval must not reconstruct quoted argv with `join(" ")`.                                                                                                          |
| `src/core/auto-approval/index.ts`                                                                                         | `checkAutoApproval` combines command decisions with user-selected approval mode. `checkAutoApprovalWithInheritedPolicy` intersects live settings with every captured child ceiling. Neither a provider nor a child can widen authority.                                                                                                                                        |
| `src/core/task/Task.ts`                                                                                                   | `Task.ask` captures the invoking step's command rules before awaiting live settings. Live approval must also satisfy that immutable command boundary; later allow additions or deny removals cannot widen a pending ask. Policy compares original command text while published worker paths remain redacted. Exact argument case is preserved when saving a persistent prefix. |
| `src/core/agent/ToolPolicy.ts`, `ToolScheduler.ts`                                                                        | The immutable step snapshot keeps command strings separate from tool-name aliases. Captured denials and timeout exemptions use the same complete-token interpretation before tool dispatch.                                                                                                                                                                                    |
| `src/core/tools/ExecuteCommandTool.ts`, `ParallelCommandRead.ts`                                                          | Ordinary terminal commands and isolated audited reads preserve command/path review and revalidation. The direct timeout fallback uses the same matcher as the scheduler callback.                                                                                                                                                                                              |
| `src/core/webview/AlphaProvider.ts`, `src/core/agent/SubagentContextCapture.ts`, `packages/types/src/subagent-context.ts` | Managed-child creation captures and sanitizes effective command rules without persisting plaintext prefixes. Reload and nested descendants retain every captured ceiling and its original policy digest.                                                                                                                                                                       |
| `webview-ui/src/utils/command-parser.ts`, `CommandExecution.tsx`, `CommandPatternSelector.tsx`                            | Suggested rules preserve executable quoting. Selector controls represent exact saved membership, not predicted execution approval. Add/remove labels must agree with the corresponding saved list, including conflicts.                                                                                                                                                        |

Scheduled tasks, sidebar/editor/background tasks, and managed descendants reach these same approval and scheduler owners.
No provider-specific approval path, alternate lifecycle authority, or new execution mechanism is introduced.

`Task.ask` computes `checkAutoApprovalWithInheritedPolicy` before publishing a completed approval request. The webview
consumes the canonical ask/outcome; no command-prefix decision engine belongs in React. A saved allow toggle does not
guarantee approval when a broader matching denial, inherited ceiling, command-path check, or explicit approval condition
applies.

## Compatibility decisions

- Saved user/workspace allow and deny settings remain string arrays. Matching parses those strings as literal token
  prefixes; persisted settings do not need a rewrite. Empty or malformed finite allow rules cannot grant approval.
  Previously partial rules such as `git sta` or `rm -` match only those literal arguments, not `status` or `-rf`; a broad
  executable denial should use `rm`. A denial for `rm ./build` no longer denies the distinct argument `./build-old`.
- Executables and argument tokens are distinct. Arguments compare case-sensitively. Windows executable case and path
  separators may be normalized at the existing native parser boundary; executable suffixes and arbitrary path basenames
  do not become aliases. On other hosts executable names remain case-sensitive. This is an explicit Windows adaptation
  beyond upstream's exact-token matcher, without inheriting upstream's optional host-path resolution authority.
- Matching denials override every allow match and allow-all. This deliberately retires Alpha's earlier
  longer-character-allow override. Users who relied on a narrow allow exception beneath a broad denial must revise that
  denial explicitly. Existing rule data is preserved.
- Finite-prefix approval cannot inherit authority from incomplete tokens, malformed shell syntax, unknown executable
  expansions, or unsupported indirect code. Existing dangerous-substitution and nested-command inspection remain
  additional checks. Recognized denials remain effective even when the surrounding syntax requires review. Malformed
  parsed syntax requires review even under an otherwise unrestricted allow-all grant. Escape and line-continuation
  spelling cannot make a known command or argument evade its denial; uncertain lowering requires review.
- Alpha retains supported native redirections, shell substitutions, background chaining, and Windows call-operator
  handling under its existing path and indirect-execution checks. Upstream's narrower plain-shell extraction does not
  require removing these Alpha capabilities. An unknown or ambiguous shell interpretation requires review. The explicit
  `*` grant remains the existing broad command grant and does not bypass matching denials or workspace/path protections.
- Without a captured shell dialect, Windows single-quoted operators, shell-dependent backslash escapes, doubled single
  quotes, and `%VAR%`/`!VAR!` expansion need review under finite rules. Literal configured quote notation remains available;
  an actual ambiguous invocation cannot establish an automatic finite grant. POSIX literal quoting and escaped-dollar
  behavior remain supported. Nested shell and launcher arguments retain expansion evidence for finite deny ceilings.
- A configured launcher/wrapper grant retains Alpha's existing scope for a recognized literal wrapper invocation.
  An otherwise unlisted literal child command does not by itself cancel that explicit wrapper grant. Indirect-execution
  analysis still blocks matching child denials and requires review for unresolved code or dynamic arguments whose
  exclusion from a configured deny policy cannot be established.
  This differs from upstream's successful plain-shell lowering, which evaluates the inner commands in place of the
  wrapper, and avoids introducing an unrelated change to Alpha's established launcher grants.
- Command timeout exemptions also match complete tokens and every command in a chain. A rule for an allowed first
  command cannot exempt an unrelated later command from the captured user timeout.
- Newly captured child rules use salted digests of canonical token prefixes, with token-count boundaries. The stored
  `sha256-salted-argv-v2` representation freezes the normalization platform and continues to exclude command plaintext
  and potentially credential-bearing arguments. Unparseable deny rules remain an explicit approval ceiling.
- Existing `sha256-salted-prefix-v1` child manifests retain their serialized objects and policy digests. Their reader
  narrows legacy allow matches to unambiguous complete token boundaries and retains legacy denials conservatively. A
  known raw denial still blocks the command. An opaque legacy deny rule cannot be assumed absent merely because another
  spelling or quoting did not reproduce its raw hash; uncertain legacy deny interpretation requires review, including
  when the captured allowlist is `*`. Mixed legacy/new ceilings all remain authoritative. No plaintext recovery or
  migration of old salted hashes is attempted. These conservative legacy ceilings may require more review than a newly
  captured, unambiguous token policy.
- When both live and inherited approval modes are Full Access, their existing tier semantics can bypass a finite
  allowlist miss. This does not bypass a command-denial ceiling: live and every captured policy must prove the command
  excluded from their denials before Full Access can proceed. Matching denials block execution; opaque legacy denials,
  unresolved captured deny rules, and shell uncertainty still require review. Auto continues to require allowlist
  approval at every applicable ceiling.
- Alpha keeps its existing explicit approval modes, workspace/protected-file checks, execution protections, cancellation,
  and child-policy intersection. Codex sandbox architecture and setup are outside this change. VS Code 1.125.0 remains
  the exact host contract; embeddings/codebase search, Tickets, skills, scheduling, HTML preview, MCP, and other active
  tools remain integrated with the existing harness.

## Validation

All final checks used Node 24.21.0 and pnpm 11.24.0 in the isolated worktree. The checkpoint probe reproduced the three
incorrect prefix matches above. No candidate shell payload was executed.

| Check                                                                                                                                                                                                                       | Result                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                                                            | Passed; no lockfile changes.                                                                        |
| `pnpm --filter @alpha-code/types build`                                                                                                                                                                                     | Passed, including entrypoint verification; only the required internal dependency package was built. |
| Focused extension suite below                                                                                                                                                                                               | 16 files, 924 tests passed.                                                                         |
| `pnpm --dir src test core/task/__tests__/Task.spec.ts --testNamePattern 'Task typed tool approval bridge\|uses the admitted step' --maxWorkers=2 --minWorkers=1`                                                            | 32 passed; 283 unrelated tests skipped.                                                             |
| `pnpm --filter @alpha-code/types test src/__tests__/subagent-context.test.ts --maxWorkers=2 --minWorkers=1`                                                                                                                 | 20 passed.                                                                                          |
| `pnpm --dir webview-ui test src/components/chat/__tests__/CommandPatternSelector.spec.tsx src/components/chat/__tests__/CommandExecution.spec.tsx src/utils/__tests__/command-parser.spec.ts --maxWorkers=2 --minWorkers=1` | 3 files, 69 tests passed.                                                                           |
| `pnpm --filter @alpha-code/types check-types`, `pnpm --dir src check-types`, `pnpm --dir webview-ui check-types`                                                                                                            | All ordinary typechecks passed.                                                                     |
| Scoped ESLint and Prettier                                                                                                                                                                                                  | Passed for touched files; existing CRLF endings in the two selector files were preserved.           |

The CRLF-aware whitespace check passed:
`git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check`.
Plain `git diff --check` reports preserved CR characters in the two selector files as trailing whitespace.

Reproduce the extension suite from the repository root in PowerShell:

```powershell
$commandTests = @(
    'core/auto-approval/__tests__/commandTokenMatching.spec.ts'
    'core/auto-approval/__tests__/commands.spec.ts'
    'core/auto-approval/__tests__/checkAutoApproval.spec.ts'
    'core/agent/__tests__/ToolPolicy.spec.ts'
    'core/auto-approval/__tests__/commandPathScope.spec.ts'
    'core/auto-approval/__tests__/commandApprovalAmendment.spec.ts'
    'core/agent/__tests__/SubagentContextCapture.spec.ts'
    'core/agent/__tests__/ToolScheduler.spec.ts'
    'core/agent/__tests__/ToolScheduler.command-batching.spec.ts'
    'core/agent/__tests__/ToolScheduler.manage-command-read.spec.ts'
    'core/tools/__tests__/commandTimeouts.spec.ts'
    'core/tools/__tests__/executeCommandTool.spec.ts'
    'core/tools/__tests__/ParallelCommandRead.spec.ts'
    'core/webview/__tests__/AlphaProvider.subagents.spec.ts'
    'core/task-persistence/__tests__/subagentInstructionSnapshot.spec.ts'
    'core/tools/__tests__/taskPathPresentation.spec.ts'
)
pnpm --dir src test @commandTests --maxWorkers=2 --minWorkers=1
```

An early webview typecheck used a temporary source-alias tsconfig and passed. That was not the ordinary package gate.
The temporary validation configurations were deleted after the existing types build; all final test commands and the
ordinary extension/webview typechecks then ran without source aliases.

Regression coverage includes direct/frozen partial-token collisions, equivalent quoting, POSIX continuation, Windows
normalization and expansion modifiers, chains and malformed syntax, indirect launchers and nested globs, GNU split-string
short/long/attached/equals/abbreviated forms under executable and wildcard grants, legacy/mixed-ceiling reload, and deny
precedence. Task tests verify that live setting changes and later step admission cannot widen an existing ask, that exact
argument case can be saved independently, and that private worker paths are redacted only after policy evaluation.

The exact VS Code 1.125.0 smoke gate, full integrated gates, managed-agent certification, extension/webview bundling,
VSIX, and live Copilot checks are deferred to the parent integration chat. They were not run in this isolated workstream.
The pre-commit hook starts repository-wide lint, so the handoff commit uses `HUSKY=0` to honor that serial gate ownership;
touched-file lint and formatting checks were run explicitly. No live performance or general task-quality claim follows
from this correctness change.

## Changed files

- `docs/approval-mode-policy.md`
- `docs/codex-alignment-command-matching-2026-10-11.md`
- `packages/types/src/subagent-context.ts`
- `packages/types/src/__tests__/subagent-context.test.ts`
- `src/core/agent/SubagentContextCapture.ts`
- `src/core/agent/ToolPolicy.ts`
- `src/core/agent/__tests__/SubagentContextCapture.spec.ts`
- `src/core/agent/__tests__/ToolPolicy.spec.ts`
- `src/core/auto-approval/commands.ts`
- `src/core/auto-approval/index.ts`
- `src/core/auto-approval/indirectCommandExecution.ts`
- `src/core/auto-approval/shellCommand.ts`
- `src/core/auto-approval/__tests__/checkAutoApproval.spec.ts`
- `src/core/auto-approval/__tests__/commandTokenMatching.spec.ts`
- `src/core/auto-approval/__tests__/commands.spec.ts`
- `src/core/task/Task.ts`
- `src/core/task/__tests__/Task.spec.ts`
- `src/core/tools/ExecuteCommandTool.ts`
- `src/core/webview/__tests__/AlphaProvider.subagents.spec.ts`
- `src/package.nls.json`
- `webview-ui/src/components/chat/CommandPatternSelector.tsx`
- `webview-ui/src/components/chat/__tests__/CommandPatternSelector.spec.tsx`
- `webview-ui/src/i18n/locales/en/settings.json`
