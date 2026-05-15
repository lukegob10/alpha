# Roo To Alpha Branding Audit

This document records the rebrand pass from Roo to Alpha. The pass removes non-core Roo marketing and support surfaces, renames local package and CLI branding, and leaves only compatibility contracts that are likely to affect authentication, provider routing, settings migration, file rules, or persisted user data.

## Changed In This Pass

- Deleted the non-core marketing website app at `apps/web-roo-code`.
- Removed website deploy and preview workflows.
- Removed workspace/config references to the deleted website app.
- Renamed internal package imports and package manifests from the `@alpha-code/*` scope to `@alpha-code/*`.
- Renamed the CLI package and command to `alpha`; no `roo` binary alias is kept.
- Reset root and CLI changelogs for Alpha.
- Removed old Roo community, blog, social, legal, and support links from root docs, issue templates, PR template, localized repo docs, and `.alpha` agent assets.
- Replaced safe user-facing extension/webview/CLI names, temporary filenames, workflow names, test fixtures, and generated metadata with Alpha equivalents.
- Renamed safe welcome UI modules from legacy welcome to `AlphaHero`/`AlphaTips`.
- Renamed eval-only local-storage/model helper names from Roo to Alpha while preserving model/provider values where they represent runtime provider routing.
- Added `alpha-cloud` as the CLI-facing provider name while preserving the guarded internal provider ID.
- Replaced non-contract request identity strings in OpenAI/Unbound integrations with Alpha identifiers.

## Deferred Because Core-Impacting

The following Roo references are intentionally left for a later backend/data migration. Changing them in this pass risks breaking authentication, model routing, persisted settings, file-ignore behavior, or public extension API compatibility.

- Provider ID and router internals: `"roo"`, `src/api/providers/roo.ts`, `src/api/providers/fetchers/roo.ts`, and `packages/types/src/providers/roo.ts`.
- Cloud/router/auth environment variables: `ROO_CODE_*`, `ROO_AUTH_BASE_URL`, `ROO_SDK_BASE_URL`, and related runtime overrides.
- Legacy cloud endpoints: `app.roocode.com`, `api.roocode.com`, `cloud-api.roocode.com`, `clerk.roocode.com`, and `ph.roocode.com`.
- Local project and persisted file contracts: `.roo`, `.rooignore`, `.rooprotected`, `showRooIgnoredFiles`, and persisted `roo_*` state keys.
- Public API and event type names: `RooCodeAPI`, `RooCodeEventName`, `rooCodeEventsSchema`, and related public schemas.
- Cloud balance and portal message contracts such as `requestRooCreditBalance` and `RooBalanceDisplay`.
- Compatibility controllers and tests for protected files and ignore behavior: `RooIgnoreController`, `RooProtectedController`, and their direct tests.
- Enterprise MDM policy locations using `RooCode` or `/etc/roo-code`; changing those paths would strand existing managed deployments without a migration.
- Legacy MCP/config locations such as `.roo`, `.roo-code`, and `src/services/roo-config` where they are used as fallback or import compatibility paths.

## Follow-Up Migration Work

- Define Alpha-owned cloud/auth/model endpoints and then migrate the guarded endpoint defaults and environment variable names with backward-compatible aliases.
- Decide whether public API names such as `RooCodeAPI` can be versioned or aliased without breaking consumers.
- Plan a persisted settings migration for `.roo*`, `roo_*`, and `showRooIgnoredFiles` keys before renaming them.
- Revisit provider ID `"roo"` only after model routing and existing user configurations can be migrated safely.
