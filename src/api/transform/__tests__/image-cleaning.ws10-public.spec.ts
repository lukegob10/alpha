import type { ModelInfo } from "@alpha-code/types"

import { ApiHandler } from "../../index"
import { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../image-cleaning"

describe("maybeRemoveImageBlocks", () => {
	// Mock ApiHandler factory function
	const createMockApiHandler = (supportsImages: boolean): ApiHandler => {
		return {
			getModel: vitest.fn().mockReturnValue({
				id: "test-model",
				info: {
					supportsImages,
				} as ModelInfo,
			}),
			createMessage: vitest.fn(),
			countTokens: vitest.fn(),
		}
	}

	const pairedMediaHistory = (status: "success" | "error" | "denied" | "cancelled"): ApiMessage[] =>
		[
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "mcp-media-call", name: "mcp__images__read", input: {} }],
				messageId: "assistant-media-message",
				provider_state: { opaque: ["retain-provider-state"] },
			},
			{
				role: "user",
				ts: 123,
				content: [
					{ type: "text", text: "Before receipt" },
					{
						type: "tool_result",
						tool_use_id: "mcp-media-call",
						is_error: status !== "success",
						status,
						cache_control: { type: "ephemeral" },
						metadata: { source: "mcp", sequence: 7 },
						content: [
							{ type: "text", text: "First caption" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "nested-png-payload" },
							},
							{ type: "text", text: "Second caption" },
							{ type: "image", source: { type: "url", url: "https://example.invalid/nested-image" } },
						],
					},
					{ type: "text", text: "After receipt" },
				],
			},
		] as unknown as ApiMessage[]

	it.each(["success", "error", "denied", "cancelled"] as const)(
		"projects nested receipt images in position for a text-only request without changing %s history",
		(status) => {
			const messages = pairedMediaHistory(status)
			const before = structuredClone(messages)
			const expected = pairedMediaHistory(status)
			const receipt = Array.isArray(expected[1].content) ? expected[1].content[1] : undefined
			if (receipt?.type !== "tool_result") throw new Error("Expected the paired media fixture")
			receipt.content = [
				{ type: "text", text: "First caption" },
				{ type: "text", text: "[Referenced image in conversation]" },
				{ type: "text", text: "Second caption" },
				{ type: "text", text: "[Referenced image in conversation]" },
			]

			const projected = maybeRemoveImageBlocks(messages, createMockApiHandler(false))

			expect(projected).toEqual(expected)
			expect(JSON.stringify(projected)).not.toContain("nested-png-payload")
			expect(JSON.stringify(projected)).not.toContain("https://example.invalid/nested-image")
			expect(messages).toEqual(before)
		},
	)

	it("keeps ordered nested media available to a vision-capable request after a text-only projection", () => {
		const messages = pairedMediaHistory("success")
		const before = structuredClone(messages)

		maybeRemoveImageBlocks(messages, createMockApiHandler(false))
		const projected = maybeRemoveImageBlocks(messages, createMockApiHandler(true))

		expect(projected).toEqual(before)
		expect(messages).toEqual(before)
	})
})
