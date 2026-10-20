# Saved provider profile retention

This closes the arbitrary invalid-profile loss risk identified in
[the upgrade investigation](ux-reliability-upgrade-config-2026-10-19.md). Investigation date: 2026-10-19,
America/New_York. No real user secrets, profiles, or sign-in stores were inspected or reset.

## Durable contract

The existing SecretStorage document accepts an additive `retainedApiConfigs` map. Each entry contains its stable identity
and original JSON value: `{ id: string, value: unknown }`. Schema-invalid entries move out of executable `apiConfigs`
into this map. Recognized legacy migrations still run before validation. Existing invalid values survive unrelated
saves, rename, export, import, and reopen; explicit validated repair or deletion is required to replace/remove them.
An all-invalid store retains its selected name and data and does not create an unrelated default provider.

Only safe identity metadata crosses into profile lists: `availability: "invalid" | "unsupported"`, and at most ten known
top-level `invalidFields`. Neither raw retained data nor invalid nested key names/values enter this metadata. Supported
profiles retain existing execution schemas. Unsupported identifiers remain readable for editing/export but activation
and availability checks reject them explicitly.

`ProviderProfileUnavailableError` is a lightweight module shared with runtime adapters; it carries only safe identity,
an `invalid`/`unsupported` classification, and field names. The configuration manager reexports it for existing callers.
Whole-store invalid JSON/metadata produces a safe error without resetting or rewriting the stored data.

## Identity and selection

- Duplicate IDs remain unchanged in storage. ID-based reads, activation, save/rename targeting, and bound-mode routing
  reject ambiguity instead of choosing the first matching profile. Name-based valid reads and selection remain available.
- Explicit imports repairing/replacing a retained profile preserve its existing identity. Mode, enhancement, delegated
  default, and delegated role references remap to that identity. Ambiguous incoming reference mappings reject before
  profile persistence. Raw imported invalid values retain their original embedded data, including embedded IDs.
- Explicit saves targeting a retained ID validate the entire replacement before removing retained data. ID-based saves
  cannot select a different profile through a draft's embedded ID.
- Deletion checks the expected clicked identity inside the storage lock, counts retained entries in the last-profile
  guard, preserves inactive selection, and chooses an available remaining profile before an unavailable one. The result
  includes a validated extension-host-only selected-profile snapshot from that same commit for native UI projection.
- Fresh, unsaved views share the portable `default` identity. Existing persisted IDs remain authoritative. Sidebar/editor
  views can resolve each other's initial profile before the first save, and first save/reopen retains that identity.
  Separate SecretStorage stores keep their settings isolated.
- Preserved legacy `name` fields never override authoritative profile-key names in read, activation, or deletion results.

The extension/webview admission and selection adapters consume these checks and metadata in the coordinating change;
the backend never chooses another provider to hide an invalid selected profile.

Configured automatic imports remain authoritative on every activation. A stale configured file can therefore reapply
invalid or unsupported setup after a local repair. Automatic import now reports a bounded warning count and file basename
with guidance to repair that configured file instead of presenting unconditional success. It does not log the retained
payload, silently clear the configured path, or suppress the next import. Malformed JSON import errors also omit file
fragments so automatic-import logging cannot disclose configuration contents.

## Codex reference and intentional adaptation

Current reference: [8196bcdc189ad2c189d631b321fa54b8e09b9bb0](https://github.com/openai/codex/commit/8196bcdc189ad2c189d631b321fa54b8e09b9bb0),
retrieved and source-inspected on 2026-10-19.

- [`config/edit.rs`](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/edit.rs)
  parses existing configuration before editing and writes through its atomic writer. Invalid configuration is not replaced
  by a fresh default.
- [`config/edit_tests.rs`](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/edit_tests.rs)
  verifies targeted migration edits preserve unrelated table data.
- [`config/mod.rs`](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/mod.rs)
  retains an explicitly selected provider ID and reports a missing provider rather than choosing another provider.
- [`config/config_loader_tests.rs`](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/config_loader_tests.rs)
  verifies invalid user configuration produces a structured configuration error.

The retained map is Alpha's adaptation for a multi-profile VS Code settings store. It preserves Alpha's provider-neutral
TypeScript architecture, native SecretStorage, approval/security boundaries, and additional tools. It does not copy a
Codex implementation or imply that all model fallback is forbidden; deliberate model-selection policy remains separate
from refusing to substitute a different provider for an invalid saved profile.

## Verification

Focused regressions reproduced invalid-profile deletion, unsupported activation, invalid import substitution, fresh-view
identity mismatch, and duplicate-ID routing before the corresponding fixes. Coverage also includes all-invalid stores,
primitive values, repeated reopen, arbitrary display names, safe metadata, explicit repair, storage failure, deletion
identity, retained-name overlap, same-name reimport, ambiguous remaps, and real-storage import reference projection.

The final command results are recorded by the integrating agent. Owned checks include the focused configuration and
automatic-import tests with `--maxWorkers=2`, shared provider-metadata tests/typecheck, owned ESLint, focused Prettier, and
`git diff --check`. Extension typecheck, exact VS Code 1.138.0 gates, and combined certification belong to the integrating
agent's final validation.

Already-deleted profile data cannot be reconstructed from a store that no longer contains it. Unsupported providers and
arbitrarily invalid settings require an explicit supported replacement; retention does not invent missing credentials or
grant execution authority to invalid data.
