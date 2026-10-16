# Chat navigation and composer redesign

Reviewed on 2026-10-16 against Alpha commit `094808748cfe1e41b54f7852ef0d66ad479fd87a` and current
implementation files. This change implements the reviewed chat mockup and preserves Alpha's existing runtime,
approval, editing, and managed-agent contracts.

## User-facing contract

- New chat shows four recent chats above the centered Alpha watermark. Opening or starting a chat replaces that
  inline preview with the toolbar's chat switcher. View all chats retains the full history view and its search,
  sorting, selection, and workspace filtering. The empty sidebar starts history below the native Alpha header,
  without a redundant New chat title or separate action row.
- Recent and expanded history share a compact, muted Chats heading in the same position. Chat names, timestamps,
  and history controls use the same chat font, regular weight, and line height. Normal history text uses the theme's
  description foreground; hover, keyboard focus, active chats, and status indicators preserve their distinct feedback.
- A saved display name identifies a chat in history, search, the current title, and attention labels. Renaming is
  user-owned metadata; it does not replace the original prompt, change execution state, or update activity timestamps.
- The native sidebar header provides New chat, Settings, Tickets, and More. More contains Scheduled Tasks and
  Marketplace, plus Alpha: Incident Dashboard when `alpha.debug` is enabled. Editor chats retain their webview toolbar.
  Existing command registrations remain available to their other callers.
- The composer contains the context meter, draft input, text selectors, draft actions, and Send/Stop. Context details
  and the existing context-management actions remain available. Image paste/drop and attachment previews remain.
  Codebase indexing stays below the composer, using the existing status mapping rather than a permanently green dot.
- Send stays visible and disabled in muted gray with a normal cursor when the draft has no text or images, and brightens
  when ready.
  Whitespace alone does not enable sending. An empty draft during streaming retains the enabled Stop action.
- The existing managed-agent group moves above the composer. Expanding grows upward, with an up caret to open and a
  down caret to close. Questions, main-chat approvals, and parent-owned child approval review retain their existing
  authority and decision paths.
- Independently launched chats retain their compact launcher strip above the composer, including Open, Stop, and
  shared/worktree identity. They remain distinct from managed sub-agents.
- User messages expose Copy and Edit. Copy does not mutate history. Edit uses the existing inline editor and
  confirmation/restart path; cancel leaves the transcript unchanged. Managed-child restrictions and disabled states
  apply to message modifications.
- The existing chat palette remains authoritative. Layout uses VS Code theme tokens and preserves light and
  high-contrast behavior, keyboard focus, narrow sidebar layout, and reduced motion.

## Current Codex CLI source review

Retrieved on 2026-10-16 from `openai/codex` commit `96eb400d1231f0199e96f640c740096087cf3e9b`.
This review supersedes the earlier mockup-only source snapshot. It establishes behavior, not a source-code port.

| Area                       | Current upstream evidence                                                                                                                                                                                                                                                                                                                                                                                     | Alpha alignment                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent chat names      | [`thread_name_persistence.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/app-server/tests/suite/v2/thread_name_persistence.rs), `named_empty_paginated_thread_resumes_after_restart`                                                                                                                                                                             | Store a separate optional display name and read older records without a migration. Preserve the original prompt and transcript.                                                                                                          |
| Name projections           | [`thread_name_websocket.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/app-server/tests/suite/v2/thread_name_websocket.rs), loaded and not-loaded thread broadcasts                                                                                                                                                                                              | Project the saved name to matching Alpha surfaces, including inactive chats, through existing task metadata updates.                                                                                                                     |
| User names own their field | [`thread_title_tests.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/tui/src/app/thread_title_tests.rs), `automatic_thread_title_respects_origin_metadata_after_switching` and manual-rename cancellation tests                                                                                                                                                   | Later background/transcript metadata saves must retain the saved name, and task switching must not retarget a rename.                                                                                                                    |
| Editing an earlier prompt  | [`app_backtrack.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/tui/src/app_backtrack.rs), module contract and `backtrack_revert_before_turn_id` tests                                                                                                                                                                                                            | Editing changes the conversation continuation through an explicit history/restart operation. Keep Alpha's existing `submitEditedMessage`, confirmation, and `restartTaskFromMessage` path rather than modifying a rendered bubble alone. |
| Edit boundaries            | The same source tests reject mid-turn steers, in-progress turns, missing prompts, and stale prompt projections                                                                                                                                                                                                                                                                                                | Preserve Alpha's existing runtime-owned edit boundary and UI restrictions. This layout change does not introduce independent rewind or steer-edit semantics.                                                                             |
| Structured questions       | [`request_user_input.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/core/src/tools/handlers/request_user_input.rs) and [`request_user_input_tests.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/core/src/tools/handlers/request_user_input_tests.rs), `multi_agent_v2_request_user_input_rejects_subagent_threads` | Structured questions remain root-owned and appear through the existing form in the parent transcript.                                                                                                                                    |
| Approval origin            | [`pending_thread_approvals.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/tui/src/bottom_pane/pending_thread_approvals.rs) and [`approval_overlay.rs`](https://github.com/openai/codex/blob/96eb400d1231f0199e96f640c740096087cf3e9b/codex-rs/tui/src/bottom_pane/approval_overlay.rs), cross-thread origin and source-thread navigation tests                   | Keep child/approval IDs and the originating agent visible in Alpha's existing parent-owned review dialog. Dismissing the dialog does not decide the request.                                                                             |

Alpha intentionally uses native React menus, dialogs, inline message editing, and a compact managed-agent dock instead
of Codex TUI's command and keyboard presentation. Alpha also retains its checkpoint restoration choice when confirming
a message edit. These presentation differences do not change tool authority, execution policy, cancellation, or the
underlying task lifecycle. Alpha's original prompt remains available separately from its custom chat label.

## Architecture and compatibility boundaries

`ChatView` remains the integration owner for draft view, cached switching, transcript projection, and parent/child
navigation. Reusable components own ephemeral menu and expansion state; none becomes a second task engine.
The extension-side history persistence boundary owns user labels. Shared request and result types belong in
`packages/types`, and the webview uses the existing provider routing and metadata projection paths.
Switching chats or opening another surface closes portalled navigation and context UI while retaining chat-owned
composer drafts and correlated in-flight agent action receipts.

Renaming validates the existing task and workspace, commits the separate label under the history file's existing
lease, and preserves that label during later full-record saves. The existing host-shared ownership queue orders
rename commits and their peer projections. A failure updating the derived compatibility mirror does not turn an
already committed canonical rename into a reported failure.

The target host remains VS Code **1.125.0**, with Node **24.21.0** and pnpm **11.24.0**. Both local cached host packages
were inspected and report `1.125.0`; executable presence is not test execution. The exact-host gate uses scripted and
fixture providers with isolated test profiles and does not require signing into live Copilot:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

That script bundles the extension, builds the webview, compiles the E2E runner, and launches the selected exact-host
suites. Live-model runs cannot substitute for it. Rendered checks below exercise the actual sidebar; focused shared
component tests cover view switching and secondary-view integration.

## Validation record

Completed on 2026-10-16 with Node 24.21.0 and pnpm 11.24.0. Every extension-host run below verified the actual host as
VS Code **1.125.0**, the test-owned process, host exit, and complete evidence capture. Providers were scripted or the
VS Code LM fixture; these were isolated test profiles, without live Copilot requests.

| Check                                                                | Observed result                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250`               | 42/42 tests passed across 13 suites, with no pending tests. Covers activation, modes, approvals, command/file boundaries, tool acceptance, questions, compaction, VS Code LM, and background completion.                                                         |
| `pnpm --filter @alpha-code/vscode-e2e test:history-ui:1250`          | Passing rerun: 1/1 host test, dark/light/high-contrast history, four-row preview, search, and bounded cold reopen. Additional renderer checks verified the approved normal More entries, context details open/close, and Copy/Edit visibility on keyboard focus. |
| `pnpm --filter @alpha-code/vscode-e2e test:composer-ui:1250`         | Initial and final runs passed 1/1 host test each. The final run rebuilt the last draft-menu visibility correction and passed trusted-input overflow, scroll alignment, square viewport, and native wheel stages.                                                 |
| `pnpm --filter @alpha-code/vscode-e2e test:task-navigation-ui:1250`  | Seed and process-cold reopen phases passed, followed by 10 trusted-pointer New chat/reopen cycles against the persisted large transcript.                                                                                                                        |
| `node --test apps/vscode-e2e/out/unit/runHistoryUi.spec.js`          | 1/1 compiled runner test passed.                                                                                                                                                                                                                                 |
| Affected webview unit sweep                                          | 1,117/1,117 tests passed in 90 files. Subsequent final ChatView/App integration rerun passed 225/225; the final composer suite passed 95/95. These suites overlap and are not additive totals.                                                                   |
| Focused persistence, provider, message-handler, and utility coverage | Backend owner reported 247 affected tests passed, including ordered rename projections and canonical success when a derived mirror callback fails.                                                                                                               |
| Type and style checks                                                | Extension, webview, and E2E package typechecks passed. Focused backend/shared-type, webview, and E2E ESLint checks passed; touched files were formatted and checked for whitespace errors.                                                                       |

The history runner's first attempt failed after the additional message-action inspection expanded the transcript
before its existing bounded-reopen assertion. Moving that inspection after the assertion fixed test interference;
the bounded-window assertion remained intact and the complete exact-host rerun passed. The navigation runner now
clicks the implemented webview New chat button instead of the removed native title action, retaining its trusted
input, identity, transcript, and stability checks.

Raw logs, host receipts, unit-result JSON, and screenshots are retained outside the source tree in
`C:/Users/Luke Goblirsch/.codex/visualizations/2026/10/16/01a1421b-5291-75c3-af8d-54f46486f7e9/alpha-chat-validation/`.
The passing history capture is `history-ui/chats-86941f3b-365c-4e22-8152-3a66f8bfd7c9/`; final composer evidence is
`composer-ui-final-evidence/`. The full smoke breakdown is `smoke-1250-results.json`, and the final UI unit receipts are
`affected-ui-results.json` and `final-integration-results.json`.

Manual inspection of native renderer captures covered the 299 px sidebar in dark, light, and high-contrast themes,
including the compact history, rounded composer, context meter, bottom indexing control, focused message actions,
and preserved indigo user bubble. The fixture's telemetry banner and provider-dependent selector labels remain
configuration state. A separate manual editor-panel theme pass and live Copilot evaluation were not performed.
Navigation timings describe one synthetic workload and do not establish a general performance improvement.

## Send visibility and empty-chat title follow-up

The follow-up keeps Send visible and natively disabled for empty or whitespace-only drafts, enables it for text or
image attachments, and preserves the streaming Stop action. The new-chat toolbar keeps its icon action without a
redundant title. Empty drafts still accept the configured newline shortcut.

Validation on 2026-10-16:

- 336/336 focused webview tests passed across the composer, user-message actions, ChatView, and App suites.
- Webview typecheck, scoped ESLint, touched-file formatting, and whitespace checks passed. The renderer test runner's
  strict typecheck and scoped style checks also passed.
- The exact VS Code 1.125.0 smoke gate passed 42/42 tests across 13 suites, with no failed or pending tests.
- The exact-host composer renderer gate passed 1/1 host test and all six renderer stages. Trusted typing enables and
  brightens the same Send element while preserving its size and bottom-right composer inset. The empty toolbar has
  no New chat title and retains its accessible icon action.

Follow-up logs, receipts, focused test results, Send-state observations, and empty/filled composer captures are retained
under the validation directory's `send-title-follow-up/` folder.

## Native sidebar header follow-up

The New chat, Settings, and Tickets actions move into the native Alpha view title. Scheduled Tasks, Marketplace,
and the debug-only Incident Dashboard use its overflow menu. Removing the duplicate webview action row reclaims
28 px above the empty sidebar's history. Active chats keep the task switcher below the native header; editor chats
retain the complete webview toolbar. No duplicate `editor/title` actions are contributed.

Native actions bind to the owning sidebar provider through explicit command adapters. They do not infer the target
from whichever Alpha editor was most recently focused. Native New chat sends the typed `newChatButtonClicked` action
to App's existing guarded new-chat path, preserving unsaved Settings edits and the existing blank-task lifecycle.
The existing public command IDs and keyboard shortcuts retain their behavior.

Reference contracts reviewed on 2026-10-16:

- The official [menu contribution reference](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)
  defines `view/title`, primary `navigation` actions, and secondary overflow groups.
- VS Code 1.125.0's [ViewPane](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/browser/parts/views/viewPane.ts)
  and [WebviewViewPane](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/workbench/contrib/webviewView/browser/webviewViewPane.ts)
  do not provide a reliable originating view identity through action arguments. Explicit sidebar adapters avoid
  ambiguous routing when both sidebar and editor chats are visible.
- The host's [action-bar stylesheet](https://github.com/microsoft/vscode/blob/1.125.0/src/vs/base/browser/ui/actionbar/actionbar.css)
  owns the standard 16 px icon slots. The three Alpha action glyphs use the existing Lucide artwork enlarged by 8%
  inside those slots, with light/dark variants and ISC attribution. The native More glyph remains host-owned.
  Editor fallback glyphs increase from 16 to 17 px.

Empty Send retains its gray disabled appearance with the normal cursor; typing enables the brighter button.

Final header validation used Node 24.21.0, pnpm 11.24.0, and actual VS Code 1.125.0 with scripted/fixture providers:

| Check                                                  | Result                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared types                                           | 597/597 tests across 50 files; build and typecheck passed.                                                                                                                                       |
| Native command/manifest coverage                       | 21/21 tests passed, including sidebar ownership and guarded New chat dispatch.                                                                                                                   |
| Webview follow-up                                      | 241/241 toolbar/App/ChatView tests and 101/101 composer tests passed.                                                                                                                            |
| Type and style                                         | Extension, webview, and E2E typechecks passed; scoped ESLint, formatting, and whitespace checks passed.                                                                                          |
| `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` | 42/42 tests across 13 suites passed, with no failed or pending tests.                                                                                                                            |
| `node ./out/runComposerUi.js`                          | 1/1 host test and all seven renderer stages passed: native header, no duplicate empty row, normal disabled cursor, persistent Send, scrolling, and a real editor fallback with four 17 px icons. |
| `node ./out/runHistoryUi.js`                           | 1/1 host test passed with dark/light/high-contrast header captures, native More contents, context details, message actions, and bounded reopen.                                                  |
| `node ./out/runTaskNavigationUi.js`                    | Process-cold reopen and all ten trusted native New chat/reopen cycles passed, retaining the same task object.                                                                                    |

The three rendered commands ran from `apps/vscode-e2e` and reused the smoke gate's unchanged product build.
Navigation used a short temporary live
profile path after a deep evidence-directory path exceeded Windows/Chromium limits before test execution.
The separate failed launch is retained with the final evidence under `native-header-follow-up/`.
Fresh native sidebar captures in dark, light, and high-contrast themes and the real dark editor fallback were visually
inspected. Product-source hashes across 2,092 files and built-asset hashes across 666 files remained unchanged through
the rendered checks; copied evidence was hash-verified before generated source-tree reports were removed.

`pnpm vsix` also passed. `node scripts/verify-vsix-contents.mjs bin/alpha-3.2.0.vsix` verified all 1,688 archive entries,
required extension resources, and the absence of packaged `.env` files. An additional archive check confirmed all six
native header SVGs and their ISC license match source bytes, their manifest references resolve, and the packaged host
contract remains `^1.125.0`. The pre-existing VSIX was copied and hash-verified outside the source tree before packaging.

## Consistent Chats heading and history typography

The recent preview and expanded history now retain the same compact, regular-weight Chats heading in the same
position. Both lists use the chat UI font, matching title/timestamp sizes and row insets, and the theme's muted
`descriptionForeground` color. Hover, keyboard focus, current-chat feedback, and semantic status colors remain distinct.
The expanded history retains its existing 1 px card border.

Validation on 2026-10-16 with Node 24.21.0 and pnpm 11.24.0:

- Two focused tests reproduced the missing preview heading before the fix. The final affected webview run passed
  300/300 tests across five files. Webview typecheck, scoped ESLint, formatting, and whitespace checks passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` passed 42/42 tests across 13 suites on actual VS Code 1.125.0.
- `node ./out/runHistoryUi.js`, run from `apps/vscode-e2e` against the same product build, passed its host test and
  renderer checks in dark, light, and high-contrast themes. The heading retained its DOM identity and exact x/y
  coordinates across preview, expansion, and collapse. Titles and ages rendered at 13 px, 18 px line height, and
  weight 400. Both list content insets measured 8 px after accounting for the expanded card's border.
- Native pointer hover and keyboard focus retained readable theme colors and visible focus feedback. Search,
  workspace filtering, native header actions, message actions, context details, and bounded cold reopen also passed.
- The E2E typecheck, scoped style checks, and compiled history-runner unit test passed. All test hosts exited;
  source hashes across 2,092 product files and hashes across 666 built assets stayed unchanged through rendering.
  All 76 copied evidence files were SHA-256 verified.
- `pnpm vsix` passed. The archive verifier checked all 1,688 entries. Packaged webview JavaScript and CSS matched
  the exact-host-tested bytes; native header SVG/license bytes and the `^1.125.0` manifest contract also passed.
  The previous VSIX was copied and hash-verified before rebuilding.

Fresh preview/expanded sidebar captures were visually inspected in all three themes. Logs, receipts, captures,
before/after focused test results, and package integrity checks are retained under
`alpha-chat-validation/history-consistency-follow-up/` in the external validation directory above.
No additional live-model run or composer/navigation rerun was needed for this history-only product change.
