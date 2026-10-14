import { OpenAiHandler } from "../openai"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import type { ApiStreamChunk } from "../../transform/stream"

const { responsesCreate, chatCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn(), chatCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(() => ({
		responses: { create: responsesCreate },
		chat: { completions: { create: chatCreate } },
	}))
	return { default: constructor, AzureOpenAI: constructor }
})

function message(id: string | undefined, phase: unknown, text: string) {
	return {
		type: "message",
		role: "assistant",
		status: "completed",
		...(id !== undefined ? { id } : {}),
		...(phase !== undefined ? { phase } : {}),
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function provider(streaming = true) {
	return new OpenAiHandler({
		openAiApiKey: "test-key",
		openAiModelId: "gpt-6.1-sol",
		openAiBaseUrl: "https://api.openai.com/v1",
		openAiStreamingEnabled: streaming,
	})
}

async function collect(handler: OpenAiHandler) {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of handler.createMessage("system", [])) chunks.push(chunk)
	return chunks
}

describe("OpenAI Responses assistant message metadata", () => {
	beforeEach(() => {
		responsesCreate.mockReset()
		chatCreate.mockReset().mockResolvedValue({
			choices: [{ message: { content: "Completed." }, finish_reason: "stop" }],
			usage: null,
		})
	})

	it.each(
		["commentary", "partial_answer", "final_answer", undefined, null, "future_phase"].flatMap((phase) =>
			[false, true].map((streaming) => ({ phase, streaming })),
		),
	)(
		"preserves supported phase=$phase with streaming=$streaming without completing a continuing turn",
		async ({ phase, streaming }) => {
			const item = message("msg_server", phase, "Answer text.")
			const response = { id: "resp_phase", status: "completed", output: [item], end_turn: false, usage: null }
			responsesCreate.mockResolvedValueOnce(
				streaming
					? (async function* () {
							yield {
								type: "response.output_item.added",
								output_index: 0,
								item: { ...item, content: [] },
							}
							yield {
								type: "response.output_text.delta",
								item_id: "msg_server",
								output_index: 0,
								content_index: 0,
								delta: "Answer text.",
							}
							yield { type: "response.output_item.done", output_index: 0, item }
							yield { type: "response.completed", response }
						})()
					: response,
			)
			const chunks = await collect(provider(streaming))
			const expectedMetadata = {
				id: "msg_server",
				outputIndex: 0,
				...(["commentary", "partial_answer", "final_answer"].includes(String(phase)) ? { phase } : {}),
			}
			expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
				{ type: "text", text: "Answer text.", ...expectedMetadata },
			])
			expect(chunks).toContainEqual({ type: "message_metadata", ...expectedMetadata })
			const accumulator = new AgentResponseAccumulator()
			for (const chunk of chunks) await accumulator.add(chunk)
			expect((await accumulator.finish()).outcome).toMatchObject({
				status: "completed",
				requiresContinuation: true,
			})
		},
	)

	it.each(["done", "completed", "repeated_done"])(
		"attaches phase first supplied by $phaseSource without duplicate text",
		async (phaseSource) => {
			const finalItem = message("msg_late", "partial_answer", "Stable answer.")
			const phaseLessItem = message("msg_late", undefined, "Stable answer.")
			responsesCreate.mockResolvedValueOnce(
				(async function* () {
					yield {
						type: "response.output_text.delta",
						item_id: "msg_late",
						output_index: 0,
						content_index: 0,
						delta: "Stable answer.",
					}
					yield {
						type: "response.output_item.done",
						output_index: 0,
						item: phaseSource === "done" ? finalItem : phaseLessItem,
					}
					if (phaseSource === "repeated_done") {
						yield { type: "response.output_item.done", output_index: 0, item: finalItem }
					}
					yield {
						type: "response.completed",
						response: { id: "resp_late", status: "completed", output: [finalItem], usage: null },
					}
				})(),
			)
			const chunks = await collect(provider())
			expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
				{ type: "text", text: "Stable answer.", id: "msg_late", outputIndex: 0 },
			])
			expect(chunks).toContainEqual({
				type: "message_metadata",
				id: "msg_late",
				phase: "partial_answer",
				outputIndex: 0,
			})
			const accumulator = new AgentResponseAccumulator()
			for (const chunk of chunks) await accumulator.add(chunk)
			expect((await accumulator.finish()).items.filter((item) => item.type === "text")).toEqual([
				{ type: "text", text: "Stable answer.", id: "msg_late", phase: "partial_answer", outputIndex: 0 },
			])
		},
	)

	it.each([
		{ id: undefined, phase: undefined },
		{ id: undefined, phase: "commentary" },
		{ id: "msg", phase: "commentary" },
	])("retains separate message boundaries with IDs=$id and phase=$phase", async ({ id, phase }) => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_boundaries",
			status: "completed",
			output: [
				message(id === undefined ? undefined : `${id}_1`, phase, "Repeated."),
				message(id === undefined ? undefined : `${id}_2`, phase, "Repeated."),
			],
			usage: null,
		})
		expect((await collect(provider(false))).filter((chunk) => chunk.type === "text")).toEqual([
			{
				type: "text",
				text: "Repeated.",
				...(id === undefined ? {} : { id: `${id}_1` }),
				...(phase === undefined ? {} : { phase }),
				outputIndex: 0,
			},
			{
				type: "text",
				text: "Repeated.",
				...(id === undefined ? {} : { id: `${id}_2` }),
				...(phase === undefined ? {} : { phase }),
				outputIndex: 1,
			},
		])
	})

	it.each(["delta", "done", "completed"])("rejects a source message whose ID changes in $stage", async (stage) => {
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "response.output_item.added",
					output_index: 0,
					item: message("msg_original", "commentary", ""),
				}
				if (stage === "delta") {
					yield {
						type: "response.output_text.delta",
						output_index: 0,
						content_index: 0,
						item_id: "msg_changed",
						delta: "Changed.",
					}
				} else if (stage === "done") {
					yield {
						type: "response.output_item.done",
						output_index: 0,
						item: message("msg_changed", "final_answer", "Changed."),
					}
				} else {
					yield {
						type: "response.output_item.done",
						output_index: 0,
						item: message("msg_original", "commentary", "Original."),
					}
					yield {
						type: "response.completed",
						response: {
							id: "resp_changed",
							status: "completed",
							output: [message("msg_changed", "final_answer", "Changed.")],
							usage: null,
						},
					}
				}
			})(),
		)
		await expect(collect(provider())).rejects.toThrow("streamed message changed identity")
	})

	it("retains an original message ID first attached by response completion", async () => {
		const finalItem = message("msg_late_id", "final_answer", "Answer.")
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Answer." }
				yield {
					type: "response.output_item.done",
					output_index: 0,
					item: message(undefined, undefined, "Answer."),
				}
				yield {
					type: "response.completed",
					response: { id: "resp_late_id", status: "completed", output: [finalItem], usage: null },
				}
			})(),
		)
		const chunks = await collect(provider())
		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
			{ type: "text", text: "Answer.", outputIndex: 0 },
		])
		expect(chunks).toContainEqual({
			type: "message_metadata",
			id: "msg_late_id",
			phase: "final_answer",
			outputIndex: 0,
		})
		const accumulator = new AgentResponseAccumulator()
		for (const chunk of chunks) await accumulator.add(chunk)
		expect((await accumulator.finish()).items.filter((item) => item.type === "text")).toEqual([
			{ type: "text", text: "Answer.", id: "msg_late_id", phase: "final_answer", outputIndex: 0 },
		])
	})

	it.each([-1, 0.5, "0"])("rejects an invalid message output index %s before accepting text", async (index) => {
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield { type: "response.output_text.delta", output_index: index, content_index: 0, delta: "Invalid." }
			})(),
		)
		await expect(collect(provider())).rejects.toThrow("message has an invalid index")
	})

	it("keeps an empty completed source message exactly once without visible text", async () => {
		const item = { ...message("msg_empty", "commentary", ""), content: [] }
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield { type: "response.output_item.added", output_index: 0, item }
				yield { type: "response.output_item.done", output_index: 0, item }
				yield { type: "response.output_item.done", output_index: 0, item }
				yield {
					type: "response.completed",
					response: { id: "resp_empty", status: "completed", output: [item], usage: null },
				}
			})(),
		)
		expect((await collect(provider())).filter((chunk) => chunk.type === "text")).toEqual([
			{ type: "text", text: "", id: "msg_empty", phase: "commentary", outputIndex: 0 },
		])
	})

	it("preserves refusal message metadata without duplicating the final refusal", async () => {
		const item = {
			...message("msg_refusal", "final_answer", ""),
			content: [{ type: "refusal", refusal: "Cannot provide that." }],
		}
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }
				yield {
					type: "response.refusal.delta",
					item_id: "msg_refusal",
					output_index: 0,
					content_index: 0,
					delta: "Cannot provide that.",
				}
				yield { type: "response.output_item.done", output_index: 0, item }
				yield {
					type: "response.completed",
					response: { id: "resp_refusal", status: "completed", output: [item], usage: null },
				}
			})(),
		)
		expect((await collect(provider())).filter((chunk) => chunk.type === "text")).toEqual([
			{ type: "text", text: "Cannot provide that.", id: "msg_refusal", phase: "final_answer", outputIndex: 0 },
		])
	})

	it("still rejects a stream with declared final phase and no terminal response event", async () => {
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "response.output_item.done",
					output_index: 0,
					item: message("msg_unfinished", "final_answer", "Declared final."),
				}
			})(),
		)
		await expect(collect(provider())).rejects.toThrow("without a terminal event")
	})

	it("propagates cancellation after final-phase text while transport is pending", async () => {
		const controller = new AbortController()
		const abort = Object.assign(new Error("Operation stopped"), { name: "AbortError" })
		let releaseTransport: () => void = () => undefined
		const pending = new Promise<void>((resolve) => {
			releaseTransport = resolve
		})
		responsesCreate.mockResolvedValueOnce(
			(async function* () {
				yield {
					type: "response.output_item.added",
					output_index: 0,
					item: message("msg_cancelled", "final_answer", ""),
				}
				yield {
					type: "response.output_text.delta",
					item_id: "msg_cancelled",
					output_index: 0,
					content_index: 0,
					delta: "Before cancellation.",
				}
				controller.abort(abort)
				await pending
			})(),
		)
		const chunks: ApiStreamChunk[] = []
		const handler = provider()
		try {
			await expect(async () => {
				for await (const chunk of handler.createMessage("system", [], {
					taskId: "phase-cancellation",
					signal: controller.signal,
				}))
					chunks.push(chunk)
			}).rejects.toBe(abort)
		} finally {
			releaseTransport()
		}
		expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
			{ type: "text", text: "Before cancellation.", id: "msg_cancelled", phase: "final_answer", outputIndex: 0 },
		])
		expect(chunks.some((chunk) => chunk.type === "usage" || chunk.type === "outcome")).toBe(false)
		expect(handler.getResponseId()).toBeUndefined()
	})

	it("does not reuse message metadata across separate requests", async () => {
		responsesCreate.mockResolvedValueOnce({
			id: "resp_first",
			status: "completed",
			output: [message("msg_first", "final_answer", "First.")],
			usage: null,
		})
		responsesCreate.mockResolvedValueOnce({
			id: "resp_second",
			status: "completed",
			output: [message(undefined, undefined, "Second.")],
			usage: null,
		})
		const handler = provider(false)
		await collect(handler)
		expect((await collect(handler)).filter((chunk) => chunk.type === "text")).toEqual([
			{ type: "text", text: "Second.", outputIndex: 0 },
		])
	})

	it("uses separate source boundaries without unsupported metadata in the actual Chat fallback request", async () => {
		const reasoningDetails = [
			{ type: "encrypted", format: "provider-opaque-v1", id: "opaque-state", data: "opaque+/=" },
		]
		const history = [
			{
				role: "assistant" as const,
				id: "response-envelope",
				content: [
					{
						type: "text" as const,
						text: "First update.",
						id: "msg_first",
						phase: "commentary",
						outputIndex: 0,
					},
					{
						type: "text" as const,
						text: "Second update.",
						id: "msg_second",
						phase: "commentary",
						outputIndex: 1,
					},
					{ type: "tool_use" as const, id: "call_read", name: "read_file", input: { path: "file.txt" } },
				],
				reasoning_details: reasoningDetails,
			},
			{
				role: "user" as const,
				content: [{ type: "tool_result" as const, tool_use_id: "call_read", content: "Contents." }],
			},
			{
				role: "assistant" as const,
				content: [
					{
						type: "text" as const,
						text: "Final answer.",
						id: "msg_final",
						phase: "final_answer",
						outputIndex: 0,
					},
				],
			},
		]
		const before = structuredClone(history)
		const handler = new OpenAiHandler({
			openAiApiKey: "test-key",
			openAiModelId: "gpt-6.1-sol",
			openAiBaseUrl: "https://compatible.example/v1",
			openAiStreamingEnabled: false,
		})
		for await (const _chunk of handler.createMessage("system", history)) {
			// Consume the public provider path so the SDK sees the final fallback payload.
		}
		expect(responsesCreate).not.toHaveBeenCalled()
		expect(chatCreate).toHaveBeenCalledOnce()
		expect(chatCreate.mock.calls[0][0].messages).toEqual([
			{ role: "system", content: "system" },
			{ role: "assistant", content: "First update." },
			{
				role: "assistant",
				content: "Second update.",
				reasoning_details: reasoningDetails,
				tool_calls: [
					{
						id: "call_read",
						type: "function",
						function: { name: "read_file", arguments: '{"path":"file.txt"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_read", content: "Contents." },
			{ role: "assistant", content: "Final answer." },
		])
		expect(history).toEqual(before)
	})
})
