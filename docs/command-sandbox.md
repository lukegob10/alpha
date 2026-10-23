# Command and path approval

Alpha executes commands through its normal inline or VS Code terminal. Approval, path preflight, cancellation, and output
capture use the shared scheduler and tool boundaries. The extension does not provision an OS sandbox or repair OS
permissions.

## Approval boundary

Auto approves commands run from the workspace without a saved prefix. Ask requests ordinary command approval unless an
explicit non-wildcard saved prefix allows the command. Full Access skips ordinary per-action review where permitted.
Explicit denials, disabled tools, Plan restrictions, and narrower inherited authority remain effective in every mode.
Any matching deny wins over an allow; arguments are case-sensitive.

The built-in allowed-prefix list is empty. A one-time migration removes only the former product defaults `git log`,
`git diff`, and `git show` from global state, preserving other saved prefixes and VS Code user/workspace/folder settings.
Users can deliberately re-add a prefix for Ask mode. See the [approval policy](approval-mode-policy.md) for MCP, Tickets,
and inherited-agent decisions.

## Path preflight

Before approval, the scheduler examines common file destinations:

- Output/append redirections, including forms without spaces.
- Common PowerShell, CMD, and POSIX write/delete/copy/move commands and output flags.
- Working-directory options and supported directory changes within command chains.
- Quoted paths, supported environment variables, traversal, and existing symlinks/junctions.
- Shell wrappers and PowerShell encoded commands within a bounded inspection budget.

In Ask and Auto, detected writes outside captured task roots or recognized writes with unresolved destinations require
review even when a command prefix matches. The card displays resolved paths and unresolved-path context; approval covers
that run only. Saving a prefix does not grant outside-path access. Full Access skips the ordinary outside-path review;
captured managed-agent restrictions still apply. Known read commands can use an outside working directory; other commands
with one require review.

Canonical path identities are captured and rechecked after approval before dispatch. File tools retain their own mutation
gates, stale-content checks, `.alphaignore`, and protected-file rules.

Preflight is not process isolation. It does not interpret arbitrary script bodies or guarantee exhaustive shell parsing.
Scripts, aliases, hooks, dynamic paths, network access, and descendant processes remain subject to OS-account permissions
and the user's command authorization. Do not describe Auto as OS-enforced workspace confinement.

## Literal command text

Structured native command strings are literal shell input. Approval, ignore/path checks, direct audited reads, and terminal
dispatch must consume the same text. Registry adapters may translate argument names or timeout units but cannot decode
HTML entities in command content. Historical native `execute_command`/`command` aliases remain accepted with literal
contents; saved transcripts are not rewritten.

Multi-file `apply_patch` retains independent per-file preflight and outcomes: invalid/ignored files are skipped while
independently valid files can apply; a later approval denial stops subsequent files. Ignored files are not read.
The aggregate status reports any failure and does not imply an all-or-nothing filesystem transaction.

## Terminal compatibility and validation

Saved terminal selection remains authoritative. Shell-integration timeout and command delay apply to the VS Code terminal,
not inline execution. Settings use the existing buffered Save/Cancel flow. Unused runtime files from retired implementations
do not authorize deletion of shared Codex/account data.

Regression coverage includes command path scope, outside-workspace access, denied effects, junction retargeting, literal
native commands, terminal lifecycle, child ceilings, and command-card presentation.

```sh
pnpm --dir src check-types
pnpm --dir webview-ui check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:command-paths:1380:run
```
