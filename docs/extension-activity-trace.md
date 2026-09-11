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
  trace. A completed historical response remains folded when a follow-up starts.
- Empty completion asks, normally filtered from the UI, supply the end timestamp.
  Elapsed time starts at the first activity row. Older records without a completion
  ask use the final row timestamp; because that row may have started streaming
  earlier, their duration is an approximation. Reload and resume time is excluded.
- Original messages, tool output, persisted formats, and provider history are
  unchanged. Folding is visual and does not compact the model's context.
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
state. Its **Running**, **Complete**, and **Narrow** controls exercise the transition
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
