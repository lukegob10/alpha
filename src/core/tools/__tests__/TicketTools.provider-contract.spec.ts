import { describe, expect, it } from "vitest"
import { createTicketSchema, updateTicketSchema, type ModelInfo } from "@alpha-code/types"
import { BaseProvider } from "../../../api/providers/base-provider"
import { toOpenAiResponsesTools } from "../../../api/providers/openai-responses"
import type { ApiStream } from "../../../api/transform/stream"
import { ticketTools } from "../../prompts/tools/native-tools/tickets"
import { normalizeTicketToolArguments } from "../normalizeTicketToolArguments"

class TicketSchemaProvider extends BaseProvider {
	createMessage(): ApiStream {
		throw new Error("Schema contract fixture does not call a model")
	}

	getModel(): { id: string; info: ModelInfo } {
		throw new Error("Schema contract fixture does not select a model")
	}

	responsesTools() {
		return toOpenAiResponsesTools(this.convertToolsForOpenAI(ticketTools))!
	}
}

const id = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"
const wireTools = () => new TicketSchemaProvider().responsesTools()

describe("ticket provider wire contracts", () => {
	it.each([
		{ name: "create_ticket", required: ["name"] },
		{ name: "update_ticket", required: ["id", "expectedRevision"] },
	])("preserves optional fields and explicit nulls for $name", ({ name, required }) => {
		const tool = wireTools().find((tool) => tool.type === "function" && tool.name === name)
		expect(tool).toMatchObject({ type: "function", strict: false, parameters: { required } })
	})

	it("keeps unrelated ticket operations strict and lists every type by default", () => {
		const tools = wireTools()
		for (const name of ["list_tickets", "read_ticket", "delete_ticket", "delete_tickets"]) {
			expect(tools.find((tool) => tool.type === "function" && tool.name === name)).toMatchObject({ strict: true })
		}
		expect(tools.find((tool) => tool.type === "function" && tool.name === "list_tickets")).toMatchObject({
			parameters: {
				required: ["query", "status", "typeFilter", "offset", "limit"],
				properties: {
					typeFilter: { type: ["string", "null"], enum: expect.arrayContaining(["untagged", null]) },
				},
			},
		})
	})

	it("keeps name-only edits free of injected null clears", () => {
		const rename = Object.freeze({ id, expectedRevision: "current", name: "New title" })
		expect(updateTicketSchema.parse(normalizeTicketToolArguments("update_ticket", rename))).toEqual(rename)
		const create = Object.freeze({ name: "New ticket" })
		expect(createTicketSchema.parse(normalizeTicketToolArguments("create_ticket", create))).toEqual(create)
	})

	it("retains explicit nullable update removals", () => {
		const clear = { id, expectedRevision: "current", type: null, priority: null, parentId: null }
		expect(updateTicketSchema.parse(normalizeTicketToolArguments("update_ticket", clear))).toEqual(clear)
	})

	it("requires a bounded, explicit revision-checked set for batch deletion", () => {
		const tool = wireTools().find((tool) => tool.type === "function" && tool.name === "delete_tickets")
		expect(tool).toMatchObject({
			strict: true,
			parameters: {
				required: ["tickets"],
				additionalProperties: false,
				properties: {
					tickets: {
						type: "array",
						minItems: 1,
						maxItems: 1000,
						items: {
							required: ["id", "expectedRevision"],
							additionalProperties: false,
							properties: {
								id: { type: "string", format: "uuid" },
								expectedRevision: { type: "string" },
							},
						},
					},
				},
			},
		})
	})
})
