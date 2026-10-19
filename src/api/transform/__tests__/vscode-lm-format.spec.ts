// npx vitest run src/api/transform/__tests__/vscode-lm-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import type { VscodeLmThinking } from "@alpha-code/types"

import { convertToVsCodeLmMessages, extractTextCountFromMessage } from "../vscode-lm-format"

const thinkingPartMock = vitest.hoisted(() => ({ enabled: true }))

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

	class MockLanguageModelThinkingPart {
		type = "thinking"
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
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
			Assistant: vitest.fn(function (content) {
				return {
					role: LanguageModelChatMessageRole.Assistant,
					name: "assistant",
					content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
				}
			}),
			User: vitest.fn(function (content) {
				return {
					role: LanguageModelChatMessageRole.User,
					name: "user",
					content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
				}
			}),
		},
		LanguageModelChatMessageRole,
		LanguageModelTextPart: MockLanguageModelTextPart,
		get LanguageModelThinkingPart() {
			return thinkingPartMock.enabled ? MockLanguageModelThinkingPart : undefined
		},
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		LanguageModelDataPart: MockLanguageModelDataPart,
	}
})

describe("convertToVsCodeLmMessages", () => {
	afterEach(() => {
		thinkingPartMock.enabled = true
	})

	it("replays exact VS Code thinking parts in order with assistant text and tool calls", () => {
		const firstThinking = {
			type: "vscode_lm_thinking",
			value: "Inspecting the file",
			id: "thinking-1",
			metadata: { signature: "opaque-signature", provider: { state: [1, true, null] } },
		}
		const secondThinking = {
			type: "vscode_lm_thinking",
			value: ["Checking the result", "Planning the next step"],
			id: "thinking-2",
			metadata: { encrypted: "opaque-state" },
		}
		const messages = [
			{
				role: "assistant",
				content: [
					firstThinking,
					{ type: "text", text: "Before the tool" },
					{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
					secondThinking,
					{ type: "text", text: "After the tool" },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: "File contents" }],
			},
		] as unknown as Anthropic.Messages.MessageParam[]
		const before = structuredClone(messages)

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(2)
		expect(result[0].content).toEqual([
			{ ...firstThinking, type: "thinking" },
			new vscode.LanguageModelTextPart("Before the tool"),
			new vscode.LanguageModelToolCallPart("tool-1", "read_file", { path: "README.md" }),
			{ ...secondThinking, type: "thinking" },
			new vscode.LanguageModelTextPart("After the tool"),
		])
		expect(result[1].content).toEqual([
			new vscode.LanguageModelToolResultPart("tool-1", [new vscode.LanguageModelTextPart("File contents")]),
		])
		expect(messages).toEqual(before)
	})

	it.each([{ value: "" }, { value: [] }])(
		"replays metadata-only VS Code thinking with empty value %j",
		({ value }) => {
			const metadata = { signature: "opaque-signature", continuation: { token: "opaque-token" } }
			const result = convertToVsCodeLmMessages([
				{
					role: "assistant",
					content: [{ type: "vscode_lm_thinking", value, metadata }],
				},
			] as unknown as Anthropic.Messages.MessageParam[])

			expect(result[0].content).toEqual([{ type: "thinking", value, id: undefined, metadata }])
		},
	)

	it("snapshots thinking arrays and nested metadata independently for every replay", () => {
		const value = ["First", "Second"]
		const metadata = { signature: "opaque-signature", nested: { fragments: ["opaque-fragment"] } }
		const messages = [
			{ role: "assistant", content: [{ type: "vscode_lm_thinking", value, id: "thinking-1", metadata }] },
		] as unknown as Anthropic.Messages.MessageParam[]

		const first = convertToVsCodeLmMessages(messages)
		const second = convertToVsCodeLmMessages(messages)
		value[0] = "Changed"
		value.push("Third")
		metadata.nested.fragments[0] = "changed-fragment"
		metadata.nested.fragments.push("extra-fragment")

		const expected = [
			{
				type: "thinking",
				value: ["First", "Second"],
				id: "thinking-1",
				metadata: { signature: "opaque-signature", nested: { fragments: ["opaque-fragment"] } },
			},
		]
		expect(first[0].content).toEqual(expected)
		expect(second[0].content).toEqual(expected)
		const firstThinking = first[0].content[0] as unknown as VscodeLmThinking
		const secondThinking = second[0].content[0] as unknown as VscodeLmThinking
		expect(firstThinking).not.toBe(secondThinking)
		expect(firstThinking.value).not.toBe(secondThinking.value)
		expect(firstThinking.metadata).not.toBe(secondThinking.metadata)
		expect(firstThinking.metadata?.nested).not.toBe(secondThinking.metadata?.nested)
	})

	it("omits opaque thinking when the host has no thinking constructor and preserves other ordered parts", () => {
		thinkingPartMock.enabled = false
		const result = convertToVsCodeLmMessages([
			{
				role: "assistant",
				content: [
					{
						type: "vscode_lm_thinking",
						value: "Private reasoning",
						id: "thinking-1",
						metadata: { token: "opaque" },
					},
					{ type: "text", text: "Before" },
					{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
					{ type: "vscode_lm_thinking", value: [], metadata: { token: "next" } },
					{ type: "text", text: "After" },
				],
			},
		] as unknown as Anthropic.Messages.MessageParam[])

		expect(result[0].content).toEqual([
			new vscode.LanguageModelTextPart("Before"),
			new vscode.LanguageModelToolCallPart("tool-1", "read_file", { path: "README.md" }),
			new vscode.LanguageModelTextPart("After"),
		])
	})

	it("omits thinking-only assistant messages when the host cannot replay thinking", () => {
		thinkingPartMock.enabled = false
		const result = convertToVsCodeLmMessages([
			{ role: "user", content: "Continue." },
			{
				role: "assistant",
				content: [
					{ type: "vscode_lm_thinking", value: "Private reasoning", id: "thinking-1" },
					{ type: "vscode_lm_thinking", value: "", metadata: { signature: "opaque" } },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "Visible answer" }] },
		] as unknown as Anthropic.Messages.MessageParam[])

		expect(result).toHaveLength(2)
		expect(result[0].content).toEqual([new vscode.LanguageModelTextPart("Continue.")])
		expect(result[1].content).toEqual([new vscode.LanguageModelTextPart("Visible answer")])
	})

	it("preserves existing empty-message behavior for content unrelated to host thinking", () => {
		thinkingPartMock.enabled = false
		const result = convertToVsCodeLmMessages([
			{ role: "assistant", content: [] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "Other reasoning", signature: "other" }] },
			{
				role: "assistant",
				content: [
					{ type: "vscode_lm_thinking", value: "Host reasoning" },
					{ type: "thinking", thinking: "Other reasoning", signature: "other" },
				],
			},
			{ role: "assistant", content: "" },
		] as unknown as Anthropic.Messages.MessageParam[])

		expect(result.map((message) => message.content)).toEqual([[], [], [], [new vscode.LanguageModelTextPart("")]])
	})

	it.each([
		{ value: undefined },
		{ value: 42 },
		{ value: ["Valid", 42] },
		{ value: "Valid", id: 42 },
		{ value: "Valid", metadata: null },
		{ value: "Valid", metadata: [] },
		{ value: "Valid", metadata: { unsupported: () => "value" } },
	])("omits malformed persisted VS Code thinking %j without inventing text", (fields) => {
		const result = convertToVsCodeLmMessages([
			{
				role: "assistant",
				content: [
					{ type: "vscode_lm_thinking", ...fields },
					{ type: "text", text: "Visible answer" },
				],
			},
		] as unknown as Anthropic.Messages.MessageParam[])

		expect(result[0].content).toEqual([new vscode.LanguageModelTextPart("Visible answer")])
	})

	it("ignores user-injected thinking and does not reinterpret another provider's thinking", () => {
		const result = convertToVsCodeLmMessages([
			{
				role: "user",
				content: [
					{
						type: "vscode_lm_thinking",
						value: "Injected reasoning",
						id: "injected",
						metadata: { token: "injected" },
					},
					{ type: "text", text: "User request" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Anthropic reasoning", signature: "anthropic-signature" },
					{ value: "Untagged reasoning", id: "untagged", metadata: { token: "untagged" } },
					{ type: "text", text: "Visible answer" },
				],
			},
		] as unknown as Anthropic.Messages.MessageParam[])

		expect(result[0].content).toEqual([new vscode.LanguageModelTextPart("User request")])
		expect(result[1].content).toEqual([new vscode.LanguageModelTextPart("Visible answer")])
	})

	it("preserves enriched text and tool ordering without unsupported message metadata", () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "Checking", id: "progress", phase: "commentary", outputIndex: 0 },
					{ type: "text" as const, text: "Again", id: "other", phase: "commentary", outputIndex: 1 },
					{ type: "tool_use" as const, id: "tool", name: "read_file", input: { path: "README.md" } },
					{ type: "text" as const, text: "Partial", id: "partial", phase: "partial_answer", outputIndex: 3 },
					{ type: "text" as const, text: "Answer", id: "answer", phase: "final_answer", outputIndex: 4 },
				],
			},
			{
				role: "user" as const,
				content: [{ type: "tool_result" as const, tool_use_id: "tool", content: "Result" }],
			},
		]
		const before = structuredClone(messages)
		const result = convertToVsCodeLmMessages(messages)
		expect(result).toHaveLength(2)
		expect(result[0].content).toEqual([
			new vscode.LanguageModelTextPart("Checking"),
			new vscode.LanguageModelTextPart("Again"),
			new vscode.LanguageModelToolCallPart("tool", "read_file", { path: "README.md" }),
			new vscode.LanguageModelTextPart("Partial"),
			new vscode.LanguageModelTextPart("Answer"),
		])
		expect(result[1].content).toEqual([
			new vscode.LanguageModelToolResultPart("tool", [new vscode.LanguageModelTextPart("Result")]),
		])
		expect(messages).toEqual(before)
	})
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
