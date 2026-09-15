# Command and path approval

## Contract (2.1.40)

Alpha uses the normal inline or VS Code terminal. There is no downloaded command runtime, Codex executable, OS sandbox,
Windows account provisioning, or permission repair in the extension. This replaces the native runtime introduced in 2.1.39.

Global command auto-approval and allowed/denied prefixes decide whether ordinary commands ask. `*` permits scripts,
computed commands, builds, tests, and network commands. Existing explicit deny rules, disabled tools, Plan restrictions,
and inherited child authority still apply. Preferences use the existing global store and persist across projects/reloads.

The execution scheduler separately examines common file destinations before command approval:

- File output redirections, including append and redirections without spaces.
- Common PowerShell, CMD, and POSIX write, delete, copy, and move commands. Copy sources may be outside the root.
- Common output flags and working-directory options. Directory changes in a command chain affect subsequent checks.
- Quoted paths, supported environment variables, traversal, and existing symlinks/junctions.
- Shell command wrappers and PowerShell encoded commands, within a bounded inspection budget.

Detected writes outside the captured task roots require explicit approval, even with `*`. A recognized write whose
destination cannot be resolved also requires review. The command card displays the paths and unresolved-path notice;
approval applies to that run only. Updating command prefix rules does not grant outside-path approval. A restricted
managed child cannot acquire outside authority from a prompt. Known read commands can run from an outside directory;
other commands with an outside working directory require review.

Canonical path identities are captured by the existing scheduler and rechecked after approval, before dispatch.
Native file tools retain their existing outside-write approval and mutation gates. `.alphaignore`, protected files,
cancellation, output capture, and command lifecycle bookkeeping remain at their existing owning boundaries.

## Deliberate limits

This is a command/path preflight, **not process isolation**. Unknown programs and arbitrary script bodies are allowed by
the user's command rules. A script, hook, alias, dynamically calculated path, or descendant process can access any file
permitted by the user's OS account. The preflight does not interpret arbitrary JavaScript/Python or audit script files.
It neither guarantees exhaustive shell parsing nor claims to prevent every outside write. Settings and policy summaries
describe this limitation.

## Compatibility and validation

The saved terminal selection is honored again. Shell-integration timeout and command delay controls apply to the VS Code
terminal; inline execution does not use those host-shell controls. Settings inputs still use the cached Save/Cancel buffer.
No settings reset or per-project setup is introduced. Runtime files left by 2.1.39 are unused; Alpha does not delete shared
Codex installation or account data.

Regression coverage lives in `commandPathScope.spec.ts`, `outsideWorkspaceAccess.spec.ts`, command/lifecycle tests,
`CommandExecution.spec.tsx`, and the shared message-schema test. The exact VS Code 1.122.1 release gate is followed by
`test:command-paths:1221:run`, which checks ordinary auto-approval, outside-path approval presentation, and actual command
execution after a one-run approval. Unit tests verify that denying review prevents the effect, that junction retargeting
is rejected, and that restricted child policy cannot be widened.
