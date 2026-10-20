# Upgrade configuration continuity findings

Investigation date: 2026-10-19, America/New_York. Owner: upgrade/configuration track in the 15-agent UX reliability hunt.
No real user profiles, secret values, or sign-in stores were inspected or reset.

## Confirmed: legacy mode bindings can select the wrong provider

`ProviderSettingsManager.initialize()` built `modeApiConfigs` before assigning missing IDs to saved profiles. A profile
store with no IDs and no mode map therefore persisted mode bindings to an ID that did not belong to any profile. When
another profile already had an ID, a selected profile without an ID instead inherited that other profile's binding.
Restoring an older task without its own `apiConfigName` can then use the wrong saved provider/model or silently fall
back to the current configuration. Existing task-specific profile restoration remains authoritative.

The fix assigns profile IDs first, seeds new mode bindings from the selected profile, and repairs existing dangling
bindings for executable modes. Existing valid choices, absent choices in an existing map, and retired-mode metadata
remain intact. The repair is idempotent and shared by sidebar/editor callers of this manager.

Severity: medium; wrong provider selection can prevent continuation or unexpectedly change the model. The affected
boundary is precisely the pre-ID/pre-mode-map storage shape. The store does not record a release version, so no exact
earliest affected extension release or population frequency was established.

## Confirmed: a supported old value can delete a saved profile

The existing mistake-limit migration intentionally accepts a null/missing `consecutiveMistakeLimit`, but `load()`
validated each profile with the current non-null schema first. A legacy profile containing
`consecutiveMistakeLimit: null` with the migration flag absent/false was silently omitted. Initialization then persisted
the filtered profile map while marking migrations complete. This could permanently erase the entire saved profile,
including its associated configuration, rather than merely default its mistake limit.

The fix converts that recognized legacy null value to `DEFAULT_CONSECUTIVE_MISTAKE_LIMIT` before current-schema
validation, only while the migration remains pending. IDs, model selection, unknown legacy metadata, and other profile
fields survive the migration. Severity: high because the old path loses saved configuration.

The investigation also observed that other arbitrary schema-invalid profiles were filtered by the reader. That
remaining risk is now closed by [the saved profile retention contract](provider-profile-retention-2026-10-19.md), which
preserves invalid data without broadening executable schema acceptance.

## Codex reference

Reference commit: [091008729d5572712ac08964a9602eb71cf31428](https://github.com/openai/codex/commit/091008729d5572712ac08964a9602eb71cf31428),
retrieved 2026-10-19. Source and tests were inspected in the verified local reference checkout.

- [`core/src/config/edit.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/config/edit.rs)
  records model migration acknowledgements as targeted configuration edits.
- [`core/src/config/edit_tests.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/config/edit_tests.rs)
  includes `blocking_record_model_migration_seen_preserves_table` and tests preserving nested legacy/unknown settings.
- [`core/src/config/mod.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/core/src/config/mod.rs)
  reports an explicit missing-provider error rather than silently substituting another configured provider.
- [`tui/src/model_migration.rs`](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/tui/src/model_migration.rs)
  represents migration acceptance, rejection, and exit as explicit outcomes.

Alpha retains its existing provider-neutral TypeScript configuration manager and VS Code SecretStorage contract.
No Codex source or prompts were copied. These fixes follow the observed preservation/explicit-selection behavior;
they do not introduce a new configuration engine.

## Validation and limits

Four focused assertions failed before the corresponding fixes: three mode-binding cases and one null-limit profile-loss
case. The five new upgrade tests also cover idempotent reopen, valid per-mode choices, absent choices, retired metadata,
and selected-model preservation. Final validation passed all 183 tests across five affected config suites:

```sh
pnpm --dir src test core/config/__tests__/ProviderSettingsManager.upgrade.spec.ts core/config/__tests__/ProviderSettingsManager.spec.ts core/config/__tests__/ProviderSettingsManager.renameProfile.spec.ts core/config/__tests__/ContextProxy.spec.ts core/config/__tests__/importExport.spec.ts --maxWorkers=1
```

ESLint for both touched TypeScript files, focused Prettier, and `git diff --check` passed. Extension typecheck and exact
VS Code 1.138.0 validation belong to the integrating agent's combined gate.

These findings substantiate a specific lingering-setup risk for old saved shapes. They do not establish that infrequent
updates generally expire sign-in, that every UX hang is a setup issue, or that either old shape existed in the user's
reported chat. Already-deleted profile data cannot be reconstructed from the remaining store by this fix.
