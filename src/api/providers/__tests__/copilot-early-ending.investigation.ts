import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiStreamChunk } from "../../transform/stream"
import { AgentTurnEngine, collectAgentResponse } from "../../../core/agent/AgentTurnEngine"

const { sendRequest, selectChatModels } = vi.hoisted(() => ({
	sendRequest: vi.fn(),
	selectChatModels: vi.fn(),
}))

vi.mock("vscode", () => {
	class TextPart {
		constructor(public value: string) {}
	}
	class ToolPart {
		constructor(
			public callId: string,
			public name: string,
			public input: unknown,
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
		static image(data: Uint8Array, mimeType: string) {
			return new DataPart(data, mimeType)
		}
	}
	return {
		version: "1.135.0",
		workspace: {
			onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
			getConfiguration: vi.fn(() => ({ get: vi.fn(() => 600) })),
		},
		lm: { selectChatModels, onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })) },
		CancellationTokenSource: class {
			token = { isCancellationRequested: false, onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })) }
			cancel() {
				this.token.isCancellationRequested = true
			}
			dispose() {}
		},
		CancellationError: class extends Error {},
		LanguageModelTextPart: TextPart,
		LanguageModelToolCallPart: ToolPart,
		LanguageModelToolResultPart: ResultPart,
		LanguageModelDataPart: DataPart,
		LanguageModelChatMessage: {
			User: (content: string | unknown[]) => ({
				role: "user",
				content: Array.isArray(content) ? content : [new TextPart(content)],
			}),
			Assistant: (content: string | unknown[]) => ({
				role: "assistant",
				content: Array.isArray(content) ? content : [new TextPart(content)],
			}),
		},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler } from "../vscode-lm"

const client = {
	id: "copilot-gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	vendor: "copilot",
	family: "gpt-5.6-sol",
	version: "gpt-5.6-sol",
	maxInputTokens: 921_793,
	sendRequest,
	countTokens: vi.fn(),
}
const tools = [
	{
		type: "function" as const,
		function: { name: "apply_patch", parameters: { type: "object", properties: { patch: { type: "string" } } } },
	},
]
const input: Anthropic.Messages.MessageParam[] = [
	{ role: "user", content: "Implement the complete specification, including all remaining requirements." },
]
let handler: VsCodeLmHandler

async function observe(stream: AsyncGenerator<ApiStreamChunk>) {
	const response = await collectAgentResponse(stream)
	const result = await new AgentTurnEngine<string>({
		shouldAbort: () => false,
		runStep: async () => ({ response, nextInput: "complete" }),
	}).run("initial")
	return { response, result }
}

describe("Copilot GPT-5.6 early-ending investigation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		selectChatModels.mockResolvedValue([client])
		handler = new VsCodeLmHandler({
			vsCodeLmModelSelector: { vendor: client.vendor, family: client.family, id: client.id },
		})
	})
	afterEach(() => handler.dispose())

	it.each(["missing-id", "missing-name", "null-input", "unserializable-input"])(
		"recognized %s tool intent following visible text cannot complete the turn",
		async (variant) => {
			const circular: Record<string, unknown> = {}
			circular.self = circular
			const part = new vscode.LanguageModelToolCallPart(
				variant === "missing-id" ? "" : "call-1",
				variant === "missing-name" ? "" : "apply_patch",
				(variant === "null-input"
					? null
					: variant === "unserializable-input"
						? circular
						: { patch: "remaining work" }) as object,
			)
			sendRequest.mockResolvedValue({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Implemented the first ten requirements; now continuing.")
					yield part
				})(),
			})
			const { response, result } = await observe(
				handler.createMessage("Complete all authorized work.", input, {
					taskId: "copilot-investigation",
					tools,
				}),
			)
			expect(response.text).toContain("first ten requirements")
			expect(result.status).not.toBe("completed")
		},
	)

	it("preserves the full long specification and instruction fragments on the host request", async () => {
		const spec = "Requirement 1. ".repeat(30_000) + "FINAL_REQUIREMENT_100_SENTINEL"
		sendRequest.mockResolvedValue({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Implemented ten requirements.")
			})(),
		})
		await observe(
			handler.createMessage(
				"unused flattened prompt",
				[{ role: "user", content: [{ type: "text", text: `<user_message>${spec}</user_message>` }] }],
				{
					taskId: "long-spec",
					tools,
					instructionFragments: [
						{ role: "developer", origin: "codex-model-instructions", content: "Complete the full scope." },
						{ role: "user", origin: "project-rules", content: " Preserve acceptance checks." },
					],
				},
			),
		)
		const messages = sendRequest.mock.calls[0]![0] as vscode.LanguageModelChatMessage[]
		expect((messages[0]!.content[0] as vscode.LanguageModelTextPart).value).toBe(
			"Complete the full scope. Preserve acceptance checks.",
		)
		expect((messages[1]!.content[0] as vscode.LanguageModelTextPart).value).toBe(
			`<user_message>${spec}</user_message>`,
		)
		expect(handler.getModel().id).toBe(client.id)
		expect(handler.getModel().info.contextWindow).toBe(272_000)
		expect(handler.getModel().info.contextWindowIncludesOutput).toBe(false)
		expect(sendRequest.mock.calls[0]![1]).not.toHaveProperty("maxOutputTokens")
	})

	it("keeps valid text-before-tool, exact call identity, continuation history, and opaque state", async () => {
		const marker = new TextEncoder().encode("opaque-copilot-state")
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Now implementing remaining requirements.")
				yield new vscode.LanguageModelToolCallPart("call-valid", "apply_patch", { patch: "remaining work" })
				yield { mimeType: "stateful_marker", data: marker }
				yield {
					mimeType: "usage",
					data: new TextEncoder().encode(JSON.stringify({ prompt_tokens: 123, completion_tokens: 45 })),
				}
			})(),
		})
		const first = await collectAgentResponse(
			handler.createMessage("Complete all work.", input, { taskId: "valid-tools", tools }),
		)
		expect(first.text).toContain("remaining requirements")
		expect(first.toolCalls).toEqual([
			{ type: "tool_call", id: "call-valid", name: "apply_patch", arguments: { patch: "remaining work" } },
		])
		const state = handler.getStatefulMarker()
		expect(state).toBe(Buffer.from(marker).toString("base64"))
		const continuation = [
			...input,
			{
				role: "assistant",
				content: [
					{ type: "text", text: first.text },
					{ type: "tool_use", id: "call-valid", name: "apply_patch", input: { patch: "remaining work" } },
				],
				vscodeLmStatefulMarker: state,
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-valid", content: "Patch applied." }] },
		] as Anthropic.Messages.MessageParam[]
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("All requirements implemented.")
			})(),
		})
		const second = await collectAgentResponse(
			handler.createMessage("Complete all work.", continuation, { taskId: "valid-tools", tools }),
		)
		const messages = sendRequest.mock.calls[1]![0] as vscode.LanguageModelChatMessage[]
		expect(messages[2]!.content).toContainEqual(
			expect.objectContaining({ callId: "call-valid", name: "apply_patch" }),
		)
		expect(messages[2]!.content).toContainEqual(
			expect.objectContaining({ mimeType: "stateful_marker", data: marker }),
		)
		expect(messages[3]!.content).toContainEqual(expect.objectContaining({ callId: "call-valid" }))
		expect(second.text).toBe("All requirements implemented.")
	})

	it("propagates a host iterator error after partial text instead of converting it into completion", async () => {
		sendRequest.mockResolvedValue({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Partial implementation.")
				throw new Error("Host stream failed")
			})(),
		})
		await expect(
			observe(handler.createMessage("Complete all work.", input, { taskId: "host-error", tools })),
		).rejects.toThrow("Host stream failed")
	})

	it("ordinary visible host text followed by clean EOF is the current completion boundary", async () => {
		sendRequest.mockResolvedValue({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Implemented ten requirements; additional work remains.")
			})(),
		})
		const { result } = await observe(
			handler.createMessage("Complete all work.", input, { taskId: "normal-eof", tools }),
		)
		expect(result.status).toBe("completed")
	})
})
