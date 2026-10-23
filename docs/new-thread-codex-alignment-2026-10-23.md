# New-chat and fork behavior: Codex comparison

Reviewed 2026-10-23 against OpenAI Codex main commit
[`adca78ddae79568279d0731dfdebef1df16f3cde`](https://github.com/openai/codex/commit/adca78ddae79568279d0731dfdebef1df16f3cde).
The investigation and implementation below align Alpha's fresh-chat and history-fork selection with those semantics.

## Expected behavior

| Operation | Conversation context                                                                                | Work directory and continuation                                                          |
| --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| New chat  | Fresh conversation; the old transcript and its compaction summary are not automatically copied.     | Current directory or a separately selected worktree. Start with the supplied new prompt. |
| Fork      | A new identity with retained source conversation history, subject to the selected history boundary. | Checkout choice is separate from history inheritance. Continue the copied conversation.  |
| Resume    | Reopen the saved conversation.                                                                      | Restore its recorded task and execution settings under applicable host policy.           |
| Compact   | Summarize context within the existing conversation.                                                 | Does not create a fresh chat.                                                            |

A fresh chat still receives applicable configuration, tools, instructions, repository state and any enabled memory
mechanism. Those sources are distinct from cloning the previous conversation. A worktree isolates files; it does not
determine whether a conversation is fresh or forked.

For “this chat is long; create a new chat and work on these tickets,” the appropriate fresh-chat handoff is a concise
new prompt containing ticket identities, the requested outcome, essential decisions or constraints, and pointers to
durable project material. Carrying the complete prior transcript is fork behavior. The exact wording of a natural-language
request alone does not prove which host operation a model selected.

## Upstream evidence

- [Official new-chat instructions](https://learn.chatgpt.com/docs/developer-commands#start-a-new-chat-with-new) describe
  a fresh chat and a separate checkout choice. The current terminal scrollback may remain visible after `/new`;
  this is not proof that it was added to the new model context.
- [Official fork instructions](https://learn.chatgpt.com/docs/developer-commands#fork-the-current-chat-with-fork) explicitly
  describe cloning the current chat with a new identity.
- [Slash-command dispatch](https://github.com/openai/codex/blob/adca78ddae79568279d0731dfdebef1df16f3cde/codex-rs/tui/src/chatwidget/slash_dispatch.rs#L237)
  chooses distinct New and Fork checkout modes.
- [Fresh-session startup](https://github.com/openai/codex/blob/adca78ddae79568279d0731dfdebef1df16f3cde/codex-rs/tui/src/app/session_lifecycle.rs#L998)
  loads new-session configuration, starts a thread, and attaches it with fresh presentation.
- [Thread startup defaults](https://github.com/openai/codex/blob/adca78ddae79568279d0731dfdebef1df16f3cde/codex-rs/core/src/thread_manager.rs#L329)
  use `InitialHistory::New`. Fork methods separately supply existing history.
- [Fresh-thread tests](https://github.com/openai/codex/blob/adca78ddae79568279d0731dfdebef1df16f3cde/codex-rs/app-server/tests/suite/v2/thread_start.rs#L384)
  assert fresh identity, empty preview and idle status.
- [Fork history tests](https://github.com/openai/codex/blob/adca78ddae79568279d0731dfdebef1df16f3cde/codex-rs/core/tests/suite/fork_thread.rs#L279)
  verify inherited history survives persistence and is available to subsequent model requests.

CLI slash commands and app-server thread operations are host controls. Alpha additionally supplies model-facing
independent-thread tools; their routing and instructions require their own verification.

## Alpha findings

- `ThreadOrchestrationTools.ts` dispatches `create_thread` to `AlphaProvider.createIndependentTask`, forwarding the
  supplied prompt. It dispatches `fork_thread` separately to `forkIndependentTask`.
- `createIndependentTask` creates a new background primary task with a distinct identity. It carries execution settings
  and workspace association, but passes neither a parent Task nor source conversation history to `createTask`.
  `historyWorkspacePath` records workspace association; it is not conversation inheritance.
- `Task.startTask` clears visible messages and initializes model history to an empty array for ordinary fresh tasks.
  Explicit managed-subagent native-history forks have a separate branch; that branch is not used by `create_thread`.
- The UI `newTask` handler also calls fresh `createTask` with no parent Task.
- `forkIndependentTask` deliberately copies provider and visible history through `forkTaskHistory`, persists
  `forkedFromId`, and leaves the fork idle. A follow-up starts work there.
- The `create_thread` schema limits its supplied prompt to 1,000 UTF-8 bytes. A complete long transcript displayed as
  separate historical messages is more consistent with the fork path than a normal create call.
- Before this change, the descriptions did not clearly prescribe fresh creation for “new chat.” `fork_thread` remained
  callable even when `create_thread` was hidden for lack of a new-task request. A focused regression reproduced that
  fresh-chat requests still exposed an executable history fork across OpenAI, VS Code LM, and Vertex.

The reported incident is not conclusively attributed to either tool. The locally discovered standard-profile history
index contained no entries matching this workspace, so it did not establish the incident's actual call or provenance.
Do not infer a proven transcript-cloning defect in fresh-task startup from the symptom alone.

## Implemented alignment

- The create description specifies empty conversation history and a concise, self-contained handoff with ticket
  references, the objective, essential decisions, and constraints. It excludes copying the old transcript or compaction
  summary. The fork description specifies explicit history retention and idle startup.
- The existing provider-neutral human-request classifier now distinguishes fork/history-retention requests from fresh
  creation. Common handoffs such as “work on these tickets in a new chat” also authorize fresh creation. Quoted examples,
  explanations, synthetic inputs, later revocations, and deferred approvals cannot supply a fork grant.
- Asking for context about a ticket remains a fresh handoff. It does not authorize a transcript fork; retaining context
  requires an explicit reference to the same, full, current, or existing conversation context.
- The captured tool catalog only offers a callable fork when that fork intent exists. Its cache key includes fork
  authorization, so a preceding fork request cannot leave the tool callable on a later fresh-chat turn. Full Access does
  not replace the human's requested conversation operation.
- Restricted providers may retain a historical fork declaration for transcript replay. That declaration is excluded
  from the callable allow-list; saved history does not authorize another fork.
- `AlphaProvider.forkIndependentTask` independently checks the latest human request before acquiring source ownership or
  copying transcripts. This also protects direct calls that do not originate through the model tool catalog.
- Fresh task startup, persisted transcript shapes, checkout behavior, execution permissions, and managed-subagent history
  inheritance remain unchanged. A regression verifies that even a compacted parent supplies only the new objective to
  fresh-task admission.

Codex CLI's slash commands already distinguish these host operations. Alpha's model-facing tools are an additional
surface; applying Alpha's existing explicit-human-request boundary to history forks is an intentional host adaptation,
not a claim that Codex uses the same language classifier. Verify the originating call and the new thread's
`forkedFromId` before attributing a particular historical incident.

## Validation

Focused validation against the working tree:

```sh
pnpm --dir src test core/agent/__tests__/independentTaskAuthorization.spec.ts core/agent/__tests__/requestWorkClass.spec.ts core/webview/__tests__/CrossTaskOrchestration.spec.ts core/task/__tests__/lookupCatalog.surface.spec.ts core/prompts/tools/native-tools/__tests__/cross_task_orchestration.spec.ts core/tools/__tests__/nativeToolSurfaceRefactor.spec.ts core/tools/__tests__/ThreadOrchestrationTools.spec.ts core/task-persistence/__tests__/ThreadHistory.spec.ts core/assistant-message/__tests__/thread-native-tool-pipeline.spec.ts core/tools/__tests__/validateToolUse.spec.ts core/task/__tests__/Task.steering-authorization.astra-review.spec.ts
```

All 11 test files passed: 376 tests. Coverage includes request classification, provider-neutral visibility and execution
policy, catalog-cache changes, restricted-provider replay, direct host checks, fresh handoffs from compacted history,
fork persistence, parsing, cancellation, and approval/error receipts. These deterministic tests do not establish which
tool ran in the historical incident or measure live-model tool-selection accuracy.

`pnpm --dir src check-types` passed. ESLint and Prettier checks passed for all ten affected source/test files, and
`git diff --check` passed for those files. The design note also passed Prettier.

`pnpm --filter @alpha-code/vscode-e2e test:smoke:1380` passed on the final source, including the extension bundle,
webview build, and all 13 sequential host suites using scripted providers and the VS Code LM fixture. The final suite's
manifest confirmed actual VS Code 1.138.0, verified host ownership, and no pending or failed tests (run
`2d0d1e75-8f7c-4788-8b62-3443891dc540`). Source/test fingerprints stayed unchanged throughout final validation.
