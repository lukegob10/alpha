import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Anthropic } from "@anthropic-ai/sdk"

const mocks = vi.hoisted(() => ({
	responses: vi.fn(),
	chat: vi.fn(),
	authorize: vi.fn(),
	sendRequest: vi.fn(),
	selectChatModels: vi.fn(),
	host: { version: "1.141.0" },
	clients: [] as Array<{ apiKey: string }>,
}))

vi.mock("openai", () => ({
	default: vi.fn(function (options: { apiKey: string }) {
		const client = {
			apiKey: options.apiKey,
			responses: { create: mocks.responses },
			chat: { completions: { create: mocks.chat } },
			withOptions: () => client,
		}
		mocks.clients.push(client)
		return client
	}),
}))
vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: { getInstance: () => ({ authorizeRequest: mocks.authorize }) },
}))
vi.mock("vscode", async (importOriginal) => {
	const original = await importOriginal<typeof import("vscode")>()
	class TextPart {
		constructor(public value: string) {}
	}
	class ThinkingPart {
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
	}
	class ToolPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class ResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}
	class DataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}
	}
	class CancellationTokenSource {
		token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
		cancel() {
			this.token.isCancellationRequested = true
		}
		dispose() {}
	}
	return {
		...original,
		get version() {
			return mocks.host.version
		},
		workspace: {
			...original.workspace,
			onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
			getConfiguration: () => ({ get: () => 600 }),
		},
		lm: { selectChatModels: mocks.selectChatModels, onDidChangeChatModels: vi.fn(() => ({ dispose() {} })) },
		LanguageModelTextPart: TextPart,
		LanguageModelThinkingPart: ThinkingPart,
		LanguageModelToolCallPart: ToolPart,
		LanguageModelToolResultPart: ResultPart,
		LanguageModelDataPart: DataPart,
		LanguageModelChatMessage: {
			User: (content: string | unknown[]) => ({
				role: "user",
				content: typeof content === "string" ? [new TextPart(content)] : content,
			}),
			Assistant: (content: string | unknown[]) => ({
				role: "assistant",
				content: typeof content === "string" ? [new TextPart(content)] : content,
			}),
		},
		CancellationTokenSource,
	}
})

import * as vscode from "vscode"
import { OpenAiHandler } from "../openai"
import { OpenAiNativeHandler } from "../openai-native"
import { OpenAiCodexHandler } from "../openai-codex"
import { VsCodeLmHandler } from "../vscode-lm"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import type { ApiStream } from "../../transform/stream"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../../../core/task-persistence/apiMessages"
import { ProviderTranscriptStore } from "../../../core/task-persistence/ProviderTranscriptStore"

const model = "gpt-6.1-sol"
const tools = [
	{
		type: "function" as const,
		function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
	},
]
const initial: Anthropic.MessageParam = { role: "user", content: "Read the fixture." }
const receipt: ApiMessage = {
	role: "user",
	content: [{ type: "tool_result", tool_use_id: "read-call", content: "Fixture content." }],
}
const reasoning = { type: "reasoning", id: "rs_original", encrypted_content: "opaque+/=\r\n", summary: [] }
const message = {
	type: "message",
	id: "msg_original",
	role: "assistant",
	status: "completed",
	phase: "commentary",
	content: [{ type: "output_text", text: "Reading.", annotations: [] }],
}
const call = {
	type: "function_call",
	id: "fc_original",
	call_id: "read-call",
	name: "read_file",
	arguments: '{"path":"fixture.ts"}',
	status: "completed",
}

async function collect(stream: ApiStream) {
	const accumulator = new AgentResponseAccumulator()
	for await (const chunk of stream) await accumulator.add(chunk)
	return accumulator.finish()
}

function providerEvents(output: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const [output_index, item] of output.entries())
				yield { type: "response.output_item.done", output_index, item }
			yield {
				type: "response.completed",
				response: { id: "resp", status: "completed", output, usage: { input_tokens: 123, output_tokens: 7 } },
			}
		},
	}
}

function requestMessages(messages: ApiMessage[]): Anthropic.MessageParam[] {
	return messages.filter(
		(message): message is ApiMessage & Anthropic.MessageParam =>
			(message.role === "user" || message.role === "assistant") &&
			(typeof message.content === "string" || Array.isArray(message.content)),
	)
}

describe("provider continuity through a cold authoritative transcript", () => {
	let storage: string
	beforeEach(async () => {
		vi.clearAllMocks()
		mocks.clients.length = 0
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-continuity-"))
		mocks.authorize.mockResolvedValue({ accessToken: "initial-token", signal: new AbortController().signal })
	})
	afterEach(async () => fs.rm(storage, { recursive: true, force: true }))

	async function coldReload(messages: ApiMessage[]) {
		const authority = await saveApiMessages({ taskId: "continuity", globalStoragePath: storage, messages })
		await new ProviderTranscriptStore("continuity", storage).commitAuthoritativeTranscript(authority)
		const cold = await readApiMessages({ taskId: "continuity", globalStoragePath: storage })
		expect((await new ProviderTranscriptStore("continuity", storage).read()).messages).toEqual(messages)
		return requestMessages(cold)
	}

	it.each([
		{
			provider: "openai",
			factory: () =>
				new OpenAiHandler({
					openAiApiKey: "fixture",
					openAiBaseUrl: "https://api.openai.com/v1",
					openAiModelId: model,
				}),
		},
		{
			provider: "openai-native",
			factory: () => new OpenAiNativeHandler({ openAiNativeApiKey: "fixture", apiModelId: model }),
		},
		{ provider: "openai-codex", factory: () => new OpenAiCodexHandler({ apiModelId: model }) },
	])(
		"continues $provider using persisted conversation state rather than adapter memory",
		async ({ provider, factory }) => {
			mocks.responses
				.mockResolvedValueOnce(providerEvents([reasoning, message, call]))
				.mockResolvedValueOnce(providerEvents([]))
			const first = factory()
			const response = await collect(
				first.createMessage("Stable instructions", [initial], { taskId: "continuity", tools }),
			)
			expect(response.items.filter((item) => item.type !== "usage").map((item) => item.type)).toEqual([
				"reasoning",
				"text",
				"tool_call",
			])
			expect(response.items.filter((item) => item.type === "usage")).toEqual([
				expect.objectContaining({ inputTokens: 123, outputTokens: 7 }),
			])
			const restored = await coldReload([
				initial,
				{
					role: "assistant",
					content: buildCanonicalAssistantHistoryContent(response),
					agentResponseItems: response.items,
					provider_state_scope: { provider, modelId: model },
				},
				receipt,
			])
			const before = structuredClone(restored)
			mocks.authorize.mockResolvedValue({ accessToken: "rotated-token", signal: new AbortController().signal })
			const fresh = factory()
			expect(fresh.getReasoningItems()).toEqual([])
			await collect(fresh.createMessage("Stable instructions", restored, { taskId: "continuity", tools }))
			const input = mocks.responses.mock.calls[1]![0].input
			expect(input).toEqual([
				{ role: provider === "openai-codex" ? "developer" : "system", content: "Stable instructions" },
				{ role: "user", content: initial.content },
				{
					type: "reasoning",
					encrypted_content: reasoning.encrypted_content,
					summary: [],
					...(provider === "openai-codex" ? { id: reasoning.id } : {}),
				},
				message,
				{ ...call, ...(provider === "openai-codex" ? { namespace: "alpha" } : {}) },
				{ type: "function_call_output", call_id: "read-call", output: "Fixture content." },
			])
			expect(restored).toEqual(before)
			expect(mocks.responses).toHaveBeenCalledTimes(2)
			if (provider === "openai-codex") expect(mocks.clients[1]!.apiKey).toBe("rotated-token")
		},
	)

	it.each(["1.125.0", "1.141.0"])(
		"continues VS Code LM on host %s with original thinking, marker and paired tool state",
		async (version) => {
			mocks.host.version = version
			const client = {
				id: "opaque-host-route",
				vendor: "copilot",
				family: model,
				version: "build-1",
				name: model,
				maxInputTokens: 200_000,
				countTokens: vi.fn(),
				sendRequest: mocks.sendRequest,
			}
			mocks.selectChatModels.mockResolvedValue([client])
			const thinking = {
				value: "Inspecting.",
				id: "thinking-original",
				metadata: { encrypted_content: "host-opaque+/=", vscode_thinking_origin_api: "messages" },
			}
			const marker = new TextEncoder().encode("host-continuation")
			mocks.sendRequest
				.mockResolvedValueOnce({
					stream: (async function* () {
						yield thinking
						yield new vscode.LanguageModelTextPart("Reading.")
						yield new vscode.LanguageModelToolCallPart("read-call", "read_file", { path: "fixture.ts" })
						yield new vscode.LanguageModelDataPart(marker, "stateful_marker")
						yield new vscode.LanguageModelDataPart(
							new TextEncoder().encode(JSON.stringify({ prompt_tokens: 123, completion_tokens: 7 })),
							"usage",
						)
					})(),
				})
				.mockResolvedValueOnce({
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("Continued.")
					})(),
				})
			const first = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: client.vendor, id: client.id } })
			const fresh = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: client.vendor, id: client.id } })
			try {
				const response = await collect(
					first.createMessage("Stable instructions", [initial], { taskId: "continuity", tools }),
				)
				expect(response.items.filter((item) => item.type !== "usage").map((item) => item.type)).toEqual([
					"reasoning",
					"text",
					"tool_call",
				])
				expect(response.items.filter((item) => item.type === "usage")).toEqual([
					expect.objectContaining({ inputTokens: 123, outputTokens: 7 }),
				])
				// The host's existing persisted extension (vscode-lm.ts:229) is
				// additive to ApiMessage and uses no API beyond minimum host types.
				const assistant: ApiMessage & { vscodeLmStatefulMarker?: string } = {
					role: "assistant",
					content: buildCanonicalAssistantHistoryContent(response),
					agentResponseItems: response.items,
					vscodeLmStatefulMarker: first.getStatefulMarker(),
					provider_state_scope: { provider: "vscode-lm", modelId: client.id },
				}
				const restored = await coldReload([initial, assistant, receipt])
				first.dispose()
				await collect(fresh.createMessage("Stable instructions", restored, { taskId: "continuity", tools }))
				const input = mocks.sendRequest.mock.calls[1]![0]
				expect(input[2].content).toEqual([
					thinking,
					new vscode.LanguageModelTextPart("Reading."),
					new vscode.LanguageModelToolCallPart("read-call", "read_file", { path: "fixture.ts" }),
					new vscode.LanguageModelDataPart(Buffer.from(marker), "stateful_marker"),
				])
				expect(input[3].content[0]).toEqual(
					new vscode.LanguageModelToolResultPart("read-call", [
						new vscode.LanguageModelTextPart("Fixture content."),
					]),
				)
				expect(restored[1]).toHaveProperty("vscodeLmStatefulMarker", Buffer.from(marker).toString("base64"))
				expect(mocks.sendRequest).toHaveBeenCalledTimes(2)
			} finally {
				first.dispose()
				fresh.dispose()
			}
		},
	)
})
