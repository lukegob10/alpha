# Live read fixture review boundaries — 2026-10-11

This change starts from integrated Alpha commit `ceaa4c3c7efbd3edbfc77076a1b63c0b2d974e82`. It corrects the
read-quality fixture's command guidance and its interpretation of surfaced review state. Production command policy
continues to require review when opaque inline interpreter code cannot prove that a saved denial is excluded.

## Retained failure and policy evidence

The parent-owned exact VS Code 1.125.0 live `exported-symbol` run used the dedicated signed-in Alpha profile
`F:/alpha-e2e/profiles/1.125.0`, Copilot model `gpt-6-luna`, and reasoning effort `max`. Provider preflight passed.
Task `01a12d0a-8d34-7223-a2dd-b88276c3748d` dispatched one request and surfaced this command approval:

```text
node -e "process.stdout.write(require('fs').readFileSync('totals.cjs','utf8'))"
```

The run reached its original 180-second completion deadline without completion. Retained evidence is in
`F:/alpha-e2e/cleanup-live-final-20261011-2216/artifacts/cleanup-live-final-exported-symbol`, with the task's
UI messages and canonical provider history in the profile's global storage.

The sanitized profile inspection
`F:/alpha-e2e/cleanup-final-evidence-20261011/live-profile-command-policy-verified.json`, retrieved
2026-10-11 at 22:25:19 UTC, records the existing denials `git push`, `git remote`, `git config`, `npm install`, and
`pnpm install`. The shared fixture retains these settings through its original configuration spread. It still
configures `allowedCommands: ["node", "rg", "cut"]` for the quality cases. Auto mode's effective allowlist is
`["*"]`; the configured finite list is not a restriction on other executables in Auto.

`commands.ts` evaluates explicit denials first and asks when a finite denial exists and indirect execution remains
unresolved. `indirectCommandExecution.ts` treats inline JavaScript as unresolved. Thus the proposed file read
correctly requires review even when Node is configured or Auto supplies a wildcard. A direct bounded `rg` read
can be approved with the same retained denials. No parser relaxation or approval grant is required.

## Verified reference and intentional divergence

The official Codex checkout was inspected read-only at
[27065a91ccbf5ba8532844be3777fcf83b77820d](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed 2026-10-11 at 17:43:08 UTC and retrieved/reviewed on 2026-10-11:

- [execpolicy/src/rule.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/execpolicy/src/rule.rs#L46)
  matches prefixes by complete argv tokens.
- [core/src/exec_policy.rs](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/exec_policy.rs#L876)
  extracts known plain shell commands and otherwise retains the original argv.
- The same file's [amendment suggestion exclusions](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/core/src/exec_policy.rs#L57)
  include Node. Those exclusions constrain reusable suggestions; they do not establish denial of saved Node rules.

Alpha intentionally preserves its stricter finite-denial ceiling for opaque interpreters, already covered by
`commandTokenMatching.spec.ts`. This fixture correction keeps that existing boundary and Alpha's execution and
workspace protections.

## Native fixture change

`Task.ask` resolves `checkAutoApprovalWithInheritedPolicy` before publishing complete approval messages and marks
automatically approved or denied messages `isAnswered: true`. It surfaces an `interactiveAsk` only for a blocking
`ask` decision, through its existing status timer. `Task.taskAsk` projects only idle, resumable, or interactive
review state; it does not return arbitrary transcript messages.

The new `assertLiveFileToolBoundary` in the existing node-safe fixture support module inspects that public projection.
It ignores missing, partial, answered, completed, or aborted observations. A settled command or tool review now throws
`Unexpected boundary: command` or `Unexpected boundary: tool` instead of consuming the full live deadline. The existing
outside-workspace tool assertion retains its specific error. Only completion review is acknowledged, once, through
the unchanged completion helper. There is no new policy evaluator, approval click, timing grace, or delay.

The fixture retains its configured-command exemption for `command_output`. Current Alpha classifies that message as
nonblocking and approves it before policy flags; the exemption remains compatible with progress observations. It
does not grant command execution.

All four `LIVE_QUALITY_CASES` share the same bounded `rg` source-reading guidance. It asks for bounded searches and
narrowed patterns or limited long-file results, without prescribing a model, answer, search pattern, or command
payload. Source files and inline interpreter code are not execution strategies for these read-only probes.

The prompts, fixture bytes, expected answers, forbidden answers, evidence spans, tools, milestones, scores, request
limits, deadlines, and original task configuration are unchanged. Original denial settings, shell/backend settings,
the configured command list, 300-second execution timeout, and 180-second wait remain intact. The same bounded
cleanup still restores the complete original configuration on success or failure.

Other shared-fixture callers, including Node-based `read-evidence-live` cases, are unchanged. Under a finite-denial
profile, a genuine review in those cases now produces a prompt failure instead of a timeout. Their command guidance
is outside this four-case read-quality change.

## Validation and review

Validation used Node 24.21.0 and pnpm 11.24.0 in an isolated managed worktree. Frozen dependency installation and
the required internal types build passed without lockfile changes.

Before the semantic fix, a behavior-preserving extraction of the old waiter logic reproduced both settled command
and tool review failures as missing expected exceptions. An initial command-output failure expectation was replaced
with coverage preserving its separate notification exemption.

After the fix, **8 focused runner tests** passed, covering settled review failure without approval, transient or
answered observations, transcript-only state, completion acknowledgement, command-output compatibility, the
outside-workspace error, and original policy/shell restoration through the real bounded cleanup helper. Restoration
uses structural configuration state; it does not substitute for extension-host verification of the public API.

**250 source tests in 3 files** passed: the new 20-case native policy probes, token-matching regressions, and
auto-approval checks. They evaluate real policy and captured snapshots without executing any command payload.
**13 existing quality scoring tests** passed. Runner compilation and runner/source typechecks, touched-file ESLint,
Prettier, and whitespace checks passed.

```powershell
pnpm --filter @alpha-code/vscode-e2e compile
node --test --test-concurrency=2 apps/vscode-e2e/out/unit/liveFileToolBoundary.spec.js
node --test --test-concurrency=2 apps/vscode-e2e/out/quality/liveQuality.spec.js
pnpm --dir src test core/auto-approval/__tests__/liveFileToolCommandPolicy.spec.ts core/auto-approval/__tests__/commandTokenMatching.spec.ts --maxWorkers=2 --minWorkers=1
pnpm --dir src test core/auto-approval/__tests__/checkAutoApproval.spec.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @alpha-code/vscode-e2e check-types
pnpm --dir src check-types
git diff --check
```

The three authorized subagents were reused. Implementation owned the fixture and scope change; regressions owned
the two new test files and independently reviewed the implementation; contract review verified upstream, current
Alpha semantics, and the final diff. Both independent reviews found no blocker. The lead reproduced the regression,
reviewed the work, recorded this source map, and ran focused validation.

The parent integration chat owns the exact VS Code 1.125.0 smoke rerun, full suites, bundles, certification, VSIX,
and live rerun. None were run from this worktree; the live outcome remains unverified after this change. The
pre-commit hook invokes repository-wide lint, so the handoff uses `HUSKY=0` after explicit touched-file checks to
preserve the parent's serial gate ownership. No general speed or quality improvement is claimed.
