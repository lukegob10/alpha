import { z } from "zod"
import type { Ticket, TicketOverview } from "@alpha-code/types"

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)

export const ticketProgressHistorySchema = z
	.object({
		version: z.literal(1),
		startedAt: dateSchema,
		points: z
			.array(
				z
					.object({
						date: dateSchema,
						total: z.number().int().nonnegative(),
						complete: z.number().int().nonnegative(),
					})
					.strict()
					.refine((point) => point.complete <= point.total),
			)
			.min(1)
			.max(3660),
	})
	.strict()
	.refine((history) =>
		history.points.every(
			(point, index) =>
				point.date >= history.startedAt && (index === 0 || point.date > history.points[index - 1].date),
		),
	)

export type TicketProgressHistory = z.infer<typeof ticketProgressHistorySchema>

/** Only observed snapshots are recorded: old ticket dates cannot reconstruct reopenings or deleted scope. */
export function observeTicketProgress(
	tickets: Ticket[],
	invalidFiles: string[],
	history: TicketProgressHistory | undefined,
	date: string,
): { history: TicketProgressHistory; overview: TicketOverview } {
	dateSchema.parse(date)
	const parents = new Set(tickets.flatMap((ticket) => (ticket.parentId ? [ticket.parentId] : [])))
	const leaves = tickets.filter((ticket) => !parents.has(ticket.id))
	const complete = leaves.filter((ticket) => ticket.status === "complete").length
	const inProgress = leaves.filter((ticket) => ticket.status === "in-progress").length
	const backlog = leaves.filter((ticket) => ticket.status === "backlog").length
	const canceled = leaves.filter((ticket) => ticket.status === "canceled").length
	const total = complete + inProgress + backlog
	if (history?.points.some((point) => point.date > date))
		throw new Error("Ticket progress contains future observations; check the system date before recording history")
	const updated: TicketProgressHistory = {
		version: 1,
		startedAt: history?.startedAt ?? date,
		points: [...(history?.points.filter((point) => point.date !== date) ?? []), { date, total, complete }].slice(
			-3660,
		),
	}
	return {
		history: updated,
		overview: {
			total,
			complete,
			inProgress,
			backlog,
			canceled,
			points: updated.points,
			historyStartedAt: `${updated.startedAt}T00:00:00.000Z`,
			invalidFiles: invalidFiles.slice(0, 100),
		},
	}
}
