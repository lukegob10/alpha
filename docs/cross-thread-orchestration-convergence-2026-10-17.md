# Cross-thread orchestration convergence

Reference: OpenAI Codex commit [`ce0323f2f2d3b25e82806cd555237da3db4e1897`](https://github.com/openai/codex/commit/ce0323f2f2d3b25e82806cd555237da3db4e1897), retrieved 2026-10-17.

## Scope and upstream evidence

This contract covers coordinating independent Alpha conversations from another conversation. Managed agents continue to
use their existing delegation tree, narrowed authority, budgets, and workspace ownership. Alpha remains a native
TypeScript VS Code extension. This work introduces no Rust runtime, copied Codex prompts, or Codex sandbox implementation.

Current Codex CLI contains model-facing thread tools, in addition to the app-server's client protocol:

- [`codex-rs/tui/src/dynamic_tools.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/tui/src/dynamic_tools.rs)
  defines schemas and behavior for the nine tools below.
- [`codex-rs/tui/src/dynamic_tools_mcp.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/tui/src/dynamic_tools_mcp.rs)
  marks list/read/wait as read operations and requires prompted approval for create, send, and fork. The TUI's direct
  dynamic-tool route rejects these three delegation operations when the approval-gated transport is absent.
- [`codex-rs/tui/src/app_server_session.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/tui/src/app_server_session.rs)
  enables the TUI task service for external app-server connections. This source does not establish that every CLI session
  exposes the tools.
- [`codex-rs/tui/src/dynamic_tools_tests.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/tui/src/dynamic_tools_tests.rs)
  verifies unrelated-thread inspection, create/send, self and peer forks, archive/restore, bounded reads, and wait cursors.
- [`codex-rs/tui/src/thread_transcript.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/tui/src/thread_transcript.rs)
  projects incoming user-message items through its user-message history cell. Alpha's colored incoming-chat bubble is a
  presentation choice requested for this extension; its model input retains agent attribution.
- [`codex-rs/app-server-protocol/src/protocol/v2/turn.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)
  defines client-only `turn/steer` with an expected active-turn ID and `turn/interrupt` with a target turn ID. These client
  methods are distinct from the nine model-facing TUI tools. Alpha's existing `steer_task` and `stop_task` remain extensions
  to that model-facing surface.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes thread lifecycle and turn
control for external clients. Public client methods alone are not evidence that a model can call them.

## Native tool contract

Alpha exposes the upstream tool names and camelCase arguments through its existing tool registry, scheduler, policy
snapshot, and task host. Historical task-oriented tool calls remain readable and executable for compatibility.

| Tool                     | Input and behavior                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_threads`           | Optional `limit`, default 10, maximum 50. Recent unarchived independent conversations, ordered by latest activity.                                                                                                                                              |
| `list_archived_threads`  | Optional `limit` and pagination `cursor`. Lists archived conversations without restoring them.                                                                                                                                                                  |
| `read_thread`            | Required `threadId`; optional `cursor`, `turnLimit` (default 1, maximum 10), `includeOutputs` (default false), and `maxOutputCharsPerItem` (default 2,000, maximum 20,000). Returns recent history and status without selecting or resuming the conversation.   |
| `wait_threads`           | One to eight `{threadId, afterCursor?}` targets and optional `timeoutMs` from 0 to 120,000 (default 120,000). Returns a bounded snapshot and wakes for completion or required user action. A previous cursor prevents repeatedly reporting the same completion. |
| `create_thread`          | Required `prompt`, optional `title` and `model`. Starts a separate conversation only when the user explicitly requests one. Inherits the source's native workspace and effective task configuration.                                                            |
| `fork_thread`            | Optional `threadId`, defaulting to the caller. Persists a separate idle conversation containing completed history. Does not start a model request. The active source turn and incomplete tool transactions are excluded.                                        |
| `send_message_to_thread` | Required `threadId` and `prompt`, optional `model`. Delivers attributed agent context to a peer and resumes an idle recipient. An active recipient receives the message at a safe model-step boundary.                                                          |
| `set_thread_title`       | Required `title`, optional `threadId` defaulting to the caller. Changes the saved display label while preserving the original prompt.                                                                                                                           |
| `set_thread_archived`    | Required `archived`, optional `threadId` defaulting to the caller. Archives a conversation and its independent descendants; restores only the selected conversation. A running caller cannot archive itself through its tool.                                   |

Create and send prompts are nonempty and bounded to 1,000 UTF-8 bytes, matching the upstream public prompt budget.
Tool results must remain valid structured data when history or output is truncated; identifiers and pagination cursors
must remain usable. Titles, summaries, transcripts, and incoming agent messages remain untrusted context.
Mutating tools check that their identity receipt fits the remaining output budget before dispatching the effect, so a
successful creation or fork cannot lose its returned conversation ID because its tool result is too large.
Archived conversations remain readable; restore a conversation before sending it a new prompt. Upstream's
[`thread_resume_rejects_archived_session_by_id`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/app-server/tests/suite/v2/thread_resume.rs)
regression test verifies that resuming does not silently unarchive it.

No adoption or reparenting operation is required to coordinate an existing peer. Each conversation retains its existing
identity, policy, provider configuration, transcript, completion ownership, and lifecycle. A coordinating conversation can
inspect and message a peer without becoming its parent. Managed-agent result verification and cancellation inheritance
continue to apply to managed agents.

## Intentional Alpha differences

- **Workspace boundary.** Upstream TUI tools can enumerate the connected app-server's conversations across directories.
  Alpha restricts peer visibility and control to primary conversations in the same saved workspace scope, including
  supported task worktrees. Managed agents, diagnostic sessions, and historical delegated task records are excluded. A
  guessed task ID does not widen this boundary.
- **Host boundary.** Live routing uses Alpha's shared extension-host registry, including sidebar and editor-panel views.
  This work does not add an interprocess controller for a task running in another VS Code window. The acceptance evidence
  covers independent conversations and saved forks in one host and workspace. Automation rejects send,
  stop, and archive operations on an unloaded conversation whose saved state is nonterminal or unknown; it cannot assume
  that another producer has stopped. Known terminal conversations remain eligible for explicit resumption.
- **Host policy.** Alpha uses its existing task mode, approval policy, tool surface, workspace checks, cancellation, and
  persistence. Calling another conversation never changes its mode or elevates its authority. Plan remains read-only;
  lifecycle mutations follow the host's executable tool policy. Creation and resumption obey the existing live-task
  capacity; saving an idle fork does not allocate a live producer.
- **Provider configuration.** The current provider and saved recipient configuration remain authoritative. An optional
  model request must be explicitly user-requested and compatible with the existing provider; it cannot silently select a
  new provider or permission profile.
- **Message delivery.** Agent messages use Alpha's durable attributed inbox and safe step boundaries. They do not answer
  pending human questions or approvals. Alpha additionally provides explicit steering and stop tools for interruption.
  Incoming peer input has a durable `agent_message` UI receipt rendered in the existing colored user-message bubble,
  labeled "From another chat". It remains agent-origin input in model history. The bubble is copyable, does not enter
  human prompt history, and does not expose human edit/resend actions. Receipts deduplicate by message ID across replay;
  incoming bubbles preserve pending approval controls and in-progress assistant streaming. Cold recipients project
  their receipt after transcript hydration. Internal wake instructions remain outside the visible chat.
  An explicit `stop_task` first persists a protected, sender-attributed bubble with the reason (or "Stop this
  conversation."). Its optional `agentMessage.stopStatus` moves from `requested` to `stopped` only after the existing
  cancellation, producer joins, persistence, and termination hooks succeed. Cleanup failures leave the request visible
  without claiming a completed stop. Repeated calls reuse the receipt while the runtime remains registered; terminal
  targets remain unchanged. A cancelled API row records the associated `agentStopMessageId` and identifies the peer stop
  instead of showing a generic cancellation. These receipts never enter the model inbox or human input queue and cannot
  start another turn on reload. A still-hydrating transcript rejects the stop for retry before cancellation so it cannot
  overwrite saved history. Internal archive and creation cleanup keep their existing behavior. This presentation follows
  Alpha's incoming-message UX; upstream's host-controlled shutdown still cancels active work and flushes persistence
  ([`session/handlers.rs`](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/core/src/session/handlers.rs)).
  A canonical `create_thread` records `orchestrationNotifyCompletion: false`; callers collect results with `read_thread`
  or `wait_threads`. Completion does not automatically start an extra turn in the creating conversation. Older
  `create_task` conversations retain their existing automatic completion reports when this field is absent.
- **Prompt construction.** Tool descriptions and orchestration guidance describe the verified behavior in Alpha's own
  language. Codex source prompt text and its XML delegation wrapper are not copied into Alpha.
- **Native tool adapter.** Upstream's TUI uses a `codex_tui` namespace, deferred tool declarations, and an approval-gated
  MCP transport. Alpha registers the same function names and arguments through its native tool catalog and host policy;
  it does not introduce a local MCP server to imitate that transport. Saved display titles retain Alpha's existing
  96-character limit.
- **Compatibility.** Existing `create_task`, `list_tasks`, `wait_task`, and `send_task_message` calls continue to use the same
  runtime. Their saved tool-call names do not create a second orchestration engine. Alpha's `steer_task` and `stop_task`
  remain available as additional controls.

These differences preserve Alpha's extension and security contracts. This document records convergence of the independent
conversation workflow; it does not establish complete Codex harness parity.

## Acceptance evidence

The deterministic real-host scenarios live in
[`apps/vscode-e2e/src/suite/cross-task-orchestration.acceptance.test.ts`](../apps/vscode-e2e/src/suite/cross-task-orchestration.acceptance.test.ts).
They cover existing child orchestration and coordination of independently created conversations through model tool calls.
The peer scenario checks that a fork remains idle until explicitly continued and that peers retain separate identities.

Run the focused exact-host suite with:

```sh
pnpm --filter @alpha-code/vscode-e2e test:cross-task:1250
```

The task lifecycle and persistence changes also require the standard exact-host release gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

### Initial thread implementation verification on 2026-10-17

- The final focused unit batch passed **520 tests across 21 files**, covering native schemas, receipts, policy and
  approvals, historical compatibility, public history and fork boundaries, metadata, durable delivery, lifecycle wakes,
  steering, host controls, and unknown cold-producer safeguards. This is one unified batch, excluding overlapping earlier
  runs. Log: `/tmp/alpha-thread-guarded-focused-20261017.log`.
- Extension type checking (`tsc --noEmit`), scoped ESLint, E2E compilation, and affected-path whitespace checks passed.
- The final native extension bundle passed. SHA-256 of `src/dist/extension.js`:
  `fd4754e231ee0025d2205b642fe4a9a7dfa6a7f9f765eb567d11f986504b681a`.
- The focused cross-thread acceptance suite passed **3/3**, with no pending or failed tests, on verified VS Code
  **1.125.0**. Run ID: `e086408e-df06-48e9-84fd-21c242a5ce48`; scripted provider; owned temporary profile
  `alpha-vscode-e2e-6x2ygR`. Log: `/tmp/alpha-thread-guarded-cross-task-20261017.log`.
- The complete exact-host smoke runner passed **42/42 across 13 selections**, with no pending or failed tests and exit
  code 0. Every selection verified actual VS Code **1.125.0**, profile ownership, and host exit. Twelve selections used
  the scripted provider; `vscode-lm-contract` used the deterministic VS Code LM fixture. Log:
  `/tmp/alpha-thread-guarded-smoke-20261017.log`.

These are deterministic extension-host checks, without a live model-quality or performance claim. The test environment
used Windows Node.js 24.21.0 and pnpm 11.24.0, launched from WSL. Tests used dedicated temporary profiles and did not
install into the user's running editor.

The final smoke receipts identify these runs:

| Selection                       | Passed | Run ID                                 |
| ------------------------------- | ------ | -------------------------------------- |
| `extension`                     | 5/5    | `b779bbab-52fb-401e-a919-dd9a0795370a` |
| `modes`                         | 2/2    | `b1ff2ed1-a743-4a55-bee8-20bed428dbd3` |
| `approval-mode`                 | 17/17  | `f1338d38-be81-46b5-aa47-7477e4c3886b` |
| `command-path-approval`         | 1/1    | `50d1c177-6de5-49a7-a600-843641bfe4dd` |
| `command-file-diff`             | 1/1    | `5398c0f2-a1a3-4640-a5c0-ce09167d03e7` |
| `tool-search.acceptance`        | 1/1    | `1bb3e817-5c18-461c-b071-aec0cb14c40b` |
| `alpha-tickets.acceptance`      | 1/1    | `6383c16b-4821-4a6b-b169-d095f04e4c20` |
| `request-user-input-async`      | 1/1    | `8733688a-dc8f-4507-90cb-ebb79ac86860` |
| `update-plan.acceptance`        | 1/1    | `fed4a747-7ccd-4f2f-851d-b01aa06ff01e` |
| `view-image.acceptance`         | 1/1    | `90b61289-5e4b-4466-a815-e46881995711` |
| `compaction-acceptance`         | 2/2    | `54b1c1c7-ea14-42a6-bcb1-8e6a27b21d70` |
| `vscode-lm-contract`            | 7/7    | `149b7cc2-5d63-4d68-99dd-49ae95c7b89a` |
| `background-command-completion` | 2/2    | `e30b17d9-9a9f-4151-ba66-3c8bb7c20007` |

The Windows tool environment used for this verification inherited `ELECTRON_RUN_AS_NODE=1`, which made the first standard
smoke attempt execute `Code.exe` as Node before any tests ran. The verification launcher removed that variable from its
own child environment and invoked the existing exact-host runner with the same version, owned temporary profiles, and
required-test settings. The original gate completed the workspace bundle and webview build. After the final guarded
source changes, verification reran `pnpm --dir src bundle`, the focused compiled runner, and
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250:run`; the unchanged built webview was reused. The smoke runner
recompiled its tests before all 13 selections. This workaround changes the test process environment only.

### Incoming-message bubble follow-up on 2026-10-17

Incoming peer messages reuse the existing colored input bubble with a "From another chat" label and copy action. A
separate typed presentation receipt preserves agent provenance, keeps human prompt history unchanged, and prevents
edit/resend actions from turning the received text into a human instruction. The existing transcript commit queue owns
receipt persistence and deduplication. Pending approvals, partial text/reasoning/command output, cold hydration, and
recovery of an unacknowledged inbox entry retain their original execution semantics.

Completed checks for this follow-up:

- Core/task regression batch: **481/481 tests across 6 files**.
- Webview regression batch: **247/247 tests across 5 files**.
- Complete shared-types package: **607/607 tests across 52 files**.
- Extension, webview, and shared-types type checks; scoped ESLint; formatting; and affected-path whitespace checks passed.
- The standard `test:smoke:1250` gate passed **42/42 tests across all 13 selections**, including its full workspace bundle,
  webview rebuild, and E2E compilation. All receipts verified actual VS Code **1.125.0** and owned temporary profiles;
  none failed or remained pending. Final smoke run: `5c216d3a-11b9-4f50-a72d-d0730d17c40d`.
- The compiled cross-thread acceptance suite passed **3/3** on the same build, including visible sender-attributed
  receipts for both messaging and steering, exactly one bubble per input, and no visible internal wake instruction.
  Run: `4adf1e6f-818c-4846-a47d-4cbfde7e5da7`; scripted provider; verified VS Code **1.125.0** and host exit.
- Extension bundle SHA-256: `2a312370fa09920ce8ac24b2b3d220d75e1df4310c655129d881037c21596d74`.

Logs: `/tmp/alpha-chat-bubble-core-tests-20261017.log`, `/tmp/alpha-chat-bubble-ui-tests-20261017.log`, and
`/tmp/alpha-chat-bubble-all-shared-tests-20261017.log`. Host logs:
`/tmp/alpha-chat-bubble-smoke1250-20261017.log` and `/tmp/alpha-chat-bubble-cross-thread1250-20261017.log`.
The process launcher cleared the inherited Electron flag before invoking the pinned pnpm gate, then reused its compiled
runner for the focused selection. No runner, profile, host-version, or execution-policy changes were required.

### Peer stop message follow-up on 2026-10-17

Explicit peer stops now persist their attributed reason before cancellation. The receipt reports a requested stop until
the existing termination boundary completes, then persists "Stopped by another chat". The cancelled API row identifies
the same receipt. Stop notices remain outside the model inbox and human queue. Regression coverage checks persistence
before cancellation, failed receipt writes, repeated requests, hydration safeguards, ownership loss, saved presentation,
and absence of a follow-up model prompt.

Completed checks:

- Core/task batch: **146/146 tests across 7 files**.
- Webview batch: **240/240 tests across 2 files**.
- Complete shared-types package: **610/610 tests across 52 files**.
- Extension, webview, shared-types, and E2E type checks; scoped ESLint; formatting; and whitespace checks passed.
- The standard `test:smoke:1250` gate passed **42/42 across 13 selections**, including its bundle, webview build, and test
  compilation. All receipts verified actual VS Code **1.125.0**, profile ownership, and host exit; none failed or remained
  pending. Final smoke run: `75ed7254-0ce9-41f4-9716-2a75020e8ce6`.
- The compiled cross-thread suite passed **3/3** on the same build. It reads the saved stop receipt, verifies completed
  cleanup and API cancellation attribution, and confirms that the notice never became provider input. Run:
  `81bf0929-6a13-44da-bb50-92a7be787d44`; scripted provider; owned profile `alpha-vscode-e2e-9fAYfA`.
- Extension bundle SHA-256: `017bd70af629f9b71a4a064c9dff2853a27e031395c76fcad7c6e1024d7b7d82`.

Logs: `/tmp/alpha-peer-stop-core-tests-final-20261017.log`, `/tmp/alpha-peer-stop-ui-tests-final-20261017.log`,
`/tmp/alpha-peer-stop-shared-tests-20261017.log`, `/tmp/alpha-peer-stop-smoke1250-20261017.log`, and
`/tmp/alpha-peer-stop-cross-thread1250-20261017.log`. These deterministic runs used the same isolated launcher and
Electron environment adjustment described above.
