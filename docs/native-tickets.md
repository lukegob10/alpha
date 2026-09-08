# Native Alpha tickets

Use **Alpha: Tickets** in the Command Palette or the ticket entry in Alpha's view menu. The editor opens beside your code and supports a searchable status-grouped list, ticket creation, editing, raw Markdown access, and **Work on ticket**.

The ticket collection fills the panel with grouped rows and search. Selecting a row opens a separate page with the ticket's name, status, dates, and formatted Markdown sections. The breadcrumb at the top shows the project, **Tickets**, and the selected ticket. Click **Tickets** to return to the list with the same search, page, scroll position, and keyboard focus. Search and pagination also survive panel reloads.

Restored panels wait for project discovery before loading a saved collection. The host resolves requests against a complete project snapshot after any pending refresh. Loading and storage failures do not appear as an empty search result: already displayed tickets remain visible during refresh, and **Reload** in a collection error refreshes project discovery and the list. A removed workspace still requires reopening its project; ticket files are not deleted when the panel closes or reloads.

Groups are always ordered **In progress → Backlog → Complete**, including across pages. All three headers use a simple underline and remain visible even when empty or collapsed. Click a header or use Enter/Space to toggle its rows; the caret points down when expanded and right when collapsed. A fresh or reloaded panel starts with every section expanded, including panels with previously saved collapse settings. Manual collapses remain in effect during search, pagination, and ticket navigation within the current view. Within a status, recently updated tickets appear first.

In the chat composer, type `@` and select **Alpha Tickets**, then search by reference or title (including multiple words). Select a result with the mouse or Enter/Tab to insert a mention such as `@ticket:PM-01`. Ticket mentions resolve in that chat's current project when the message is processed. The current fields and revision are attached before the model request, with an Alpha Tickets banner confirming the read or reporting a failure. Legacy tickets without a reference use their UUID. Searches are read-only, limited to 50 summaries, debounced, and correlated so old replies cannot replace current results.

You can also type `@tickets:PM`, `@ticket:PM-0`, or a short reference directly, such as `@PM-01`. Typing a two-to-four-letter project prefix such as `@PM` shows ticket matches alongside file suggestions; adding the hyphen switches to ticket search. Partial references and combinations such as `PM backend` are searchable in the menu and ticket collection. Full references still resolve exactly. Selected results use the canonical `@ticket:PM-01` spelling; manually typed `@tickets:PM-01` and `@PM-01` load and open the same ticket. Aliases for the same reference are loaded once per message.

Click a ticket name in a successful chat banner to open its full reading page in Alpha Tickets. New banners carry the project and immutable ticket ID; older reference-only banners resolve against the chat's current project. Selected ticket mentions are clickable too. Navigation waits for the panel to initialize and respects unsaved drafts and in-flight editor operations. The ticket's workspace must be open in the editor.

**Edit ticket** opens the form on the ticket page and adds an Edit step to the breadcrumb. The ticket-name breadcrumb, Save, and Cancel return to the reading view. Navigating away from unsaved changes requires discarding them; drafts restore in edit mode. **Activity** appears on every ticket before editing, with a blank body when it has no content. Other empty sections stay hidden while reading. Activity uses the existing implementation-summary field and Markdown section for backward compatibility, so existing notes remain available in both the reader and editor.

**Delete ticket** is available on a saved ticket's reading and editing pages in any status. A confirmation names the ticket and explains that deletion is permanent. **Cancel** or Escape closes the confirmation without deleting. Confirming removes that ticket's Markdown file and returns to the collection, preserving the search and moving to the nearest valid page if necessary. An unsaved new ticket can be discarded instead. Deleting a ticket does not delete its linked Alpha tasks or their histories.

Deletion checks the displayed revision again before removing the file. A newer edit or status change prevents deletion and leaves the displayed ticket and draft available for review. Ticket references are never reused after deletion, including after removing the last ticket. The project sequence remains in storage.

## Storage and editing

### Short references

Tickets have permanent project references such as **PM-01**, **PM-02**, and **PM-100**. The prefix comes from up to three initials of the workspace folder's words, ignoring version suffixes (`project-manager-v2` → `PM`, `Alpha-Code` → `AC`). A single word uses its first three letters; names without a usable Latin prefix use `AT`. The prefix is stored with the project sequence. References are scoped to the current workspace, so two projects may share a prefix without sharing tickets.

Numbers increase across all statuses and never change on rename, completion, or reopening. `.sequence.json` reserves the next number under the existing project transaction lock before the Markdown write; interrupted writes can leave gaps. Keep this file when backing up or moving the collection. Deleting it loses the record of previously deleted/reserved numbers. UUIDs remain the internal identity and filenames, preserving existing task links.

The extension's ticket lifecycle backfills old tickets in creation-date/UUID order when a workspace opens; opening the ticket panel also performs this idempotent migration. Only the reference metadata is inserted, preserving dates and Markdown content. Malformed files are left for repair. Read-only tools do not assign numbers, write files, or recover interrupted moves; legacy files remain readable by UUID before migration. References appear in the list, reader, editor, breadcrumbs, native results, and chat banners.

Tickets live in the extension host user's home directory:

```text
~/.alpha/tickets/<workspace-folder-name>-<12-character-path-hash>/
  backlog/<uuid>.md
  in-progress/<uuid>.md
  complete/<uuid>.md
```

The hash uses the canonical workspace path, case-normalized on Windows. Separate checkouts and same-named project folders remain isolated. In a remote extension host, this is the remote user's home directory. Each root in a multi-root workspace has its own ticket collection.

YAML frontmatter contains `schemaVersion: 1`, `id`, `reference`, `name`, `createdAt`, `updatedAt`, optional `completedAt`, and `linkedTaskIds`. The directory determines status. Dates written by Alpha use ISO UTC timestamps; the editor displays local dates. Keep assigned references unchanged when editing Markdown; duplicate references are rejected during lookup and allocation.

The Markdown body has level-two headings named `Description`, `Context`, `Success criteria`, and `Implementation summary`. Use level-three headings within those sections. Fenced code blocks may contain headings. Additional Markdown sections and unknown metadata values survive edits; YAML comments and formatting are not preserved. Ticket files are limited to 100 KB, names to 200 characters, and each editable section to 16,000 characters.

You can edit the files directly. Malformed files appear in the editor's repair report rather than being rewritten. Keep the UUID filename and frontmatter ID consistent. Duplicate section names and duplicate ticket IDs require manual repair.

The editor holds a local draft, asks before discarding it, and preserves it when disk changes arrive. Saving compares the original content revision with current disk content. A conflict requires reloading and reconciling the draft. Cooperating Alpha windows use a project lock; external editors do not participate in that advisory lock. Avoid saving the same file simultaneously from an external editor and Alpha.

Status moves use a durable `.move.json` intent and atomic writes. Opening the editor or performing the next mutation finishes an interrupted move. Read-only tools report a pending move instead of modifying storage. If an external edit conflicts with a pending move, Alpha stops and retains both the journal and edited files for repair. Do not delete a move journal without inspecting its source and destination.

## Agent tools and task links

- `list_tickets`: optional `query`, `status`, `offset`, and `limit` (default 50, maximum 100). Searches a short reference or all supplied title/content keywords in any order. Returns reference/name summaries, a total, and malformed filenames.
- `read_ticket`: accepts a UUID or short reference in `id`; returns all fields and `revision`. `PM-01`, `pm1`, `PM #1`, and `PM number 1` resolve identically.
- `create_ticket`: requires `name`; accepts the four Markdown sections. Creates a Backlog ticket.
- `update_ticket`: requires a UUID or short reference in `id` and `expectedRevision`; accepts edited fields and `status`. Identity and reference are not editable tool fields.
- `delete_ticket`: requires a UUID or short reference in `id` and `expectedRevision` from a full read. Permanently removes that ticket after manual approval; linked tasks remain available.

Tools operate on the task's project directory without accepting arbitrary profile paths. Reads are available in Plan mode. Mutations use the Work tool surface, run serially, and use the canonical ticket approval flow. Native results distinguish success, errors, denial, and cancellation.

Enable **Alpha Tickets** under **Settings → Auto Approvals** or in the chat auto-approval dropdown to automatically approve `create_ticket` and `update_ticket`. Both **Auto Approvals** and **Alpha Tickets** must be on. This category defaults to off, including existing installations without a saved value. Settings edits take effect on **Save**. In the unsaved-changes dialog, **Discard changes** restores the saved value; **Cancel** keeps the draft open. The chat dropdown saves the same setting immediately, and both controls restore it after reload.

The category covers creating tickets, editing fields, changing status, and marking tickets Complete. With either switch off or the category missing, writes request confirmation; denial leaves the ticket unchanged. `list_tickets` and `read_ticket` remain approval-free. Successful automatic writes retain the **Ticket created** and **Ticket updated** activity banners.

`delete_ticket` always requires manual approval, including when ticket auto approval is enabled. Its approval request names the ticket; a **Ticket deleted** banner appears only after successful removal. A deleted-ticket banner does not link to a ticket that no longer exists. Denial or cancellation before removal leaves the ticket intact.

Ticket approval grants apply only to the native ticket tools. They do not approve arbitrary file writes, commands, or external tracker operations. Plan mode, project isolation, cancellation, revision checks, and completion-summary requirements still apply. Managed children also retain their captured approval limits: a later global preference change cannot grant ticket auto approval to a child that did not inherit it, while disabling the live preference revokes automatic approval.

The primary Work and Plan prompts instruct the model to look up a referenced Alpha ticket before planning, repository investigation, delegation, or implementation. Short references go directly to `read_ticket`; names use `list_tickets` followed by `read_ticket`. No match or ambiguous matches require clarification instead of substituting repository documents or the application's own ticket functionality. Explicit references to another tracker retain their requested scope. This guides model behavior; it is not a natural-language execution gate or a grant of additional tool permissions.

Chat displays an **Alpha Tickets** banner. Successful searches show a match count and up to three reference/title pairs; only a successful full read shows **Ticket loaded**. Empty searches, failures, and cancellation have distinct labels. Successful writes show **Ticket created** or **Ticket updated** with the reference and title. Approval requests use **Create ticket** or **Update ticket** without claiming success. Structured JSON remains available to the model, but neither current nor legacy ticket chat rows display the raw payload. Search summaries are not evidence that ticket contents were read.

**Work on ticket** saves the draft, creates a normal Alpha Code task with existing permissions/model configuration, stores its ID, moves the ticket to In progress, and then starts execution. Concurrent launch requests share a lock; later clicks reopen the latest linked task, including after reload. Task creation failure leaves the ticket unchanged. A conflicting ticket edit aborts the unstarted task and preserves the edit.

Task completion, failure, and cancellation do not automatically complete tickets. A person or agent explicitly sets Complete and provides an implementation summary. Reopening clears the completed date while retaining the summary. Completed tickets must be reopened before starting work.

No cloud service, automatic backlog runner, due dates, priorities, or board view is included.

## Validation

```sh
pnpm --dir src test -- services/tickets/__tests__ core/tools/__tests__/TicketTools.spec.ts core/tools/__tests__/ToolRegistry.spec.ts core/assistant-message/__tests__/NativeToolCallParser.spec.ts
pnpm --dir src test -- core/auto-approval/__tests__/checkAutoApproval.spec.ts core/tools/__tests__/TicketTools.autoApproval.integration.spec.ts
pnpm --dir webview-ui test -- src/components/tickets/__tests__/TicketsView.spec.tsx src/components/chat/__tests__/ChatRow.tickets.spec.tsx
pnpm --filter @alpha-code/types test -- src/__tests__/ticket.test.ts
pnpm lint
pnpm check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
node scripts/find-missing-translations.js
pnpm vsix
node scripts/verify-vsix-contents.mjs <path-to-vsix>
```

Focused tests cover Markdown round trips, preserved fields, safe status moves, stale and concurrent writes, project isolation, path escapes, cancellation, tool policy, linked-task failures and duplicate launch requests, and editor draft preservation. The exact-host extension suite checks command registration and a single reusable ticket editor tab.

Validation on September 7, 2026:

- Native ticket regression set: 21 tests passed; shared types: 279 tests passed; ticket reader/editor and chat: 15 tests passed.
- Repository-wide lint and type checks passed.
- Exact VS Code 1.122.1 gate passed: extension (3), modes (2), and LM contract (4) tests.
- Bundle and VSIX creation passed. The contents check verified 1,792 archive entries, required assets, and no packaged `.env` files. Additional inspection confirmed the ticket command, four native tools, and editor bundle.
- All 18 ticket locale files have matching keys. The repository-wide translation check still reports unrelated existing missing translations.
- Visual review used the actual React components in a local browser with a mocked VS Code message bridge: dark and light themes, a 430-pixel panel, and list/detail/edit/breadcrumb transitions including keyboard focus. Navigation tests also cover preserved search, pagination, scroll position, and unsaved drafts. Manual visual inspection in the Extension Development Host was not performed; the exact-host tab lifecycle was tested automatically.

Short-reference and discovery follow-up, September 7, 2026:

- 70 extension/store/tool/prompt tests, 21 webview tests, and 4 shared contract tests passed. Coverage includes concurrent allocation, no reuse after deletion, legacy migration without date/body changes, stale revisions, shorthand/name search, ambiguous references, read banners, empty/error states, and references throughout navigation.
- Repository lint/type checks and the exact VS Code 1.122.1 gate passed (3 extension, 2 modes, 4 LM tests). Six prompt snapshots were reviewed and updated for the Alpha Tickets guidance.
- All 18 ticket locales contain all 44 keys; unrelated repository translation gaps remain.
- Dark/wide and light/430-pixel visual review used the actual React components with fixture messages. The packaged extension and four ticket UI source maps were checked against the current build/source; the VSIX contents check passed for 1,790 entries, with no temporary preview artifacts.
- The new primary prompt section is 1,337 source bytes and the ticket schema module is 2,456 source bytes; these are source-size measurements, not provider token usage. A fresh live-model request has not been run, so prompt compliance is not claimed as a deterministic runtime guarantee.

Chat selection and navigation follow-up, September 7, 2026:

- Regression coverage verifies status order across pages, project-scoped search, bounded and stale search responses, timeout and cleanup, keyboard selection, switching back to slash commands, ticket context in initial/feedback messages, clickable banner identities, panel initialization, and unsaved-draft protection.
- Browser review used the actual chat composer, ticket banner, list, and reader with fixture messages at 1280- and 430-pixel widths. Selecting a result inserted `@ticket:PM-01`; clicking its banner opened the full reader, and the breadcrumb returned to In progress, Backlog, Complete in that order. The fixture did not access user ticket storage.
- Existing translated ticket labels are reused throughout the new chat flow; no locale keys were added.
- Validation passed: 108 extension regression tests, 146 webview regression tests, five shared contract tests, repository lint and type checks, touched-file formatting, and the exact VS Code 1.122.1 smoke gate (3 extension, 2 mode, 4 LM tests). Manual visual inspection used the browser fixture; the exact host was checked automatically.
- The rebuilt VSIX passed the 1,790-entry contents check. Its extension bundle and all seven changed ticket/chat UI modules were checked against the current build and source. Packaging ran after the other builds finished to avoid the active development watcher's writes racing archive creation.

Persistent section headers follow-up, September 7, 2026:

- All three status headers render independently of their ticket rows, including empty search results. Each native button exposes its expanded state and controlled list, with down/right carets and VS Code section-header theme colors.
- The existing panel state now stores optional collapse preferences, preserving compatibility with older saved state. Returning to a ticket in a collapsed section focuses that section's header.
- All 18 ticket webview tests passed, including empty sections, independent toggles, filtering, focus targeting, navigation, and reload persistence. Webview lint, type checks, and touched-file formatting passed; existing localized status labels are reused.
- Browser review verified actual component rendering in dark/wide and light/430-pixel layouts, visible headers with all sections collapsed, empty search results, and Enter/Space activation. Manual visual review in the Extension Development Host was not performed; the exact VS Code 1.122.1 automated gate passed (3 extension, 2 mode, 4 LM tests).
- The rebuilt VSIX passed its 1,790-entry contents check. Packaged list/panel source maps, section styles, and the extension bundle match the current source/build.

Ticket search follow-up, September 7, 2026:

- Reproduced missing partial-reference results in the store and missing plural/direct autocomplete paths in the composer. Search now includes ticket references alongside existing text fields; complete references retain exact matching.
- Existing chat search handles `ticket:`, `tickets:`, and direct hyphenated references. A project-prefix search can show ticket results alongside file suggestions. The shared mention parser normalizes aliases for attachment loading, deduplication, and clickable chat references, preserving escaped-text and word-boundary rules.
- Validation passed: 107 extension/mention regression tests, 141 webview regression tests, repository lint and type checks, touched-file formatting, and the exact VS Code 1.122.1 gate (3 extension, 2 mode, 4 LM tests).
- Browser review used the actual composer and mention components with fixture messages: partial project prefixes, plural syntax, multiword title searches through the menu, Enter selection, and clicking a manually entered short reference. It did not access user ticket storage. Manual visual review in the Extension Development Host was not performed.
- The rebuilt VSIX passed the 1,790-entry contents check. Its changed composer, menu utility, clickable mention, and shared parser source maps match the current source; its extension bundle matches the current build. No locale strings or dependency versions changed.

Restored-panel loading follow-up, September 7, 2026:

- Reproduced the missing-workspace error with controlled project initialization and refresh promises: the saved webview issued a list request while the host's project map was empty, then failed to reload when discovery completed with the same project ID. Existing ticket files were intact.
- The host now waits for current discovery, publishes project maps and watchers together, ignores superseded discovery failures, and prevents late results from reaching a reopened panel. Projects actually removed from the workspace remain unavailable.
- The webview waits for discovery, refreshes on subsequent project snapshots, preserves existing rows during failed refreshes, and offers Reload. Loading/error states no longer claim there are no matching tickets. Existing localized labels are reused, and unsaved drafts remain protected.
- Validation passed: 29 ticket service tests, 20 ticket webview tests, repository lint and type checks, touched-file formatting, and the exact VS Code 1.122.1 gate (3 extension, 2 mode, 4 LM tests). A browser fixture verified delayed startup, successful population, retained rows on failure, and Reload recovery with the actual components. Manual visual review in the Extension Development Host was not performed.
- The rebuilt VSIX passed its 1,790-entry contents check; packaged list/panel source maps and the extension bundle match the current source/build. No ticket files or storage identities were changed by this repair.

Section appearance and defaults follow-up, September 7, 2026:

- Status headers now have a bottom border with no surrounding box. Theme colors, focus outlines, carets, and independent collapse controls remain intact.
- Fresh panels expand all sections and ignore older saved collapse preferences. Collapses stay local to the current view, preserving choices during ticket navigation without hiding rows after reload.
- The updated regression failed against the previous behavior and passed after the change. All 20 ticket webview tests, webview lint and type checks, touched-file formatting, and the exact VS Code 1.122.1 gate passed (3 extension, 2 mode, 4 LM tests).
- Dark and light browser previews verified the actual header stylesheet. Manual visual review in the Extension Development Host was not performed.
- The rebuilt VSIX passed its 1,790-entry contents check. Its ticket view source map, underline styles, and extension bundle match the current source/build.

Activity section follow-up, September 7, 2026:

- Renamed the reader and editor label to Activity in all 18 ticket locales. The reader always renders this section, leaving its body blank when empty. Existing implementation notes retain their content and persisted field/Markdown format.
- All 24 ticket webview tests passed, including empty Activity across all three statuses and existing notes in the reader/editor. Webview lint, type checks, formatting, and the exact VS Code 1.122.1 gate passed (3 extension, 2 mode, 4 LM tests).
- The translation check found no ticket locale gaps; unrelated existing translation gaps elsewhere still make the repository-wide check fail. Manual visual review in the Extension Development Host was not performed.
- The rebuilt VSIX passed its 1,790-entry contents check; the packaged reader source/executable and Activity translation bundle match the current build.

Ticket deletion follow-up, September 8, 2026:

- Saved tickets can be deleted from the reader or editor after a named confirmation. Deletion preserves linked tasks, references, project boundaries, and concurrent edits; failed requests retain the displayed ticket and draft. Native deletion always requests manual approval.
- Focused store, panel, tool, approval, parser, task-link, and webview regressions passed, including cancellation, stale revisions, sequence preservation, interrupted moves, duplicate clicks, keyboard focus, and collection pagination. All 286 shared-package tests, repository lint/type checks, and the exact VS Code 1.122.1 gate passed (3 extension, 2 mode, 4 LM tests).
- Browser review used the built interface and in-memory sample tickets in dark and light themes, including a 430-pixel panel. Confirmation text, Cancel/Escape focus restoration, and successful return to the remaining collection were verified. Manual visual review in the Extension Development Host was not performed.
- All 18 ticket locales include the deletion strings. The repository translation scan still reports unrelated existing gaps. Bundle and VSIX creation passed, and the rebuilt package passed the 1,790-entry contents check.
