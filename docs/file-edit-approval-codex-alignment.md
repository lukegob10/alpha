# File edit availability and approval payloads

Verified against Codex CLI commit `7135b303d918fc80fecb8053a92173bd211d2c0a` on 2026-10-02.

## Reproduced failures

1. `build-tools.ts` used the request classifier's lookup preset as both a schema filter and an execution allow-list.
   Requests such as “Use the api-export skill” or “Can you retrieve the export and save the document?” removed
   `apply_patch` from Code tasks even in Full Access. Loading a skill did not change the captured human request, so the
   same restriction persisted on subsequent steps. Direct patches and patches intercepted from shell commands both
   correctly enforced this incorrectly narrowed policy.
2. File edit tools generate review messages containing original content, final content, and diff information. The
   scheduler copied that entire message into `ToolApprovalRequest.description`, whose schema limits summaries to
   100,000 characters. A 94-character patch against a 63,016-character file produced a 132,478-character description
   and failed before the approval host was called. Full Access could not help because validation preceded its decision.
   Other file editors and sufficiently large MCP review payloads used the same boundary.

The regression tests reproduced both failures before the implementation changed. The remote machine's complete
transcript and lifecycle artifacts were not available; these reproductions establish local root causes, not every
claim in that machine's diagnostic summary. In particular, missing lifecycle events, retry exhaustion, and absent
post-edit verification require their own evidence. A completed provider response or scheduler batch does not imply
that every tool succeeded or that the whole task completed.

## Codex reference and Alpha behavior

- [Tool registration](https://github.com/openai/codex/blob/7135b303d918fc80fecb8053a92173bd211d2c0a/codex-rs/core/src/tools/spec_plan.rs)
  registers patch support from tool and environment configuration. Request wording is not an execution permission.
- [Patch safety](https://github.com/openai/codex/blob/7135b303d918fc80fecb8053a92173bd211d2c0a/codex-rs/core/src/safety.rs)
  and [its tests](https://github.com/openai/codex/blob/7135b303d918fc80fecb8053a92173bd211d2c0a/codex-rs/core/src/safety_tests.rs)
  assess actual paths, approval policy, and filesystem permissions.
- [Patch approval runtime](https://github.com/openai/codex/blob/7135b303d918fc80fecb8053a92173bd211d2c0a/codex-rs/core/src/tools/runtimes/apply_patch.rs)
  carries the patch, affected files, and changes as action data.

Alpha now derives its catalog from mode, configuration, captured policy, task role, and available capabilities. It no
longer applies a lookup-wording allow-list. Plan restrictions, explicitly disabled tools, inherited child limits, and
workspace checks remain authoritative. Root delegation guidance follows the same configured availability. The separate
explicit authorization for independent task creation remains in place. Request classification continues to guide
existing completion behavior; this change does not redefine that behavior.

Restricted providers retain historical schemas for replay while the captured policy controls callability. The cache
no longer varies with lookup classification, and the catalog schema version changes so stale captures are not reused.
Ordinary lookup requests may carry more schemas than before; no latency or token-efficiency improvement is claimed.

The scheduler passes full review text separately to `requestToolApproval`. Non-command descriptions over 4,096
characters become short metadata summaries; the complete text reaches the user approval flow and injected reviewer.
`Task.ask` stores that text in the existing message body and only the bounded summary in the typed approval prompt.
Existing one-argument approval callers and persisted prompts remain readable. Reviewers must use the full review text
for action details rather than assume the description contains them.

Command descriptions remain exact, including rejection of commands that exceed the existing schema limit. The host
rejects command review text that differs from the description. Session grants still bind the complete original review
text and arguments, not a summary; oversized identities remain ineligible for session reuse. Denial and cancellation
still prevent effects. No approval limit is raised and no policy or stale-file guard is bypassed.

Alpha retains its existing VS Code approval and workspace protections. Codex's OS sandbox implementation is outside the
alignment scope.

## Regression coverage

- Stable Code catalogs across OpenAI, VS Code LM, and Vertex; Ask, Auto, and Full Access; skill, save, and lookup wording.
- Plan, disabled-tool, captured-policy, child-authority, diagnostic-session, and historical declaration restrictions.
- A real patch handler with tiny changes to small and large files, plus shared approval coverage for other edit tools
  and MCP actions.
- Full review data through the Task, persisted prompt validation, reviewer context, denial, cancellation, exact command
  identity, and session grants for distinct actions with identical summaries.
- Scripted VS Code 1.125.0 cases for tiny changes to large files after a skill request, using direct patches and shell
  interception in all three approval modes. These assert actual disk contents and approval-message validity.

## Validation performed on 2026-10-02

- Twelve focused extension suites: 704 tests passed. These cover the catalog, patch handler, scheduler, Task approval
  flow, completion fixtures, compaction safety, session grants, auto approval, and captured tool surfaces.
- `pnpm --dir src check-types` and `pnpm --filter @alpha-code/vscode-e2e check-types`: passed.
- ESLint on the changed extension TypeScript files and the host test: passed. The scoped diff check passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` built the extension and webview successfully. After correcting
  the new fixture's directory setup, `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250:run` passed all 40 tests in
  twelve suites, including the six new direct/intercepted patch cases. All twelve host receipts report actual VS Code
  version 1.125.0 and `passed`.

The host runs used dedicated temporary Windows profiles, scripted providers (including `approval-mode-host` for the
new regressions), and the VS Code LM fixture. They did not use a live Copilot model. The initial launcher inherited
`ELECTRON_RUN_AS_NODE=1` from the Windows environment; final runs removed that variable only from the test child
environment. No machine setting or launcher implementation was changed.
