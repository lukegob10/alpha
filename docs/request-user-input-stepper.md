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

## Validation

Focused regression coverage exercises one active question, custom draft preservation, Back and Edit, request identity,
keyboard focus, final review, duplicate-send protection, failed admission, and read-only closed history. Receipt coverage
includes schema validation, plain-text compatibility, attachments, private path redaction, retry and partial-message
replacement, actual disk reload, and stale metadata after edits. Provider transform and replay tests verify the unchanged
model-facing result contract.

Reproducible host commands:

```sh
pnpm --filter @alpha-code/vscode-e2e test:request-user-input-ui:1250
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```
