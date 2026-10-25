import type { Ticket, TicketList } from "@alpha-code/types"

import { truncateToolOutputText } from "./BaseTool"

type TicketIdentity = Pick<Ticket, "id" | "reference" | "status" | "revision">
type TicketEntry = Ticket | TicketList["tickets"][number]

interface SerializedTicketResponse {
	content: string
	truncated: boolean
}

const ticketTextFields = ["name", "description", "context", "successCriteria", "implementationSummary"] as const
const ticketMetadataFields = ["type", "priority", "parentId", "childCount", "completedChildCount"] as const

function receipt(ticket: TicketIdentity): TicketIdentity {
	return { id: ticket.id, reference: ticket.reference, status: ticket.status, revision: ticket.revision }
}

function compactTicket(ticket: TicketEntry, limit: number): Record<string, unknown> {
	const result: Record<string, unknown> = { ...receipt(ticket) }
	const fields: Partial<Ticket & TicketList["tickets"][number]> = ticket
	for (const key of ticketTextFields) {
		const text = fields[key]
		if (text !== undefined) result[key] = truncateToolOutputText(text, limit)
	}
	for (const key of ticketMetadataFields) {
		if (fields[key] !== undefined) result[key] = fields[key]
	}
	return result
}

function boundedJson(
	value: unknown,
	minimum: unknown,
	compact: (limit: number) => unknown,
	maxOutputChars?: number,
): SerializedTicketResponse {
	const budget =
		maxOutputChars === undefined || maxOutputChars === Number.POSITIVE_INFINITY
			? Number.MAX_SAFE_INTEGER
			: Number.isFinite(maxOutputChars)
				? Math.max(0, Math.floor(maxOutputChars))
				: 0
	const original = JSON.stringify(value)
	if (original.length <= budget) return { content: original, truncated: false }
	let best = JSON.stringify(minimum)
	if (best.length > budget) throw new Error("Ticket response metadata exceeds the output budget")
	let low = 0
	let high = Math.min(original.length, budget)
	while (low <= high) {
		const limit = Math.floor((low + high) / 2)
		const candidate = JSON.stringify(compact(limit))
		if (candidate.length <= budget) {
			best = candidate
			low = limit + 1
		} else {
			high = limit - 1
		}
	}
	return { content: best, truncated: true }
}

/** Reserve host-issued UUID, reference, and SHA-256 revision metadata before a mutation commits. */
export function reserveTicketMutationReceipt(maxOutputChars?: number): void {
	const result: TicketIdentity = {
		id: "00000000-0000-0000-0000-000000000000",
		reference: "AAAA-9999999999",
		status: "in-progress",
		revision: "f".repeat(64),
	}
	const minimum = { status: "success", result, truncated: true }
	boundedJson(minimum, minimum, () => minimum, maxOutputChars)
}

/** Reduce content without cutting JSON, ticket identities, revisions, or entries from a list page. */
export function serializeTicketResult(result: Ticket | TicketList, maxOutputChars?: number): SerializedTicketResponse {
	const minimum =
		"tickets" in result
			? { tickets: result.tickets.map(receipt), total: result.total, invalidFiles: [] }
			: receipt(result)
	return boundedJson(
		{ status: "success", result },
		{ status: "success", result: minimum, truncated: true },
		(limit) => ({
			status: "success",
			result:
				"tickets" in result
					? {
							tickets: result.tickets.map((ticket) => compactTicket(ticket, limit)),
							total: result.total,
							invalidFiles: [],
						}
					: compactTicket(result, limit),
			truncated: true,
		}),
		maxOutputChars,
	)
}

export function serializeTicketFailure(
	status: "error" | "denied" | "cancelled",
	message: string,
	maxOutputChars?: number,
): SerializedTicketResponse {
	return boundedJson(
		{ status, message },
		{ status },
		(limit) => ({ status, message: truncateToolOutputText(message, limit), truncated: true }),
		maxOutputChars,
	)
}
