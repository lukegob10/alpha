# Completion while a background application remains running

Alpha may finish a primary launch turn while its admitted command session remains alive. The process must have returned
to the model in the background, still belong to the same task and physical execution ID in the terminal registry, and
have neither settled nor stopped. An explicit verification association or captured acceptance check keeps the command
blocking. Foreground commands and managed child commands retain their existing completion rules.

The former completion path waited for every running command in implementation turns. Lookup turns could bypass that
wait but still treated the command's retained mutation reservation as a missing receipt. Both waits have a 30-second
deadline, so a successful long-running launch could end in an incomplete/unverified outcome.

Task supplies current process ownership to the shared parent completion policy. The policy omits only matching primary
reservation tokens from its completion projection. It leaves durable reservations, content versions, and verification
accounting intact. Physical exit still publishes the original final receipt and command outcome. Unknown mutation scope,
other pending writes, child review and result obligations, and declared acceptance checks still block completion.
Readiness and correctness are separate claims: a live process proves ownership, not that an application is healthy or
that tests passed.

The ownership exemption exists only in memory. Reloaded reservations have no exemption without a current owned process.
Changes to command evidence or process ownership during an asynchronous completion read cause a refresh. Cancellation,
hard command timeouts, disposal, and terminal reuse keep their existing cleanup and failure semantics.

## Reference behavior

Inspected the current Codex CLI source on 2026-10-03 UTC (2026-10-02 America/New_York), pinned to commit
8f7a0f7a878199c6886600370e5be6bd37ca38a3:

- [Unified execution process manager](https://github.com/openai/codex/blob/8f7a0f7a878199c6886600370e5be6bd37ca38a3/codex-rs/core/src/unified_exec/process_manager.rs):
  stores live sessions before yielding and returns a live process ID separately from a terminal exit code.
- [Unified execution lifecycle tests](https://github.com/openai/codex/blob/8f7a0f7a878199c6886600370e5be6bd37ca38a3/codex-rs/core/tests/suite/unified_exec.rs):
  cover assistant turn completion and later background process end events as distinct boundaries.

Alpha retains its native execution protections and durable mutation ledger. This change applies the independent turn
and process lifetimes at Alpha's existing TypeScript completion boundary. Managed child commands remain finite within
their existing delegated task lifecycle.

## Regression coverage and commands

The focused task and primary-policy tests cover live ownership, terminal reuse, lost/stopped/settled processes,
foreground and child commands, verification associations, declared checks, concurrent completion reads, unmatched
reservations, unresolved scope, durable reload, and final receipt settlement.

The real extension-host scenario launches frontend/backend HTTP services through both terminal adapters, completes the
turn with services alive, then stops the services and checks actual zero exits, receipt settlement, workspace change
projection, and exactly one completion event. It runs in the exact VS Code 1.125.0 smoke gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

For a focused run:

```sh
pnpm --filter @alpha-code/vscode-e2e test:background-apps:1250
```

Set ALPHA_E2E_ELECTRON_BINARY to an absolute Electron executable before that command to additionally run both adapters
against a real hidden BrowserWindow. The fixture verifies loaded renderer content and a live health endpoint; it does
not claim interactive visual or application-specific coverage. Electron is an evaluation input and adds no Alpha
production dependency. Test artifacts record host version, completion latency, process evidence, retained reservations,
transactions, lifecycle, and final settlement.

Investigation logs and current validation results are recorded separately under
artifacts/harness/launch-investigation-2026-10-03/. Earlier sealed benchmark results remain evidence for their original
source and are not reused as validation of this fix.
