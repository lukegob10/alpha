# Extension activity trace

The extension keeps activity visible while an assistant is working. Command rows
start as one-line disclosures; opening a row reveals the command, retained live
output, and existing command-management controls. New output does not change the
reader's expansion choice.

When a response reaches the host's completion or completion-review boundary, its
preceding activity collapses into **Worked for m:ss**. The user message and formatted
final response remain visible. Clicking the elapsed-time row restores the activity.
A follow-up gets its own activity segment. Running, interrupted, failed, and
awaiting-approval work remains visible.

## Ownership and compatibility

- `completedActivity.ts` derives presentation ranges from the existing messages and
  selected task's live metadata. The runtime remains the owner of completion.
- A candidate `completion_result` during live verification does not collapse the
  trace. Reaching the recorded completion-review boundary seals the trace even if
  running metadata for a follow-up arrives before its user message. Both ordinary
  text and `attempt_completion` retain the prior final answer when direct or queued
  follow-up input starts another turn. Verification rejection or a completion-commit
  failure can still retract an invalid completion.
- Empty completion asks, normally filtered from the UI, supply the end timestamp.
  Elapsed time starts at the first activity row. Older records without a completion
  ask use the final row timestamp; because that row may have started streaming
  earlier, their duration is an approximation. Reload and resume time is excluded.
- Original message text, tool output, and provider history are unchanged. Optional
  synopsis fields are additive to saved UI messages. Folding is visual and does
  not compact the model's context.
- Hidden activity rows stay mounted so live tool subscriptions and reader-opened
  command details survive folding. Terminal output is rendered when its command
  disclosure is open.
- Expansion is scoped to the selected task. Retraction or checkpoint restoration
  clears expansion for removed traces. Checkpoint navigation opens its containing
  trace before scrolling. Keyboard focus moves to the trace button if completion
  hides the focused activity row.
- The UI uses existing theme tokens and native buttons. New labels are
  translated in all 18 webview locales. Durations use localized hour/minute/second
  units through `Intl.NumberFormat`.

The requested interaction is based on the user's Codex app description, recorded
2026-09-11. The [official feature documentation](https://developers.openai.com/codex/app/features/)
was retrieved on that date; it does not specify this exact collapse behavior.
Alpha's existing completion projection and command renderer determine the integration.
The CLI and VS Code compatibility shim are outside this change.

## Inline thinking synopses (2026-09-16)

The previously proposed bottom-dock **Current focus** panel was removed. A short
synopsis now appears beneath **Thinking** inside its existing disclosure button.
Opening that row displays the complete, unmodified provider-visible reasoning.
The synopsis stays attached to the row when streaming ends and when the completed
activity group folds. Existing labels and theme tokens are reused; no new locale
strings are needed. Old saved traces keep their original disclosure behavior.

Only Thinking rows show a descriptive synopsis. Directory search rows use a
generic action label, such as **Alpha wants to search a directory**; the query,
file filter, path, and results remain available when expanded. Outside-workspace
labels retain their scope warning. The generic search labels are localized in
all 18 webview locales.

`ReasoningSummary` owns best-effort presentation work outside the task execution
loop. It uses a separate handler built from the step's captured provider profile
and model, sends only the visible reasoning, and supplies no tools or conversation
history. It requests one short sentence describing action and purpose, retaining
uncertainty. This is an additional model request, not heading extraction. It does
not attempt to obtain hidden reasoning or synthesize intentions from tool names.

Each task has at most one active request and one coalesced pending row. Requests
wait 750 ms for streamed context, have a 15-second deadline, and use at most the
latest 12,000 source characters. Each row gets at most an initial request and one
completion refresh. Output is capped at 280 characters and displayed in at most
three lines. Responses that fail, emit tools, exceed the bound, or end incompletely
are discarded. The ordinary Thinking disclosure remains available throughout.

Cancellation, task disposal, and transcript replacement cancel pending summaries;
late results cannot update a replaced transcript. Separate provider handlers are
disposed after use. Only transports advertising cancellation support are used
(currently OpenAI-compatible, OpenAI Native/Codex, and VS Code LM). Other providers
retain the full original disclosure. No summary calls are made merely by reopening
history. Reported summary tokens and cost are saved separately and counted in task
totals, without changing the agent's context-window measurement or provider history.

### Pulse run review

Local saved UI, provider-history, and lifecycle records were inspected for the
recent six-document review in the `intake-process` workspace and its three children.
The parent contained 16 request markers and no reasoning or assistant commentary;
children contained 12 reasoning rows. Across the team there were 45 `read_file`,
16 `search_files`, and eight `list_files` calls. These counts include chunked reads
and source-code verification, not just six document reads. Identical whole-call
arguments were not repeatedly submitted within a task. Delegation overlap alone
does not justify weakening verification or adding a hard read-count limit.

Confirmed fixes:

- An empty path in a search batch could discard valid sibling queries (or cause
  parsing to fall back to a duplicated top-level search). Structurally valid batch
  entries now reach per-query validation; successful results survive. The schema
  explicitly requires `.` for the workspace root rather than an empty string.
- Two read continuations were altered when copied into tool calls. New compact
  cursors include an integrity check so copy errors do not masquerade as file
  changes. Existing v1 cursors remain readable; real file changes and cross-file
  cursor reuse still fail. This does not bypass stale-file protection.
- OpenAI-compatible adapters dropped the `reasoning` field and non-streaming
  reasoning, including their o-series paths. Both supported reasoning text fields
  now flow to the trace while retaining tool calls and usage. Request cancellation
  reaches the transport and cannot be mistaken for successful EOF.

The records do not retain raw HTTP responses, so they cannot prove that the Pulse
parent's endpoint sent reasoning. Its profile label is not proof of its wire
protocol. Missing historical reasoning cannot be reconstructed; these fixes apply
to future provider output. The rejected fourth child spawn correctly enforced
capacity and remains unchanged.

Validation on 2026-09-16: 423 focused extension tests, 181 webview tests (one
optional test skipped), and 23 shared-package tests passed. Follow-up provider
inheritance tests also passed. Repository typechecks and lint passed, with the
extension checks repeated after the provider capability declarations changed.
The actual React preview was checked at 340 pixels in dark, light, and high-contrast
themes, including opening the original reasoning and reopening completed activity.
Extension and webview builds succeeded. The exact VS Code 1.122.1 smoke command
reached host launch but was blocked by the Windows `vscode-updating` mutex; the
host reported that Code was currently being updated. This is not a passing host
gate. No live-provider summary request or retrospective reconstruction was performed.

The search-label follow-up passed 142 focused webview tests (one existing skip),
webview typechecking, and lint. The new regression cases cover pending and finished
searches, outside-workspace warnings, expandable details, and Thinking-only
synopses. The narrow React preview passed dark, light, high-contrast, and completed
trace checks. The full translation audit still reports existing missing keys;
the change updates exactly four existing keys in every locale without adding gaps.
Extension and webview builds passed again; the exact VS Code 1.122.1 smoke rerun
was blocked before host tests by the same Windows update mutex.

## Conversation bubble actions (2026-09-16)

Copy prompt was removed from task metadata. Opening prompts and user follow-ups
now expose Copy and Edit and resend beneath the bubble. Alpha's text, completed
answers, and follow-up questions expose Copy and Restart from previous prompt.
Restart selects the closest preceding user prompt and preserves its images.
Tool and Thinking disclosures retain their existing trace interactions.
Copy remains available during a run; edit and restart wait until the turn stops.

Confirmation retains the originating task ID even if focus changes. Both restore
choices preserve images, including prompts containing only images. Restarts replace
the selected prompt and later conversation; workspace files are restored only when
the user selects the checkpoint option. The host joins cancellation and persistence
before rewinding through MessageManager, then reloads a fresh Task under the same
ID and admits the replacement through the existing history-resume loop. This
replaces the old timed pending-edit handoff, which could leave completed tasks
rewound without starting a new request. Opening-prompt rewinds also remove legacy
API records without timestamps. Stopped-task checkpoint accounting uses transcript
persistence rather than the agent output path, which rejects output after abort.

Focused tests cover prompt editing, preceding-prompt selection, image retention,
confirmation routing, duplicate admission, cancellation barriers, legacy history,
checkpoint restoration, and completed-task restart. Repository lint and typechecks
passed. Extension and webview builds passed. The actual React preview was checked
at 340 pixels in dark, light, and high-contrast themes, including inline editing.
All seven new action strings are translated in all 18 locales; the full translation
audit still reports pre-existing missing keys. VS Code 1.122.1 host validation
remains blocked before preflight by the Windows `vscode-updating` mutex.

## Shared extension appearance

The user's Codex screenshot supplied on 2026-09-11 is the visual reference for
the next styling pass. The extension uses flat neutral surfaces, subtle borders,
compact controls, right-aligned prompt bubbles, plain assistant responses, and
small response actions. Shared tokens in `webview-ui/src/index.css` carry this
treatment into settings, history, marketplace, dialogs, and other extension views.
Ticket controls use the same surface tokens. Colors follow the installed VS Code
theme, including explicit light and high-contrast prompt treatments; Alpha retains
its own branding and existing actions.

Task metrics remain accessible inside expanded task details. The file-change
summary is part of the scrollable transcript below the answer, so its expansion
does not shrink the composer. It initially lists up to three files, with collapsed
diffs and a disclosure for the rest. Native buttons expose separate diff and
open-file actions. Counts still represent the entire conversation, and the existing
approved-edit projection supplies all data. No undo or review workflow is implied
by the reference screenshot. Presentation changes do not alter task lifecycle,
approval authority, persistence, or the settings edit buffer.

## Review the actual components

Run `pnpm --dir webview-ui dev --host 127.0.0.1`, then open
`http://127.0.0.1:5173/preview/activity-trace.html` (use the port Vite prints).
The preview loads the actual chat, settings, and history components with fixture
state. Its **Running**, **Thinking**, **Complete**, **Follow-up**, **Finish follow-up**, and **Narrow** controls exercise the transitions
and a 340-pixel sidebar; surface and theme selectors support visual comparison.
It sends no model requests and executes no commands. It is a
development HTML entry, outside the packaged webview's production entry point.

Focused regression coverage includes live/finished rendering, per-task expansion,
keyboard focus, checkpoint navigation, streamed/final output, legacy timestamps,
and keeping approvals and failures visible:

```sh
pnpm --dir webview-ui test -- src/components/chat/__tests__/completedActivity.spec.ts src/components/chat/__tests__/CommandExecution.spec.tsx src/components/chat/__tests__/ChatView.spec.tsx src/components/chat/__tests__/ChatView.scroll.spec.tsx
pnpm --dir webview-ui check-types
pnpm --dir webview-ui lint
node scripts/find-missing-translations.js
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```

The visual follow-up also covers `FileChangesPanel`, `ActivityTraceToggle`,
`TaskHeader`, `Markdown`, the composer, settings, history, and existing chat-row
interactions. The preview is visual QA of real React components, not a replacement
for the VS Code 1.122.1 extension-host gate.

Verification on 2026-09-11: 411 tests passed across 29 focused files (one optional
live-evidence test skipped); webview typecheck and lint passed. The exact 1.122.1
smoke gate passed its scripted extension, modes, and VS Code LM fixture runs.
Browser visual checks covered completed/running chat, command disclosures,
settings, history, and dark/light/high-contrast themes at wide and narrow sizes.
The repository translation audit still reports existing missing translations;
all four keys introduced by this work exist with matching placeholders in all
18 webview locales.

Follow-up regression review on 2026-09-12: the runtime had retracted a valid final
answer when accepting another user message, removing the UI's historical trace
boundary. Direct replies and queued replies at review/finalization now retain that
answer. Regression coverage checks two separately collapsed turns, live follow-up
activity, metadata-before-transcript delivery, independent disclosure controls,
reload, and continued retraction when verification fails.

Validation: 269 runtime tests and 143 webview tests passed (one optional test
skipped), together with extension/webview typechecks and lint. The exact VS Code
1.122.1 smoke gate passed. Browser checks of the actual React preview confirmed
live follow-up isolation, separate completed disclosures, and independent expansion
at wide and narrow sidebar sizes.
