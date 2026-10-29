import nock from "nock"

import { OpenAiCodexHandler } from "../openai-codex"
import { getNativeTools } from "../../../core/prompts/tools/native-tools"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"

vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: {
		getInstance: () => ({
			authorizeRequest: async () => ({ accessToken: "alpha-oauth-token", signal: new AbortController().signal }),
		}),
	},
}))

afterEach(() => vi.unstubAllEnvs())

const profileSelectionTools = () =>
	getNativeTools().filter(
		(tool) => tool.type === "function" && ["list_provider_profiles", "spawn_agent"].includes(tool.function.name),
	)

it.each(["task", "auxiliary"] as const)(
	"sends app-owned %s requests without ambient API account headers through the actual SDK",
	async (kind) => {
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-api-organization")
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-api-project")
		const output = {
			type: "message",
			id: "msg_one",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "wire answer", annotations: [] }],
		}
		const scope = nock("https://api.openai.com", {
			reqheaders: { authorization: "Bearer alpha-oauth-token" },
			badheaders: ["openai-organization", "openai-project"],
		})
			.post("/v1/responses", (body) => {
				expect(body).toMatchObject({
					model: "gpt-6.1-sol",
					stream: true,
					store: false,
					reasoning: { effort: "medium" },
					input:
						kind === "task"
							? [
									{ role: "developer", content: "Instructions" },
									{ role: "user", content: "Hello" },
								]
							: [{ role: "user", content: "Hello" }],
				})
				expect(body).not.toHaveProperty("max_output_tokens")
				expect(body).not.toHaveProperty("temperature")
				return true
			})
			.reply(
				200,
				`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_wire", status: "completed", output: [output], usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`,
				{ "Content-Type": "text/event-stream" },
			)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		if (kind === "task") {
			const chunks = []
			for await (const chunk of handler.createMessage("Instructions", [{ role: "user", content: "Hello" }]))
				chunks.push(chunk)
			expect(chunks).toContainEqual(expect.objectContaining({ type: "text", text: "wire answer" }))
			expect(chunks).toContainEqual(
				expect.objectContaining({ type: "outcome", status: "completed", terminal: true }),
			)
		} else {
			await expect(handler.completePrompt("Hello")).resolves.toBe("wire answer")
		}
		expect(scope.isDone()).toBe(true)
	},
)

it("advertises profile discovery before the model knows any saved connections", async () => {
	const requests: unknown[] = []
	const args = { query: "requested model" }
	const output = {
		type: "function_call",
		id: "fc_discovery",
		call_id: "call_discovery",
		namespace: "alpha",
		name: "list_provider_profiles",
		arguments: JSON.stringify(args),
		status: "completed",
	}
	const scope = nock("https://api.openai.com", { reqheaders: { authorization: "Bearer alpha-oauth-token" } })
		.post("/v1/responses", (body) => {
			requests.push(body)
			return true
		})
		.reply(
			200,
			`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_discovery", status: "completed", output: [output], usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`,
			{ "Content-Type": "text/event-stream" },
		)
	const chunks = []
	for await (const chunk of new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" }).createMessage(
		"Instructions",
		[{ role: "user", content: "Launch a subagent using my other saved connection." }],
		{ taskId: "wire-profile-discovery", tools: profileSelectionTools() },
	))
		chunks.push(chunk)
	expect(requests).toHaveLength(1)
	expect(requests[0]).toMatchObject({
		tools: [
			{
				type: "namespace",
				name: "alpha",
				tools: [
					{
						type: "function",
						name: "list_provider_profiles",
						strict: false,
						parameters: { required: [], additionalProperties: false },
					},
					{ type: "function", name: "spawn_agent" },
				],
			},
		],
	})
	const call = chunks.find((chunk) => chunk.type === "tool_call")
	if (call?.type !== "tool_call") throw new Error("The discovery call did not reach the native parser")
	expect(call).toMatchObject({ id: "call_discovery", name: "list_provider_profiles" })
	const parsed = NativeToolCallParser.parseToolCall({
		id: call.id,
		name: "list_provider_profiles",
		arguments: call.arguments,
	})
	if (parsed?.type !== "tool_use") throw new Error("The discovery arguments were rejected")
	expect(parsed.nativeArgs).toEqual(args)
	expect(scope.isDone()).toBe(true)
})

it.each([
	{ id: "profile-west", name: 'Research "Delta" / West', apiProvider: "vscode-lm", modelId: "grok-4.6" },
	{ id: "profile-north", name: "Review connection North", apiProvider: "anthropic", modelId: "claude-sonnet-5-5" },
])(
	"preserves a discovered $apiProvider profile result and a profile-only spawn through the actual SDK",
	async (profile) => {
		const requests: unknown[] = []
		const args = {
			task_name: "profile_review",
			message: "Review the requested task and return a concise result.",
			profile: profile.id,
		}
		const output = {
			type: "function_call",
			id: "fc_profile",
			call_id: "call_profile",
			namespace: "alpha",
			name: "spawn_agent",
			arguments: JSON.stringify(args),
			status: "completed",
		}
		const scope = nock("https://api.openai.com", { reqheaders: { authorization: "Bearer alpha-oauth-token" } })
			.post("/v1/responses", (body) => {
				requests.push(body)
				return true
			})
			.reply(
				200,
				`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_profile", status: "completed", output: [output], usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`,
				{ "Content-Type": "text/event-stream" },
			)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		const chunks = []
		for await (const chunk of handler.createMessage(
			"Instructions",
			[
				{ role: "user", content: "Use the saved profile." },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_profiles", name: "list_provider_profiles", input: {} }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_profiles",
							content: JSON.stringify({ profiles: [profile] }),
						},
					],
				},
			],
			{
				taskId: "wire-profile-selection",
				tools: profileSelectionTools(),
			},
		))
			chunks.push(chunk)
		expect(requests).toHaveLength(1)
		const request = requests[0]
		expect(request).toMatchObject({
			model: "gpt-6.1-sol",
			tools: [
				{
					type: "namespace",
					name: "alpha",
					tools: [
						{ type: "function", name: "list_provider_profiles" },
						{
							type: "function",
							name: "spawn_agent",
							strict: false,
							parameters: {
								required: ["task_name", "message"],
								properties: {
									profile: { description: expect.stringContaining("list_provider_profiles") },
									provider: { enum: expect.arrayContaining([profile.apiProvider]) },
									model: { description: expect.stringContaining("selected provider") },
								},
							},
						},
					],
				},
			],
			input: expect.arrayContaining([
				{
					type: "function_call_output",
					call_id: "call_profiles",
					output: JSON.stringify({ profiles: [profile] }),
				},
			]),
		})
		if (!request || typeof request !== "object" || !("tools" in request)) throw new Error("Missing wire tools")
		expect(JSON.stringify(request.tools)).not.toContain(profile.name)
		const call = chunks.find((chunk) => chunk.type === "tool_call")
		expect(call).toMatchObject({ type: "tool_call", id: "call_profile", name: "spawn_agent" })
		if (call?.type !== "tool_call")
			throw new Error("The namespaced profile selection did not reach the native parser")
		const parsed = NativeToolCallParser.parseToolCall({
			id: call.id,
			name: "spawn_agent",
			arguments: call.arguments,
		})
		if (parsed?.type !== "tool_use") throw new Error("The profile-only spawn arguments were rejected")
		expect(parsed.nativeArgs).toEqual(args)
		expect(scope.isDone()).toBe(true)
	},
)
