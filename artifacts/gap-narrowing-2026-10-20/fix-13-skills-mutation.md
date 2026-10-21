# Fix 13: skill authoring mutation integrity

Mode: correctness cleanup. Implementation slice for `clean-07-extensions.md`, finding 2 (High / must-fix).
Runtime verified: Windows, Node `v24.21.0`, pnpm `11.24.0`. Review/source retrieval: 2026-10-20.

## Owning invariant and cause

Settings mode changes must not write an old instruction body over a user save or save a document that already contains
unapproved unsaved instructions. A newly created skill must not replace a file created by someone else after discovery.

The active route is `SkillsSettings` → `handleUpdateSkillModes` → `SkillsManager.updateSkillModes`. The manager previously
read the entire `SKILL.md` through Node, changed its frontmatter, and wrote the captured body back with an unconditional
`fs.writeFile`. The Settings host operation has no Task owner; manufacturing one to enter a task-owned gate would widen
the wrong boundary. Wire shapes and existing skill selection/source/approval semantics remain unchanged.

## Patch

- `SkillsManager.updateSkillModes` delegates to a focused document transaction. It retains its original source and bundled
  path checks. The helper validates the resolved target before acquiring a file lease and again inside the transaction.
- The helper reuses `WorkspaceMutationGate` across manager instances and `withFileLock` across cooperating extension
  windows. It pins the canonical path, detects a changed alias, and rejects dirty documents, including dirty documents
  opened under another symlink URI.
- It opens the file as a VS Code document, checks its version/text against disk, and applies only the frontmatter range
  through `WorkspaceEdit`. No await separates the final snapshot check from edit dispatch. VS Code captures and validates
  the opened document version across that dispatch; there is no raw-file write fallback.
- The original instruction body remains untouched in the document. CRLF, a missing final newline, UTF-8 BOM, unrelated
  YAML values, and explicit empty mode restrictions have coverage. Only `modeSlugs` and the retired frontmatter `mode`
  change; the existing YAML serialization convention remains.
- Before saving, the transaction rejects newer disk/editor content and requires host save-conflict protection
  (`files.saveConflictResolution: askUser`). It uses `TextDocument.save`, checks its result and final document state, and
  never forces a conflicting save. A late failure retains the pending document edit for recovery instead of attempting a
  rollback that could erase a newer amendment. The localized error directs the user to resolve/reload and retry.
- `createSkill` rechecks its existing bundled-path guard and uses `flag: wx`. `EEXIST` maps to the existing localized
  already-exists error. Its existing validation, `.agents` location, and refresh behavior remain.

## Regression and verification evidence

Before implementation, this command ran against the original production write path:

```sh
pnpm --dir src test services/skills/__tests__/SkillsManager.mutation.spec.ts --maxWorkers=1
```

Result: **8 tests failed**, all for the intended missing protections or body alteration. Tests covered a real-file save
injected after reading the original contents, a dirty editor, a document change during snapshot checking, a host version
rejection after dispatch, a disk change at host save, CRLF/body-ending preservation, unsafe overwrite configuration, and
exclusive creation. The original method resolved instead of rejecting conflicts; its serialization added a final newline.

The regression fixture uses real temporary files and real Windows junctions. Controlled read/apply/save callbacks model
the two host boundaries; they do not use sleeps or network access. Host apply captures a document version synchronously
and rejects a subsequent change. Host save compares real disk bytes with the document's original disk snapshot and can
return false. This is a deliberate host-contract model, not a real extension-host test or a claim that VS Code uses a
bytewise filesystem compare-and-swap.

Five later cases cover a post-apply unsaved amendment, BOM/unrelated metadata/empty modes, writable and protected real
directory aliases, and a dirty alternate symlink URI. The focused file now has **13 passing tests**.

Final affected-surface command:

```sh
pnpm --dir src test services/skills/__tests__/SkillsManager.mutation.spec.ts services/skills/__tests__/SkillsManager.spec.ts services/skills/__tests__/SkillsManager.policy.spec.ts services/skills/__tests__/SkillsManager.explicit-selection.spec.ts services/skills/__tests__/SkillsManager.nested-discovery.spec.ts services/skills/__tests__/SkillsManager.ws07-public.spec.ts core/webview/__tests__/skillsMessageHandler.spec.ts --maxWorkers=1
```

Result: **7 files, 180 tests passed** (9.70 seconds). The pre-existing manager spec now mocks the document transaction
boundary rather than expecting its removed raw write; the new real-file suite covers that transaction. An intermediate
run found that old mock assumption (1 failed / 166 passed), which was corrected without weakening production assertions.

`pnpm exec prettier --check` passed for the five touched source/test/locale files. `git diff --check` passed for the tracked
changes. Final diff inspection found no lockfile, generated artifact, unrelated source, dependency, or release changes.

Not run in this implementation slice: extension-wide typecheck, builds, and exact VS Code 1.138.0/1.125.0 host gates. The
parent coordinator reserved those broader checks; this slice does not claim they passed. Required integration follow-up:

```sh
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
pnpm --filter @alpha-code/vscode-e2e test:compatibility:1250
```

## Current upstream and minimum-host sources

Codex CLI commit inspected: `c7234c1174b27d9c55199fba0d546dc27d1b0415`, using the coordinator's local source checkout.

- [Codex config manager](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server/src/config_manager_service.rs):
  `apply_edits` confines config writes to the user layer and rejects an `expected_version` mismatch before applying edits.
- [Codex config RPC tests](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server/tests/suite/v2/config_rpc.rs):
  `config_value_write_rejects_version_conflict` verifies a stale version produces `configVersionConflict`.
- [Codex config editor](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/core/src/config/edit.rs)
  and [skill config route](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/app-server/src/request_processors/catalog_processor.rs):
  skill enablement is a config edit; the lower-level editor resolves symlink write paths, applies structured edits to the
  parsed document, and persists with atomic replacement. Alpha keeps its own first-class frontmatter mode associations
  and native VS Code document handling; no upstream code, prompt, runtime, or sandbox was copied.

VS Code **1.125.0** source and installed `@types/vscode@1.125.0` were inspected for the used stable APIs:

- [ExtHostBulkEdits](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/api/common/extHostBulkEdits.ts)
  obtains open document versions and converts a workspace edit before sending it to the main thread.
- [WorkspaceEdit conversion](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/api/common/extHostTypeConverters.ts)
  associates text edits with the open resource's version.
- [BulkTextEdits](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/contrib/bulkEdit/browser/bulkTextEdits.ts)
  validates versions before preparation and again before applying model edits.
- [TextFileEditorModel](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/services/textfile/common/textFileEditorModel.ts)
  supplies the resolved file's modified-since metadata when saving, and retains a dirty model on save conflict.
- [FilesConfigurationService](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/services/filesConfiguration/common/filesConfigurationService.ts)
  disables that protection when configured to overwrite external file changes; the new transaction rejects that setting.

## Concurrency limits and closure

Fixed now: the reproduced unconditional stale-body overwrite, dirty-document bypass, dirty symlink-alias bypass, body
newline alteration, and check-then-overwrite skill creation. Bundled aliases remain protected and writable sibling aliases
remain usable. These results are scoped to the skill authoring paths above.

The file lease is advisory and only serializes cooperating Alpha writers. It does not lock a user's editor or arbitrary
external process. Actual disk safety after save dispatch remains the supported VS Code file-provider modified-since
contract, not a portable atomic content CAS. Equal metadata timestamps/sizes, a noncooperating writer racing after the
host's filesystem check, hostile concurrent parent/symlink replacement, other extensions/save participants, and edits
arriving after save dispatch are host/filesystem limits. Such editor amendments must remain recoverable, but a host save
can include them; the final version/content checks report the stale update rather than claiming the originally captured
edit succeeded. Live exact-host tests remain necessary to verify this integration's actual host behavior.

Out of scope: moving or deleting skill directories, Task/AlphaProvider changes, new approval authority, mode runtime
semantics, arbitrary filesystem CAS, and changes to built-in skills. This patch does not claim broader repository closure.

Exact files owned by this slice:

- `src/services/skills/SkillsManager.ts`
- `src/services/skills/skillMutation.ts` (new)
- `src/services/skills/__tests__/SkillsManager.spec.ts`
- `src/services/skills/__tests__/SkillsManager.mutation.spec.ts` (new)
- `src/i18n/locales/en/skills.json` (two English error keys)
- `artifacts/gap-narrowing-2026-10-20/fix-13-skills-mutation.md` (this report)

## Follow-up: variant-identity host fixture, 2026-10-21

The coordinator's broader extension suite exposed a separate test fixture that still modeled raw filesystem skill
updates: `src/core/webview/__tests__/skills-variant-identity.spec.ts`. Running that file reproduced **9 failures / 49
passes**. The successful mode-change cases failed because the fixture omitted iterable `workspace.textDocuments` and
returned an empty object from `openTextDocument`; it also lacked workspace edit and document save behavior. No additional
production defect was found in this follow-up.

Only this additional test file and the report were changed. Its controlled host now tracks open document identities and
versions, captures the version before asynchronous edit application, rejects changed/closed documents, and saves real
files only when their original disk snapshot still matches. It preserves the fixture's read-only virtual built-in
document path. The model follows the existing mutation regression fixture, including BOM/EOL handling. All original
variant identity, exact path, directory override, bundled read-only, legacy-selector, instruction-body and Any-mode
rediscovery/reload assertions remain unchanged. No production fallback or policy weakening was introduced.

Verification:

```sh
pnpm --dir src test core/webview/__tests__/skills-variant-identity.spec.ts --maxWorkers=1
```

Result after the fixture change: **58 tests passed**.

```sh
pnpm --dir src test core/webview/__tests__/skills-variant-identity.spec.ts services/skills/__tests__/SkillsManager.mutation.spec.ts services/skills/__tests__/SkillsManager.spec.ts services/skills/__tests__/SkillsManager.policy.spec.ts services/skills/__tests__/SkillsManager.explicit-selection.spec.ts services/skills/__tests__/SkillsManager.nested-discovery.spec.ts services/skills/__tests__/SkillsManager.ws07-public.spec.ts core/webview/__tests__/skillsMessageHandler.spec.ts --maxWorkers=1
pnpm --dir src exec eslint core/webview/__tests__/skills-variant-identity.spec.ts services/skills/SkillsManager.ts services/skills/skillMutation.ts services/skills/__tests__/SkillsManager.spec.ts services/skills/__tests__/SkillsManager.mutation.spec.ts --max-warnings=0
```

Result: **8 files / 238 tests passed** (8.44 seconds); scoped ESLint passed with zero warnings. The additional fixture file
was formatted with Prettier and passed `git diff --check`. Broader extension/type/host gates remain the coordinator's
responsibility; they were not rerun by this implementation agent.
