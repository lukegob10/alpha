# Patch calls and command shells

## Codex reference

The pinned Codex model instructions in `src/core/prompts/codex-model-instructions.ts` came from upstream commit
`e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1`, retrieved on 2026-09-24. Current Codex CLI source, checked on
2026-09-28, has both a [native `apply_patch` tool](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch.rs)
and an [`exec_command` interceptor](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs).
Its [invocation parser](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/invocation.rs) recognizes a
standalone `apply_patch` heredoc, optionally preceded by `cd <path> &&`, and sends the verified patch to the patch
executor before launching a shell. Codex also accepts a direct two-argument `apply_patch <patch>` process invocation.
The [OpenAI Apply Patch documentation](https://developers.openai.com/api/docs/guides/tools-apply-patch) describes the
native patch operation. The native tool is preferred, but shell-shaped patch calls are a supported compatibility path.

## Alpha behavior

A Copilot GPT-5.6 Sol task tried a Unix here-document in `cmd.exe`, then PowerShell here-string variants, then searched
for an `apply_patch` executable. Alpha had advertised a native patch tool but sent the heredoc to its terminal. A prior
local change responded by rejecting every command beginning with `apply_patch`. That guard was broader than Codex CLI
and could block ordinary terminal commands without applying a valid patch.

Alpha now recognizes a complete, standalone `apply_patch` or `applypatch` heredoc in `exec_command`, with an optional
simple `cd <path> &&` prefix. It routes the extracted body through the registered `ApplyPatchTool`. The original command
call ID remains paired with one terminal result; the effective patch tool controls path checks, approval, mutation
serialization, checkpointing, cancellation, and write receipts. Both the command and patch capabilities must be allowed
by the captured step policy. Command deny rules are checked before interception, and patch mode, task, and workspace
rules are checked before dispatch. `workdir` and the optional `cd` prefix are applied when resolving patch file paths.
Malformed recognized heredocs return a tool error without launching a shell. Other command forms retain ordinary
terminal behavior.

Alpha's VS Code LM and other function-call providers use a JSON `patch` argument. The OpenAI Responses adapter may
expose a freeform patch call. Both use the same canonical patch handler. This schema difference is an extension/provider
adapter detail; model selection does not change tool authority or execution semantics.

The system-information shell describes the interpreter used by `exec_command`, not only the VS Code profile. With
shell integration disabled (the default), Alpha uses Execa: its default `shell: true` uses `cmd.exe` on Windows and
`/bin/sh` on Unix, unless an explicit Execa shell path is configured. With shell integration enabled, Alpha uses the
configured VS Code terminal shell. Managed editing workers always use Execa. See [Execa's shell
documentation](https://github.com/sindresorhus/execa/blob/main/docs/shell.md), checked on 2026-09-28.

## Verification and limits

Focused tests cover heredoc recognition, `workdir` rebasing, policy and mode denial, task write scope, approval identity,
result pairing, and the canonical mutation gate. They also cover command shell reporting and prompt/tool descriptions.
The captured GPT-5.6 Sol Code prompt measures 4,227 local `o200k_base` tokens, versus 4,179 before the patch guidance;
the 48-token increase remains below the predeclared 5,710-token blind-append comparison. Run the exact-host gate with
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` for this runtime change.

On 2026-09-28, focused Vitest suites, `pnpm --dir src check-types`, `pnpm lint`, and the complete VS Code 1.122.1 smoke
gate passed. The smoke gate includes a scripted end-to-end `exec_command` heredoc that creates a file through
`ApplyPatchTool` without starting a terminal command.

Alpha does not parse arbitrary shell scripts or PowerShell here-strings into patches. Those forms are outside the Codex
CLI interception contract; the native patch tool remains available for them. The interceptor cannot guarantee a model
will choose a supported form, so a live Copilot run on the affected host is still needed to measure actual tool choice
and recovery under its specific profile and extension version.
