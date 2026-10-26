import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { host, sendRequest, selectChatModels } = vi.hoisted(() => ({
	host: { version: "1.138.0", thinkingAvailable: true },
	sendRequest: vi.fn(),
	selectChatModels: vi.fn(),
}))

vi.mock("vscode", () => {
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
	class ToolCallPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class ToolResultPart {
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
		get version() {
			return host.version
		},
		workspace: {
			onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
			getConfiguration: () => ({ get: () => 600 }),
		},
		lm: { selectChatModels, onDidChangeChatModels: vi.fn(() => ({ dispose() {} })) },
		LanguageModelTextPart: TextPart,
		get LanguageModelThinkingPart() {
			return host.thinkingAvailable ? ThinkingPart : undefined
		},
		LanguageModelToolCallPart: ToolCallPart,
		LanguageModelToolResultPart: ToolResultPart,
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
		CancellationError: class extends Error {},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler } from "../vscode-lm"
import { collectAgentResponse } from "../../../core/agent/AgentTurnEngine"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"

const families = [
	{ family: "claude-opus-4.6", name: "Claude Opus 4.6", effortSupported: true },
	{ family: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", effortSupported: true },
	{ family: "claude-haiku-4.5", name: "Claude Haiku 4.5", effortSupported: false },
	{ family: "claude-opus-5.5", name: "Claude Opus 5.5", effortSupported: true },
	{ family: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", effortSupported: true },
	{ family: "claude-haiku-5.5", name: "Claude Haiku 5.5", effortSupported: true },
] as const

function claudeClient(family: string, name = family) {
	return {
		id: "opaque-copilot-route",
		vendor: "copilot",
		family,
		name,
		version: "provider-build-1",
		maxInputTokens: 200_000,
		countTokens: vi.fn(),
		sendRequest,
	}
}

const tools = [
	{
		type: "function" as const,
		function: {
			name: "exec_command",
			parameters: { type: "object", properties: { cmd: { type: "string" } } },
		},
	},
]

describe.each(["1.125.0", "1.138.0"])("Claude Copilot streaming on VS Code %s", (version) => {
	let handler: VsCodeLmHandler | undefined

	beforeEach(() => {
		vi.clearAllMocks()
		host.version = version
		host.thinkingAvailable = true
	})

	afterEach(() => {
		vi.mocked(vscode.lm.onDidChangeChatModels).mock.calls[0]?.[0]()
		handler?.dispose()
		handler = undefined
	})

	it.each(families)(
		"preserves $family signed thinking, ordered tools, and provider usage through canonical accumulation",
		async ({ family, name, effortSupported }) => {
			// Copilot route IDs are opaque; Claude capabilities come from the selected model's family.
			const client = claudeClient(family, name)
			selectChatModels.mockResolvedValue([client])
			const origin = { vscode_thinking_origin_api: "messages" }
			const thinking = { value: ["Inspect both", "requested files"], id: "thinking-1", metadata: origin }
			// Native Copilot carries Claude signatures in its opaque reasoning envelope.
			// Verified 2026-10-25 at microsoft/vscode@4f383697191fef7129052d5396d5709d5799934a.
			const signed = {
				value: "",
				id: "thinking-1",
				metadata: { encrypted_content: "opaque-claude-envelope", ...origin },
			}
			const done = { value: "", id: "", metadata: { vscode_reasoning_done: true, ...origin } }
			const firstInput = { cmd: 'node inspect.cjs "résumé.txt"' }
			const secondInput = { cmd: "node verify.cjs" }
			const marker = new TextEncoder().encode("opaque-claude-continuation")
			sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield thinking
					yield signed
					yield done
					yield new vscode.LanguageModelTextPart("Inspecting both files.")
					yield new vscode.LanguageModelToolCallPart("toolu_01_first", "exec_command", firstInput)
					yield new vscode.LanguageModelTextPart("Then checking the result.")
					yield new vscode.LanguageModelToolCallPart("toolu_01_second", "exec_command", secondInput)
					yield new vscode.LanguageModelDataPart(marker, "stateful_marker")
					yield new vscode.LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify({ prompt_tokens: 700, completion_tokens: 41 })),
						"usage",
					)
				})(),
			})
			handler = new VsCodeLmHandler({
				vsCodeLmModelSelector: { vendor: "copilot", id: client.id },
				enableReasoningEffort: true,
				reasoningEffort: "high",
			})

			const response = await collectAgentResponse(
				handler.createMessage(
					"Inspect the requested files.",
					[{ role: "user", content: "Check both files." }],
					{
						taskId: "claude-stream-contract",
						tools,
					},
				),
			)

			const provenance = { modelId: client.id, modelVendor: client.vendor, modelVersion: client.version }
			expect(response.items).toEqual([
				{
					type: "reasoning",
					text: "Inspect both\nrequested files",
					vscodeLmThinking: { ...thinking, ...provenance },
				},
				{ type: "reasoning", text: "", vscodeLmThinking: { ...signed, ...provenance } },
				{ type: "reasoning", text: "", vscodeLmThinking: { ...done, ...provenance } },
				{ type: "text", text: "Inspecting both files." },
				{ type: "tool_call", id: "toolu_01_first", name: "exec_command", arguments: firstInput },
				{ type: "text", text: "Then checking the result." },
				{ type: "tool_call", id: "toolu_01_second", name: "exec_command", arguments: secondInput },
				{ type: "usage", inputTokens: 700, outputTokens: 41 },
			])
			expect(response.text).toBe("Inspecting both files.Then checking the result.")
			expect(response.toolCalls.map(({ id }) => id)).toEqual(["toolu_01_first", "toolu_01_second"])
			expect(handler.getStatefulMarker()).toBe(Buffer.from(marker).toString("base64"))
			expect(client.countTokens).not.toHaveBeenCalled()
			expect(selectChatModels).toHaveBeenCalledWith({ vendor: "copilot", id: client.id })
			const requestOptions = sendRequest.mock.calls[0]![1]
			if (effortSupported) {
				expect(requestOptions.modelOptions).toEqual({
					reasoningEffort: "high",
					...(version === "1.138.0" ? { _enableThinking: true } : {}),
				})
			} else {
				expect(requestOptions.modelOptions).toBeUndefined()
			}
		},
	)

	it.each(["default", "disabled"])(
		"requests and replays native Claude opaque state with %s effort settings",
		async (effort) => {
			const client = claudeClient("claude-sonnet-5.5")
			selectChatModels.mockResolvedValue([client])
			const metadata = { encrypted_content: "opaque-claude-envelope", vscode_thinking_origin_api: "messages" }
			sendRequest.mockImplementationOnce(
				(_messages: unknown, options: { includeEncryptedThinking?: boolean }) => ({
					stream: (async function* () {
						yield {
							value: "Inspecting the file",
							id: "thinking-1",
							metadata: { vscode_thinking_origin_api: "messages" },
						}
						// Native Copilot deliberately omits this replay state unless the caller requests it.
						if (options.includeEncryptedThinking) yield { value: "", id: "thinking-1", metadata }
						yield {
							value: "",
							id: "",
							metadata: { vscode_reasoning_done: true, vscode_thinking_origin_api: "messages" },
						}
						yield new vscode.LanguageModelToolCallPart("toolu_01_read", "exec_command", {
							cmd: "node inspect.cjs",
						})
					})(),
				}),
			)
			handler = new VsCodeLmHandler({
				vsCodeLmModelSelector: { vendor: client.vendor, id: client.id },
				...(effort === "disabled" ? { enableReasoningEffort: false, reasoningEffort: "disable" as const } : {}),
			})
			const first = await collectAgentResponse(
				handler.createMessage("Inspect the file.", [{ role: "user", content: "Inspect the file." }], {
					taskId: "claude-native-replay-contract",
					tools,
				}),
			)
			expect(first.items).toContainEqual({
				type: "reasoning",
				text: "",
				vscodeLmThinking: {
					value: "",
					id: "thinking-1",
					metadata,
					modelId: client.id,
					modelVendor: client.vendor,
					modelVersion: client.version,
				},
			})
			expect(sendRequest.mock.calls[0]![1]).toMatchObject({ includeEncryptedThinking: true })
			expect(sendRequest.mock.calls[0]![1].modelOptions).toBeUndefined()

			sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Verified.")
				})(),
			})
			const savedContent = structuredClone(buildCanonicalAssistantHistoryContent(first))
			const second = await collectAgentResponse(
				handler.createMessage(
					"Inspect the file.",
					[
						{ role: "user", content: "Inspect the file." },
						{ role: "assistant", content: savedContent },
						{
							role: "user",
							content: [{ type: "tool_result", tool_use_id: "toolu_01_read", content: "Verified file." }],
						},
					],
					{ taskId: "claude-native-replay-contract", tools },
				),
			)
			const projected = sendRequest.mock.calls[1]![0] as vscode.LanguageModelChatMessage[]
			const assistant = projected.find((message) => String(message.role) === "assistant")
			expect(assistant?.content).toContainEqual(
				expect.objectContaining({ value: "", id: "thinking-1", metadata }),
			)
			expect(projected.at(-1)?.content).toContainEqual(expect.objectContaining({ callId: "toolu_01_read" }))
			expect(sendRequest.mock.calls[1]![1]).toMatchObject({ includeEncryptedThinking: true })
			expect(second.text).toBe("Verified.")
		},
	)

	it("retains ordinary Claude streaming when optional thinking reconstruction is unavailable", async () => {
		host.thinkingAvailable = false
		const client = claudeClient("claude-sonnet-5.5")
		selectChatModels.mockResolvedValue([client])
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Verified.")
			})(),
		})
		handler = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: client.vendor, id: client.id } })
		const response = await collectAgentResponse(
			handler.createMessage("Inspect the file.", [{ role: "user", content: "Inspect the file." }]),
		)
		expect(sendRequest.mock.calls[0]![1]).not.toHaveProperty("includeEncryptedThinking")
		expect(response.text).toBe("Verified.")
	})
})
