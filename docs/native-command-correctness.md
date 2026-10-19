# Native command text preservation

Verified 2026-10-17 against Codex CLI commit
[`8c076942cb70fba8e5c4732c23f1faabc4aed484`](https://github.com/openai/codex/commit/8c076942cb70fba8e5c4732c23f1faabc4aed484).
Its [`unified_exec.rs`](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/tools/handlers/unified_exec.rs)
passes the deserialized `cmd` directly into shell argument construction. The adjacent
[`unified_exec_tests.rs`](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/tools/handlers/unified_exec_tests.rs)
asserts the command argument remains unchanged. Alpha preserves that behavior using its existing TypeScript tools,
registry, scheduler, approvals, terminal transport, and audited direct ripgrep reader.

## Correctness boundary

Structured native command strings are literal shell input. HTML entity decoding changed commands such as
`echo '&amp;amp;'` into `echo '&amp;'`. It also changed prepared ripgrep search patterns and the scheduler's policy/path
assessment. All of these boundaries must consume the same literal text. Registry adapters may translate argument names
and timeout units, but must not decode command content.

`BaseTool.handle` already requires native arguments and rejects XML calls. There is no supported XML ingestion path
that needs command decoding retained here. Historical native `execute_command` and `command` argument aliases remain
accepted with literal contents; saved transcripts are not rewritten. The general HTML normalization helper remains
available to its unrelated consumers.

Regression coverage exercises `execute_command` approval, ignore checks and terminal input; native `exec_command`
through the task tool surface and scheduler into the terminal host; prepared ripgrep direct argv through the registry;
and denied-prefix policy applied to the literal native command. These tests do not require live models.

## Intentional multi-file patch policy

This fix does not change `ApplyPatchTool` partial application. Its read-only sequential preflight records each file's
outcome, skips invalid or ignored files, and applies independently valid files. The existing
`applyPatchTool.spec.ts` case `reports every path after %s preflight failure` deliberately asserts first/third files
apply when the second fails or is ignored. Ignored files are not read. A later approval denial stops subsequent files.
The result reports per-file outcomes and a non-success aggregate status.

At the pinned upstream commit, [`apply_hunks_to_files`](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/apply-patch/src/lib.rs)
applies hunks sequentially and returns on a failed operation, retaining its accumulated delta for earlier effects.
It does not establish an all-or-nothing filesystem transaction. Alpha intentionally retains its existing per-file
preflight and independent-file continuation behavior for compatibility. Changing either failure-continuation behavior
or atomicity requires its own compatibility decision and is outside native command text preservation.
