# Diff preview ownership

## Scope and root cause

The normal diff-editor path used the target file as editable preview storage. `DiffViewProvider.open()` saved an already-dirty document and read the resulting disk content, even when a caller had calculated its replacement from an older disk snapshot. Approval then saved the replacement over the user's work. Denial also restored and saved the source document. The managed-diff exemption in the shared conflict check could not distinguish these source edits from preview edits.

The inherited snapshot is commit `f00cb5a541a278c622f2982bd2e7dcedc847f5f5`, based on `6a5c3a5745aa5339e9f2e27025bcc8ae42cf6c65`. Its changes are independent of this fix.

## Resulting behavior

- Each edit has a unique temporary file for the editable side of its diff. Previewing does not create, save, edit, or close the source file.
- Callers pass the raw source state used to calculate their replacement. Streaming whole-file writes retain the first preview snapshot.
- Approval checks target content and open-editor identity/version, including changes during asynchronous reads. Dirty source documents always conflict. No stale patch is rebased automatically.
- Preview edits use one `TextEditor.edit` transaction. Streaming stops if the user amended the preview. Approval includes amendments already present in the preview, while a change during save validation conflicts.
- Moves validate the source and destination independently, write approved preview content through the shared save boundary, and recheck the source before deletion. A changed source is preserved if destination writing already succeeded.
- Denial, failure, cancellation, and reset clean only the owned preview. Unapproved amendments remain in their preview document for recovery. Empty replacements remain valid.
- Diagnostics are collected against the committed file, excluding the temporary preview.

`TextEditor.edit` uses the existing VS Code API for document transactions; the API describes rejecting invalid edits when the document changed in the meantime. See the [VS Code TextEditorEdit reference](https://code.visualstudio.com/api/references/vscode-api#TextEditorEdit). No proposed API or extension-engine change is introduced.

## Reproduction and checks

Before production changes, the new controlled-document ownership suite failed four of six tests: dirty-buffer approval, disk changes during approval, source-buffer changes during approval, and denial. The preexisting provider suite passed all 27 tests on the inherited baseline.

A further focused regression reproduced an editor revision that was saved during the disk read: the document became clean, but the pending read returned older bytes. It failed before adding the editor identity/version check and passed afterward.

The final default `EditTool` dirty-buffer regression was also replayed against a temporary copy of the inherited provider: it failed because the source document was saved once. The fixed provider passes it. The temporary replay modules were removed without changing the production checkout.

Focused test command:

```powershell
pnpm --dir src exec vitest run integrations/editor/__tests__/DiffViewProvider.spec.ts integrations/editor/__tests__/DiffViewProvider.ownership.spec.ts core/tools/__tests__/editTool.spec.ts core/tools/__tests__/searchReplaceTool.spec.ts core/tools/__tests__/editFileTool.spec.ts core/tools/__tests__/ApplyDiffTool.spec.ts core/tools/__tests__/ApplyPatchTool.spec.ts core/tools/__tests__/writeToFileTool.spec.ts
pnpm --dir src lint
pnpm --dir src check-types
git diff --check
```

The final isolated focused run passed all eight files: **170 tests passed, 5 existing Windows skips**. The extension package lint/typecheck and `git diff --check` passed. Exact VS Code 1.122.1 host tests and managed-host tests were reserved for centralized execution; see [the combined revalidation](extension-agent-loop-bug-revalidation-2026-09-06.md) for integrated results.

The new deterministic host suite uses a gated offline provider to obtain the bundled Task's real diff provider, then exercises actual VS Code documents. It checks initial dirty-buffer rejection, isolated preview editing and approval with a user amendment, source refresh, and dirty-source conflict followed by denial. Its E2E package lint and both TypeScript configurations are checked locally. After the parent builds the extension and webview, run it serially:

```powershell
pnpm --filter @alpha-code/vscode-e2e exec tsc -p tsconfig.json
pnpm --filter @alpha-code/vscode-e2e exec node out/runTest.js --vscode-version 1.122.1 --provider scripted --file diff-preview-ownership.test
```

## Host verification scenario

1. Create a target with saved content `before` and leave a different unsaved buffer open. Use an edit tool with normal diff mode enabled. Confirm the conflict preserves both disk and buffer and never saves the buffer.
2. Repeat from a clean source. While approval is pending, edit the real source, both with and without saving. Approval must conflict; denial must preserve those changes.
3. From a clean source, amend only the editable preview and approve. Confirm those amendments are written and reported as user edits. Repeat with denial and confirm the source is unchanged and the amended preview remains recoverable.
4. Check creation, empty replacement, streaming cancellation, and moves to both existing and missing destinations. Changes to either move path while approval is pending must be preserved; a source change after destination writing must report the partial move.
5. Check syntax display, editor focus, source refresh, diagnostics, preview cleanup, and source undo behavior in the exact host.

## Integration considerations

The editable proposal now resides outside the workspace. Source save participants and undo grouping follow the existing direct-write behavior instead of saving the source editor. Workspace-sensitive language services may behave differently in the preview; committed-file diagnostics remain authoritative. Unapproved preview amendments intentionally keep their temporary document/file available. This is a recovery tradeoff, not a source-file mutation.

As with the existing direct-write implementation, content validation followed by a filesystem write is not an atomic compare-and-swap for existing files. An unrelated process can still race the final read/write system calls. Expected-missing creation retains the exclusive `wx` write.

New or revised user-visible errors in `DiffViewProvider.ts` concern cancellation, failed preview editing/opening, missing edit state, preview amendments during opening/streaming/approval, and source-editor changes during validation. `WriteToFileTool.ts` also adds an invariant error for a missing preview baseline. Shared localization was assigned to the parent integration task; no locale files were changed in the isolated issue commit.

## Changed paths

- `src/integrations/editor/DiffViewProvider.ts`
- `src/integrations/editor/__tests__/DiffViewProvider.spec.ts`
- `src/integrations/editor/__tests__/DiffViewProvider.ownership.spec.ts`
- `src/core/tools/EditTool.ts`
- `src/core/tools/SearchReplaceTool.ts`
- `src/core/tools/EditFileTool.ts`
- `src/core/tools/ApplyDiffTool.ts`
- `src/core/tools/ApplyPatchTool.ts` (add/update/move only)
- `src/core/tools/WriteToFileTool.ts`
- `src/core/tools/__tests__/editTool.spec.ts`
- `src/core/tools/__tests__/searchReplaceTool.spec.ts`
- `src/core/tools/__tests__/editFileTool.spec.ts`
- `src/core/tools/__tests__/ApplyDiffTool.spec.ts`
- `src/core/tools/__tests__/ApplyPatchTool.spec.ts` (preview/move only)
- `src/core/tools/__tests__/writeToFileTool.spec.ts`
- `apps/vscode-e2e/src/suite/diff-preview-ownership.test.ts`
- `docs/diff-preview-ownership-2026-09-06.md`
