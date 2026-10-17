# Native question stepper

The native `request_user_input` form uses a **Step by step** flow in chat. The nonblocking async question card keeps its
existing presentation.

## Interaction

The form shows one question at a time with short topic steps, answer progress, and quieter option rows. Recommended
choices have a separate badge; their original labels remain unchanged in the submitted answer map. Users can write a
custom answer, move Back, revisit answered steps, and edit answers in the final review. Moving between steps or switching
between a suggested choice and custom text preserves the draft. A replay of the same request also preserves it; a
different task, ask timestamp, or question payload starts a fresh draft.

Continue and Review only navigate locally. Send answers submits the entire group once through the existing task input
path. A synchronous submission lock prevents duplicate events before React commits. If the host declines immediate
admission, the review remains editable and displays a retry message. A reopened host ask unlocks the same retained draft.
Navigation moves keyboard focus to the new question or review heading; choosing a custom answer focuses its textarea.

Native Send and Cancel actions are scoped to the originating ask timestamp and the latest complete, unanswered
follow-up boundary.
They cannot use the composer's queued-message edit path, become queued instructions after a newer input boundary, or
start a new task from a Failed/Closed task's historical card. Rejected submissions retain the answer draft. The form also
uses an own-property lookup for previous drafts so a valid question ID such as `constructor` cannot inherit a JavaScript
prototype value and crash custom input.

Successful card actions preserve separate composer text and selected images because those drafts are not part of the
form's answer packet. A local origin flag in the existing pending ask-request buffer keeps rejected native acknowledgements
from inserting answer JSON into the composer; the form already retains its own review for retry. Ordinary composer and
async question rejection handling remains covered by the existing interaction tests. The flag is not sent to the host or
added to persisted messages.

Completed requests retain the original questions and option descriptions in a collapsed, read-only disclosure. This
also keeps historical chats understandable when their old answer messages contain only short headers or answer text.
The new feedback receipt presents each full prompt beside its submitted answer and retains normal message actions and
image attachments.

## Contracts and ownership

The model still receives `{ "answers": { "question_id": { "answers": ["answer"] } } }` only after final submission.
The assistant tool call already retains the complete questions. This change adds no model round trips, provider-specific
behavior, policy authority, or task engine.

The shared `AlphaMessage` schema adds optional `userInputResponse` presentation metadata to `say: user_feedback` messages.
`RequestUserInputTool` builds this metadata from validated prompts and answers; `Task.say` applies the existing private
path redaction to both the feedback text and metadata, without mutating its caller's data. The normal persistence,
projection, retry, and partial-message paths carry or clear the metadata alongside its owning feedback. Older messages
remain valid without it.

The webview validates a receipt and renders it only if its full question/answer text exactly matches the persisted feedback
text. Historical messages, malformed metadata, and edited feedback with stale metadata use the existing text renderer.
Plain text remains the readable transcript. The receipt does not create a new authoritative answer store.

## Codex reference

Reverified current `openai/codex` main on **2026-10-13**, at commit
**12cca49c81c8aa6a37a5cc4e39964ee3b70f9458**. Its
[question pane](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs)
and associated tests show one active question with navigation; its
[completed transcript](https://github.com/openai/codex/blob/12cca49c81c8aa6a37a5cc4e39964ee3b70f9458/codex-rs/tui/src/history_cell/request_user_input.rs)
retains full question/answer pairs. Alpha translates these behaviors into its existing React and TypeScript layers.
The explicit editable final review is an intentional UX addition selected by the user. Existing Alpha tool visibility,
root-thread restrictions, cancellation, default suggestions, and autoapproval policy remain in the shared harness.

## Validation

Focused regression coverage exercises one active question, custom draft preservation, Back and Edit, request identity,
keyboard focus, final review, duplicate-send protection, failed admission, and read-only closed history. Receipt coverage
includes schema validation, plain-text compatibility, attachments, private path redaction, retry and partial-message
replacement, actual disk reload, and stale metadata after edits. Provider transform and replay tests verify the unchanged
model-facing result contract.

Final lower-level checks passed:

| Surface                                                      | Result                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Webview interaction and receipts                             | **264/264 tests across nine files**: ChatView 198, native form/row 28, receipt/ordinary/async question suites 36, composer draft hook 2 |
| Native/async tools, receipt persistence, queued ask handling | **75/75 tests across four files**                                                                                                       |
| OpenAI/VS Code LM transforms and tool-history replay         | **91/91 tests across three files**                                                                                                      |
| Shared types                                                 | **547/547 tests across 48 files**                                                                                                       |
| Exact-host UI runner contract                                | **12/12 tests**                                                                                                                         |
| Types and hygiene                                            | Extension, shared types, webview, and E2E typechecks; focused ESLint, formatting, and diff whitespace checks passed                     |

Before the final guards, five routing cases failed for the intended reasons: editing a queued instruction, crossing a
newer API boundary, answering a newer native question from an older card, and starting a new task from Failed and Closed
historical cards. The `constructor` custom-input regression also failed with `undefined.trim()`. These cases pass after
the bounded fixes; eligible current-question and queued-edit retry paths remain covered.

Additional pre-fix regressions demonstrated that stale Cancel closed a newer ask, current Cancel cleared a queued edit,
and successful Send/Cancel cleared unrelated composer text and images. Rejected native acknowledgements also restored
raw answer JSON into empty or populated composer drafts. The final native action and local origin fixes cover each case.

The exact-host UI fixture uses the real extension and rendered webview on **VS Code 1.125.0** with the scripted model
`request-user-input-ui-scripted`, autoapproval disabled, and an isolated Alpha-owned temporary profile. Trusted native
Tab/Space/Enter and text input exercise the wizard. The host checks that review does not call the model, final submission
produces one result and one continuation, and persisted receipts survive a cold task reopen and renderer reload.
The fixture also checks 320px layouts and dark/light themes and retains screenshots and DOM observations.

Reproducible host commands:

```sh
pnpm --filter @alpha-code/vscode-e2e test:request-user-input-ui:1250
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

The final `test:smoke:1250` run passed **42/42 tests across 13 host runs**, with zero failures and zero pending tests.
Every run recorded actual VS Code **1.125.0**, verified ownership, and `requireAllTests: true`. This gate rebuilt the final
extension and webview before execution. The dedicated rendered fixture then ran against those same built assets through
`pnpm --dir apps/vscode-e2e exec node out/runRequestUserInputUi.js`.

That final rendered run passed **1/1 test and all nine stages**, with zero failures/pending tests, trusted native input,
verified ownership, and an observed host exit. Run ID: `ui-836d9016-9372-4cf7-b925-5b95e4954c92`. Retained evidence is in
`artifacts/request-user-input-ui/ui-836d9016-9372-4cf7-b925-5b95e4954c92/`, including its manifest, scripted-model fixture
observations, temporary profile identity, screenshots, and DOM/scroll measurements. Final wizard/review and dark/light
recap screenshots were manually inspected. The owned host processes had exited after the run.

The capture driver uses trusted upward wheel input to enter the existing chat controller's browsing state before aligning
screenshots. This fixes a test capture interaction with automatic bottom following; production scroll policy was not
changed. Native wheel scrolling and frame geometry settle through bounded observed conditions. Components taller than
the transcript viewport retain top and bottom screenshots, and all horizontal-fit assertions remain enabled.
