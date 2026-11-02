import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ticketSchema, ticketTypeSchema, type GlobalSettings, type ModelInfo, type Ticket } from "@alpha-code/types"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import { BaseProvider } from "../../../api/providers/base-provider"
import type { ApiStream } from "../../../api/transform/stream"
import { TicketStore } from "../../../services/tickets/TicketStore"
import { AgentTurnEngine, collectAgentResponse, type AgentTurnStagedHost } from "../../agent/AgentTurnEngine"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOutcome } from "../../agent/ToolScheduler"
import { checkAutoApproval } from "../../auto-approval"
import { Task } from "../../task/Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"
import { serializeTicketResult } from "../serializeTicketResult"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const listResponseSchema = z.object({
	status: z.literal("success"),
	result: z.object({
		tickets: z.array(ticketSchema.pick({ id: true, revision: true, parentId: true, type: true })),
		total: z.number().int(),
		invalidFiles: z.array(z.string()),
	}),
})

function resultText(messages: Anthropic.Messages.MessageParam[], callId: string): string {
	const results = messages.flatMap((message) =>
		typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "tool_result"),
	)
	const matching = results.filter((result) => result.tool_use_id === callId)
	expect(matching, `one terminal receipt for ${callId}`).toHaveLength(1)
	const result = matching[0]
	expect(result.is_error).not.toBe(true)
	if (typeof result.content !== "string") throw new Error(`Expected JSON text for ${callId}`)
	return result.content
}

/** Script only the model's decisions; schema conversion, parsing, tools, approvals, and disk effects stay real. */
class ScriptedDeletionProvider extends BaseProvider {
	readonly requests: {
		messages: Anthropic.Messages.MessageParam[]
		tools: OpenAI.Chat.ChatCompletionTool[]
	}[] = []

	getModel(): { id: string; info: ModelInfo } {
		return { id: "scripted-ticket-deletion", info: { contextWindow: 128_000, supportsPromptCache: false } }
	}

	async *createMessage(
		_systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const tools: OpenAI.Chat.ChatCompletionTool[] = this.convertToolsForOpenAI(metadata?.tools) ?? []
		this.requests.push({ messages: structuredClone(messages), tools })
		const list = tools.find((tool) => tool.type === "function" && tool.function.name === "list_tickets")
		expect(list).toMatchObject({
			function: {
				strict: true,
				parameters: {
					additionalProperties: false,
					required: expect.arrayContaining(["query", "status", "typeFilter", "offset", "limit"]),
					properties: {
						query: { type: ["string", "null"] },
						status: { enum: expect.arrayContaining([null]) },
						typeFilter: { enum: expect.arrayContaining(["untagged", "bug", null]) },
						offset: { type: ["integer", "null"] },
						limit: { type: ["integer", "null"] },
					},
				},
			},
		})
		expect(tools).toContainEqual(
			expect.objectContaining({
				function: expect.objectContaining({
					name: "delete_tickets",
					strict: true,
					parameters: expect.objectContaining({
						required: ["tickets"],
						properties: {
							tickets: expect.objectContaining({
								type: "array",
								maxItems: 1000,
								items: expect.objectContaining({ required: ["id", "expectedRevision"] }),
							}),
						},
					}),
				}),
			}),
		)

		switch (this.requests.length) {
			case 1:
				yield {
					type: "tool_call",
					id: "list-all",
					name: "list_tickets",
					arguments: JSON.stringify({
						query: null,
						status: null,
						typeFilter: null,
						offset: null,
						limit: null,
					}),
				}
				break
			case 2: {
				const listing = listResponseSchema.parse(JSON.parse(resultText(messages, "list-all"))).result
				expect(listing.total).toBe(17)
				expect(listing.tickets).toHaveLength(17)
				expect(listing.invalidFiles).toEqual([])
				const parent = listing.tickets.find((ticket) => !ticket.parentId && !ticket.type)
				if (!parent) throw new Error("The all-types listing missed its untagged parent")
				// Deliberately place the parent first: the store owns dependency ordering.
				const selected = [parent, ...listing.tickets.filter((ticket) => ticket.id !== parent.id)]
				yield {
					type: "tool_call",
					id: "delete-all",
					name: "delete_tickets",
					arguments: JSON.stringify({
						tickets: selected.map(({ id, revision }) => ({ id, expectedRevision: revision })),
					}),
				}
				break
			}
			case 3:
				expect(JSON.parse(resultText(messages, "delete-all"))).toEqual({
					status: "success",
					result: { deleted: 17 },
				})
				yield { type: "text", text: "Deleted all 17 tickets." }
				break
			default:
				throw new Error("Ticket deletion exceeded its three-request budget")
		}
	}
}

describe("ticket deletion workflow", () => {
	let profile: string
	let workspace: string
	let store: TicketStore
	let tickets: Ticket[]

	beforeEach(async () => {
		profile = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-deletion-"))
		workspace = path.join(profile, "project")
		await fs.mkdir(workspace)
		const forWorkspace = TicketStore.forWorkspace.bind(TicketStore)
		vi.spyOn(TicketStore, "forWorkspace").mockImplementation((cwd, _profile, signal) =>
			forWorkspace(cwd, profile, signal),
		)
		store = await TicketStore.forWorkspace(workspace)
		const requirements = {
			description:
				"Synthetic full-description marker. Explain the expected change and its observable behavior. ".repeat(
					60,
				),
			context:
				"Synthetic context marker. Include the affected workflow and relevant implementation constraints. ".repeat(
					40,
				),
			successCriteria:
				"Synthetic acceptance marker. Verify the result and preserve existing project behavior. ".repeat(30),
		}
		const extra = await store.create({ name: "Independent bug", type: "bug", ...requirements })
		const parent = await store.create({ name: "Untyped parent", ...requirements })
		tickets = [extra, parent]
		for (let index = 0; index < 15; index++) {
			tickets.push(
				await store.create({
					name: `Tagged child ${index + 1}`,
					parentId: parent.id,
					type: ticketTypeSchema.options[index % ticketTypeSchema.options.length],
					...requirements,
				}),
			)
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(profile, { recursive: true, force: true })
	})

	it.each([
		{ approvalMode: "auto" as const, manualPrompts: 0 },
		{ approvalMode: "ask" as const, manualPrompts: 1 },
	])(
		"lists and deletes all classifications in three requests in $approvalMode mode",
		async ({ approvalMode, manualPrompts }) => {
			const provider = { context: {}, getMcpHub: () => ({ getServers: () => [] }) }
			const tools = await buildNativeToolsArrayWithRestrictions({
				provider: provider as unknown as BuildToolsOptions["provider"],
				cwd: workspace,
				mode: "code",
				customModes: undefined,
				experiments: {},
				apiConfiguration: { apiProvider: "openai-codex" },
				catalogCache: new TaskToolCatalogCache(),
				discoveryHistory: [],
				userRequestText: "Delete all tickets in this project.",
			})
			const surface = tools.surface!
			expect(surface.isCallable("delete_tickets")).toBe(true)
			const task = Object.assign(Object.create(Task.prototype), {
				workspacePath: workspace,
				abort: false,
				canMutateWorkspace: () => true,
				say: vi.fn(),
			}) as Task
			const manualApproval = vi.fn(async () => true)
			const state: GlobalSettings = { approvalMode }
			const askApproval = vi.fn<NonNullable<ToolExecutionHost["askApproval"]>>(
				async (ask, text, _progress, isProtected, requiresExplicitApproval) => {
					const result = await checkAutoApproval({ state, ask, text, isProtected, requiresExplicitApproval })
					const approved =
						result.decision === "approve" || (result.decision === "ask" && (await manualApproval()))
					return { response: approved ? "yesButtonClicked" : "noButtonClicked" }
				},
			)
			const host: ToolExecutionHost = {
				taskId: `ticket-deletion-${approvalMode}`,
				cwd: workspace,
				taskFacade: task,
				userMessageContent: [],
				say: async () => {},
				askApproval,
				recordToolUsage: vi.fn(),
				pushToolResultToUserContent(result) {
					host.userMessageContent.push(result)
					return true
				},
			}
			const lookup = vi.spyOn(TicketStore.prototype, "list")
			const batchMutation = vi.spyOn(TicketStore.prototype, "deleteMany")
			const individualMutation = vi.spyOn(TicketStore.prototype, "delete")
			const model = new ScriptedDeletionProvider()
			const history: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Delete all tickets in this project." },
			]
			const batches: ToolSchedulerOutcome[] = []
			const calls: string[] = []
			const engineHost: AgentTurnStagedHost<string> = {
				shouldAbort: () => false,
				sampleStep: async () => ({
					response: await collectAgentResponse(
						model.createMessage("", history, { taskId: host.taskId, tools: tools.tools }),
					),
				}),
				commitResponse: async ({ response }) => {
					history.push({
						role: "assistant",
						content: response.items.flatMap((item): Anthropic.Messages.ContentBlockParam[] => {
							if (item.type === "tool_call")
								return [{ type: "tool_use", id: item.id, name: item.name, input: item.arguments }]
							return item.type === "text" ? [{ type: "text", text: item.text }] : []
						}),
					})
				},
				executeEffects: async ({ response }) => {
					if (!response.toolCalls.length) return
					calls.push(...response.toolCalls.map((call) => call.name))
					const start = host.userMessageContent.length
					const outcome = await new ToolScheduler({
						executionHost: host,
						registry: surface.registry,
						policy: surface.policy,
						mode: "code",
					}).run(response.toolCalls)
					batches.push(outcome)
					history.push({ role: "user", content: host.userMessageContent.slice(start) })
				},
				selectContinuation: async ({ response }) => ({
					nextInput: response.toolCalls.length ? "tool-results" : "complete",
				}),
			}
			const outcome = await new AgentTurnEngine(engineHost).run("delete-all")

			for (const result of batches.flatMap((batch) => batch.results)) {
				expect(result.status, JSON.stringify(result.content)).toBe("success")
			}
			expect(outcome).toMatchObject({
				status: "completed",
				steps: 3,
				response: { text: "Deleted all 17 tickets." },
			})
			expect(model.requests).toHaveLength(3)
			expect(calls).toEqual(["list_tickets", "delete_tickets"])
			expect(batches.flatMap((batch) => batch.results)).toMatchObject([
				{ callId: "list-all", name: "list_tickets", status: "success", trustedProgress: { kind: "read" } },
				{
					callId: "delete-all",
					name: "delete_tickets",
					status: "success",
					trustedProgress: { kind: "mutation" },
				},
			])
			expect(batches.reduce((count, batch) => count + batch.approvalRequestCount, 0)).toBe(1)
			expect(batches.reduce((count, batch) => count + batch.outputTruncatedCount, 0)).toBe(0)
			expect(askApproval).toHaveBeenCalledTimes(1)
			expect(manualApproval).toHaveBeenCalledTimes(manualPrompts)
			expect(lookup).toHaveBeenCalledTimes(1)
			expect(batchMutation).toHaveBeenCalledTimes(1)
			expect(batchMutation.mock.calls[0][0].tickets).toHaveLength(17)
			expect(batchMutation.mock.calls[0][0].tickets[0].id).toBe(tickets[1].id)
			expect(individualMutation).not.toHaveBeenCalled()
			expect(host.userMessageContent).toMatchObject([
				{ type: "tool_result", tool_use_id: "list-all", is_error: false },
				{ type: "tool_result", tool_use_id: "delete-all", is_error: false },
			])
			resultText(history, "list-all")
			resultText(history, "delete-all")

			// Conservative payload baseline: one full read per ticket, before repeated history resends or deletion receipts.
			// The observed incident took 27 task requests / 72 calls; this scripted workload bounds the repaired path.
			const fullReadPassBytes = tickets.reduce(
				(bytes, ticket) => bytes + Buffer.byteLength(serializeTicketResult(ticket).content),
				0,
			)
			const cumulativeHistoryBytes = model.requests.reduce(
				(bytes, request) => bytes + Buffer.byteLength(JSON.stringify(request.messages)),
				0,
			)
			expect(cumulativeHistoryBytes).toBeLessThan(fullReadPassBytes / 10)
			expect(JSON.stringify(history)).not.toContain("Synthetic full-description marker")
			lookup.mockRestore()
			expect((await store.list()).tickets).toEqual([])
		},
	)
})
