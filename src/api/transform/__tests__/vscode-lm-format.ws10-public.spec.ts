import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { convertToVsCodeLmMessages } from "../vscode-lm-format"

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
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		LanguageModelDataPart: MockLanguageModelDataPart,
	}
})

describe("VS Code nested WS10 tool media projection", () => {
	it("keeps nested text and images inside one paired VS Code tool result in their original order", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "nested-media-call", name: "mcp__images__read", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "nested-media-call",
						status: "success",
						is_error: false,
						metadata: { source: "mcp" },
						content: [
							{ type: "text", text: "First caption" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" } },
							{ type: "text", text: "Second caption" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/jpeg", data: "c2Vjb25k" },
							},
						],
					},
				],
			},
		] as unknown as Anthropic.Messages.MessageParam[]
		const before = structuredClone(messages)

		const result = convertToVsCodeLmMessages(messages)

		expect(result).toHaveLength(2)
		expect(result[0].content).toEqual([
			new vscode.LanguageModelToolCallPart("nested-media-call", "mcp__images__read", {}),
		])
		expect(result[1].content).toEqual([
			new vscode.LanguageModelToolResultPart("nested-media-call", [
				new vscode.LanguageModelTextPart("First caption"),
				vscode.LanguageModelDataPart.image(Buffer.from("first"), "image/png"),
				new vscode.LanguageModelTextPart("Second caption"),
				vscode.LanguageModelDataPart.image(Buffer.from("second"), "image/jpeg"),
			]),
		])
		expect(messages).toEqual(before)
	})
})
