import { ThinkingLevel } from "@google/genai"
import nock from "nock"
import type { ProviderSettings, ProviderSettingsEntry, ProviderSettingsWithId } from "@alpha-code/types"

import { buildApiHandler } from "../../index"
import { resolveSubagentModelRoute } from "../../../core/agent/SubagentModelRouter"
import { resolveTaskReasoning } from "../../../core/agent/TaskReasoning"
import type { ApiStreamChunk } from "../../transform/stream"

vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: {
		getInstance: () => ({
			authorizeRequest: async () => ({
				accessToken: "routed-chatgpt-oauth",
				signal: new AbortController().signal,
			}),
		}),
	},
}))

type Profile = ProviderSettingsWithId & { id: string; name: string }
type RecordedRequest = { url: string; headers: Headers; body: Record<string, unknown> }

const staleCompatibleSettings: ProviderSettings = {
	openAiBaseUrl: "https://old-compatible.example.test/v1",
	openAiApiKey: "stale-compatible-key",
	openAiModelId: "stale-compatible-model",
	openAiHeaders: { Authorization: "stale-compatible-authorization" },
	openAiCustomModelInfo: {
		maxTokens: 1024,
		contextWindow: 8192,
		supportsPromptCache: false,
		supportsReasoningEffort: false,
	},
}

const profiles: Profile[] = [
	{
		...staleCompatibleSettings,
		id: "native-profile",
		name: "OpenAI work",
		apiProvider: "openai-native",
		apiModelId: "gpt-6.1-sol",
		openAiNativeApiKey: "routed-native-key",
	},
	{
		...staleCompatibleSettings,
		id: "chatgpt-profile",
		name: "ChatGPT work",
		apiProvider: "openai-codex",
		apiModelId: "gpt-6.1-sol",
		openAiNativeApiKey: "stale-openai-native-key",
	},
	{
		id: "anthropic-profile",
		name: "Anthropic work",
		apiProvider: "anthropic",
		apiModelId: "claude-opus-5-5",
		apiKey: "routed-anthropic-key",
	},
	{
		id: "gemini-profile",
		name: "Gemini work",
		apiProvider: "gemini",
		apiModelId: "gemini-4-argon",
		geminiApiKey: "routed-gemini-key",
	},
	{
		...staleCompatibleSettings,
		id: "bedrock-responses-profile",
		name: "Bedrock OpenAI work",
		apiProvider: "bedrock",
		apiModelId: "global.openai.gpt-6.1-sol",
		awsRegion: "us-east-1",
		awsUseApiKey: true,
		awsApiKey: "routed-bedrock-token",
	},
	{
		...staleCompatibleSettings,
		id: "bedrock-messages-profile",
		name: "Bedrock Anthropic work",
		apiProvider: "bedrock",
		apiModelId: "global.anthropic.claude-opus-5-5",
		awsRegion: "us-east-1",
		awsUseApiKey: true,
		awsApiKey: "routed-bedrock-token",
	},
	{
		id: "compatible-profile",
		name: "Compatible work",
		apiProvider: "openai",
		openAiBaseUrl: "https://compatible.example.test/v1",
		openAiApiKey: "routed-compatible-key",
		openAiModelId: "deployment-original",
		openAiStreamingEnabled: false,
		openAiHeaders: { "X-Deployment": "selected-profile" },
		openAiCustomModelInfo: {
			maxTokens: 8192,
			contextWindow: 128_000,
			supportsPromptCache: false,
			supportsReasoningEffort: ["low", "medium", "high"],
			reasoningEffort: "medium",
		},
	},
]

const parent: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://parent.example.test/v1",
	openAiApiKey: "parent-key",
	openAiModelId: "parent-deployment",
	openAiHeaders: { "X-Parent": "must-stay-with-parent" },
	reasoningEffort: "max",
	enableReasoningEffort: true,
}

const loader = {
	async listConfig(): Promise<ProviderSettingsEntry[]> {
		return profiles.map(({ id, name, apiProvider, apiModelId, openAiModelId }) => ({
			id,
			name,
			apiProvider,
			modelId: apiModelId ?? openAiModelId,
		}))
	},
	async getProfile(query: { id?: string; name?: string }): Promise<Profile> {
		const profile = profiles.find((candidate) => candidate.id === query.id || candidate.name === query.name)
		if (!profile) throw new Error("Profile not found")
		return structuredClone(profile)
	},
}

function eventStreamText(events: unknown[]): string {
	return events
		.map((event) => {
			const type = typeof event === "object" && event !== null && "type" in event ? event.type : undefined
			return `${typeof type === "string" ? `event: ${type}\n` : ""}data: ${JSON.stringify(event)}\n\n`
		})
		.join("")
}

function eventStream(events: unknown[]): Response {
	return new Response(eventStreamText(events), {
		headers: { "content-type": "text/event-stream" },
	})
}

const anthropicEvents = [
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Selected route answered." } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
	{ type: "message_stop" },
]

function responsesAnswer() {
	return {
		id: "resp_routed",
		status: "completed",
		output: [
			{
				type: "message",
				id: "msg_routed",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Selected route answered.", annotations: [] }],
			},
		],
		usage: { input_tokens: 12, output_tokens: 3 },
	}
}

let requests: RecordedRequest[]

beforeEach(() => {
	requests = []
	nock("https://api.anthropic.com")
		.post("/v1/messages")
		.reply(function (_uri, body) {
			const headers = new Headers()
			for (const [name, value] of Object.entries(this.req.headers)) {
				if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : String(value))
			}
			requests.push({
				url: "https://api.anthropic.com/v1/messages",
				headers,
				body: typeof body === "string" ? JSON.parse(body) : body,
			})
			return [200, eventStreamText(anthropicEvents), { "content-type": "text/event-stream" }]
		})
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
			const request = new Request(input, init)
			const body = JSON.parse(await request.text()) as Record<string, unknown>
			requests.push({ url: request.url, headers: request.headers, body })
			if (request.url.startsWith("https://generativelanguage.googleapis.com/")) {
				return eventStream([
					{
						candidates: [
							{ content: { parts: [{ text: "Selected route answered." }] }, finishReason: "STOP" },
						],
					},
				])
			}
			if (
				request.url.endsWith("/anthropic/v1/messages") ||
				request.url === "https://api.anthropic.com/v1/messages"
			) {
				return eventStream(anthropicEvents)
			}
			if (request.url.endsWith("/responses")) {
				return eventStream([{ type: "response.completed", response: responsesAnswer() }])
			}
			if (request.url === "https://compatible.example.test/v1/chat/completions") {
				return new Response(
					JSON.stringify({
						choices: [{ message: { content: "Selected route answered." }, finish_reason: "stop" }],
						usage: { prompt_tokens: 12, completion_tokens: 3 },
					}),
					{ headers: { "content-type": "application/json" } },
				)
			}
			throw new Error(`Unexpected offline provider request: ${request.url}`)
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	nock.cleanAll()
})

describe("selected provider profiles at the SDK request boundary", () => {
	it.each(profiles)("routes $apiProvider model and reasoning through its selected profile", async (profile) => {
		const parentBefore = structuredClone(parent)
		const profileBefore = structuredClone(profile)
		const modelId = profile.apiModelId ?? profile.openAiModelId!
		const route = await resolveSubagentModelRoute({
			role: "worker",
			parentApiConfiguration: parent,
			parentReasoningPreference: { kind: "effort", effort: "max" },
			profileLoader: loader,
			requestedProvider: profile.apiProvider,
			requestedProfile: profile.name,
			requestedModelId: modelId,
			requestedReasoningEffort: "high",
		})
		expect(route.apiConfigName).toBe(profile.name)
		expect(route.apiConfiguration.apiProvider).toBe(profile.apiProvider)
		expect(route.apiConfiguration.openAiHeaders ?? {}).not.toHaveProperty("X-Parent")
		const handler = buildApiHandler(route.apiConfiguration)
		const reasoning = resolveTaskReasoning(route.apiConfiguration, route.reasoningPreference, handler.getModel())
		handler.setReasoningOptions?.(reasoning.configuration)
		expect(handler.getModel().id).toBe(modelId)
		const chunks: ApiStreamChunk[] = []
		for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
			chunks.push(chunk)
		}
		expect(chunks).toContainEqual(expect.objectContaining({ type: "text", text: "Selected route answered." }))
		expect(requests).toHaveLength(1)
		const request = requests[0]!
		if (profile.apiProvider !== "gemini") expect(request.body.model).toBe(modelId)
		expect(request.headers.has("x-parent")).toBe(false)
		switch (profile.apiProvider) {
			case "openai-native":
			case "openai-codex":
				expect(request.url).toBe("https://api.openai.com/v1/responses")
				expect(request.headers.get("authorization")).toBe(
					`Bearer ${profile.apiProvider === "openai-native" ? "routed-native-key" : "routed-chatgpt-oauth"}`,
				)
				expect(request.body.reasoning).toMatchObject({ effort: "high" })
				break
			case "anthropic":
				expect(request.url).toBe("https://api.anthropic.com/v1/messages")
				expect(request.headers.get("x-api-key")).toBe("routed-anthropic-key")
				expect(request.body.output_config).toEqual({ effort: "high" })
				break
			case "gemini":
				expect(request.url).toContain(`models/${modelId}:streamGenerateContent`)
				expect(request.headers.get("x-goog-api-key")).toBe("routed-gemini-key")
				expect(request.body.generationConfig).toMatchObject({
					thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
				})
				break
			case "openai":
				expect(request.url).toBe("https://compatible.example.test/v1/chat/completions")
				expect(request.headers.get("authorization")).toBe("Bearer routed-compatible-key")
				expect(request.headers.get("x-deployment")).toBe("selected-profile")
				expect(request.body.reasoning_effort).toBe("high")
				break
			case "bedrock":
				expect(request.headers.get("authorization")).toBe("Bearer routed-bedrock-token")
				expect(request.headers.has("x-api-key")).toBe(false)
				if (modelId.includes("anthropic")) {
					expect(request.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1/messages")
					expect(request.body.output_config).toEqual({ effort: "high" })
				} else {
					expect(request.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses")
					expect(request.body.reasoning).toMatchObject({ effort: "high" })
				}
				break
			default:
				throw new Error("Unexpected fixture provider")
		}
		expect(parent).toEqual(parentBefore)
		expect(profile).toEqual(profileBefore)
	})
})
