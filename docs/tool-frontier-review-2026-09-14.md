# Alpha Code tool quality review

Implementation follow-up: the four must-fix findings below have been addressed. See
[the implementation and validation record](tool-must-fix-validation-2026-09-14.md). The original findings are retained
as review evidence; the remaining roadmap is unchanged.

Reviewed September 14, 2026 against the working tree based on commit
`e10e1f62cdcdc8dce75efa790df6e7883d444755`. The working tree contained substantial concurrent work, including
mode retirement, compaction, and search changes. This report describes the inspected working tree, not only that commit.

## Assessment

**Alpha has a strong execution foundation and a capable tool set, but its tools are not consistently at a frontier
quality level yet.** The strongest parts are the shared registry, captured task policy, mutation safeguards, command
output artifacts, hybrid code search, and MCP discovery. The largest gaps are a few correctness and approval defects,
inconsistent output limits, and missing command-session control.

The practical path is to improve the existing tools. A replacement tool engine or a much larger catalog would add risk
without addressing these gaps. Several useful changes are small; fully competitive command interaction and reliable
large-file reads need more deliberate work.

Here, frontier quality means:

- Correct literal arguments, precise effects, and useful recovery after errors.
- Task-scoped authority, approvals, cancellation, and state.
- Bounded input processing and output with an honest way to continue reading.
- Few unnecessary model round trips and enough control to finish real development workflows.
- Measured success on representative tasks, including failures and concurrency.

These are engineering criteria. This review does not establish a benchmark ranking against a commercial agent.

## Findings, in priority order

### 1. High / must-fix: TODO approval state can cross task boundaries

**Status: reproduced and fixed in the linked implementation follow-up.**

[UpdateTodoListTool.ts](../src/core/tools/UpdateTodoListTool.ts) stores pending approval data in the module-global
`approvedTodoList` at line 14. Execution assigns that variable before awaiting approval and reads it again afterward
(lines 56–66). The webview handler calls `setPendingTodoList(todos)` without a task or approval-request identity.

A deterministic controlled-promise test reproduced this sequence:

1. Task A proposes “First task work” and waits for approval.
2. Task B proposes “Second task work” and receives approval.
3. Task A receives approval.
4. A saves B's list instead of its own.

**Smallest complete fix:** associate the editable proposal with both task ID and pending approval/call ID; route webview
edits to that proposal; discard it on denial, cancellation, and disposal. Add the interleaved two-task regression test.
Serializing every task would hide the ownership error and reduce concurrency.

This crosses the tool/webview contract and should be a separate focused change. The temporary reproduction test was
removed after confirming the failure; no intentionally failing test is left in the tree.

### 2. High / must-fix: opening a browser changes ambient approval settings

**Status: fixed in the linked implementation follow-up; browser host confirmation coverage remains limited.**

[VSCodeBrowserTools.ts](../src/services/browser/VSCodeBrowserTools.ts), lines 140–200, temporarily sets
`vscode.chat.tools.global.autoApprove.testMode` and changes the user's `chat.tools.global.autoApprove` configuration to
auto-approve `open_browser_page`. Restoration is attempted, but a failure only logs a warning. The implementation comment
specifically cites internal behavior in VS Code 1.131, while Alpha's required host is 1.122.1.

The browser adapter otherwise does useful work: it detects available tools, forwards cancellation, preserves text/image
results, and disposes cancellation sources. The problem is the approval workaround. Local serialization of browser-open
calls does not make ambient window settings private to one invocation.

**Smallest complete fix:** use a supported host confirmation path, or an explicitly supported adapter flow that preserves
approval authority; feature-detect availability and test it on 1.122.1. Do not toggle shared approval settings to make an
invocation succeed. The passing smoke gate in this review does not exercise this browser approval scenario.

### 3. High / must-fix: literal replacement text was interpreted as replacement syntax

**Status: fixed in this review.**

[SearchReplaceTool.ts](../src/core/tools/SearchReplaceTool.ts), line 140, passed model-supplied replacement text directly
to `String.replace`. JavaScript expands sequences such as `$&`, `$$`, and `$'` in replacement strings. A request to
write a literal `$&` could instead insert the matched source text.

The fix uses a replacement callback, preserving the supplied text literally. Twelve regression cases cover six dollar
sequences through both direct-save and diff-preview paths. Before the fix, eight cases failed for the intended reason.
After the fix, all passed as part of the broader tool suite. The public schema and persisted format are unchanged.

### 4. High / must-fix: GitHub effects lack a complete approval and cancellation contract

**Status: fixed in the linked implementation follow-up.**

[GitHubApiTool.ts](../src/core/tools/GitHubApiTool.ts), lines 127–140, builds an approval message containing repository,
action, title, and related identifiers, but excludes the comment or pull-request body. Writes force approval, yet this
approval payload cannot show the full proposed content.

The same tool does not propagate `callbacks.signal` into
[GitHubApiClient.ts](../src/services/github/GitHubApiClient.ts). Its `fetch` and fallback `execFile` requests have no
request cancellation signal or bounded deadline. Cancellation can stop task presentation while an external request
continues. The tool also needs an explicit post-approval cancellation check before starting an effect.

**Smallest complete fix:** include the actual proposed content in the review payload and UI, propagate a bounded abort
signal through both transports, and test cancellation before approval, after approval, and during a request. If a
remote write may already have been accepted, report an uncertain outcome and reconcile it; do not imply abort undoes it.

Follow-on improvements: expected-head SHA for merges, pagination for lists/checks, and optional draft PR creation. The
existing client tests are useful, but a dedicated tool-level approval/cancellation suite is needed.

### 5. Medium / should-fix: native arguments are still subject to legacy entity decoding

**Status: confirmed transformations; compatibility fix needs dedicated tests.**

[ExecuteCommandTool.ts](../src/core/tools/ExecuteCommandTool.ts), line 211, HTML-decodes command text.
[ApplyDiffTool.ts](../src/core/tools/ApplyDiffTool.ts), lines 32–38, decodes diff content for model IDs that do not contain
`claude`. A native JSON tool argument can legitimately contain literal `&amp;`, `&lt;`, or `&quot;`; changing those strings
can change the intended command or source file. Tool semantics should not vary based on a vendor substring.

**Smallest complete fix:** preserve native structured arguments exactly. If legacy textual tool parsing still requires
decoding, isolate it at that parser boundary. Characterize both formats before changing compatibility behavior.

### 6. Medium / should-fix: read limits do not describe the amount actually visible to the model

**Status: confirmed processing paths; combined cursor risk identified by inspection.**

[ReadFileTool.ts](../src/core/tools/ReadFileTool.ts), lines 282–284 and 1037–1039, reads the whole file into memory even
for a small line range. A line count is not a memory budget. The default 2,000-line output can also exceed the scheduler's
32,000-character default cap.

The reader computes its continuation offset before the scheduler applies a generic text cut. For example, a reader
response can advertise the next offset after 2,000 lines while the later cap exposes only a fraction of those lines.
The cap reports truncation, but cannot supply a corrected file cursor. See the read continuation at lines 469–478 and
[ToolScheduler.ts](../src/core/agent/ToolScheduler.ts), lines 319–334.

**Smallest complete fix:** give the reader an effective output budget, stop at a complete line, and derive the next offset
from the content actually emitted. Add a bounded streaming slice reader for large text files. Preserve a separate,
explicitly bounded path for indentation/document extraction.

Also correct the schema's claim that indentation mode “guarantees” syntactically valid complete blocks. The current
reader is an indentation heuristic with hard limits, not a language parser. Test long lines, UTF-8 boundaries, very large
files, empty results, and continuations through the scheduler.

### 7. Medium / should-fix: equivalent edit tools differ in line-ending behavior

**Status: confirmed by source; follow-up required.**

[EditTool.ts](../src/core/tools/EditTool.ts), line 102, and
[SearchReplaceTool.ts](../src/core/tools/SearchReplaceTool.ts), line 108, normalize the entire file from CRLF to LF before
editing. The direct-save path writes the resulting content. In contrast,
[EditFileTool.ts](../src/core/tools/EditFileTool.ts) detects and restores the original newline convention.

**Smallest complete fix:** share literal matching and newline-preservation behavior behind the existing tool formats.
Test CRLF, LF, BOMs, mixed endings, repeated matches, and stale file changes. Preserve model-compatible wrappers; do not
remove formats solely because their names overlap.

Multi-file `apply_patch` also deserves clearer per-file outcomes. It applies approved files sequentially and can stop
after earlier changes succeeded. It is not an atomic all-files transaction. Improve preflight and applied/skipped/error
reporting without introducing unsafe rollback over external edits.

## Complete tool inventory and assessment

The static native catalog contained **47 entries**. These are capabilities, not 47 tools necessarily sent on every
request. Modes, model tool profiles, host support, index availability, child scope, and MCP connections filter the actual
surface. `apply_diff` and `write_to_file` are the default file-editing choices; alternative edit formats are opt-in.

| Tool or family                                                                                                                                                                                       | Current quality                                                                                                                                    | Best next improvement                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_files`                                                                                                                                                                                       | Good regex foundation, bounded batches, progress, ignore handling, and explicit partial results.                                                   | Add literal search and `content` / `files` / `count` output modes; expose bounded context and result controls. Return per-query errors so one invalid query does not discard independent successful queries. |
| `list_files`                                                                                                                                                                                         | Safe basic listing with a tightly constrained prepared parallel path.                                                                              | Add glob filtering and bounded pagination. A 200-entry listing is insufficient for many repositories.                                                                                                        |
| `codebase_search`                                                                                                                                                                                    | Strong implementation: lexical and semantic retrieval, rank fusion, candidate/result bounds, and current-file verification of indexed snippets.    | Propagate cancellation through embedding/vector work; evaluate retrieval quality and behavior when the index is unavailable.                                                                                 |
| `read_file`                                                                                                                                                                                          | Rich line-range, batch, indentation, image, PDF, and DOCX support. Uneven resource and output contracts.                                           | Budget-aware streaming slices and trustworthy continuation offsets; remove the syntactic-completeness promise.                                                                                               |
| `write_to_file`                                                                                                                                                                                      | Useful shared diff/approval path, stale-content checks, and mutation integration.                                                                  | Preserve encoding/newlines consistently; characterize crash-safe replacement and external-writer races. Existing checks are valuable but are not a filesystem-level compare-and-swap guarantee.              |
| `apply_diff`                                                                                                                                                                                         | Mature contextual diff path with partial-failure handling.                                                                                         | Preserve literal native arguments and make partial application/results unambiguous.                                                                                                                          |
| `apply_patch`                                                                                                                                                                                        | Useful structured create/update/delete format; validates operations and handles files sequentially.                                                | Better preflight and per-file outcomes; evaluate format selection per model.                                                                                                                                 |
| `search_replace`                                                                                                                                                                                     | Useful strict single-match edit, now fixed for dollar replacement sequences.                                                                       | Preserve line endings and share the tested literal-edit core.                                                                                                                                                |
| `edit`                                                                                                                                                                                               | Literal replacement already uses callbacks; explicit single/all-match semantics.                                                                   | Preserve line endings and converge matching/error behavior.                                                                                                                                                  |
| `edit_file`                                                                                                                                                                                          | Flexible matching and newline preservation are useful.                                                                                             | Evaluate tolerant matching against formatting-sensitive and ambiguous fixtures; maintain explicit occurrence checks.                                                                                         |
| `execute_command`                                                                                                                                                                                    | Strong cancellation, process cleanup, output limits/artifacts, background execution, and verification plumbing.                                    | Expose stable command session IDs plus status/wait/stop over the existing registry. Make yield timeout versus lifetime timeout unmistakable. Add interactive stdin/PTY support as a separate larger change.  |
| `read_command_output`                                                                                                                                                                                | One of the strongest tools: task-owned artifact IDs, byte pagination, UTF-8 boundary handling, bounded filtering, and incomplete-output reporting. | Offer explicit literal filtering and align continuation conventions with other tools.                                                                                                                        |
| `open_browser_page`, `list_browser_pages`, `read_page`, `screenshot_page`, `navigate_page`, `click_element`, `type_in_page`, `hover_element`, `drag_element`, `handle_dialog`, `run_playwright_code` | Thin host adapters preserve useful existing browser capabilities and cancellation. Host availability varies.                                       | Fix the browser-open approval workaround; add exact-host browser coverage and predictable result budgets. Avoid building a competing browser engine.                                                         |
| `github_api`                                                                                                                                                                                         | Convenient common PR/comment/check operations and forced approval for writes.                                                                      | Full approval content, cancellation/deadlines, expected-head merge protection, and pagination. Avoid steering models away from alternatives when the native tool cannot perform the operation.               |
| `generate_image`                                                                                                                                                                                     | Validates destinations and protects output writes; cancellation checks prevent a late save.                                                        | Abort the upstream generation request as well, where supported. Keep schemas out of tasks that do not need image generation.                                                                                 |
| `list_tickets`, `read_ticket`, `create_ticket`, `update_ticket`, `delete_ticket`                                                                                                                     | Useful structured project work with schema validation and revision-aware mutation support.                                                         | Keep results compact and project-scoped; measure whether these belong in the initial tool surface for ordinary coding tasks.                                                                                 |
| `delegate_task`, `spawn_agent`                                                                                                                                                                       | Bounded delegation with role/policy/workspace constraints and cleanup support.                                                                     | Make synchronous delegation versus managed background execution clear in descriptions; evaluate total task cost and cancellation with real workloads.                                                        |
| `list_agents`, `wait_agent`, `send_message`, `report_progress`, `followup_task`, `interrupt_agent`, `cancel_agent`, `close_agent`                                                                    | A comparatively complete managed-agent lifecycle surface with bounded messages/waits and ownership checks.                                         | Validate end-to-end delivery, cancellation, and cleanup; avoid redundant polling/model turns. Full managed-agent certification was not rerun in this review.                                                 |
| `new_task`                                                                                                                                                                                           | Maintains the older parent/subtask workflow.                                                                                                       | Clearly explain its different lifecycle from managed agents; preserve saved-task compatibility while reducing selection ambiguity.                                                                           |
| `update_todo_list`                                                                                                                                                                                   | Useful structured progress UI, but unsafe concurrent pending approval state.                                                                       | Fix task/request isolation before adding features.                                                                                                                                                           |
| `ask_followup_question`                                                                                                                                                                              | Adequate blocking question/choice flow.                                                                                                            | Evaluate whether independent work should continue while optional questions are pending; this is a UX/lifecycle enhancement, not a small schema edit.                                                         |
| `attempt_completion`                                                                                                                                                                                 | Explicit completion and verification integration.                                                                                                  | Keep results concise and distinguish blocked, failed, and completed outcomes; continue allowing ordinary text completion where the engine contract permits.                                                  |
| `skill`, `run_slash_command`                                                                                                                                                                         | Reuses skill invocation logic with captured catalogs, path/digest checks, and instruction provenance.                                              | Keep instructions compact and invocation semantics consistent. No separate execution engine is needed.                                                                                                       |
| `access_mcp_resource`                                                                                                                                                                                | Useful structured connector resource access.                                                                                                       | Keep resource output budgets, cancellation, and provenance consistent with tool calls.                                                                                                                       |

Additional runtime surfaces are `discover_tools`, dynamic MCP tools, the `use_mcp_tool` compatibility path, and custom
tools. The legacy aliases `write_file` and `search_and_replace` resolve to canonical implementations. Dynamic providers
cannot be individually certified from their descriptors: inspect their permissions, outputs, and cancellation at the
connector boundary. Custom executable tools also need an explicit cooperative cancellation contract; arbitrary custom
code is not made safely cancellable by scheduler metadata alone.

## What should be retained

- **One tool registry and one captured task surface.** Schema visibility and execution policy are joined, aliases resolve
  canonically, and MCP invocation revalidates captured connection/schema state after approval.
- **The scheduler as the effect boundary.** Structured outcomes, bounded concurrency, approval/mutation barriers, and
  terminal-result handling are the right design.
- **The workspace mutation machinery.** Checkpoints, reservations, content observations, and failure settlement are
  materially better than a thin filesystem wrapper. They still need tests for each individual write path.
- **Command output artifacts.** Large logs remain readable through task-owned handles instead of consuming the entire
  model context.
- **Hybrid code search.** Current source verification and fused lexical/semantic ranking already address several common
  weaknesses of simple vector-only retrieval.
- **Existing MCP discovery/cache.** Deferred discovery is already implemented. Recommending it as a missing subsystem
  would be incorrect.

Only `list_files` currently registers `prepareParallelRead` in the registry, and its eligible scope is deliberately
conservative. General read-only metadata does not by itself put every read/search on that scheduler path. Extending the
existing prepared path to approved, captured read/search scopes is worthwhile after measuring the workload and preserving
revocation, ignore rules, deterministic ordering, and cancellation. Never parallelize approval waits or writes merely
because they are slow.

## Search changes observed during this review

Concurrent work changed [the ripgrep service](../src/services/ripgrep/index.ts) while the review was running. The earlier
raw-line buffering and incomplete truncation reporting findings were resolved in the later inspected code: it adds a
raw-byte budget, bounded decoding, and explicit partial-result reporting. The observed defaults include a 1 MiB raw
search-output budget and 1,500 raw search lines, with a separate formatted result budget.

Those changes belong to the concurrent work, not the one-line replacement fix in this review. Search output modes,
literal matching, pagination, and batch error isolation remain worthwhile improvements. See
[the current search design note](search-files.md) for that work's own contract and validation.

## Measured catalog baseline

Reran the existing deterministic `tool-catalog-measurement.spec.ts` fixture. These are serialized schema JSON payloads,
not complete provider requests. Token estimates use the repository's `o200k_base` counter and 1.5 multiplier; they are
not provider billing measurements.

| Fixture snapshot                              | Functions | Schema JSON bytes | Repository token estimate |
| --------------------------------------------- | --------: | ----------------: | ------------------------: |
| Static native inventory                       |        47 |            63,988 |                    20,580 |
| Effective Code surface without MCP in fixture |        27 |            41,608 |                    13,581 |
| Eager fixture with 48 connected MCP tools     |        75 |           224,980 |                    70,791 |
| Deferred fixture, initial request             |        28 |            42,251 |                    13,784 |
| Deferred fixture, selected tool available     |        29 |            46,079 |                    14,982 |

In this scripted MCP workflow, cold discovery takes one extra model/tool round. Across those two requests it sends
88,330 schema bytes, compared with 224,980 for the eager request. A warm selected-tool request takes one round. This is
evidence of a payload tradeoff, not proof of improved model latency or quality: the fixture makes no live model call.

The remaining native prompt surface is large enough to justify an experiment in trimming descriptions and making
specialized families discoverable. Retain common coding tools eagerly, preserve cache stability, and measure the added
discovery round trip before changing defaults. Correcting inaccurate descriptions comes before simply shortening them.

## Recommended implementation sequence

Effort labels indicate likely scope, not delivery commitments: **small** is a focused tool/helper change; **medium**
crosses related tool/runtime/UI boundaries; **large** introduces a substantial interaction contract.

| Order | Change                                                                                         | Effort       | Evidence required                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1     | Isolate TODO proposals by task and approval request.                                           | Medium       | Controlled interleaving, edited approval, denial/cancel/dispose, stale UI message tests.                             |
| 2     | Remove ambient browser approval mutation.                                                      | Medium       | Supported host behavior and browser approval tests on exact VS Code 1.122.1.                                         |
| 3     | Complete GitHub approval/cancellation handling.                                                | Medium       | Full review payload; cancellation/deadline tests for fetch and fallback transport; uncertain write outcome handling. |
| 4     | Preserve literal native command/diff arguments and edit newlines.                              | Small–medium | Native versus legacy parsing, literal entities, dollar sequences, CRLF/BOM, duplicate matches.                       |
| 5     | Add search output modes, literal search, and per-query errors; add glob filtering to listings. | Small–medium | Fixed fixtures with identical ignore/scope policy, bounded results, no-match versus error distinction.               |
| 6     | Align read output budgets/cursors and add bounded large-file slices.                           | Medium       | Large-file/long-line fixtures through scheduler; UTF-8, continuation, cancellation, memory measurements.             |
| 7     | Add command session status/wait/stop using the existing terminal registry.                     | Medium       | Stable handles, background completion, nonzero exit, cancellation, task isolation, reload/dispose policy.            |
| 8     | Extend safe prepared parallel reads and reduce optional schema exposure.                       | Medium       | Same-workload round trips, payloads and wall time; deterministic ordering and policy revocation tests.               |
| 9     | Add stdin/PTY interaction where required.                                                      | Large        | Interactive process control and cleanup across Windows, macOS, Linux; clear approval and shell contracts.            |

The literal replacement fix is already complete. The best everyday usability upgrade is search output control: asking
“which files mention this?” should return filenames without spending the context budget on snippets. The biggest workflow
upgrade is command-session control: an agent should be able to start a server, inspect it, and stop it through a stable
handle.

### Capabilities worth adding after the reliability work

1. **Read-only VS Code language navigation:** definitions, references, workspace/document symbols, and diagnostics through
   stable host APIs. This can reduce repeated text search for semantic questions. Use one focused adapter over existing
   language services, with cancellation and bounded output. Diagnostics after editing already exist; this proposal is
   agent-addressable navigation/inspection.
2. **Optional web retrieval:** use existing MCP/browser capabilities where available. A dedicated fetch/search integration
   should have clear provenance, output limits, and permissions; it need not be eager in every coding task.
3. **Notebook cell operations:** useful for notebook-heavy workloads, lower priority for this extension's general coding
   workflows until usage evidence supports them.

## Primary-source comparison

Sources were retrieved on September 14, 2026. Unversioned current documentation is comparison context and does not prove
compatibility with Alpha's exact host. The repository's working code and tests determine Alpha's behavior.

- OpenAI documents structured file operations and per-call outcomes in
  [Apply Patch](https://developers.openai.com/api/docs/guides/tools-apply-patch). Alpha already supports that style;
  adopting the name or format alone does not establish edit reliability.
- The model-specific
  [Codex prompting guide's tools section](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#tools)
  discusses patch/shell tools and interactive command execution. This supports evaluating command control and
  model-appropriate formats; it is not a universal recommendation to copy one vendor's prompt or expose every format.
- Anthropic's
  [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
  emphasizes focused tools, concise relevant outputs, and realistic evaluation. That supports search output modes and
  task-level evals over adding tools for catalog size.
- The current [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) describes search output modes,
  language navigation, and background-task control. Availability varies by configuration/platform; it should not be read
  as a universal default catalog. These are useful capability comparisons for Alpha.
- The [VS Code Language Model Tool API guide](https://code.visualstudio.com/api/extension-guides/ai/tools) documents
  confirmation through the tool invocation lifecycle. Production approval behavior should be verified using supported
  APIs on the required host, rather than inferred from an internal newer-host setting.

## Validation and coverage

Run mode: **full-surface review of the extension's tools**, with a small implementation budget for one isolated bug.
The review covers schemas, registry/build/filtering, scheduler and mutation integration, read/search/edit/command
implementations, host browser and GitHub adapters, MCP/custom tool boundaries, agent/task/ticket/skill tools, and selected
webview approval/result routes. It includes JavaScript/TypeScript correctness and bounded performance analysis.

Completed checks:

- Pre-fix literal replacement regression: eight intended failures, 25 passing cases.
- Tool suite, scheduler, and catalog tests: **50 files passed; 900 tests passed, five skipped**.
- Focused ripgrep, code-index search service, browser adapter, and GitHub client tests: **four files, 59 tests passed**.
- Final full ripgrep suite after the concurrent changes: **two files, 54 tests passed**.
- Catalog measurement fixture rerun: passed; measurements above captured from that run.
- `pnpm --dir src lint`: passed.
- `pnpm --dir src check-types`: passed after concurrent ripgrep edits settled.
- Prettier check for the two changed TypeScript files: passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`: passed, **five extension-host tests**, actual host **1.122.1**.
  The successful run also built the extension/webview. An earlier attempt stopped during a concurrent ripgrep type error;
  it did not launch a substitute host.
- Temporary deterministic TODO race reproduction: failed for the intended cross-task overwrite, then removed.

Commands for the principal unit coverage:

```sh
pnpm --dir src test core/tools/__tests__ core/agent/__tests__/ToolScheduler.spec.ts core/agent/__tests__/ToolScheduler.progress.spec.ts core/task/__tests__/tool-catalog-policy.spec.ts core/task/__tests__/tool-catalog-measurement.spec.ts --maxWorkers=2
pnpm --dir src test services/ripgrep/__tests__/index.spec.ts services/code-index/__tests__/search-service.spec.ts services/browser/__tests__/VSCodeBrowserTools.spec.ts services/github/__tests__/GitHubApiClient.spec.ts --maxWorkers=2
pnpm --dir src test services/ripgrep/__tests__ --maxWorkers=2
pnpm --dir src test core/task/__tests__/tool-catalog-measurement.spec.ts --no-silent
```

### Closure ledger

| Category                    | Result                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixed now                   | Literal dollar replacement in `search_replace`; both save paths covered by regression tests.                                                                                                                                                                             |
| Resolved by concurrent work | Ripgrep raw output bounds and explicit partial-result reporting, credited separately.                                                                                                                                                                                    |
| Flagged for follow-up       | TODO isolation; browser approval workaround; GitHub approval/cancellation; native entity decoding; read budgets/cursors; newline consistency; command control and search ergonomics.                                                                                     |
| Not verified                | Live provider quality/latency ranking; interactive PTY behavior on all platforms; real GitHub write/cancel behavior; browser approval flow on 1.122.1; every external MCP/custom tool; full managed-agent certification; full webview accessibility and visual behavior. |
| Out of scope                | CLI and VS Code shim subtrees, release/version changes, whole-repository cleanup, and implementation of the full roadmap.                                                                                                                                                |

The broad passing tests support the bounded fix and inspected lower-level contracts. They do not close the remaining
findings or certify unrelated concurrent changes.

## What would justify a frontier-quality claim

Extend existing evaluation tooling with a stable tool-workflow suite: large-repository search, long-line and large-file
reads, literal/ambiguous/stale edits, partial patches, UTF-8 command logs, nonzero exit, background-server lifecycle,
approval denial, cancellation at each effect boundary, and simultaneous tasks.

Measure task completion, first-attempt edit success, retries, model/tool round trips, input/output payloads, peak memory,
resource cleanup, and p50/p95 time. Use the same workload, provider/model settings, and warm/cold-cache conditions for
before/after comparisons. Offline scripted providers establish deterministic CI contracts; repeated live-model samples
can supplement them. A single successful run or a larger unit-test count is not a general quality or speed result.
