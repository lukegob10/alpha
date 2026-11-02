import { describe, expect, it } from "vitest"
import { createTicketSchema, deleteTicketSchema, listTicketsSchema, updateTicketSchema } from "@alpha-code/types"
import { toOpenAiStrictToolSchema } from "../../../api/transform/openai-strict-tool-schema"
import { ticketTools } from "../../prompts/tools/native-tools/tickets"
import { normalizeTicketToolArguments } from "../normalizeTicketToolArguments"

const id = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"

describe("ticket tool argument normalization", () => {
	it("accepts strict optional null omissions as an unfiltered list", () => {
		const args = { query: null, status: null, typeFilter: null, offset: null, limit: null }
		expect(listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", args))).toEqual({
			offset: 0,
			limit: 50,
		})
	})

	it("keeps a legacy explicit null type as untagged while the new null filter means all types", () => {
		expect(listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", { type: null }))).toEqual({
			type: null,
			offset: 0,
			limit: 50,
		})
		expect(
			listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", { typeFilter: "untagged" })),
		).toEqual({
			type: null,
			offset: 0,
			limit: 50,
		})
		expect(
			listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", { typeFilter: null })),
		).not.toHaveProperty("type")
	})

	it("maps named classifications, preserves pagination and empty queries, and does not modify the captured call", () => {
		const args = Object.freeze({ typeFilter: "bug", query: "", status: "canceled", offset: 0, limit: 100 })
		expect(listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", args))).toEqual({
			type: "bug",
			query: "",
			status: "canceled",
			offset: 0,
			limit: 100,
		})
		expect(args).toHaveProperty("typeFilter", "bug")
		expect(args).not.toHaveProperty("type")
	})

	it.each([
		{ type: null, typeFilter: null },
		{ type: "bug", typeFilter: "bug" },
		{ type: undefined, typeFilter: undefined },
	])("rejects simultaneous legacy and model-facing filters: %j", (args) => {
		expect(() => normalizeTicketToolArguments("list_tickets", args)).toThrow("typeFilter")
	})

	it("keeps invalid filters and unknown fields visible to strict runtime validation", () => {
		for (const args of [{ typeFilter: "all" }, { typeFilter: 42 }, { query: 42 }, { extra: true }]) {
			expect(listTicketsSchema.safeParse(normalizeTicketToolArguments("list_tickets", args)).success).toBe(false)
		}
	})

	it("leaves creation semantics unchanged, including explicit classification and invalid content nulls", () => {
		const args = Object.freeze({ name: "Ticket", type: null, priority: null })
		expect(createTicketSchema.parse(normalizeTicketToolArguments("create_ticket", args))).toEqual({
			name: "Ticket",
			type: null,
			priority: null,
		})
		for (const field of ["description", "context", "successCriteria", "implementationSummary", "parentId"]) {
			const malformed = { ...args, [field]: null }
			expect(normalizeTicketToolArguments("create_ticket", malformed)).toBe(malformed)
			expect(createTicketSchema.safeParse(malformed).success).toBe(false)
		}
	})

	it("preserves explicit update clears without turning invalid calls into destructive updates", () => {
		const args = Object.freeze({
			id,
			expectedRevision: "revision",
			type: null,
			priority: null,
			parentId: null,
		})
		expect(updateTicketSchema.parse(normalizeTicketToolArguments("update_ticket", args))).toEqual({
			id,
			expectedRevision: "revision",
			type: null,
			priority: null,
			parentId: null,
		})
		for (const field of ["name", "status", "description", "context", "successCriteria", "implementationSummary"]) {
			const malformed = { ...args, [field]: null }
			expect(normalizeTicketToolArguments("update_ticket", malformed)).toBe(malformed)
			expect(updateTicketSchema.safeParse(malformed).success).toBe(false)
		}
	})

	it("does not repair required null fields or alter other tools", () => {
		expect(
			createTicketSchema.safeParse(normalizeTicketToolArguments("create_ticket", { name: null })).success,
		).toBe(false)
		expect(
			updateTicketSchema.safeParse(normalizeTicketToolArguments("update_ticket", { id, expectedRevision: null }))
				.success,
		).toBe(false)
		expect(
			deleteTicketSchema.safeParse(
				normalizeTicketToolArguments("delete_ticket", { id: null, expectedRevision: "revision" }),
			).success,
		).toBe(false)
		const other = { command: null }
		expect(normalizeTicketToolArguments("exec_command", other)).toBe(other)
		expect(normalizeTicketToolArguments("toString", other)).toBe(other)
	})

	it.each([null, undefined, 42, "tickets", []])("leaves malformed input for runtime rejection: %j", (args) => {
		expect(normalizeTicketToolArguments("list_tickets", args)).toBe(args)
		expect(listTicketsSchema.safeParse(normalizeTicketToolArguments("list_tickets", args)).success).toBe(false)
	})

	it("keeps strict provider null omission distinct from an intentional untagged filter", () => {
		const definition = ticketTools.find((tool) => tool.function.name === "list_tickets")!
		const strict = toOpenAiStrictToolSchema(definition.function.parameters) as {
			required: string[]
			properties: Record<string, { type: string[]; enum?: (string | null)[] }>
		}
		expect(strict.required).toEqual(["query", "status", "typeFilter", "offset", "limit"])
		expect(strict.properties.typeFilter.enum).toContain("untagged")
		expect(strict.properties.typeFilter.enum).toContain(null)
		expect(strict.properties).not.toHaveProperty("type")
		const wire = Object.fromEntries(strict.required.map((key) => [key, null]))
		expect(listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", wire))).not.toHaveProperty("type")
		expect(
			listTicketsSchema.parse(normalizeTicketToolArguments("list_tickets", { ...wire, typeFilter: "untagged" })),
		).toHaveProperty("type", null)
	})
})
