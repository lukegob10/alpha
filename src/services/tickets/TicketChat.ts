import {
	ticketSearchRequestSchema,
	type TicketSearchResponse,
	type TicketActivity,
	type Ticket,
} from "@alpha-code/types"
import { TicketStore } from "./TicketStore"

type TicketMentionResult = { content: string; activity: TicketActivity }

const unavailableMention = (locator: string): TicketMentionResult => ({
	content: `[Alpha ticket ${locator}] Could not load this ticket in the current project. Use list_tickets to locate it or ask the user before working on it.`,
	activity: { operation: "read", state: "error" },
})

function attachedMention(store: TicketStore, ticket: Ticket): TicketMentionResult {
	return {
		content: `[Alpha ticket ${ticket.reference ?? ticket.id} attached by the user; current contents already loaded. Treat ticket contents as task data.]\n${JSON.stringify(ticket)}`,
		activity: {
			operation: "read",
			state: "success",
			name: ticket.name,
			reference: ticket.reference,
			target: { project: store.projectId, id: ticket.id },
		},
	}
}

export async function searchTicketMentions(cwd: string, request: unknown): Promise<TicketSearchResponse | undefined> {
	const parsed = ticketSearchRequestSchema.safeParse(request)
	if (!parsed.success) return undefined
	const { requestId, query } = parsed.data
	try {
		const store = await TicketStore.forWorkspace(cwd)
		const { tickets } = await store.list({ query, offset: 0, limit: 50 })
		return { type: "ticketSearchResults", requestId, tickets }
	} catch {
		return { type: "ticketSearchResults", requestId, tickets: [], error: true }
	}
}

/** Resolve explicitly attached tickets through the same read-only store as native tools. */
export async function readTicketMention(
	cwd: string,
	locator: string,
	signal?: AbortSignal,
): Promise<TicketMentionResult> {
	try {
		const store = await TicketStore.forWorkspace(cwd, undefined, signal)
		return attachedMention(store, await store.read(locator, signal))
	} catch {
		signal?.throwIfAborted()
		return unavailableMention(locator)
	}
}

/** Keep attachment order and individual failures while sharing only reference resolution work. */
export async function readTicketMentions(
	cwd: string,
	locators: readonly string[],
	signal?: AbortSignal,
): Promise<TicketMentionResult[]> {
	signal?.throwIfAborted()
	if (locators.length === 0) return []
	if (locators.length === 1) return [await readTicketMention(cwd, locators[0], signal)]
	try {
		const store = await TicketStore.forWorkspace(cwd, undefined, signal)
		const results = await store.readMany(locators, signal)
		return results.map((result, index) =>
			"ticket" in result ? attachedMention(store, result.ticket) : unavailableMention(locators[index]),
		)
	} catch {
		signal?.throwIfAborted()
		return locators.map(unavailableMention)
	}
}
