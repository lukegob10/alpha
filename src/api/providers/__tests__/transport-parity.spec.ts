import type { Anthropic } from "@anthropic-ai/sdk"
import type * as vscode from "vscode"
import { SYSTEM_PROMPT } from "../../../core/prompts/system"
import { resolveCodexModelPrompt } from "../../../core/prompts/codex-model-instructions"
import { getNativeTools } from "../../../core/prompts/tools/native-tools"
import { OpenAiHandler } from "../openai"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { VertexHandler } from "../vertex"
import { VsCodeLmHandler } from "../vscode-lm"

const { openAiCreate, anthropicCreate, geminiCreate, sendRequest } = vi.hoisted(() => ({
	openAiCreate: vi.fn(),
	anthropicCreate: vi.fn(),
	geminiCreate: vi.fn(),
	sendRequest: vi.fn(),
}))

vi.mock("openai", () => ({
	default: vi.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}))
vi.mock("@anthropic-ai/vertex-sdk", () => ({ AnthropicVertex: vi.fn() }))
vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: () => ({}) } }))
vi.mock("vscode", () => {
	class TextPart {
		constructor(public value: string) {}
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
		static image(data: Uint8Array, mimeType: string) {
			return new DataPart(data, mimeType)
		}
	}
	return {
		version: "1.125.0",
		env: { language: "en" },
		workspace: {
			getConfiguration: () => ({ get: () => undefined }),
			onDidChangeConfiguration: () => ({ dispose() {} }),
			workspaceFolders: [],
		},
		window: { activeTextEditor: undefined },
		CancellationTokenSource: class {
			token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
			cancel() {}
			dispose() {}
		},
		CancellationError: class extends Error {},
		LanguageModelTextPart: TextPart,
		LanguageModelToolCallPart: ToolCallPart,
		LanguageModelToolResultPart: ToolResultPart,
		LanguageModelDataPart: DataPart,
		LanguageModelChatMessage: {
			User: (content: unknown) => ({
				role: "user",
				content: Array.isArray(content) ? content : [new TextPart(content as string)],
			}),
			Assistant: (content: unknown) => ({
				role: "assistant",
				content: Array.isArray(content) ? content : [new TextPart(content as string)],
			}),
		},
		lm: {
			selectChatModels: async () => [
				{
					id: "copilot-gpt",
					name: "GPT",
					vendor: "copilot",
					family: "gpt",
					version: "1",
					maxInputTokens: 8192,
					sendRequest,
					countTokens: async () => 1,
				},
			],
			onDidChangeChatModels: () => ({ dispose() {} }),
		},
	}
})

describe("assembled prompt and native tool transport", () => {
	// Reference: Codex CLI e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1, codex-rs/core/src/client.rs:
	// base instructions and the captured tool catalog are separate request inputs.
	const tool = getNativeTools().find(
		(candidate) => "function" in candidate && candidate.function.name === "exec_command",
	)!
	const messages: Anthropic.Messages.MessageParam[] = [
		{ role: "user", content: "Read a.ts" },
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "call-1", name: "exec_command", input: { cmd: "Get-Content a.ts" } }],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] },
	]
	const roleAwareInstructionFragments = [
		{ role: "developer", origin: "codex-model-instructions", content: "Codex model rules.\n\n" },
		{ role: "user", origin: "agent-rules", content: "Project convention.\n\n" },
		{ role: "developer", origin: "alpha-feature-overlay", content: "Alpha tool policy." },
	] as const
	let prompt: string

	beforeAll(async () => {
		prompt = await SYSTEM_PROMPT(
			{} as vscode.ExtensionContext,
			"C:\\workspace",
			false,
			undefined,
			undefined,
			"code",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				todoListEnabled: false,
				useAgentRules: false,
				newTaskRequireTodos: false,
				subagentRole: "worker",
				subagentUsesFrozenContext: true,
				subagentFrozenInstructions: "Project rules apply.",
			},
			undefined,
			"gpt-6-sol",
		)
		expect(prompt).toContain(resolveCodexModelPrompt("gpt-6-sol").instructions)
		expect(prompt).toContain("Project rules apply.")
		expect(prompt).toContain("CAPABILITIES")
	})

	beforeEach(() => {
		openAiCreate.mockReset()
		anthropicCreate.mockReset()
		geminiCreate.mockReset()
		sendRequest.mockReset()
	})

	it("OpenAI sends the assembled instructions and ordered tool transaction", async () => {
		openAiCreate.mockResolvedValue({ choices: [{ message: { content: "done" } }] })
		const handler = new OpenAiHandler({ openAiModelId: "gpt-4", openAiStreamingEnabled: false })
		for await (const _chunk of handler.createMessage(prompt, messages, { taskId: "parity", tools: [tool] })) {
		}
		const request = openAiCreate.mock.calls[0][0]
		expect(request.messages[0]).toMatchObject({ role: "system", content: prompt })
		expect(request.messages.slice(2)).toEqual([
			expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] }),
			expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: "file contents" }),
		])
		expect(request.tools[0].function.name).toBe("exec_command")
	})

	it("Anthropic Vertex sends the same instructions with native tool use and result", async () => {
		anthropicCreate.mockResolvedValue({
			content: [{ type: "text", text: "done" }],
			usage: { input_tokens: 1, output_tokens: 1 },
		})
		const handler = new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "test",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: false,
		})
		;(handler as unknown as { directClient: unknown }).directClient = { messages: { create: anthropicCreate } }
		for await (const _chunk of handler.createMessage(prompt, messages, { taskId: "parity", tools: [tool] })) {
		}
		const request = anthropicCreate.mock.calls[0][0]
		expect(request.system).toEqual([expect.objectContaining({ type: "text", text: prompt })])
		expect(request.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "call-1", name: "exec_command" })
		expect(request.messages[2].content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call-1",
			content: "file contents",
		})
		expect(request.tools[0].name).toBe("exec_command")
	})

	it("Anthropic Vertex keeps project instructions in user context", async () => {
		anthropicCreate.mockResolvedValue({
			content: [{ type: "text", text: "done" }],
			usage: { input_tokens: 1, output_tokens: 1 },
		})
		const handler = new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "test",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: false,
		})
		;(handler as unknown as { directClient: unknown }).directClient = { messages: { create: anthropicCreate } }
		const systemPrompt = roleAwareInstructionFragments.map(({ content }) => content).join("")
		for await (const _chunk of handler.createMessage(systemPrompt, messages, {
			taskId: "role-aware-anthropic",
			instructionFragments: roleAwareInstructionFragments,
		})) {
		}

		const request = anthropicCreate.mock.calls[0][0]
		const systemText = Array.isArray(request.system)
			? request.system.map((block: { text: string }) => block.text).join("")
			: request.system
		const firstUserMessageText = JSON.stringify(request.messages[0].content)

		expect(systemText).toBe("Codex model rules.\n\nAlpha tool policy.")
		expect(systemText).not.toContain("Project convention.")
		expect(firstUserMessageText).toContain("Project convention.")
		expect(firstUserMessageText).toContain("Read a.ts")
	})

	it("Gemini Vertex sends the same instructions with matching function IDs", async () => {
		geminiCreate.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "done" }] } }] })
		const handler = new VertexHandler({
			apiModelId: "gemini-3.5-flash",
			vertexProjectId: "test",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: false,
		})
		;(handler as unknown as { client: unknown }).client = { models: { generateContent: geminiCreate } }
		for await (const _chunk of handler.createMessage(prompt, messages, { taskId: "parity", tools: [tool] })) {
		}
		const request = geminiCreate.mock.calls[0][0]
		expect(request.config.systemInstruction).toBe(prompt)
		expect(request.contents[1].parts[0].functionCall).toMatchObject({ id: "call-1", name: "exec_command" })
		expect(request.contents[2].parts[0].functionResponse).toMatchObject({ id: "call-1", name: "exec_command" })
		expect(request.config.tools[0].functionDeclarations[0].name).toBe("exec_command")
	})

	it("Gemini Vertex keeps project instructions in user context", async () => {
		geminiCreate.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "done" }] } }] })
		const handler = new VertexHandler({
			apiModelId: "gemini-3.5-flash",
			vertexProjectId: "test",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: false,
		})
		;(handler as unknown as { client: unknown }).client = { models: { generateContent: geminiCreate } }
		const systemPrompt = roleAwareInstructionFragments.map(({ content }) => content).join("")
		for await (const _chunk of handler.createMessage(systemPrompt, messages, {
			taskId: "role-aware-gemini",
			instructionFragments: roleAwareInstructionFragments,
		})) {
		}

		const request = geminiCreate.mock.calls[0][0]
		const firstUserMessage = request.contents[0]
		const firstUserMessageText = firstUserMessage.parts.map((part: { text?: string }) => part.text ?? "").join("")

		expect(request.config.systemInstruction).toBe("Codex model rules.\n\nAlpha tool policy.")
		expect(firstUserMessage.role).toBe("user")
		expect(firstUserMessageText).toContain("Project convention.")
		expect(firstUserMessageText).toContain("Read a.ts")
	})

	it("keeps a historical Vertex model ID while using the current fallback tool schema", async () => {
		geminiCreate.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "done" }] } }] })
		const handler = new VertexHandler({
			apiModelId: "gemini-2.5-pro",
			vertexProjectId: "test",
			vertexRegion: "us-central1",
			vertexStreamingEnabled: false,
		})
		;(handler as unknown as { client: unknown }).client = { models: { generateContent: geminiCreate } }
		for await (const _chunk of handler.createMessage(prompt, messages, { taskId: "historical", tools: [tool] })) {
		}
		const request = geminiCreate.mock.calls[0][0]
		expect(request.model).toBe("gemini-2.5-pro")
		expect(request.config.tools[0].functionDeclarations[0]).toHaveProperty("parametersJsonSchema")
		expect(request.contents[2].parts[0].functionResponse.id).toBe("call-1")
		// The mock proves Alpha's serialized request shape; only a live historical Vertex endpoint can validate acceptance.
	})

	it("VS Code 1.125.0 uses its User constructor for instructions and preserves the tool ID", async () => {
		sendRequest.mockResolvedValue({
			stream: {
				async *[Symbol.asyncIterator]() {
					yield { value: "done" }
				},
			},
		})
		const handler = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: "copilot", family: "gpt" } })
		for await (const _chunk of handler.createMessage(prompt, messages, { taskId: "parity", tools: [tool] })) {
		}
		const [requestMessages, requestOptions] = sendRequest.mock.calls[0]
		expect(requestMessages[0]).toMatchObject({
			role: "user",
			content: [expect.objectContaining({ value: prompt })],
		})
		expect(requestMessages[2].content[0]).toMatchObject({ callId: "call-1", name: "exec_command" })
		expect(requestMessages[3].content[0]).toMatchObject({
			callId: "call-1",
			content: [expect.objectContaining({ value: "file contents" })],
		})
		expect(requestOptions.tools[0].name).toBe("exec_command")
	})
})
