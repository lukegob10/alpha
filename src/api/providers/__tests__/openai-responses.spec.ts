import {
	buildOpenAiResponsesInput,
	supportsOpenAiResponsesFreeformApplyPatch,
	toOpenAiResponsesTools,
} from "../openai-responses"
import type OpenAI from "openai"

describe("OpenAI Responses freeform apply_patch conversion", () => {
	it("keeps view_image tool output attached as the original image data", () => {
		const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII="
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "view-image-call",
						name: "view_image",
						input: { path: "pixel.png" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "view-image-call",
						content: [
							{ type: "text", text: "File: pixel.png" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
						],
					},
				],
			},
		] as const

		const input = buildOpenAiResponsesInput("fallback prompt", [], messages, false)

		expect(input).toEqual([
			{
				type: "function_call",
				call_id: "view-image-call",
				name: "view_image",
				arguments: JSON.stringify({ path: "pixel.png" }),
			},
			{ type: "function_call_output", call_id: "view-image-call", output: "File: pixel.png" },
			{
				role: "user",
				content: [{ type: "input_image", image_url: `data:image/png;base64,${imageData}`, detail: "auto" }],
			},
		])
	})

	it("round-trips ordered encrypted reasoning and patch tool history without response storage", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						id: "reasoning_1",
						encrypted_content: "encrypted-state",
						summary: [{ type: "summary_text", text: "Reviewed the edit." }],
					},
					{ type: "text", text: "I will apply this patch." },
					{
						type: "tool_use",
						id: "patch_call_1",
						name: "apply_patch",
						input: { patch: "*** Begin Patch\n*** End Patch" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "patch_call_1",
						content: [
							{ type: "text", text: "Patch applied." },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
						],
					},
				],
			},
		] as const

		const input = buildOpenAiResponsesInput(
			"fallback prompt",
			[
				{ role: "developer", content: "Pinned base" },
				{ role: "user", content: "Task context" },
			],
			messages,
			false,
		)

		expect(input).toEqual([
			{ role: "developer", content: "Pinned base" },
			{ role: "user", content: "Task context" },
			{
				type: "reasoning",
				encrypted_content: "encrypted-state",
				summary: [{ type: "summary_text", text: "Reviewed the edit." }],
			},
			{ role: "assistant", content: "I will apply this patch." },
			{
				type: "custom_tool_call",
				call_id: "patch_call_1",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
			{ type: "custom_tool_call_output", call_id: "patch_call_1", output: "Patch applied." },
			{
				role: "user",
				content: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "auto" }],
			},
		])
	})

	it("uses the Codex Lark grammar only for apply_patch and retains function tools", () => {
		const tools: OpenAI.Chat.ChatCompletionTool[] = [
			{
				type: "function",
				function: {
					name: "apply_patch",
					description: "JSON wrapper schema is not sent for freeform input.",
					parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
				},
			},
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file.",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		]

		expect(toOpenAiResponsesTools(tools)).toEqual([
			expect.objectContaining({
				type: "custom",
				name: "apply_patch",
				description:
					"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
				format: {
					type: "grammar",
					syntax: "lark",
					definition: expect.stringContaining("start: begin_patch hunk+ end_patch"),
				},
			}),
			{
				type: "function",
				name: "read_file",
				description: "Read a file.",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				strict: false,
			},
		])
	})

	it("rejects unsupported IDs and OpenAI-compatible or Azure hosts", () => {
		expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol", "https://api.openai.com/v1")).toBe(true)
		expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-4o", "https://api.openai.com/v1")).toBe(false)
		expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol", "https://api.example.com/v1")).toBe(false)
		expect(supportsOpenAiResponsesFreeformApplyPatch("gpt-5.6-sol", "https://api.openai.com/v1", true)).toBe(false)
	})
})
