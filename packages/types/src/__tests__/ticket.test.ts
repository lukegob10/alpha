import { describe, it, expect } from "vitest"
import {
	createTicketSchema,
	listTicketsSchema,
	ticketPrioritySchema,
	ticketTypeSchema,
	deleteTicketSchema,
	updateTicketSchema,
	ticketRequestSchema,
	ticketActivitySchema,
	ticketLocatorSchema,
	normalizeTicketReference,
	ticketStatusSchema,
	ticketSearchRequestSchema,
	ticketSearchResponseSchema,
	ticketTargetSchema,
} from "../ticket.js"

describe("ticket wire contracts", () => {
	it("accepts cancellation and UUID parent links while rejecting arbitrary hierarchy input", () => {
		const parentId = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"
		expect(ticketStatusSchema.options).toContain("canceled")
		expect(createTicketSchema.parse({ name: "Child", parentId }).parentId).toBe(parentId)
		expect(updateTicketSchema.parse({ id: parentId, expectedRevision: "v1", parentId: null }).parentId).toBeNull()
		expect(updateTicketSchema.parse({ id: parentId, expectedRevision: "v1", status: "canceled" }).status).toBe(
			"canceled",
		)
		expect(createTicketSchema.safeParse({ name: "Bad", parentId: "../parent" }).success).toBe(false)
		expect(updateTicketSchema.safeParse({ id: parentId, expectedRevision: "v1", parentId: "PM-01" }).success).toBe(
			false,
		)
	})
	it("accepts the complete ticket classification set and explicit removal across mutations and filters", () => {
		expect(ticketTypeSchema.options).toEqual(["bug", "feature", "improvement", "testing", "performance", "ux"])
		for (const type of [...ticketTypeSchema.options, null]) {
			expect(createTicketSchema.parse({ name: "Ticket", type })).toEqual({ name: "Ticket", type })
			expect(updateTicketSchema.parse({ id: "PM-01", expectedRevision: "v1", type }).type).toBe(type)
			expect(listTicketsSchema.parse({ type }).type).toBe(type)
		}
		expect(listTicketsSchema.parse({}).type).toBeUndefined()
		expect(ticketPrioritySchema.options).toEqual(["high", "medium", "low"])
		for (const priority of [...ticketPrioritySchema.options, null]) {
			expect(createTicketSchema.parse({ name: "Ticket", priority }).priority).toBe(priority)
			expect(updateTicketSchema.parse({ id: "PM-01", expectedRevision: "v1", priority }).priority).toBe(priority)
		}
		expect(createTicketSchema.parse({ name: "Legacy" })).not.toHaveProperty("priority")
		for (const type of ["task", "Bug", ["bug"], 1]) {
			expect(createTicketSchema.safeParse({ name: "Ticket", type }).success).toBe(false)
			expect(updateTicketSchema.safeParse({ id: "PM-01", expectedRevision: "v1", type }).success).toBe(false)
			expect(listTicketsSchema.safeParse({ type }).success).toBe(false)
		}
		for (const priority of ["urgent", "High", 1]) {
			expect(createTicketSchema.safeParse({ name: "Ticket", priority }).success).toBe(false)
			expect(updateTicketSchema.safeParse({ id: "PM-01", expectedRevision: "v1", priority }).success).toBe(false)
		}
	})
	it("validates ticket navigation identities and bounded search messages", () => {
		const target = { project: "project-hash", id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f" }
		expect(ticketTargetSchema.parse(target)).toEqual(target)
		expect(ticketTargetSchema.safeParse({ ...target, id: "../escape" }).success).toBe(false)
		expect(
			ticketSearchRequestSchema.safeParse({ type: "searchTickets", requestId: "one", query: "x".repeat(201) })
				.success,
		).toBe(false)
		expect(
			ticketSearchResponseSchema.safeParse({
				type: "ticketSearchResults",
				requestId: "one",
				tickets: [{ id: "bad" }],
			}).success,
		).toBe(false)
		expect(
			ticketSearchResponseSchema.safeParse({
				type: "ticketSearchResults",
				requestId: "one",
				tickets: [
					{
						id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
						name: "Ticket",
						status: "backlog",
						priority: "high",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}).success,
		).toBe(true)
		expect(
			ticketActivitySchema.parse({ operation: "read", state: "success", name: "Ticket", target }),
		).toMatchObject({ target })
	})
	it("accepts short references without admitting paths or editable identities", () => {
		for (const value of ["PM-01", "pm1", "PM #1", "PM number 1"]) {
			expect(ticketLocatorSchema.parse(value)).toBe(value)
			expect(normalizeTicketReference(value)).toBe("PM-01")
		}
		for (const value of ["../PM-01", "PM-0", "PM-01.md", "C:/tickets/PM-01", "A".repeat(81)])
			expect(ticketLocatorSchema.safeParse(value).success).toBe(false)
		expect(updateTicketSchema.safeParse({ id: "PM-01", expectedRevision: "v1", reference: "PM-02" }).success).toBe(
			false,
		)
		expect(createTicketSchema.safeParse({ name: "Test", reference: "PM-01" }).success).toBe(false)
	})
	it("accepts only bounded, known ticket activities", () => {
		expect(ticketActivitySchema.safeParse({ operation: "create", state: "success", name: "Ticket" }).success).toBe(
			true,
		)
		expect(ticketActivitySchema.safeParse({ operation: "archive", state: "success", name: "Ticket" }).success).toBe(
			false,
		)
		expect(
			ticketActivitySchema.safeParse({
				operation: "update",
				state: "success",
				name: { description: "Raw payload" },
			}).success,
		).toBe(false)
	})
	it("validates revision-bound deletion requests and their activity", () => {
		const input = { id: "PM-01", expectedRevision: "revision" }
		expect(deleteTicketSchema.parse(input)).toEqual(input)
		for (const invalid of [
			{ id: input.id },
			{ ...input, expectedRevision: "" },
			{ ...input, id: "../PM-01" },
			{ ...input, path: "PM-01.md" },
			{ ...input, force: true },
		])
			expect(deleteTicketSchema.safeParse(invalid).success).toBe(false)
		expect(
			ticketRequestSchema.parse({
				type: "ticketRequest",
				project: "project",
				requestId: "delete-one",
				operation: { action: "delete", input },
			}).operation,
		).toEqual({ action: "delete", input })
		for (const state of ["pending", "success"])
			expect(ticketActivitySchema.parse({ operation: "delete", state, name: "Ticket" })).toMatchObject({
				operation: "delete",
				state,
			})
	})
	it("validates ticket relation and linked-task requests", () => {
		const id = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"
		const base = { type: "ticketRequest" as const, project: "project", requestId: "relations" }
		expect(ticketRequestSchema.parse({ ...base, operation: { action: "relations", id } }).operation).toEqual({
			action: "relations",
			id,
		})
		expect(
			ticketRequestSchema.parse({ ...base, operation: { action: "openLinkedTask", id, taskId: "task-1" } })
				.operation,
		).toEqual({ action: "openLinkedTask", id, taskId: "task-1" })
		expect(
			ticketRequestSchema.safeParse({ ...base, operation: { action: "relations", id: "PM-01" } }).success,
		).toBe(false)
		expect(
			ticketRequestSchema.safeParse({ ...base, operation: { action: "openLinkedTask", id, taskId: "" } }).success,
		).toBe(false)
	})
	it("validates bounded editable fields without accepting filesystem paths", () => {
		expect(createTicketSchema.parse({ name: " Ticket " })).toEqual({ name: "Ticket" })
		expect(createTicketSchema.safeParse({ name: "Ticket", path: "../escape" }).success).toBe(false)
		expect(createTicketSchema.safeParse({ name: "", context: "x".repeat(16001) }).success).toBe(false)
	})
	it("requires a revision and rejects unknown message actions", () => {
		expect(
			updateTicketSchema.safeParse({ id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f", name: "Changed" }).success,
		).toBe(false)
		expect(
			ticketRequestSchema.safeParse({
				type: "ticketRequest",
				project: "test",
				requestId: "1",
				operation: { action: "deleteEverything" },
			}).success,
		).toBe(false)
	})
})
