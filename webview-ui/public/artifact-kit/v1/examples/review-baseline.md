# Keep task exports inside the chosen folder

Engineering review · fictional fixture

Request changes. Two boundary defects can replace an unrelated file or leave an export permanently incomplete.

Scope: path resolution, archive writing, and export tests. This is an illustrative review of invented code, not a claim about Alpha’s repository. Source paths and line numbers below describe that fixture.

## Decision before merge

Resolve the destination against the export root, then publish the completed archive with a same-directory rename. Add tests for both escape attempts and failed writes before exposing the command.

**Two required fixes.** The command’s confirmation copy and archive layout are otherwise consistent with its stated behavior.

## Findings, in priority order

### High · A task title can escape the export directory

**Trigger:** an imported task has the title `../../notes`. Joining it to the selected folder produces a destination outside that folder; a preexisting `notes.zip` can be replaced.

**Evidence:** [src/export/resolveDestination.ts:7](src/export/resolveDestination.ts:7) joins the raw title, while [src/export/exportTask.ts:19](src/export/exportTask.ts:19) opens that destination for writing.

```typescript
const destination = path.join(exportRoot, `${task.title}.zip`)
await writeArchive(destination, entries)
```

**Required change:** use an opaque filename or validate a single filename component; reject separators and reserved names. Independently verify that the resolved destination is a child of the selected root. A display title is not a filesystem identifier.

#### Regression cases and boundary conditions

- Reject traversal using both slash styles, absolute names, and drive-qualified names.
- Preserve Unicode in the displayed title without using it as authority to choose a destination.
- When the destination exists, require an explicit overwrite decision before writing.

### Medium · Failed writes leave a final-looking archive

**Trigger:** cancellation or a full disk interrupts archive generation. The partial file already has its final name, so the next export treats it as completed output.

**Evidence:** [src/export/writeArchive.ts:19](src/export/writeArchive.ts:19) writes directly to the final path. [The current test at line 6](src/export/__tests__/writeArchive.spec.ts:6) covers only a successful write.

```diff
- await streamArchive(finalPath, entries)
+ await streamArchive(temporaryPath, entries)
+ await publishCompletedArchive(temporaryPath, finalPath)
```

**Required change:** create a unique temporary file in the destination directory, close the completed archive, and publish it with rename. Clean up the temporary file on failure; retain any existing valid archive. The sketch above omits platform-specific overwrite handling, which must be tested.

## Review coverage

Three implementation areas and one test file; counts describe this fixture only.

| File                                        | Result                                 | Required fixes |
| ------------------------------------------- | -------------------------------------- | -------------: |
| src/export/resolveDestination.ts            | Path boundary missing                  |              1 |
| src/export/writeArchive.ts                  | Failure recovery missing               |              1 |
| src/export/exportTask.ts                    | Caller affected; no separate finding   |              0 |
| `src/export/__tests__/writeArchive.spec.ts` | Failure cases required with writer fix |              0 |

## Verification needed

- **Required:** traversal inputs never create a file outside the selected folder.
- **Required:** an injected write failure preserves an existing archive and removes temporary output.
- **Required:** cancellation and overwrite behavior pass on Windows and POSIX.
- **Reviewed:** success copy names the chosen destination and does not imply a cloud upload.

These are read-only review requirements, not saved approval state. No test execution is claimed for this fictional patch.

---

Comparison procedure (not review content): render this same text through Alpha’s existing Markdown and diff flow, then open `review.html` in the HTML viewer. For each format, record the steps needed to identify the merge recommendation, find the highest-priority finding’s evidence, and activate its source reference. The source files are fictional; source-opening success requires opening the supplied fixture-workspace directory. Do not report successful navigation merely because a link looks clickable. Record keyboard access, narrow-width reading, and any uncertainty. This baseline supplies comparison material; it does not claim a usability study has run.
