# Extension agent-loop bug audit — 2026-09-04

This audit found **11 actionable defects: 4 High and 7 Medium**, grouped into five workstreams. The most consequential findings are stalled recovery after a failed or incomplete turn, overwriting a concurrent file edit, accepting an incomplete context summary, and losing cancellation at the MCP boundary. These could explain unfinished-task symptoms; this audit does not establish the cause of earlier incidents.

**Original audit scope:** the first version of this document recorded bugs only and made no source changes. The reproduction details below remain the historical evidence from that audit snapshot.

## Remediation update — 2026-09-04

All **11 findings are fixed in the current working tree**. The changes keep the existing agent architecture and repair the owning boundaries: turn recovery, completion policy, compaction acceptance, tool result/cancellation contracts, file mutation integrity, and bounded command-output retrieval. The pre-existing `AGENTS.md` workspace edit was preserved, and no protected CLI or VS Code shim source was changed.

| Finding | Status | Implemented behavior | Primary regression coverage |
| ------- | ------ | -------------------- | --------------------------- |
| E01 | Fixed | Failed, incomplete, and exhausted primary turns open one explicit `resume_task` boundary; accepted follow-up text starts the next model turn, while denial, supersession, managed children, cancellation, and completed tasks retain their existing terminal behavior. | `Task.spec.ts`, `Task.retry-wire.spec.ts`, `stageThreeCompletion.integration.spec.ts` |
| E02 | Fixed | Direct saves and patch moves capture the approved baseline, reject changed disk or dirty-editor state, use exclusive creation for expected-missing files, and preserve a move source if the destination commit fails. | `DiffViewProvider.spec.ts`, `editTool.spec.ts`, `writeToFileTool.spec.ts`, `ApplyDiffTool.spec.ts`, `ApplyPatchTool.spec.ts` |
| E03 | Fixed | Compaction replaces active history only after an explicit completed lifecycle outcome; incomplete, failed, cancelled, and streamed-error summaries retain the prior history. Legacy providers without lifecycle events keep their compatible EOF path. | `core/condense/__tests__/index.spec.ts` |
| E04 | Fixed | Scheduler cancellation now propagates through MCP tool and resource adapters into `McpHub` and the SDK request. `McpHub` also settles promptly on local abort when a transport ignores the signal and absorbs late transport settlement. | `useMcpToolTool.spec.ts`, `accessMcpResourceTool.spec.ts`, `McpHub.spec.ts` |
| E05 | Fixed | MCP `isError` results and invalid command-output reads set structured `error` metadata, task failure state, and provider-history `is_error` consistently. | `ToolScheduler.spec.ts`, `useMcpToolTool.spec.ts`, `ReadCommandOutputTool.test.ts`, webview `McpExecution.spec.tsx` |
| E06 | Fixed | `attempt_completion` and ordinary visible-text completion share the same open-todo decision and perform a final state recheck before completion. | `attemptCompletionTool.spec.ts`, `Task.spec.ts`, `stageThreeCompletion.integration.spec.ts` |
| E07 | Fixed | Native `write_to_file` content is saved literally; HTML entities, code fences, line-number-like text, and model identity no longer alter the requested bytes. | `writeToFileTool.spec.ts` |
| E08 | Fixed | Empty replacement content and missing final newlines are persisted, and failed editor apply/save operations produce truthful failures. | `DiffViewProvider.spec.ts`, `editTool.spec.ts`, `writeToFileTool.spec.ts` |
| E09 | Fixed | Embedded MCP image resources become model-visible data-URL images, text resources remain text, and unsupported binary resources return bounded metadata instead of silently losing their payload type. | `useMcpToolTool.spec.ts`, `accessMcpResourceTool.spec.ts`, webview `McpExecution.spec.tsx` |
| E10 | Fixed | An oversized matching log line returns a bounded, explicitly incomplete match instead of a false “no matches” result. | `ReadCommandOutputTool.test.ts` and the original audit probe |
| E11 | Fixed | Search accounts for the rendered payload, bounds retained data and work, scans in cancellable chunks, and rejects known nested or overlapping regular-expression forms while preserving ordinary flat quantifiers. The public tool schema and runtime limits now share one contract. | `ReadCommandOutputTool.test.ts`, `ToolScheduler.spec.ts`, and the original audit probe |

An adjacent command-output resource leak was also fixed: every file handle opened by artifact search now enters owned `try/finally` cleanup before alignment or count initialization can fail.

## Scope and evidence

- **Scope:** the VS Code extension's execution loop, tool dispatch/results, context compaction and transcript recovery, task completion, and the chat/session adapters used by that loop. Shared types were followed only to understand extension contracts.
- **Source snapshot:** HEAD at the source cross-check was `323799d2aa96093e2530cf0cf18c1b76a9a85ac1`, with an existing local `AGENTS.md` edit. During the audit, HEAD advanced from `acefd390e2fab263708f6211acd8055855f4b62d`; that tree difference contained the pre-existing `readFileTool.spec.ts` and `file-search.ts` changes. Later, `ReadFileTool.ts` and its test received additional concurrent edits. Those edits were preserved and do not change the finding locations below. Test counts describe the recorded test runs, not certification of subsequent concurrent work.
- **Method:** trace active callers through the owning layer, examine adjacent error/cancellation/completion paths, run selected existing tests, and reproduce suspected failures with isolated probes outside the repository. This applied the clean-code-review workflow in report-only mode, as requested.
- **Environment:** Windows; Node 20.19.2; pnpm 10.8.1; Vitest 3.2.4. Providers, approvals, and VS Code UI were controlled adapters in the probes. File-race and command-output probes used real files in the OS temporary directory.
- **Original validation:** 17 existing test files passed: **415 tests passed, 5 skipped**. Separately, **14 audit probe cases failed their intended correctness assertions**, reproducing the 11 findings. These deliberate red probes were not failures of the existing repository test suite.
- **Original audit limits:** no live-model quality study, production telemetry analysis, extension-host profiling, or VS Code 1.122.1 smoke/manual UI run was performed during discovery. The remediation verification and remaining limits are recorded below.

Severity uses impact and reach: **High / must-fix** means a task can become stranded or its work/context can be corrupted; **Medium / should-fix** means a narrower correctness, result-contract, or resource-bound failure. Confidence is high in each identified code defect. Remediation passed the release-host checks recorded below; live remote-service behavior retains the stated limits.

## Coordinated workstreams

| Workstream                                | Owning layer                                      | Findings                 | Desired invariant                                                                                       |
| ----------------------------------------- | ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| A. Turn recovery and completion           | `core/task`, `core/webview`, chat UI              | E01, E06                 | Every stopped task has a usable recovery boundary; completion policy is shared by all completion paths. |
| B. Context and memory                     | `core/condense`, context management               | E03                      | Only a successful summary can replace detailed active context.                                          |
| C. Tool result and cancellation contracts | MCP tool adapter, `McpHub`, scheduler integration | E04, E05, E09            | Cancellation reaches the operation; status and returned content survive normalization.                  |
| D. File-edit integrity                    | Edit/write tools, `DiffViewProvider`              | E02, E07, E08            | Approved writes preserve concurrent edits and the requested content, including empty content.           |
| E. Command-output retrieval               | `ReadCommandOutputTool`                           | E10, E11; coordinate E05 | Searching logs returns truthful, bounded results.                                                       |

Remediation followed those ownership groups. E02/E07/E08 were coordinated at the file-write boundary, E05 used the existing result-metadata contract across MCP and command output, and E10/E11 were repaired together without conflating their separate failures: false negatives and an ineffective budget.

## Findings

### E01 — Failed or incomplete turns can strand follow-up chat input

**High / must-fix · Workstream A · Reproduced at Task + session-registry boundaries**

**Locations:** [Task.ts:6912](../src/core/task/Task.ts#L6912), `initiateTaskLoop`; [Task.ts:4205](../src/core/task/Task.ts#L4205), `handleWebviewAskResponse`; [TaskSessionRegistry.ts:247](../src/core/webview/TaskSessionRegistry.ts#L247), terminal-turn projection; [ChatView.tsx:1034](../webview-ui/src/components/chat/ChatView.tsx#L1034), send routing.

**Trigger:** a primary task receives a failed or incomplete step without authoritative task cancellation, for example a partial provider response followed by an incomplete outcome. The user then sends “Please continue.”

**Failure and context:** `initiateTaskLoop` records the terminal outcome and returns. It does not establish a retry/resume ask or another consumer for user input. Canonical turn termination deliberately does not terminate the containing task: `TaskSessionRegistry` keeps its nonterminal task lifecycle and `canAcceptInput` remains true. Once the turn is inactive, the chat's normal route posts `askResponse`; its handler only stores `askResponseText` in memory. No waiting `ask` or active loop consumes it, persists it as conversation input, or issues the next model request. `submitUserMessage` ultimately reaches the same handler. The stranded session also continues to consume a live-task slot.

**Evidence:** scripted `incomplete` and `failed` steps ran through the real task loop, engine, final lifecycle method, and session registry. Both ended with `isTurnActive() === false`, input admission true, one live session, one model-step invocation, zero asks, and the follow-up text left in `askResponseText`. The webview route was traced in source; no real-host click-through was performed.

**Follow-up boundary:** task termination/recovery owns this invariant. Preserve the valid distinction between terminal turns and terminal tasks while ensuring every exit installs an explicit resume boundary or a durable route that starts the next turn. Regression coverage should send a real chat follow-up after provider incompleteness, failure, exhausted retry, and unresolvable completion rejection; verify one persisted input, one resumed turn, correct capacity, and no duplicate execution.

### E02 — Direct saves overwrite edits made while approval is pending

**High / must-fix · Workstream D · Reproduced with real disk I/O**

**Locations:** [EditTool.ts:91](../src/core/tools/EditTool.ts#L91), initial file read; [EditTool.ts:199](../src/core/tools/EditTool.ts#L199), approval followed by save; [DiffViewProvider.ts:658](../src/integrations/editor/DiffViewProvider.ts#L658), unconditional direct write. Equivalent caller: [WriteToFileTool.ts:114](../src/core/tools/WriteToFileTool.ts#L114).

**Trigger:** enable `preventFocusDisruption`, request an edit, change the same file externally while the approval is pending, then approve.

**Failure and context:** the replacement and displayed diff are calculated from the earlier disk content. `saveDirectly` writes that replacement without checking the original content/version immediately before committing it. Alpha's workspace mutation gate serializes participating Alpha operations, but it does not serialize an external editor or process. The [registry's before/after content capture](../src/core/tools/ToolRegistry.ts#L448) records mutation evidence; it does not reject this stale write.

**Evidence:** a temporary file started as `const count = 1\n`. During approval for `1` → `2`, the probe appended `// concurrent user edit\n`. The actual EditTool/direct-save path completed without an error, leaving only `const count = 2\n`; the concurrent edit was gone.

**Scope:** this reproduction applies to the direct-save experiment, which [defaults to disabled](../src/shared/experiments.ts#L19). The default diff-editor path was not claimed to have this same race. Handling already-dirty editor buffers also warrants coverage at the same boundary; that separate scenario was not reproduced.

**Follow-up boundary:** enforce stale-content/dirty-document protection at the shared save boundary. Test both `edit` and `write_to_file`, changes during approval, and conflicting writes immediately before commit. A stale write should produce an actionable conflict instead of discarding user work.

### E03 — An incomplete summary can replace the active conversation context

**High / must-fix · Workstream B · Reproduced with controlled provider streams**

**Locations:** [condense/index.ts:655](../src/core/condense/index.ts#L655), summary stream consumption; [condense/index.ts:712](../src/core/condense/index.ts#L712), acceptance of nonempty text; [condense/index.ts:788](../src/core/condense/index.ts#L788), summary insertion; [condense/index.ts:862](../src/core/condense/index.ts#L862), effective-history selection.

**Trigger:** the summarization provider emits some text, then reports `outcome.status = "incomplete"`, such as an output-token limit or a stream ending without its final event.

**Failure and context:** summarization consumes only text and usage chunks. It ignores the explicit outcome, accepts nonempty summary text, tags the old prefix with `condenseParent`, and reports `reduced`. Subsequent effective history uses the summary in place of that detailed prefix. A truncated summary can therefore omit constraints, findings, or unfinished work just when the agent needs them to continue.

**Evidence:** both an explicit incomplete terminal outcome and an incomplete EOF outcome caused a partial summary to be accepted and the original prefix to be tagged. This is a reachable provider contract: [OpenAI native EOF handling](../src/api/providers/openai-native.ts#L644) and [terminal outcome handling](../src/api/providers/openai-native.ts#L1529) emit incomplete chunks without requiring a thrown error.

**Scope:** the original records remain in saved history; this is loss from active model context, not deletion of the durable transcript. Thrown exceptions and locally aborted signals have separate handling and were not counted as failures. Failed outcomes that are followed by a provider exception reach the existing catch block.

**Follow-up boundary:** make summary acceptance respect canonical response outcomes before changing effective history. Test partial text followed by incompleteness, provider errors, local cancellation, and normal completion; unsuccessful summarization must retain the prior usable history or use the existing explicit recovery policy.

### E04 — Cancellation stops at the MCP adapter after dispatch

**High / must-fix · Workstream C · Reproduced with a controlled pending call**

**Locations:** [UseMcpToolTool.ts:304](../src/core/tools/UseMcpToolTool.ts#L304), dispatch helper; [McpHub.ts:1729](../src/services/mcp/McpHub.ts#L1729), `callTool`; [McpHub.ts:1755](../src/services/mcp/McpHub.ts#L1755), SDK request options. Related resource-read path: [McpHub.ts:1710](../src/services/mcp/McpHub.ts#L1710).

**Trigger:** an MCP call is already in flight when the task is stopped, steered, or its execution signal is cancelled.

**Failure and context:** the dynamic-tool path checks cancellation before dispatch, but it does not forward the scheduler's signal into `McpHub`. `callTool` has no signal parameter and supplies only a timeout to the SDK request. The scheduler therefore remains awaiting the dispatched operation; the cancellation cannot notify that request. Resource reads have the same missing signal connection.

**Evidence:** after an actual registry/scheduler dispatch reached a controlled MCP promise, aborting the scheduler signal forwarded no signal to `callTool` and did not settle the running call before the server promise resolved. Resolving the promise allowed cleanup and cancellation handling to finish.

**Impact and limits:** stop/steering can be delayed until response or timeout; the server-side operation may continue. The configured tool timeout [defaults to 60 seconds and permits up to 3,600 seconds](../src/services/mcp/McpHub.ts#L69). No live server's cancellation behavior was tested, and remote cancellation cannot guarantee rollback of an effect already performed.

**Follow-up boundary:** carry cancellation through both MCP tool and resource APIs into the supported SDK request controls, then settle the canonical receipt and listeners. Test cancellation before approval, before dispatch, during a pending request, and a late result. Simply abandoning the promise would not establish operation cleanup.

### E05 — Tool errors can be recorded as successful calls

**Medium / should-fix · Workstreams C and E · Reproduced through the real scheduler**

**Locations:** [UseMcpToolTool.ts:346](../src/core/tools/UseMcpToolTool.ts#L346), MCP error formatting; [UseMcpToolTool.ts:368](../src/core/tools/UseMcpToolTool.ts#L368), result callback; [ReadCommandOutputTool.ts:113](../src/core/tools/ReadCommandOutputTool.ts#L113), invalid artifact response; [ToolScheduler.ts:237](../src/core/agent/ToolScheduler.ts#L237), result collection; [ToolScheduler.ts:1455](../src/core/agent/ToolScheduler.ts#L1455), history error flag.

**Trigger:** an MCP server returns `{ isError: true, content: [...] }`, or `read_command_output` rejects an invalid artifact identifier.

**Failure and context:** these adapters return an ordinary text result beginning with `Error:` without setting terminal result metadata. The scheduler defaults to `success`; that textual prefix does not establish a structured error status. MCP even sends an error state to the webview while its canonical scheduler result is successful. The scheduler derives `tool_result.is_error` from the result status, creating inconsistent UI, history, and execution evidence.

**Evidence:** an MCP lookup returning `isError: true` and an artifact read with `artifact_id: "invalid.txt"` each produced scheduler status `success` in separate probes. The artifact adapter does set the task's failure flag in this branch; that does not repair its canonical result status. The MCP `isError` branch does not set that flag either.

**Follow-up boundary:** use the existing `setResultMetadata` contract in error-producing adapters, preserving `error`, `denied`, and `cancelled` distinctly. Assert UI status, scheduler status, history `is_error`, and task failure handling together. Do not depend on natural-language error-prefix parsing as the long-term contract.

### E06 — Plain-text completion bypasses the open-todo setting

**Medium / should-fix · Workstream A · Reproduced through the real completion finalizer**

**Locations:** [AttemptCompletionTool.ts:60](../src/core/tools/AttemptCompletionTool.ts#L60), todo policy; [Task.ts:6714](../src/core/task/Task.ts#L6714), text-only completion eligibility; [Task.ts:6932](../src/core/task/Task.ts#L6932), completion gate; [Task.ts:4476](../src/core/task/Task.ts#L4476), shared gate implementation.

**Trigger:** set `preventCompletionWithOpenTodos = true`, keep a pending todo, and receive a normal primary-task text response with no tool calls. Accept its completion boundary.

**Failure and context:** the setting is enforced only inside `attempt_completion`. Ordinary assistant completion runs the shared descendant/verification gate and finalizer, which do not check open todos. The same task can therefore be blocked through one completion route and completed through the other.

**Evidence:** with the setting true and a pending todo, the real loop and finalizer set `didComplete = true` after the mocked user accepted the text completion. Completion persistence/parent-decision adapters reported success as intended for the fixture.

**Scope:** ordinary assistant text completing a turn is an intentional architecture contract. The defect is inconsistent enforcement of an enabled setting, not the existence of text completion.

**Follow-up boundary:** centralize applicable completion policy and exercise both routes with pending, in-progress, and completed todos, plus setting-disabled behavior and state changes during finalization.

### E07 — `write_to_file` rewrites literal content depending on the model name

**Medium / should-fix · Workstream D · Reproduced at the tool/save boundary**

**Location:** [WriteToFileTool.ts:83](../src/core/tools/WriteToFileTool.ts#L83).

**Trigger:** a model whose ID does not contain `claude` supplies literal HTML entities in a native `write_to_file` content argument.

**Failure and context:** the tool unescapes HTML entities before approval/save. Native structured string arguments are already decoded values; an entity in the intended file is legitimate content. Rewriting it can change HTML meaning, string literals, documentation, or fixtures. Identical requested content has different save behavior depending on the model ID.

**Evidence:** requested `<p>&lt;script&gt; &amp;</p>` became `<p><script> &</p>` at `saveDirectly`. The real tool's content transformation was exercised; the save adapter was captured instead of writing an HTML file. The existing write-tool tests [mock the unescaper as an identity function](../src/core/tools/__tests__/writeToFileTool.spec.ts#L51), so they miss this corruption.

**Related review point:** the same tool also strips leading/trailing code fences at lines 75–80. Literal files made entirely of a fenced Markdown block should be included in the eventual content-preservation regression matrix; that case was not a separate audit probe.

**Follow-up boundary:** keep native file content literal and confine any required legacy transport decoding to that transport. Cover entities, literal fences, model independence, and save-result content.

### E08 — Saving an empty replacement skips persistence

**Medium / should-fix · Workstream D · Reproduced at the VS Code save adapter boundary**

**Locations:** [DiffViewProvider.ts:204](../src/integrations/editor/DiffViewProvider.ts#L204), `saveChanges`; callers [EditTool.ts:217](../src/core/tools/EditTool.ts#L217) and [WriteToFileTool.ts:168](../src/core/tools/WriteToFileTool.ts#L168).

**Trigger:** use the default diff-editor path to empty an existing file or write valid empty content.

**Failure and context:** `saveChanges` treats `newContent === ""` as missing initialization and returns before calling the document's `save`, collecting final content, or closing the diff views. An empty string is accepted by the tool contract and is a valid replacement. Callers continue to mark the file edited and return a write result after this early return. With auto-save disabled, the requested contents can remain only in a dirty editor buffer while the tool reports completion.

**Evidence:** a provider with a valid path, dirty editor document, and `newContent: ""` invoked the real `saveChanges`; the document save callback was called zero times. The UI was mocked. The actual update method [stores the supplied empty value](../src/integrations/editor/DiffViewProvider.ts#L124), so this is a reachable state.

**Follow-up boundary:** distinguish uninitialized content from valid empty content. Test the full update/approve/save path with auto-save disabled, verifying disk content, closed diff state, and truthful tool receipts. Preserve separate coverage for user rejection and editor closure.

### E09 — MCP tool results discard embedded image resource data

**Medium / should-fix · Workstream C · Reproduced through the real scheduler**

**Location:** [UseMcpToolTool.ts:281](../src/core/tools/UseMcpToolTool.ts#L281), `processToolContent`.

**Trigger:** an MCP tool returns an embedded resource with `mimeType: "image/png"` and a base64 `blob`, rather than a top-level `image` content block.

**Failure and context:** the resource branch removes `blob` and returns only the remaining metadata as JSON. It never adds the image to the image collection. Top-level image blocks are handled, but the equivalent embedded resource loses its payload before reaching chat/model content. A tool can report a successful image-bearing result while leaving the model unable to inspect it.

**Evidence:** an embedded resource with a one-pixel PNG payload produced no model image block. The fixture also passed the installed MCP SDK's `CallToolResultSchema`, confirming it is a supported input shape. The reproduction used the real dynamic MCP registry, content processing, and scheduler result projection.

**Follow-up boundary:** normalize supported embedded image resources into the existing image path. For unsupported binary resources, return an explicit bounded representation or retrieval route instead of silently dropping data. Cover embedded text, embedded images, top-level images, and unsupported binary types.

### E10 — Log search says “no matches” when a matching line exceeds the limit

**Medium / should-fix · Workstream E · Reproduced with a real output artifact**

**Locations:** [ReadCommandOutputTool.ts:343](../src/core/tools/ReadCommandOutputTool.ts#L343), matching-line budget check; [ReadCommandOutputTool.ts:374](../src/core/tools/ReadCommandOutputTool.ts#L374), no-match response.

**Trigger:** search a command artifact whose first matching line is longer than the requested output budget. Large single-line JSON, minified output, and long diagnostics can reach this case.

**Failure and context:** the search recognizes the matching line, then hits its size check before adding it to `matches`. With no earlier matches, the final branch reports “No matches found for the search pattern.” An oversized matching final line without a newline is also silently omitted. A retrieval limit is therefore misrepresented as evidence that the searched error or result does not exist.

**Evidence:** an artifact containing `"ERROR " + "x".repeat(50000) + "\n"` searched for `ERROR` with the default 40,960-byte limit returned `matchCount: 0` and the no-match response.

**Follow-up boundary:** retain the fact that a match exists and return bounded/truncated content with an explicit continuation or limit indicator. Cover first matches over the budget, newline/no-newline endings, and earlier matches that consume the budget.

### E11 — Blank-line matches bypass the command-output search budget

**Medium / should-fix · Workstream E · Measured resource-bound defect**

**Locations:** [ReadCommandOutputTool.ts:344](../src/core/tools/ReadCommandOutputTool.ts#L344), byte accounting; [ReadCommandOutputTool.ts:352](../src/core/tools/ReadCommandOutputTool.ts#L352), match accumulation; [ReadCommandOutputTool.ts:385](../src/core/tools/ReadCommandOutputTool.ts#L385), output construction.

**Trigger:** search a large artifact for a pattern matching empty lines, for example `^$`.

**Failure and context:** the budget charges only the line's content bytes. A blank line costs zero, although it consumes an array entry and creates numbered output. The loop can retain every matching blank line and format the entire result regardless of the requested limit. Newlines and numbering are also uncharged for nonempty lines. Scheduler truncation happens after this allocation and formatting, so it cannot bound the tool's intermediate memory or work.

**Measured fixture:** 100,000 newline bytes, pattern `^$`, requested limit 16 bytes → **100,000 retained matches and 900,089 output bytes**. The final local probe took approximately 40.5 ms. The defect is the unbounded relation between the requested budget and accumulated output; this single timing sample is not a general extension-latency benchmark. No optimization was applied and there is no before/after speed claim.

**Follow-up boundary:** charge the actual rendered payload and bound match count/intermediate storage while scanning. Verify bounded output and match retention for empty lines, tiny nonempty lines, long lines, and normal logs, including cancellation during large searches. Coordinate with E10 so enforcing a limit cannot produce false no-match results.

## Validation record

### Original audit baseline

These repository tests ran before remediation without source or test modifications:

| Area                                                        | Existing test files                                                                                                                                                                                                                                  | Result                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Loop, scheduling, retry, completion, queued asks, context   | `AgentTurnEngine.spec.ts`, `ToolScheduler.spec.ts`, `ToolScheduler.progress.spec.ts`, `Task.retry-wire.spec.ts`, `stageThreeCompletion.integration.spec.ts`, `ask-queued-message-drain.spec.ts`, `context-management.spec.ts`, `recent-tail.spec.ts` | 192 passed; 8 files           |
| MCP, writes, editor save, lifecycle projection, transcripts | `useMcpToolTool.spec.ts`, `writeToFileTool.spec.ts`, `editTool.spec.ts`, `DiffViewProvider.spec.ts`, `AgentLifecycleProjection.spec.ts`, `ProviderTranscriptStore.spec.ts`, `stageFourTranscript.integration.spec.ts`                                | 90 passed, 5 skipped; 7 files |
| Chat and extension-state projection                         | `ChatView.spec.tsx`, `ExtensionStateContext.spec.tsx`                                                                                                                                                                                                | 133 passed; 2 files           |

Commands used, from the repository root:

```powershell
pnpm --dir src test -- core/agent/__tests__/AgentTurnEngine.spec.ts core/agent/__tests__/ToolScheduler.spec.ts core/agent/__tests__/ToolScheduler.progress.spec.ts core/task/__tests__/Task.retry-wire.spec.ts core/task/__tests__/stageThreeCompletion.integration.spec.ts core/task/__tests__/ask-queued-message-drain.spec.ts core/context-management/__tests__/context-management.spec.ts core/condense/__tests__/recent-tail.spec.ts --maxWorkers=4
pnpm --dir src test -- core/tools/__tests__/useMcpToolTool.spec.ts core/tools/__tests__/writeToFileTool.spec.ts core/tools/__tests__/editTool.spec.ts integrations/editor/__tests__/DiffViewProvider.spec.ts core/webview/__tests__/AgentLifecycleProjection.spec.ts core/task-persistence/__tests__/ProviderTranscriptStore.spec.ts core/task-persistence/__tests__/stageFourTranscript.integration.spec.ts --maxWorkers=4
pnpm --dir webview-ui test -- src/components/chat/__tests__/ChatView.spec.tsx src/context/__tests__/ExtensionStateContext.spec.tsx --maxWorkers=3
```

The temporary audit harness is at `C:\Users\Luke Goblirsch\AppData\Local\Temp\alpha-extension-audit-20260904\audit-probes.spec.ts`. It imports the extension implementation and uses the repository's Vitest setup/VS Code mock. Before remediation, its final discovery run had **14 expected assertion failures**, with no setup exceptions: E01 has two cases, E03 has two, E05 has two, and the other eight findings have one each. The harness is local and temporary; durable regression coverage was added to the owning repository suites.

```powershell
pnpm --dir src test -- --dir 'C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-extension-audit-20260904' --maxWorkers=1 --no-silent
```

### Remediation verification

| Gate | Final result |
| ---- | ------------ |
| Original external audit harness | **14 passed**; the same defect cases now satisfy their intended assertions. Fixture-only updates reflected the new private method signature and terminal/resume semantics. |
| Focused extension regression surface | **17 files passed; 637 tests passed, 5 skipped** across the turn loop, compaction, file mutation, MCP, command-output, scheduler, and editor-save suites. |
| Focused webview MCP projection | **1 file and 1 test passed**. |
| Full workspace `pnpm test` | Bundle succeeded; **11/11 workspace test tasks passed**. The extension result was **501 files passed, 3 skipped; 7,512 tests passed, 42 skipped**. |
| Static checks | Root lint and typecheck passed. Extension lint and typecheck were repeated after the final fixture corrections and passed. Webview lint and typecheck passed. `pnpm knip` passed. |
| Exact VS Code host | `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed on **VS Code 1.122.1**: activation/commands 2 tests, modes 2 tests, and VS Code LM contracts 4 tests. The LM coverage includes late cancellation, tool-call/result continuation, provider-error recovery, and a healthy subsequent task. |

The E11 audit workload used the same 100,000 blank-line input, `^$` pattern, and 16-byte requested limit. Before remediation it retained 100,000 matches and built 900,089 output bytes in approximately 40.5 ms. Across the final verification runs, the remediated path retained one bounded match, returned 16 bytes, and completed in approximately 20–22 ms. These are deterministic single-fixture measurements that demonstrate removal of output amplification; they are not a generalized latency claim.

The command-output regression suite also verifies that search initialization failures close their file handle, covering the adjacent ownership defect found during remediation.

### Remaining limits

- Existing-file writes still have the unavoidable local-filesystem interval between the last content check and the write, and patch moves have a similar interval between the last source check and deletion. Expected-missing destinations use exclusive creation. The current Node/VS Code APIs do not provide a portable compare-and-swap write for existing files.
- If MCP cancellation arrives after a completed terminal result has already been posted to the webview but before `ToolScheduler` observes handler completion, the canonical scheduler receipt/history can become `cancelled` while the already-posted UI terminal remains completed. Rewriting that UI event would violate the exactly-once terminal contract; closing this interval would require moving terminal UI ownership into the scheduler transaction.
- Regex protection is a bounded heuristic: ordinary flat quantifiers remain supported, known nested or overlapping forms are rejected, and each searched line is capped at the configured scan bound. JavaScript regular expressions outside those checks can still consume CPU within that line bound.
- The exact-host gate used deterministic providers and MCP behavior was tested with controlled adapters. No remote server can guarantee rollback after an MCP side effect has already occurred, and this work did not claim live-provider quality or full extension performance profiling.

## Coverage and closure ledger

| Area                             | Review coverage and result                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model-step/turn loop             | E01 and E06 are fixed at the Task-owned recovery and shared completion boundaries, with primary-turn, retry, denial, stale-loop, todo-state, and integration coverage. No parallel task engine was introduced.                 |
| Tool dispatch and result history | E04, E05, and E09 are fixed across adapters, `McpHub`, scheduler receipts/history, and MCP webview projection. E10/E11 are fixed at the command-output boundary with shared schema/runtime limits.                           |
| Memory and persistence           | E03 is fixed at summary acceptance; failed or incomplete lifecycle-provider summaries cannot replace effective history. Existing persistence and compatible legacy EOF behavior remain intact.                              |
| Workspace mutations              | E02, E07, and E08 are fixed across direct saves, diff saves, edits, writes, and patch moves, including dirty buffers, stale baselines, empty content, literal content, and failed save/apply operations.                      |
| Chat/session lifecycle           | E01's explicit resume boundary is covered in Task/integration tests and the exact-host gate verifies healthy completion, follow-up continuation, cancellation recovery, and provider-error recovery.                         |
| Provider adapters                | Canonical lifecycle outcomes now govern compaction acceptance, while the existing VS Code LM response ordering, tool transactions, late-cancellation behavior, and recovery contracts pass on VS Code 1.122.1.               |
| Performance                      | E11's retained matches/output are bounded by the requested rendered payload, scanning yields to cancellation, known nested/overlapping regex forms are rejected, and the original amplification fixture is bounded; the regex guard remains heuristic. |
| Delegation                       | Managed-child terminal behavior remains distinct from primary-task recovery. Existing nested-delegation coverage was updated for the shared completion decision and passes in the full suite.                              |

- **Fixed now:** E01–E11, with regression coverage in each owning layer.
- **Additional repair:** command-output search now closes its file handle even when initialization fails.
- **Verified:** focused regressions, the original audit probes, lint, typecheck, dead-code analysis, bundle/full workspace tests, and the exact VS Code 1.122.1 smoke gate.
- **Residual limits:** the narrow filesystem and MCP terminal-order intervals described above, plus live-service and broad performance work outside this bounded repair.
- **Out of scope:** `apps/cli/`, `packages/vscode-shim/`, other applications, general repository cleanup, and release/package changes.
