import type Anthropic from "@anthropic-ai/sdk"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import { createApiStreamOutcome } from "../../../api/transform/stream"
import { getPendingAgentMailIds } from "../../task-persistence/agentMailSampling"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

function fixture() {
	const mail: ApiMessage = {
		role: "user",
		input_origin: "agent",
		agent_message_id: "captured",
		content: "<agent_message>Finding from child</agent_message>",
	}
	let durable: ApiMessage[] = [mail]
	const save = vi.fn(async (message: Anthropic.MessageParam) => {
		durable = structuredClone([...durable, message])
		return true
	})
	const task = Object.assign(Object.create(Task.prototype), {
		abort: false,
		currentAgentStep: {
			sampledAgentMessageIds: ["captured"],
			snapshot: { context: { provider: { apiProtocol: "openai" } } },
		},
		apiConfiguration: { apiProvider: "openai" },
		addToApiConversationHistory: save,
		retrySaveApiConversationHistory: vi.fn(async () => false),
		suspendAfterCurrentTurn: vi.fn(),
		recordFinalizedAssistantMemoryUsage: vi.fn(async () => undefined),
		publishCanonicalLifecycleResponseItems: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
	}) as Task
	const persist = Reflect.get(task, "persistAssistantResponseBeforeEffects") as (
		message: Anthropic.MessageParam,
		reasoning: undefined,
		response: AgentResponse,
		guard: () => boolean,
	) => Promise<boolean>
	return {
		task,
		save,
		durable: () => durable,
		commit: (response: AgentResponse) =>
			persist.call(task, { role: "assistant", content: response.text }, undefined, response, () => true),
	}
}

it("persists the captured mail checkpoint with successful regular output, leaving later mail unread", async () => {
	const { commit, durable } = fixture()
	await commit(createAgentResponse([{ type: "text", text: "I have considered the finding." }]))
	const restored: ApiMessage[] = JSON.parse(JSON.stringify(durable()))
	restored.push({ role: "user", input_origin: "agent", agent_message_id: "later", content: "New finding" })
	expect(restored.at(-2)?.sampled_agent_message_ids).toEqual(["captured"])
	expect([...getPendingAgentMailIds(restored)]).toEqual(["later"])
})

it.each(["failed", "cancelled", "incomplete"] as const)("does not consume mail on %s output", async (status) => {
	const { commit, durable } = fixture()
	await commit(createAgentResponse([{ type: "text", text: "Partial output" }], createApiStreamOutcome({ status })))
	expect(durable().at(-1)).not.toHaveProperty("sampled_agent_message_ids")
	expect([...getPendingAgentMailIds(durable())]).toEqual(["captured"])
})

it("leaves mail pending after a rejected response commit and consumes it on a successful retry", async () => {
	const { commit, durable, save } = fixture()
	const response = createAgentResponse([{ type: "text", text: "Response" }])
	save.mockResolvedValueOnce(false)
	expect(await commit(response)).toBe(false)
	expect([...getPendingAgentMailIds(durable())]).toEqual(["captured"])
	expect(await commit(response)).toBe(true)
	expect([...getPendingAgentMailIds(durable())]).toEqual([])
})

it("does not consume mail after host cancellation", async () => {
	const { commit, durable, task } = fixture()
	task.abort = true
	await commit(createAgentResponse([{ type: "text", text: "Late response" }]))
	expect([...getPendingAgentMailIds(durable())]).toEqual(["captured"])
})

it.each([
	createAgentResponse([
		{ type: "text", text: "Partial" },
		{ type: "error", message: "Malformed tool call" },
	]),
	createAgentResponse([{ type: "usage", inputTokens: 10, outputTokens: 0 }]),
	...(["text", "reasoning"] as const).map((type) =>
		createAgentResponse(
			[
				{ type, text: "" },
				{ type: "usage", inputTokens: 10, outputTokens: 0 },
			],
			{ status: "completed", requiresContinuation: false },
		),
	),
	createAgentResponse([{ type: "reasoning", text: " \n", signature: "", encryptedContent: "" }]),
	createAgentResponse([{ type: "reasoning", text: "", geminiResponse: { modelId: "gemini", parts: [{}] } }]),
	createAgentResponse([{ type: "reasoning", text: "", vscodeLmThinking: { value: "", metadata: { invalid: NaN } } }]),
	createAgentResponse([
		{ type: "tool_call", id: "call", name: "read_file", arguments: {}, argumentParseError: "Invalid payload" },
	]),
])("does not consume mail without successful semantic response evidence", async (response) => {
	const { commit, durable } = fixture()
	await commit(response)
	expect([...getPendingAgentMailIds(durable())]).toEqual(["captured"])
})

it.each([
	{ type: "reasoning" as const, text: "", signature: "signed-thinking" },
	{ type: "reasoning" as const, text: "", encryptedContent: "encrypted-provider-state" },
	{
		type: "reasoning" as const,
		text: "",
		geminiResponse: { modelId: "gemini", parts: [{ thoughtSignature: "signature" }] },
	},
	{ type: "reasoning" as const, text: "", vscodeLmThinking: { value: "", metadata: { opaqueState: "state" } } },
])("accepts nonempty signed or opaque reasoning as sampling evidence", async (item) => {
	const { commit, durable } = fixture()
	await commit(createAgentResponse([item], { status: "completed" }))
	expect([...getPendingAgentMailIds(durable())]).toEqual([])
})
