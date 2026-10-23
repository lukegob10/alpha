# Standalone CLI retirement

Alpha runs as a VS Code extension. The standalone `alpha` application in `apps/cli/`,
its exclusive `packages/vscode-shim/`, CLI-only exports, and CLI evaluation execution
are retired. Do not recreate a parallel agent runtime.

Development commands and `packages/evals/src/cli/` remain supported. They orchestrate
tests and the real VS Code extension through its existing API and IPC boundaries.
The shared execution kernel, task history, skills, MCP, terminal sessions, and extension
surfaces retain their normal contracts.

## Compatibility

- Historical task and evaluation records remain readable with their original execution
  identity. Do not relabel or delete them because CLI execution is retired.
- New evaluation requests reject CLI execution before creating a run. Executing an old
  CLI run fails before launching an agent or container and reports the unsupported path.
- A retained `ROO_CLI_RUNTIME` environment variable cannot suppress extension command
  timeouts, approvals, or saved-provider restoration.
- Extension APIs and saved task formats remain supported. Retired application paths
  remain forbidden in automated patch plans.

Validate affected extension and evaluator routing, cancellation, failure classification,
and historical-record readers. Use the current [testing workflow](testing-harness.md)
and [VS Code host contract](vscode-1.138-migration.md) for the applicable gates.
