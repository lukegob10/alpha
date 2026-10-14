import { z } from "zod"

export const ticketStatusSchema = z.enum(["backlog", "in-progress", "complete", "canceled"])
export const ticketTypeSchema = z.enum(["bug", "feature", "improvement", "testing", "performance", "ux"])
export const ticketPrioritySchema = z.enum(["high", "medium", "low"])
export const ticketIdSchema = z.string().uuid()
export const ticketReferenceSchema = z
	.string()
	.regex(/^[A-Z]{2,4}-\d{2,10}$/)
	.refine((value) => Number(value.split("-")[1]) > 0)
/** Accept spoken-style spacing without making arbitrary text a filesystem identifier. */
export function normalizeTicketReference(value: string): string | undefined {
	const match = /^([a-z]{2,4})\s*(?:[-#]|number\s*)?\s*(\d{1,10})$/i.exec(value.trim())
	if (!match || Number(match[2]) < 1) return undefined
	return `${match[1]!.toUpperCase()}-${String(Number(match[2])).padStart(2, "0")}`
}
export const ticketLocatorSchema = z
	.string()
	.trim()
	.max(80)
	.refine(
		(value) => ticketIdSchema.safeParse(value).success || !!normalizeTicketReference(value),
		"Use a ticket UUID or reference such as PM-01",
	)
const section = z.string().max(16000)
export const ticketFieldsSchema = z.object({
	name: z.string().trim().min(1).max(200),
	// Omitted in legacy tickets; null explicitly removes an existing classification.
	type: ticketTypeSchema.nullable().optional(),
	// Omitted in legacy tickets; null explicitly removes an existing priority.
	priority: ticketPrioritySchema.nullable().optional(),
	description: section,
	context: section,
	successCriteria: section,
	implementationSummary: section,
})
export const ticketSchema = ticketFieldsSchema.extend({
	schemaVersion: z.literal(1),
	id: ticketIdSchema,
	reference: ticketReferenceSchema.optional(),
	parentId: ticketIdSchema.optional(),
	status: ticketStatusSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	completedAt: z.string().datetime().optional(),
	linkedTaskIds: z.array(z.string().min(1).max(200)).max(100),
	revision: z.string(),
})
export const createTicketSchema = ticketFieldsSchema
	.partial()
	.required({ name: true })
	.extend({ parentId: ticketIdSchema.optional() })
	.strict()
export const deleteTicketSchema = z.object({ id: ticketLocatorSchema, expectedRevision: z.string().min(1) }).strict()
export const updateTicketSchema = ticketFieldsSchema
	.partial()
	.extend({
		id: ticketLocatorSchema,
		expectedRevision: z.string().min(1),
		status: ticketStatusSchema.optional(),
		parentId: ticketIdSchema.nullable().optional(),
	})
	.strict()
export const listTicketsSchema = z
	.object({
		query: z.string().max(200).optional(),
		status: ticketStatusSchema.optional(),
		offset: z.number().int().min(0).default(0),
		type: ticketTypeSchema.nullable().optional(),
		limit: z.number().int().min(1).max(100).default(50),
	})
	.strict()
export type Ticket = z.infer<typeof ticketSchema>
export type TicketFields = z.infer<typeof ticketFieldsSchema>
export type CreateTicket = z.infer<typeof createTicketSchema>
export type DeleteTicket = z.infer<typeof deleteTicketSchema>
export type UpdateTicket = z.infer<typeof updateTicketSchema>
export type TicketStatus = z.infer<typeof ticketStatusSchema>
export type TicketType = z.infer<typeof ticketTypeSchema>
export type TicketPriority = z.infer<typeof ticketPrioritySchema>
export const ticketStatusOrder: TicketStatus[] = ["in-progress", "backlog", "complete", "canceled"]
export const ticketTargetSchema = z.object({ project: z.string().min(1).max(200), id: ticketIdSchema }).strict()
export type TicketTarget = z.infer<typeof ticketTargetSchema>
export const ticketSearchRequestSchema = z.object({
	type: z.literal("searchTickets"),
	requestId: z.string().min(1).max(100),
	query: z.string().max(200),
})
export const ticketSearchResponseSchema = z.object({
	type: z.literal("ticketSearchResults"),
	requestId: z.string(),
	tickets: z
		.array(
			ticketSchema.pick({
				id: true,
				reference: true,
				parentId: true,
				name: true,
				status: true,
				type: true,
				priority: true,
				updatedAt: true,
			}),
		)
		.max(50),
	error: z.boolean().optional(),
})
export type TicketSearchResponse = z.infer<typeof ticketSearchResponseSchema>
export const ticketActivitySchema = z.discriminatedUnion("operation", [
	z.object({
		operation: z.enum(["create", "update", "delete"]),
		state: z.enum(["pending", "success"]),
		name: ticketFieldsSchema.shape.name,
		reference: ticketReferenceSchema.optional(),
		target: ticketTargetSchema.optional(),
	}),
	z.object({
		operation: z.literal("list"),
		state: z.enum(["pending", "success", "error", "cancelled"]),
		query: z.string().max(200).optional(),
		total: z.number().int().min(0).optional(),
		matches: z
			.array(
				z.object({
					name: ticketFieldsSchema.shape.name,
					reference: ticketReferenceSchema.optional(),
					target: ticketTargetSchema.optional(),
				}),
			)
			.max(3)
			.optional(),
	}),
	z.object({
		operation: z.literal("read"),
		state: z.enum(["pending", "success", "error", "cancelled"]),
		name: ticketFieldsSchema.shape.name.optional(),
		reference: ticketReferenceSchema.optional(),
		target: ticketTargetSchema.optional(),
	}),
])
export type TicketActivity = z.infer<typeof ticketActivitySchema>
export type TicketSummary = Pick<
	Ticket,
	"id" | "reference" | "parentId" | "name" | "status" | "type" | "priority" | "updatedAt" | "revision"
> & {
	/** Direct children across the whole project, before search and pagination. */
	childCount: number
	completedChildCount: number
}
export type TicketRelations = {
	parent?: TicketSummary
	children: TicketSummary[]
}
export interface TicketList {
	tickets: TicketSummary[]
	total: number
	invalidFiles: string[]
}

export const ticketRequestSchema = z
	.object({
		type: z.literal("ticketRequest"),
		requestId: z.string().max(100),
		project: z.string().max(200),
		operation: z.discriminatedUnion("action", [
			z.object({ action: z.literal("list"), input: listTicketsSchema }),
			z.object({ action: z.literal("read"), id: ticketIdSchema }),
			z.object({ action: z.literal("create"), input: createTicketSchema }),
			z.object({ action: z.literal("update"), input: updateTicketSchema }),
			z.object({ action: z.literal("delete"), input: deleteTicketSchema }),
			z.object({ action: z.literal("relations"), id: ticketIdSchema }),
			z.object({
				action: z.literal("openLinkedTask"),
				id: ticketIdSchema,
				taskId: z.string().min(1).max(200),
			}),
			z.object({ action: z.literal("openMarkdown"), id: ticketIdSchema }),
			z.object({ action: z.literal("work"), id: ticketIdSchema, expectedRevision: z.string().min(1) }),
		]),
	})
	.strict()
export type TicketRequest = z.infer<typeof ticketRequestSchema>
export type TicketResponse =
	| { type: "ticketOpen"; target: TicketTarget }
	| { type: "ticketProjects"; projects: { id: string; name: string }[]; language: string; error?: string }
	| { type: "ticketChanged"; project: string }
	| { type: "ticketResponse"; requestId: string; result?: Ticket | TicketList | TicketRelations; error?: string }
