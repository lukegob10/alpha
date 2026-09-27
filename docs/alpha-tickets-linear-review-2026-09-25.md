# Alpha Tickets: product and UX review

Reviewed September 25, 2026 (America/New_York). Repository source: `c51ddc23` plus the existing uncommitted working tree. This is a proposal, not an implementation or a release certification.

## Recommendation

Develop Alpha Tickets as a project-scoped work manager inside VS Code: a place to capture work, decide what is ready, run Alpha, and review the result. Keep personal, offline use complete on its own. Add optional shared project spaces when the identity and history contracts can support them.

The most valuable lesson from Linear is the combination of stable navigation, consistent issue properties, fast actions, and several useful views over the same records. Alpha already has much of the visual foundation. Its largest gaps concern prioritization, attention, and the handoff between an agent finishing a run and a person accepting the work.

## Evidence and scope

I inspected the running Alpha Tickets list and ticket reader in an existing Extension Development Host, and Linear's project issue list and issue detail in the desktop app. I read current Alpha types, storage, panel routing, task linkage, list, reader, editor, styles, localization, and nearby tests. The installed development build was not independently matched to the working-tree commit; implementation claims below are based on the source.

Linear's public documentation was retrieved September 25, 2026 local time / September 26 UTC. The live service is the reference, rather than an assumed historical version. No ticket records, Linear records, or production code were changed. No extension tests or exact-host certification were run for this product review. Visual judgments are qualitative; no speed or usability improvement has been measured.

## What Alpha already does well

- One editor-panel experience scoped to open project folders, with breadcrumbs and a project switcher.
- Readable references, keyword/reference search, and Bug / Feature / Improvement classification.
- Status-grouped lists, nested children, and project-wide child completion counts.
- A readable Markdown detail page with separate context and success criteria.
- A direct Work on ticket action, durable task linkage before execution, and deduplication of launches.
- Markdown storage, revision checks, atomic writes, conflict messages, draft preservation, and navigation/focus restoration.
- VS Code theme tokens and narrow-width adaptations.

These are foundations to extend. Search, short IDs, subtickets, Markdown, and native task launching are already present.

## What Linear contributes

Linear's structure is not simply a nested folder tree. Issues belong to teams, move through a team's workflow, and can also belong to an outcome-oriented project and a timeboxed cycle. Views filter the same underlying work. This separation lets people move between their own work, a team's queue, and a project's deliverable without duplicating issues. See [Concepts](https://linear.app/docs/conceptual-model).

Its list and board presentation supports grouping, ordering, visible-property choices, and personal display preferences. Saved views make those choices reusable. See [Display options](https://linear.app/docs/display-options), [Custom Views](https://linear.app/docs/custom-views), and [Board layout](https://linear.app/docs/board-layout).

The interaction pattern is equally useful: keyboard selection, bulk actions, and a peek preview reduce repeated navigation. See [Select issues](https://linear.app/docs/select-issues) and [Peek preview](https://linear.app/docs/peek).

Linear also already supports agent delegation. Human responsibility and agent execution are separate concepts. Alpha should adopt that distinction and make the local editor, working copy, validation, and review handoff especially coherent. See [Assign and delegate issues](https://linear.app/docs/assigning-issues).

## Prioritized proposals

### 1. Give the project a daily working surface

Add a compact navigation rail on wide editor panels and a view picker or tabs on narrow panels:

- **Needs attention:** questions, pending approvals, failed runs needing intervention, and changes ready for review.
- **Ready:** intentionally prioritized work with enough context to start.
- **Active:** work in progress, including a clear indication of a waiting or interrupted run.
- **All tickets:** the complete project collection, with Backlog and Completed filters.
- **Saved views:** optional combinations such as Bugs, Release cleanup, or Blocked.

Needs attention is a derived view, not another ticket status. Incoming suggestions can have a separate optional Triage queue. Linear uses triage to review incoming work before admitting it into the ordinary workflow; this is a good fit for agent-generated follow-ups. See [Triage](https://linear.app/docs/triage).

Avoid filling the first screen with summary cards. Show work and the next meaningful action. An optional personal view across explicitly registered projects can come later; each ticket should retain one project home.

### 2. Distinguish ready work, running work, and accepted work

Suggested default workflow: **Backlog → Ready → In progress → Review → Done**, with Canceled as a terminal alternative. Keep blocked-by relationships orthogonal. Enable Triage only when intake volume warrants it.

Represent an agent run separately: queued, running, waiting for input/approval, failed, stopped, or finished. A run finishing should produce reviewable evidence; it should not by itself establish that the ticket's success criteria have been accepted. A human completion action, or an explicitly configured verified-completion policy, decides that transition.

Use the existing runtime's lifecycle and approval sources. The ticket view must project them rather than maintain another task engine. Selecting Ready must not silently grant execution authority or schedule work unless the user has opted into that behavior.

The existing schema has four statuses only, so this is a deliberate persisted-contract migration. Preserve historical Complete records as completed work; do not retroactively demand new review evidence.

### 3. Add enough metadata to make decisions

First additions: priority, manual ordering within a view, optional area labels, and a human owner that defaults to Me in personal use. Keep Bug / Feature / Improvement as the existing type field. Show an agent executor separately from the owner.

Priority and a Ready queue solve a more immediate problem than estimates, cycles, or due dates: deciding which ticket deserves attention next. Make due dates and lightweight milestones optional later. Keep sorting stable during selection or editing; a background activity update should not make the targeted row jump away.

### 4. Replace the Activity summary with a real work history

Keep the current implementation summary, but label it **Implementation summary**. Add a chronological activity stream with actor, timestamp, event type, and links: created, status changed, run started, question asked, user answered, implementation proposed, verification recorded, and work accepted.

Show linked runs directly on the ticket, with Open conversation, Resume, Retry, and Review changes as appropriate to the actual runtime state. Attach a concise verification result and the working-copy or commit revision to which it applies. Make the ticket useful for answering what happened yesterday without reopening several conversations.

Today, `implementationSummary` is rendered as Activity and `linkedTaskIds` is stored but not exposed as a run history in the reader. This is a substantial product gap even for one user.

### 5. Reduce capture and editing friction

Quick creation should start with a title and optional description. Offer templates for bug reproduction, feature outcomes, and improvements; reveal context and success criteria progressively. The structured fields remain useful for agent handoff, but presenting four large textareas immediately makes small tasks feel expensive.

Allow capture from selected code, a diagnostic, a test failure, or an explicitly selected chat passage, retaining a link to the source. Add safe screenshot/file attachments and workspace file links. The current reader intentionally suppresses image rendering and only renders HTTP(S) links as links, so richer evidence needs a designed resource and URI boundary.

Keep explicit saving and conflict protection for long prose. Inline property editing can save independently with a visible saving/error state. Do not replace the current draft protection with unqualified autosave.

### 6. Make the existing visual design more efficient

- Consolidate repeated Tickets headings and reduce empty toolbar spacing.
- Keep compact, aligned rows: priority, status, reference, title, and a few chosen properties. Offer comfortable and compact density rather than forcing smaller text.
- Reserve strong contrast for the title, selected row, and primary action. Use restrained borders and status color with an accompanying icon or label.
- Move the primary ticket action near the title. Adapt its label to Start work, Open run, Answer question, or Review changes. The current Work on ticket button sits below the content and always uses one label.
- Move Delete into an overflow menu and add Archive and undo/recovery. Keep edit and related-work actions secondary.
- Preserve the existing full-page detail. Add a peek or optional side preview for scanning, plus previous/next navigation within the current result set. Do not force three panes into a narrow VS Code editor group.
- Add keyboard quick-create, search, row navigation, peek, and bulk actions within the focused ticket surface. Use VS Code-aware bindings; copying Linear's Ctrl+B shortcut would conflict with the host's sidebar action.
- Differentiate an empty project from no matching results and an unavailable store. Offer Create ticket or Clear filters according to the state.

### 7. Add relationships and a little project context

Extend existing parent/child tickets with **blocks**, **blocked by**, **related**, and **duplicate**. Dependencies describe sequencing; subtickets describe decomposition. Linear treats these relations as explicit issue properties; see [Issue relations](https://linear.app/docs/issue-relations).

Within an Alpha project, use optional milestones or deliverables to group an outcome spanning several tickets. Avoid introducing another mandatory object also named Project under a repository already called Project. A lightweight Overview can hold a brief, important docs, current milestone, and blockers.

Two scale issues in the present source deserve focused regression work before richer hierarchy UI: group contents are assembled after pagination, and reader relations are taken from the current filtered page. A child can consequently appear under a different status header because its parent owns its position, or be omitted from the reader's child list when it is outside that page. Relationship retrieval and group counts should have explicit project-wide semantics.

### 8. Make sharing optional, with explicit ownership of the data

Current storage is personal Markdown under `~/.alpha/tickets/<project-id>`. The project ID derives from the canonical local folder path; it is not a portable repository identity. From the source, a moved folder or distinct checkout resolves to a different collection. Shared work needs identity separated from checkout location.

Recommended progression:

1. **Private local:** keep today's offline default. Add a stable project UUID and an explicit mapping of checkout/worktree locations to that project. Preserve existing ticket UUIDs and references, with a tested migration of the old store.
2. **Portable handoff:** export/import selected ticket records and chosen attachments. Preserve provenance and identity, show conflicts, and distinguish a snapshot from a live shared record. Exclude raw conversations and local-only context by default.
3. **Shared internal project:** an optional authenticated service with project membership, reader/editor roles, authorship, comments, history, durable links, local caching, conflict resolution, deletion tombstones, and recoverable synchronization.

Keep view preferences and drafts personal while sharing the actual ticket record. Make Local only / Shared with project visible. A shared link should not itself grant access; Linear's [Custom Views](https://linear.app/docs/custom-views) makes this distinction explicit as well.

For a small engineering team, a Git-backed ticket directory could be an explicit alternative. It is a poor default for chatty activity, concurrent edits, attachments, and offline numbering conflicts. Avoid making raw filesystem synchronization the permanent collaboration contract. Likewise, avoid automatic identity merging based solely on a matching Git remote; forks and independently scoped projects need deliberate association.

## Suggested delivery order

| Stage  | Deliverable                                                                                           | Reason                                                             |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| First  | View navigation, Ready/Review workflow, priority, clear next actions, quick capture, keyboard support | Makes ordinary daily work easier to understand and operate         |
| Second | Durable activity, linked runs, review evidence, relationships, archive, relation pagination fixes     | Makes agent execution and project history trustworthy              |
| Third  | Stable identity migration, portable handoff, optional shared internal projects                        | Adds collaboration without making personal use depend on a service |

Specify the stable identity and event contracts early if sharing is likely, even if their UI ships later. List and board should reuse one query/view model. A board, milestones, and personal cross-project search are good subsequent additions; enterprise team hierarchies, mandatory sprints, portfolio reporting, and elaborate workflow customization can wait for demonstrated demand.

## Validation for a future implementation

Use a small set of tasks: capture a bug from code, choose the next ready ticket, answer a blocked agent, inspect changes and tests, accept work, and resume from another checkout. Count interactions and navigation, and measure task time using the same fixtures before and after. No numeric improvement target is asserted by this review.

Test empty and large projects, filtered children, more than 50 tickets, long titles, keyboard-only use, narrow editor groups, light/dark/high-contrast themes, external Markdown edits, interrupted saves, reloads, and unavailable linked runs. Any implementation must follow the repository validation matrix, including the exact VS Code 1.122.1 smoke gate for webview, lifecycle, and persistence changes. Sharing additionally requires offline conflicts, membership changes, reference collisions, and recovery tests.

## Current implementation references

- [Ticket schema and wire contracts](../packages/types/src/ticket.ts)
- [Authoritative Markdown store and folder-based identity](../src/services/tickets/TicketStore.ts)
- [Project discovery and panel routing](../src/services/tickets/TicketPanel.ts)
- [Ticket-to-task launch and reuse](../src/services/tickets/TicketTaskLink.ts)
- [List, editor state, and reader relationships](../webview-ui/src/components/tickets/TicketsView.tsx)
- [Grouped and paginated list](../webview-ui/src/components/tickets/TicketListView.tsx)
- [Reader, summary, properties, and primary action](../webview-ui/src/components/tickets/TicketReader.tsx)
- [Activity label](../webview-ui/src/i18n/locales/en/tickets.json)
- [Editor regression tests](../webview-ui/src/components/tickets/__tests__/TicketsView.spec.tsx)
- [Hierarchy regression tests](../webview-ui/src/components/tickets/__tests__/TicketListView.spec.tsx)
