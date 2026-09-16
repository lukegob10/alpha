# Read evidence and investigation scope

Implemented September 16, 2026. This change fixes delivered evidence and guides investigation strategy; it does not
reduce production task budgets or impose a fixed number of reads.

## Independent assessment (16 September 2026)

This is a reviewer check of the working tree against the old `read_file` failure, not a restatement of the
implementation notes below.

**The continuation lie is gone on the tool path.** Slice no longer formats 2,000 numbered lines and then lets
`ToolScheduler` clip them at 32,000 characters. `readFileContent.renderFileRead` sizes pages to
`getRemainingOutputChars()` (approval text already subtracted), stops on a complete source line, and emits a
`Continuation` object whose next unread position is the first line (or column) that was **not** returned. A 2,500-line
numbered fixture through the default 32k cap now resumes at the next line with no skipped body. Live Copilot
`gpt-5.6-luna` on VS Code 1.136.1 delivered lines 1–501 then 502–1,000 at 31,933 / 31,919 characters, with no
`[Tool output truncated by harness]` suffix.

That is stronger than a corrected `offset=N` notice. Continuations are bound to path identity and a content hash, so a
stale or cross-file cursor errors instead of paging the wrong bytes. Disjoint `line_ranges` and indentation selections
keep their unread ranges. A line that cannot fit one page is labeled `[partial line]` and resumes inside the line
without splitting a UTF-16 surrogate. Indentation is an indent heuristic that then paginates; the native schema no
longer claims syntactic completeness. Invalid `anchor_line` is an error, not an empty success. Single-file, public
batch, and saved legacy batches share one validation/approval/render path, including nullable per-file options that
inherit top-level defaults.

Investigation prompt text now tells the model to locate a known symbol before reading a large file from line 1, to
continue a page only when the missing slice matters, and not to treat incidental file contents as new requirements.
That is guidance. It is not a new security boundary, and the two live repair samples **did not** show fewer opening
reads after the wording change.

**Qualitative score (same core-loop scale as the frontier scorecard):** Read **72 → 88** / 100. Core-loop closeness
**81 → 83**. Frontier reads stay ~90 because they still have language navigation and do not slurp whole files for a
slice. This is not a SWE-bench or VSC-Bench delta. The four live cases are one Luna sample with a capped tool list;
the 1.122.1 smoke gate is a separate host check (reported passed in the validation record below; not re-run in this
review).

What this does **not** fix, and must not be scored as fixed:

- Ordinary text reads still load the whole file into memory (`fs.readFile` then split). Budget-aware **output** is
  not a streaming slice reader.
- `@` mentions still advertise `offset=${nextOffset}` and `limit=2000` (`src/core/mentions/index.ts`). That path is
  not the tool, but it can still point the model at a line-count cursor.
- Approval snippets still say “up to 2000 lines.” Harmless compared with the old skip, not honest about the character
  cap.
- Skills still tax a missed catalog check as an error. Extra edit dialects, browser, and MCP are unchanged. Tickets,
  GitHub, and spawn stay eager on purpose.

Focused tests re-run for this assessment: `readFileTool.pagination.spec.ts` and `native-tools/__tests__/read_file.spec.ts`
— **32 passed**. The pagination file covers the real scheduler with approval feedback, 32k complete-line resume, batch
sharing, Unicode fragments, stale/cross-file cursors, disjoint ranges, and saved range formats.

## Failure and owning boundary

Previously, `read_file` formatted up to 2,000 lines before the scheduler enforced its 32,000-character allowance. A
2,500-line reproduction produced a 127,066-character result. The scheduler could remove most of the selected lines
and the continuation notice. A separate reproduction delivered only lines 1–496 completely while the reader's
unclipped notice directed the model to line 2,001. The reader and scheduler disagreed about which evidence was visible.

Batch calls also followed a separate implementation that ignored top-level offset/limit and rejected optional null
line ranges. This created unnecessary retries and much larger reads than requested.

## Contract

- Single-file calls, public batches, and saved legacy batches share validation, approvals, selection, and rendering.
  Batch defaults apply to each entry; non-null per-file options override them. Optional nulls mean omitted.
- The scheduler exposes its remaining text allowance after scheduler-owned approval output. The reader shares that
  allowance across batch entries, reserving its own framing, feedback, and continuation before returning source.
- Ordinary pages end on complete source lines. The supplied `Continuation` object identifies the first unread
  position. Explicit disjoint selections and indentation selections retain their remaining ranges.
- A source line too large for one page uses explicitly marked fragments and a within-line continuation. UTF-16
  surrogate pairs are not split. This is display pagination; file contents are not rewritten.
- Continuations bind to the resolved path and decoded content version. Changed content requires a fresh relevant
  read. Cursors do not grant access: ordinary workspace, ignore, approval, and cancellation controls still apply.
- Trusted read progress fingerprints only delivered source, excluding the continuation envelope. The scheduler's
  hard output limit remains a fallback for every tool.
- Indentation remains the existing indentation-based selector, not an AST/LSP guarantee of a complete function.
  Pagination preserves its selected source and no longer claims that an oversized selection was fully delivered.

Tool guidance now distinguishes known locations, exact symbols, and unknown implementations. It encourages relevant
reads, reuse of valid evidence and passing checks, retained command output, and synthesis when requested coverage is
complete. Explicitly comprehensive tasks still require full coverage. Delegation guidance asks for distinct scopes and
deliverables and uses existing `report_progress` for established findings before further investigation. It does not
change child authority, budgets, lifecycle, or persistence formats.

A missing `command` tool-group registry entry was also restored. Its absence broke tool setup before a model request
and blocked the build. Other branch changes were preserved.

## Focused validation

```sh
pnpm --dir src exec vitest run core/tools/__tests__/readFileTool.spec.ts core/tools/__tests__/readFileTool.pagination.spec.ts core/prompts/tools/native-tools/__tests__/read_file.spec.ts core/prompts/sections/__tests__/tool-use-guidelines.spec.ts core/prompts/sections/__tests__/tool-use.spec.ts core/agent/__tests__/SubagentDelegation.spec.ts core/agent/__tests__/ToolScheduler.progress.spec.ts core/assistant-message/__tests__/NativeToolCallParser.spec.ts
pnpm --dir packages/types test -- src/__tests__/primary-observation.test.ts
pnpm --dir src check-types
pnpm --dir packages/types check-types
pnpm --dir apps/vscode-e2e check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The pagination tests use the real reader and include a real scheduler boundary with approval feedback, contiguous and
disjoint pages, oversized Unicode lines, content changes, different paths, duplicate batch paths, malformed cursors,
nullable defaults, structural selections, and small complete results. Existing tests cover denials, ignore rules,
cancellation, binary handling, and error status.

## Live Copilot probes

`apps/vscode-e2e/src/suite/read-evidence-live.test.ts` runs four tasks using the shared live file-tool helper:

1. Repair a named arithmetic function late in a large file; validate its behavior and preserve unrelated BOM/CRLF bytes.
2. Read exact batched selections with nullable ranges and top-level defaults.
3. Follow a real continuation; assert complete lines, no gap, and no scheduler truncation.
4. Review a small access-control implementation, callers, requirements, and tests; inspect the answer for concrete
   defects, correct behavior, and missing tests.

The helper records actual model identity, request count, elapsed time, tool arguments/results, assistant text, terminal
transaction integrity, and file hashes. Model availability discovery is not a model invocation. Every actual request
is guarded to use the selected Copilot Luna model. Its 12-request test guard bounds test spend; it is not a production
budget change. These fixtures intentionally restrict tool availability, so they do not measure autonomous delegation
or indexed semantic-search strategy.

Example (use a fresh owned workspace and run ID, and an authenticated Copilot test profile):

```sh
pnpm --dir apps/vscode-e2e test:copilot --vscode-version 1.136.1 --profile-dir <profile> --workspace <fresh-workspace> --artifacts-dir <artifacts> --init-profile --model-id gpt-5.6-luna --reasoning-effort high --file read-evidence-live.test --run-id <new-run-id>
```

Live tests on the available Copilot host supplement the exact VS Code 1.122.1 gate. They never replace it.

## Investigation record

Local evidence root: `F:/alpha-vscode-e2e-runs/read-evidence-20260916`.

- The initial `before` attempt dispatched zero requests because of the missing command registry entry. It is not a
  valid performance baseline.
- `after-01`: batch and continuation passed. The repair passed in five requests, but included an unnecessary opening
  read before locating a named symbol. Guidance was refined to locate known symbols before reading a large file from
  its beginning.
- The review used four independent reads in one step and completed in two requests. Manual inspection of the persisted
  answer confirmed both write-authorization defects, the correct read boundary, and missing negative/route tests.
  Its assertion initially failed because the test collector skipped a plain-text completion. The helper now captures
  assistant text directly from persisted history instead of dropping the first UI text message.
- `after-02`: all four live cases passed with Copilot `gpt-5.6-luna`, high effort, VS Code 1.136.1. The large read
  delivered complete lines 1–501 (31,933 characters), then 502–1,000 (31,919 characters), with intact continuations.
  The review again inspected the four relevant files and correctly identified the defects and missing tests.

| Live case             | Model requests | Elapsed seconds |    Tool-result characters |
| --------------------- | -------------: | --------------: | ------------------------: |
| Named-function repair |              5 |            29.6 |                    17,694 |
| Batch selection       |              2 |            12.2 |                     1,109 |
| Continuation          |              3 |            14.6 | 63,852 across two results |
| Quality review        |              2 |            19.6 |                     1,289 |

The repair still included an initial read after the guidance refinement; the two samples do not demonstrate that
guidance reduced calls. There were no observed tool errors, retries, or budget exhaustion in the successful four-case
run. No speed claim is made against the earlier, larger auth review. Build identity is in `after02-build.json`, and
full calls and completion text (including `attempt_completion.input.result`) remain in the per-case receipts.

Final compatibility review additionally reproduced and fixed a saved-call regression: raw string/tuple ranges could
override the parser's canonical ranges. Two parser-to-reader regression cases failed before changing that precedence
and passed afterward. An invalid indentation anchor also now returns an error instead of a misleading empty-success
result, with a regression that failed before the fix. These edge-case fixes were made after the live runs; the live
native object-range contract is unchanged and the final code is covered by the deterministic tests and exact-host gate.

Final focused coverage passed 274 extension tests across eight files and two shared-types tests. Extension, shared-types,
and E2E typechecks and lint passed, as did the extension bundle. The exact-host smoke gate passed all ten checks on
VS Code 1.122.1 (three activation, two modes, five VS Code LM adapter tests). The three original live file-edit/search
probes also passed again in `filetools-final`, using nine additional Luna requests. Full-suite testing was not run.

Single live samples and different workloads do not establish a general speed or quality improvement. The deterministic
claim is that delivered pages fit the real allowance and continuations preserve the unread selection. Live runs show
whether the selected model can use that contract and reveal strategy issues for subsequent measurement.

The remaining quality work on this surface is streaming/sliced I/O for huge files, aligning `@` mention continuation
with the tool cursor, and dropping the “up to 2000 lines” approval copy. Those are not the old silent skip.
