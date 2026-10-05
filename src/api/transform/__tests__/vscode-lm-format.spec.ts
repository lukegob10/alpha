// npx vitest run src/api/transform/__tests__/vscode-lm-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { convertToVsCodeLmMessages, convertToAnthropicRole, extractTextCountFromMessage } from "../vscode-lm-format"

// Mock crypto using Vitest
vitest.stubGlobal("crypto", {
	randomUUID: () => "test-uuid",
})

// Define types for our mocked classes
interface MockLanguageModelTextPart {
	type: "text"
	value: string
}

interface MockLanguageModelToolCallPart {
	type: "tool_call"
	callId: string
	name: string
	input: any
}

interface MockLanguageModelToolResultPart {
	type: "tool_result"
	callId: string
	content: Array<MockLanguageModelTextPart | MockLanguageModelDataPart>
}

interface MockLanguageModelDataPart {
	type: "data"
	mimeType: string
	data: Uint8Array
}

// Mock vscode namespace
vitest.mock("vscode", () => {
	const LanguageModelChatMessageRole = {
		Assistant: "assistant",
		User: "user",
	}

	class MockLanguageModelTextPart {
		type = "text"
		constructor(public value: string) {}
	}

	class MockLanguageModelToolCallPart {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: any,
		) {}
	}

	class MockLanguageModelToolResultPart {
		type = "tool_result"
		constructor(
			public callId: string,
			public content: Array<MockLanguageModelTextPart | MockLanguageModelDataPart>,
		) {}
	}

	class MockLanguageModelDataPart {
		type = "data"
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}

		static image(data: Uint8Array, mimeType: string) {
			return new MockLanguageModelDataPart(data, mimeType)
		}
	}

	return {
		LanguageModelChatMessage: {
			Assistant: vitest.fn((content) => ({
				role: LanguageModelChatMessageRole.Assistant,
				name: "assistant",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
			User: vitest.fn((content) => ({
				role: LanguageModelChatMessageRole.User,
				name: "user",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
		},
		LanguageModelChatMessageRole,
		LanguageModelTextPart: MockLanguageModelTextPart,
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		LanguageModelDataPart: MockLanguageModelDataPart,
	}
})

describe("convertToVsCodeLmMessages", () => {
	it.each([null, undefined, "", []])(
		"replays a legacy terminal ID with raw patch input and empty output (%j)",
		(content) => {
			const patch =
				'*** Begin Patch\r\n*** Add File: file.txt\r\n+const path = "C:\\work\\file.txt"\r\n*** End Patch\n'
			const messages = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "patch-call", name: "apply_patch", input: patch }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_call_id: "patch-call",
							content,
							is_error: true,
							status: "cancelled",
						},
					],
				},
			] as unknown as Anthropic.Messages.MessageParam[]
			const before = structuredClone(messages)
			const result = convertToVsCodeLmMessages(messages)
			expect(result).toHaveLength(2)
			expect(result[0].content[0]).toMatchObject({
				type: "tool_call",
				callId: "patch-call",
				name: "apply_patch",
				input: { patch },
			})
			expect(result[1].content[0]).toMatchObject({ type: "tool_result", callId: "patch-call" })
			expect(messages).toEqual(before)
		},
	)

	it("should convert simple string messages", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(2)
		expect(result[0].role).toBe("user")
		expect((result[0].content[0] as MockLanguageModelTextPart).value).toBe("Hello")
		expect(result[1].role).toBe("assistant")
		expect((result[1].content[0] as MockLanguageModelTextPart).value).toBe("Hi there")
	})

	it("should handle complex user messages with tool results", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Here is the result:" },
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: "Tool output",
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(result[0].role).toBe("user")
		expect(result[0].content).toHaveLength(2)
		const [textContent, toolResult] = result[0].content as [
			MockLanguageModelTextPart,
			MockLanguageModelToolResultPart,
		]
		expect(textContent.type).toBe("text")
		expect(toolResult.type).toBe("tool_result")
	})

	it("should handle complex assistant messages with tool calls", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me help you with that." },
					{
						type: "tool_use",
						id: "tool-1",
						name: "calculator",
						input: { operation: "add", numbers: [2, 2] },
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		expect(result[0].role).toBe("assistant")
		expect(result[0].content).toHaveLength(2)
		// Keep the model's text and tool call in their original order.
		const [textContent, toolCall] = result[0].content as [MockLanguageModelTextPart, MockLanguageModelToolCallPart]
		expect(textContent.type).toBe("text")
		expect(toolCall.type).toBe("tool_call")
	})

	it("preserves ordered assistant parts around tool calls for continuation", () => {
		const result = convertToVsCodeLmMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Before" },
					{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.txt" } },
					{ type: "text", text: "After" },
					{ type: "tool_use", id: "tool-2", name: "read_file", input: { path: "b.txt" } },
				],
			},
		])

		expect(result[0].content).toMatchObject([
			{ type: "text", value: "Before" },
			{ type: "tool_call", callId: "tool-1", name: "read_file", input: { path: "a.txt" } },
			{ type: "text", value: "After" },
			{ type: "tool_call", callId: "tool-2", name: "read_file", input: { path: "b.txt" } },
		])
	})

	it("preserves ordered user parts around tool results for continuation", () => {
		const result = convertToVsCodeLmMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "First" },
					{ type: "tool_result", tool_use_id: "tool-1", content: "Output one" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
					{ type: "text", text: "Second" },
					{ type: "tool_result", tool_use_id: "tool-2", content: "Output two" },
				],
			},
		])

		expect(result[0].content).toMatchObject([
			{ type: "text", value: "First" },
			{ type: "tool_result", callId: "tool-1", content: [{ type: "text", value: "Output one" }] },
			{ type: "data", mimeType: "image/png", data: expect.any(Uint8Array) },
			{ type: "text", value: "Second" },
			{ type: "tool_result", callId: "tool-2", content: [{ type: "text", value: "Output two" }] },
		])
		expect(Array.from((result[0].content[2] as MockLanguageModelDataPart).data)).toEqual([104, 101, 108, 108, 111])
	})

	it("should convert base64 image blocks to VS Code data parts", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Look at this:" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "aGVsbG8=",
						},
					},
				],
			},
		]

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(1)
		const imagePart = result[0].content[1] as MockLanguageModelDataPart
		expect(imagePart.type).toBe("data")
		expect(imagePart.mimeType).toBe("image/png")
		expect(Array.from(imagePart.data)).toEqual([104, 101, 108, 108, 111])
	})
})

describe("convertToAnthropicRole", () => {
	it("should convert assistant role correctly", () => {
		const result = convertToAnthropicRole("assistant" as any)
		expect(result).toBe("assistant")
	})

	it("should convert user role correctly", () => {
		const result = convertToAnthropicRole("user" as any)
		expect(result).toBe("user")
	})

	it("should return null for unknown roles", () => {
		const result = convertToAnthropicRole("unknown" as any)
		expect(result).toBeNull()
	})
})

describe("extractTextCountFromMessage", () => {
	it("should extract text from simple string content", () => {
		const message = {
			role: "user",
			content: "Hello world",
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("Hello world")
	})

	it("should extract text from LanguageModelTextPart", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Text content")
		const message = {
			role: "user",
			content: [mockTextPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("Text content")
	})

	it("should extract text from structurally compatible text parts", () => {
		const message = {
			role: "user",
			content: [{ value: "Text content" }],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("Text content")
	})

	it("should extract text from multiple LanguageModelTextParts", () => {
		const mockTextPart1 = new (vitest.mocked(vscode).LanguageModelTextPart)("First part")
		const mockTextPart2 = new (vitest.mocked(vscode).LanguageModelTextPart)("Second part")
		const message = {
			role: "user",
			content: [mockTextPart1, mockTextPart2],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("First partSecond part")
	})

	it("should extract text from LanguageModelToolResultPart", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Tool result content")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("tool-result-id", [
			mockTextPart,
		])
		const message = {
			role: "user",
			content: [mockToolResultPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-result-idTool result content")
	})

	it("should extract text from structurally compatible tool result parts", () => {
		const message = {
			role: "user",
			content: [
				{
					callId: "tool-result-id",
					content: [{ value: "Tool result content" }],
				},
			],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-result-idTool result content")
	})

	it("should extract text from LanguageModelToolCallPart without input", () => {
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool-name", {})
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-namecall-id")
	})

	it("should extract text from LanguageModelToolCallPart with input", () => {
		const mockInput = { operation: "add", numbers: [1, 2, 3] }
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)(
			"call-id",
			"calculator",
			mockInput,
		)
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe(`calculatorcall-id${JSON.stringify(mockInput)}`)
	})

	it("should extract text from structurally compatible tool call parts", () => {
		const mockInput = { operation: "add", numbers: [1, 2, 3] }
		const message = {
			role: "assistant",
			content: [{ callId: "call-id", name: "calculator", input: mockInput }],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe(`calculatorcall-id${JSON.stringify(mockInput)}`)
	})

	it("should extract text from LanguageModelToolCallPart with empty input", () => {
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool-name", {})
		const message = {
			role: "assistant",
			content: [mockToolCallPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("tool-namecall-id")
	})

	it("should extract text from mixed content types", () => {
		const mockTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Text content")
		const mockToolResultTextPart = new (vitest.mocked(vscode).LanguageModelTextPart)("Tool result")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [
			mockToolResultTextPart,
		])
		const mockInput = { param: "value" }
		const mockToolCallPart = new (vitest.mocked(vscode).LanguageModelToolCallPart)("call-id", "tool", mockInput)

		const message = {
			role: "assistant",
			content: [mockTextPart, mockToolResultPart, mockToolCallPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe(`Text contentresult-idTool resulttoolcall-id${JSON.stringify(mockInput)}`)
	})

	it("should handle empty array content", () => {
		const message = {
			role: "user",
			content: [],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("")
	})

	it("should handle undefined content", () => {
		const message = {
			role: "user",
			content: undefined,
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("")
	})

	it("should handle ToolResultPart with multiple text parts", () => {
		const mockTextPart1 = new (vitest.mocked(vscode).LanguageModelTextPart)("Part 1")
		const mockTextPart2 = new (vitest.mocked(vscode).LanguageModelTextPart)("Part 2")
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [
			mockTextPart1,
			mockTextPart2,
		])

		const message = {
			role: "user",
			content: [mockToolResultPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("result-idPart 1Part 2")
	})

	it("should handle ToolResultPart with empty parts array", () => {
		const mockToolResultPart = new (vitest.mocked(vscode).LanguageModelToolResultPart)("result-id", [])

		const message = {
			role: "user",
			content: [mockToolResultPart],
		} as any

		const result = extractTextCountFromMessage(message)
		expect(result).toBe("result-id")
	})
})
