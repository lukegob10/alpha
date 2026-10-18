# Standalone CLI retirement

Date: 2026-09-17. Scope: contract alignment and deletion of Alpha's standalone CLI.

## Plan and boundaries

1. Remove `apps/cli`, its exclusive `packages/vscode-shim`, CLI release automation,
   stdin/event schemas, debug logger and core CLI entry point. Prune only dependencies
   no longer reachable from the remaining workspace packages.
2. Remove the `ROO_CLI_RUNTIME` branches from command timeouts, approval preparation
   and profile restoration. Preserve the existing VS Code behavior, shared execution
   kernel, tools, IPC, task history, skills, MCP, terminal sessions and all extension surfaces.
3. Keep the existing VS Code evaluation runner. Remove the CLI runner and execution
   selector. Reject CLI execution in new run requests. Keep historical database values
   readable; attempts to execute a retired CLI run must fail before launching an agent,
   with an actionable message. Do not relabel historical results or delete user data.
4. Run focused regressions, workspace lint/types/tests and dependency checks, then
   bundle, package inspection, the exact VS Code 1.122.1 smoke gate and the unattended
   live Copilot harness exercise.

The dependency search found no extension import of the shim or CLI protocol. Shared
packages remain; only their exclusively CLI exports are removed. Development commands
and the evaluation orchestrator under `packages/evals/src/cli` remain: these launch
tests and the real VS Code extension, not a second Alpha agent application.

The checkout already contained unrelated and earlier harness work. Its pre-removal
state was captured outside the repository in
`alpha-cli-removal-baseline-20260917-003553` under the local temporary directory.
Those changes must remain intact. This task does not publish a release, change a version,
remove installed software, delete home-directory data, or rewrite past release notes.

## Compatibility and verification

The intentional removals are the standalone `alpha` executable, its shim, CLI-only
package exports and CLI evaluation execution. Existing extension APIs and saved task
formats retain their contracts. Retired paths remain forbidden in automated patch
plans so subsequent extension maintenance cannot recreate a parallel CLI.

The implementation removes 223 tracked files (37,206 lines) and 26 exclusive dependency
versions. Remaining workspace importers and dependency versions are unchanged. The
lockfile change contains deletions only. Historical release notes remain as history;
unused CLI announcements and the CLI release/debug instructions are removed.

Regression tests verify that an inherited retired environment flag cannot suppress
command timeouts or saved provider restoration. Evaluation tests exercise VS Code
routing, cancellation, failure, budget-result classification, and rejection of legacy
CLI runs before launching a local agent or container. The server action validates new
run requests before creating database records. Historical database values remain readable.
