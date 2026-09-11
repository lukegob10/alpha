import { describe, it, expect } from "vitest"
import {
	createTicketSchema,
	listTicketsSchema,
	ticketTypeSchema,
	deleteTicketSchema,
	updateTicketSchema,
	ticketRequestSchema,
	ticketActivitySchema,
	ticketLocatorSchema,
	normalizeTicketReference,
	ticketSearchRequestSchema,
	ticketSearchResponseSchema,
	ticketTargetSchema,
} from "../ticket.js"

describe("ticket wire contracts", () => {
	it("accepts optional ticket classifications and explicit removal across mutations and filters", () => {
		for (const type of [...ticketTypeSchema.options, null]) {
			expect(createTicketSchema.parse({ name: "Ticket", type })).toEqual({ name: "Ticket", type })
			expect(updateTicketSchema.parse({ id: "PM-01", expectedRevision: "v1", type }).type).toBe(type)
			expect(listTicketsSchema.parse({ type }).type).toBe(type)
		}
		expect(listTicketsSchema.parse({}).type).toBeUndefined()
		for (const type of ["task", "Bug", ["bug"], 1]) {
			expect(createTicketSchema.safeParse({ name: "Ticket", type }).success).toBe(false)
			expect(updateTicketSchema.safeParse({ id: "PM-01", expectedRevision: "v1", type }).success).toBe(false)
			expect(listTicketsSchema.safeParse({ type }).success).toBe(false)
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
