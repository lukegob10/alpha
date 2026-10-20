# Persistence UX reliability hunt — 2026-10-19

## Confirmed defects

| Severity | Trigger                                                                                                                                                         | Root cause                                                                                                                                                                                                                                                      | Result after fix                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Reopen or background-read a saved chat while its UI transcript is being saved; host exit or failed rollback in the same window                                  | `saveTaskMessages` used the streaming writer's backup-first replacement. Between moving the old file aside and publishing the new file, `ui_messages.json` did not exist. Strict readers reported `not_found`; tolerant readers returned an empty conversation. | The existing writer uses its atomic replacement option. Readers retain the previous canonical snapshot until the replacement commits. A failed replacement leaves the previous file readable without a rollback rename. |
| P2       | Two cold readers open a task still using `claude_messages.json`, or another writer publishes its canonical transcript after a reader initially observes absence | The migration admission check treated newly present authoritative history as a failure requiring reload, even after another reader had successfully completed migration.                                                                                        | After acquiring the existing sidecar/authority locks, the reader follows the validated canonical transcript. Both overlapping legacy readers receive the same migrated history.                                         |

The second change deliberately replaces the old test's expectation that a successful concurrent migration must reject the second reader. It does not permit a fallback to overwrite canonical history. A newly present invalid transcript fails validation and retains both files. A v2 transcript still requires matching receipt bytes, preserves conflict evidence, and rejects missing or conflicting authority. No storage schema or provider metadata is migrated by these fixes.

## Codex CLI comparison

Reference: official OpenAI Codex source at commit `091008729d5572712ac08964a9602eb71cf31428`, retrieved 2026-10-19 (America/New_York).

- [Rollout recorder](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/rollout/src/recorder.rs): one queued writer appends canonical items; its pending suffix survives failed writes. Persist, flush, and shutdown acknowledge the actual writer result rather than treating queue admission as durable success.
- [Recorder tests](https://github.com/openai/codex/blob/091008729d5572712ac08964a9602eb71cf31428/codex-rs/rollout/src/recorder_tests.rs): `persist_reports_filesystem_error_and_retries_buffered_items` and `writer_state_retries_write_error_before_reporting_flush_success` verify retained input and failed-write recovery.

Alpha retains its native streaming JSON snapshots, advisory leases, receipt verification, and existing task runtime. The behavioral alignment is keeping acknowledged history usable while later writes are in progress or fail; no Rust runtime or new persistence engine was introduced.

## Reproduction and validation

- `taskMessages.atomic-replace.spec.ts`: two regressions failed before the fix. A controlled rename barrier reproduced strict-reader `not_found` during a save; an injected replacement/rollback failure stranded the previous snapshot. Both pass after the fix.
- `apiMessagesMigration.spec.ts`: five of six cases failed before the fix. Coverage includes overlapping cold readers, invalid newly present authority, matching v2, conflicting v2 with preserved evidence, and missing v2 without fallback replay. All six pass after the fix.
- Focused UI persistence run: 10 tests passed across two files.
- Focused migration/integrity run: 49 tests passed across four files (`apiMessagesMigration`, `apiMessages`, `transcriptConflict`, `ProviderTranscriptStore`).
- Final combined run after formatting: 59 tests passed across six files. Focused ESLint and `git diff --check` passed.
- Commands used `pnpm --dir src test <file filters> --maxWorkers=1` with controlled promises and injected filesystem failures; no live provider requests were made.

The parent investigation owns consolidated type checking and the exact VS Code 1.138.0 host gate. These focused tests do not establish the frequency of these defects in installed versions or prove the cause of any particular user's unavailable historical chat. Existing orphaned backup files were not automatically selected, overwritten, or deleted.
