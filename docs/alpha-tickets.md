# Alpha Tickets

Alpha Tickets uses the project-scoped Markdown files managed by `src/services/tickets/TicketStore.ts` as its source of
truth. The editor and agent tools share the schemas in `packages/types/src/ticket.ts` and the same revision-checked store.

## Ticket classification

Tickets can have one optional `type`: `bug`, `feature`, or `improvement`. The editor calls this field **Type** and displays
it as a labeled badge in list rows and the detail properties panel. Colors come from VS Code theme tokens; the label
always conveys the classification independently of color.

The field is stored in YAML frontmatter alongside the ticket name. Schema version 1 remains readable without migration:

- Missing `type` means an untagged ticket. Reading existing files does not rewrite them.
- `type: null` explicitly clears a classification in an update. Omitting the field preserves the saved value.
- Create, update, list summaries, search responses, and native ticket tool definitions share the same classification.
- List requests may omit `type` for all tickets, provide a classification, or use `null` to find untagged tickets.
  Filtering happens before the total is counted and pagination is applied, and combines with text and status filters.

The editor saves the type filter with the collection's search and page position. Changing the filter starts at page one;
opening a ticket and returning preserves the filter. Classification edits remain in the draft until Save and retain the
existing stale-revision and external-change protections.

## Presentation

The list groups tickets by their existing status order, with collapsible headers, reference IDs, type badges, and update
dates. The reader separates Markdown content from status, classification, and dates in a properties sidebar. Narrow
layouts wrap rows and stack the properties panel. New labels are localized in every supported ticket locale.

The supplied Linear screenshots informed the visual spacing and badge treatment. This does not add a Linear integration
or change ticket status, approval, task-linking, or completion semantics.
