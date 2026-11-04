import { OpenAiHandler } from "../openai"
import { buildOpenAiResponsesInput } from "../openai-responses"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }))
vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { responses: { create: responsesCreate } }
	}),
	AzureOpenAI: vi.fn(),
}))

const destination = { providerId: "openai", modelId: "gpt-6.1-sol" }
const parts = [
	{
		type: "output_text",
		text: "One.",
		annotations: [
			{ type: "url_citation", url: "https://example.test", title: "Source", start_index: 0, end_index: 3 },
		],
		logprobs: [],
	},
	{ type: "output_text", text: " Two.", annotations: [], logprobs: [] },
]
const message = {
	type: "message",
	id: "msg_original",
	role: "assistant",
	phase: "commentary",
	status: "completed",
	content: parts,
}
const call = {
	type: "function_call",
	id: "fc_original",
	call_id: "call_read",
	name: "read_file",
	arguments: '{"path":"a.ts"}',
	status: "completed",
}

async function sample(events: unknown[]) {
	responsesCreate.mockResolvedValueOnce({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event
		},
	})
	const handler = new OpenAiHandler({
		openAiApiKey: "fixture",
		openAiBaseUrl: "https://api.openai.com/v1",
		openAiModelId: destination.modelId,
	})
	const accumulator = new AgentResponseAccumulator()
	for await (const chunk of handler.createMessage("system", [])) await accumulator.add(chunk)
	return accumulator.finish()
}

function completed(output: unknown[]) {
	return { type: "response.completed", response: { id: "resp", status: "completed", output, end_turn: false } }
}

function history(response: Awaited<ReturnType<typeof sample>>) {
	return JSON.parse(
		JSON.stringify([
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "Data" }] },
		]),
	)
}

describe("native Responses item metadata round trips", () => {
	beforeEach(() => responsesCreate.mockReset())

	it.each([{ output: [] }, { output: [{ ...message, phase: "final_answer", content: [] }] }])(
		"distinguishes authoritative empty completion from missing terminal output: %j",
		async ({ output }) => {
			const terminal = completed(output)
			terminal.response.end_turn = true
			const response = await sample([terminal])
			expect(response.outcome).toMatchObject({ status: "completed", requiresContinuation: false })
			if (output.length)
				expect(response.items).toContainEqual(
					expect.objectContaining({ type: "text", text: "", phase: "final_answer", id: message.id }),
				)
		},
	)

	it("rejects EOF without a provider terminal", async () => {
		await expect(sample([])).rejects.toThrow("without a terminal event")
	})

	it("retains late content-part metadata and tool item identity across canonical history and reload", async () => {
		const response = await sample([
			{
				type: "response.output_text.delta",
				item_id: message.id,
				output_index: 0,
				content_index: 0,
				delta: "One.",
			},
			{
				type: "response.output_text.delta",
				item_id: message.id,
				output_index: 0,
				content_index: 1,
				delta: " Two.",
			},
			{ type: "response.output_item.done", output_index: 0, item: message },
			{ type: "response.output_item.done", output_index: 1, item: call },
			completed([message, call]),
		])
		expect(response.text).toBe("One. Two.")
		expect(response.toolCalls).toHaveLength(1)
		expect(response.toolCalls[0]).toMatchObject({ id: call.call_id, name: call.name, arguments: { path: "a.ts" } })
		const input = buildOpenAiResponsesInput("", undefined, history(response), false, true, destination)
		expect(input).toEqual([message, call, { type: "function_call_output", call_id: "call_read", output: "Data" }])
	})

	it("suppresses source envelopes on incompatible provider/model routes without changing tool authority", async () => {
		const response = await sample([completed([message, call])])
		const saved = history(response)
		for (const route of [
			{ ...destination, providerId: "openai-native" },
			{ ...destination, modelId: "other-model" },
			{},
		]) {
			const input = buildOpenAiResponsesInput("", undefined, saved, false, true, route)
			expect(input).toContainEqual({
				type: "function_call",
				call_id: "call_read",
				name: "read_file",
				arguments: call.arguments,
			})
			expect(input).not.toContainEqual(call)
			expect(JSON.stringify(input)).not.toContain("url_citation")
		}
		expect(saved[0].content.some((block: { providerItem?: unknown }) => block.providerItem)).toBe(true)
	})

	it("retains completed item envelopes after cancellation without making the response successful", async () => {
		const cancelled = new DOMException("Cancelled fixture", "AbortError")
		responsesCreate.mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.output_item.done", output_index: 0, item: message }
				yield { type: "response.output_item.done", output_index: 1, item: call }
				throw cancelled
			},
		})
		const handler = new OpenAiHandler({
			openAiApiKey: "fixture",
			openAiBaseUrl: "https://api.openai.com/v1",
			openAiModelId: destination.modelId,
		})
		const accumulator = new AgentResponseAccumulator()
		await expect(async () => {
			for await (const chunk of handler.createMessage("system", [])) await accumulator.add(chunk)
		}).rejects.toBe(cancelled)
		const response = await accumulator.finish(undefined, { status: "cancelled", retryable: false })
		expect(response.outcome?.status).toBe("cancelled")
		const saved = history(response)
		saved[1].content[0].content = "Error: cancelled"
		expect(buildOpenAiResponsesInput("", undefined, saved, false, true, destination)).toEqual([
			message,
			call,
			{ type: "function_call_output", call_id: call.call_id, output: "Error: cancelled" },
		])
	})

	it("bounds optional provider metadata without dropping visible text or its source identity", async () => {
		const oversized = {
			...message,
			content: [{ ...parts[0], text: "Visible", annotations: [{ data: "x".repeat(40_000) }] }],
		}
		const response = await sample([completed([oversized])])
		expect(response.text).toBe("Visible")
		expect(response.items.filter((item) => item.type === "text")).toEqual([
			{ type: "text", text: "Visible", id: message.id, phase: "commentary", outputIndex: 0 },
		])
		expect(JSON.stringify(response.items)).not.toContain("providerItem")
	})

	it("does not let source envelopes replace canonical tool identity or survive an explicit account boundary", async () => {
		const response = await sample([completed([message, call])])
		const saved = history(response)
		const tool = saved[0].content.find((block: { type: string }) => block.type === "tool_use")
		Object.assign(tool.providerItem, { name: "execute_command", arguments: "untrusted", call_id: "other-call" })
		const input = buildOpenAiResponsesInput("", undefined, saved, false, true, destination)
		expect(input).toContainEqual(call)
		expect(JSON.stringify(input)).not.toContain("execute_command")
		saved[0].provider_state_replay_disabled = true
		const revoked = buildOpenAiResponsesInput("", undefined, saved, false, true, destination)
		expect(revoked).not.toContainEqual(call)
		expect(JSON.stringify(revoked)).not.toContain("url_citation")
		expect(revoked).toContainEqual({
			type: "function_call",
			call_id: call.call_id,
			name: call.name,
			arguments: call.arguments,
		})
	})

	it("preserves metadata for a completed malformed call without authorizing its execution", async () => {
		const malformed = { ...call, arguments: '{"path":' }
		const response = await sample([completed([malformed])])
		expect(response.toolCalls[0]).toMatchObject({
			id: call.call_id,
			argumentParseError: expect.any(String),
			arguments: {},
		})
		const saved = JSON.parse(
			JSON.stringify([{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) }]),
		)
		const input = buildOpenAiResponsesInput("", undefined, saved, false, true, destination)
		expect(input).toEqual([malformed])
	})
})
