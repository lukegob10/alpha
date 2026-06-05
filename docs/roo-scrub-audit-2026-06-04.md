# Roo Reference Scrub Review (Alpha migration)

Date: 2026-06-04  
Branch: `codex/roo-reference-scrub`  
Owner: local review

## Scope

This document is a review-only pass. It lists where `"Roo"` / `"roo"` still appears in the codebase, what they represent, and what would be required to safely migrate them to Alpha naming.

## 1) Runtime-critical references (must decide before changing)

- `packages/types/src/provider-settings.ts`

    - `RooCode` provider value strings and provider metadata.
    - Likely persisted user settings / external integrations depend on these exact values.
    - Risk: breaking saved data + CLI/runtime interoperability if changed without migration.

- `packages/types/src/events.ts` and `packages/types/src/task.ts`

    - Event/task naming includes `RooCode...` and references to Roo domain IDs.
    - Used by message contracts between extension/core/webview and likely external clients.
    - Risk: protocol breakage if changed without versioned fallback.

- `src/services/roo-config/index.ts`

    - `.roo` directory logic (global/project discovery and config load paths).
    - Risk: workspace data migration impact and legacy folder compatibility.

- `src/core/config/CustomModesManager.ts`
- `src/core/prompts/sections/custom-instructions.ts`

    - `.roo` custom-instruction and rules directory usage.
    - Risk: existing user projects with `.roo/rules-*` files stop loading if renamed abruptly.

- `src/core/ignore/RooIgnoreController.ts`
- `src/core/protect/RooProtectedController.ts`
- `src/core/task/Task.ts`

    - Runtime behavior for ignore/protection logic still uses Roo naming and identifiers.
    - Risk: behavioral change if names/filenames are changed without migration.

- `src/services/mcp/McpHub.ts`
- `src/services/marketplace/SimpleInstaller.ts`
- `src/services/marketplace/MarketplaceManager.ts`

    - `.roo/mcp.json` fallback behavior and related discovery flow.
    - Risk: external configuration compatibility for existing MCP setups.

- `src/extension.ts`
    - `ROO_CODE_IPC_SOCKET_PATH` and related IPC path env.
- `apps/cli/src/agent/extension-host.ts`
    - `ROO_CLI_RUNTIME` environment selection.
- `packages/evals/src/cli/runTaskInCli.ts`
- `packages/evals/src/cli/runTaskInVscode.ts`

    - `ROO_CODE_CLOUD_TOKEN`, `ROO_CODE_IPC_SOCKET_PATH`, and `/roo/` path conventions.
    - Risk: CI/test/CLI tooling contracts.

- `packages/core/src/debug-log/index.ts`

    - `~/.roo/cli-debug.log` output path.
    - Risk: losing old log location expectations during migration.

- `src/integrations/terminal/ShellIntegrationManager.ts`
    - `ROO_ZDOTDIR` and `roo-zdotdir-*` temp naming.
    - Risk: shell environment compatibility and script expectations.

## 2) Client/diagnostic labels and user-facing wording

- Multiple diagnostics and UI strings still include Roo branding, e.g.:
    - Roo diagnostics headings/messages.
    - Settings/help text and command labels.
- These are mostly string-level changes and are lower risk if the underlying behavior remains identical.

## 3) Likely safe-to-surface renames (lower risk)

- Text branding: diagnostic messages, labels, UI copy, docs references, and comment/variable names with no external contract attached.
- Internal class/file naming that is not serialized or stored in external payloads (only if compile/test-safe).

## 4) What I recommend changing in phases

1. Introduce Alpha aliases first

    - Keep current Roo names as canonical wire/storage keys.
    - Add Alpha aliases in user-facing labels and logs.

2. Add compatibility migration layer

    - For each runtime contract (`provider`, event/task names, env vars, config paths), support both old and new names.
    - Map legacy values inbound and emit canonical Alpha values outward where safe.

3. Migrate docs and user messaging

    - Update `webview-ui`, `docs`, and diagnostics text after compatibility layer is in place.

4. Optionally deprecate legacy aliases
    - Add explicit deprecation warnings and eventual removal plan.

## 5) Dependency and risk checklist before rename execution

- Data migration for persisted state (settings, caches, `.roo` files on disk).
- Inter-process and external protocol compatibility (webview bridge, eval harnesses, CLI runner, marketplace config, IPC env surface).
- Legacy `.roo` workflow behavior for user projects.
- Test suite updates where assertion snapshots include Roo strings.
- Backward compatibility plan with rollback strategy.

## 6) Open questions before refactor

- Is it acceptable to keep `.roo` directory conventions as compatibility aliases permanently?
- Which external integrations depend on specific env vars (`ROO_CODE_*`) and should not break?
- Can we keep protocol strings (`RooCode...`) while rebranding UI text only, or do we want a full wire-level rename?
- What is the acceptable compatibility window before removing legacy names?

## 7) Existing related docs

- `docs/roo-to-alpha-branding-audit.md`
- `ALPHA_SERVER_COMMUNICATION_POINTS.md`

These already capture prior branding and backend interoperability context and should be used as the migration design baseline.
