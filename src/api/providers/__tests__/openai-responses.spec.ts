import {
	buildOpenAiResponsesInput,
	supportsOpenAiResponsesFreeformApplyPatch,
	toOpenAiResponsesTools,
} from "../openai-responses"
import type OpenAI from "openai"
import { beforeAll } from "vitest"
import i18next from "../../../i18n"
import toolTranslations from "../../../i18n/locales/en/tools.json"

beforeAll(() => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
})

describe("OpenAI Responses assistant message replay", () => {
	it.each([false, true])(
		"replays phases and original message IDs around reasoning and tool transactions (store=%s)",
		(store) => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Checking.", id: "msg_commentary", phase: "commentary", outputIndex: 0 },
						{ type: "reasoning", id: "reasoning_id", encrypted_content: "opaque+/=", summary: [] },
						{
							type: "text",
							text: "Stable result.",
							id: "msg_partial",
							phase: "partial_answer",
							outputIndex: 2,
						},
						{ type: "tool_use", id: "call_read", name: "read_file", input: { path: "file.txt" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "Contents." }] },
				{
					role: "assistant",
					content: [{ type: "text", text: "Done.", id: "msg_final", phase: "final_answer", outputIndex: 0 }],
				},
			] as const
			const before = structuredClone(messages)
			expect(buildOpenAiResponsesInput("", [], messages, store)).toEqual([
				{
					type: "message",
					role: "assistant",
					id: "msg_commentary",
					phase: "commentary",
					content: [{ type: "output_text", text: "Checking.", annotations: [] }],
				},
				{
					type: "reasoning",
					...(store ? { id: "reasoning_id" } : {}),
					encrypted_content: "opaque+/=",
					summary: [],
				},
				{
					type: "message",
					role: "assistant",
					id: "msg_partial",
					phase: "partial_answer",
					content: [{ type: "output_text", text: "Stable result.", annotations: [] }],
				},
				{ type: "function_call", call_id: "call_read", name: "read_file", arguments: '{"path":"file.txt"}' },
				{ type: "function_call_output", call_id: "call_read", output: "Contents." },
				{
					type: "message",
					role: "assistant",
					id: "msg_final",
					phase: "final_answer",
					content: [{ type: "output_text", text: "Done.", annotations: [] }],
				},
			])
			expect(messages).toEqual(before)
		},
	)

	it("retains same-phase and phase-less message boundaries without emitting output indexes", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "One.", id: "msg_1", phase: "commentary", outputIndex: 0 },
					{ type: "text", text: "Two.", id: "msg_2", phase: "commentary", outputIndex: 1 },
					{ type: "text", text: "Three.", outputIndex: 2 },
					{ type: "text", text: "Four.", outputIndex: 3 },
					{ type: "text", text: "Legacy." },
				],
			},
		]
		expect(buildOpenAiResponsesInput("", [], messages, false)).toEqual([
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				phase: "commentary",
				content: [{ type: "output_text", text: "One.", annotations: [] }],
			},
			{
				type: "message",
				role: "assistant",
				id: "msg_2",
				phase: "commentary",
				content: [{ type: "output_text", text: "Two.", annotations: [] }],
			},
			{ role: "assistant", content: "Three." },
			{ role: "assistant", content: "Four." },
			{ role: "assistant", content: "Legacy." },
		])
	})

	it("replays adjacent fragments of one identified source message in their original order", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First ", id: "msg_parts", phase: "partial_answer", outputIndex: 0 },
					{ type: "text", text: "second.", id: "msg_parts", phase: "partial_answer", outputIndex: 0 },
				],
			},
		]
		expect(buildOpenAiResponsesInput("", [], messages, false)).toEqual([
			{
				type: "message",
				role: "assistant",
				id: "msg_parts",
				phase: "partial_answer",
				content: [
					{ type: "output_text", text: "First ", annotations: [] },
					{ type: "output_text", text: "second.", annotations: [] },
				],
			},
		])
	})

	it("does not use a shared phase as a source message identity", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "One.", phase: "commentary" },
					{ type: "text", text: "Two.", phase: "commentary" },
				],
			},
		]
		expect(buildOpenAiResponsesInput("", [], messages, false)).toEqual([
			{
				type: "message",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "One.", annotations: [] }],
			},
			{
				type: "message",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "Two.", annotations: [] }],
			},
		])
	})

	it.each([undefined, null, "future_phase", 4])(
		"keeps unknown phase %s off the wire without losing valid original IDs",
		(phase) => {
			expect(
				buildOpenAiResponsesInput(
					"",
					[],
					[{ type: "message", role: "assistant", id: "msg_saved", phase, content: "Saved." }],
					false,
				),
			).toEqual([
				{
					type: "message",
					role: "assistant",
					id: "msg_saved",
					content: [{ type: "output_text", text: "Saved.", annotations: [] }],
				},
			])
		},
	)

	it("accepts original Responses output-message histories and keeps phase only on assistant input", () => {
		const messages = [
			{
				type: "message",
				role: "assistant",
				id: "msg_output",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: "Saved output." },
					{ type: "refusal", refusal: "Cannot provide that." },
				],
			},
			{ role: "user", id: "not-an-assistant-id", phase: "final_answer", content: "Follow-up." },
		]
		expect(buildOpenAiResponsesInput("", [], messages, false)).toEqual([
			{
				type: "message",
				role: "assistant",
				id: "msg_output",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: "Saved output.", annotations: [] },
					{ type: "refusal", refusal: "Cannot provide that." },
				],
			},
			{ role: "user", content: "Follow-up." },
		])
	})

	it("retains empty identified source messages while omitting legacy empty text", () => {
		expect(
			buildOpenAiResponsesInput(
				"",
				[],
				[
					{
						role: "assistant",
						content: [
							{ type: "text", text: "", id: "msg_empty", phase: "commentary", outputIndex: 0 },
							{ type: "text", text: "" },
						],
					},
				],
				false,
			),
		).toEqual([
			{
				type: "message",
				role: "assistant",
				id: "msg_empty",
				phase: "commentary",
				content: [{ type: "output_text", text: "", annotations: [] }],
			},
		])
	})

	it("ignores legacy response-envelope IDs and replays only explicitly declared message identity", () => {
		const messages = [
			{ role: "assistant", id: "arbitrary-response-envelope", content: "Legacy string." },
			{
				role: "assistant",
				id: "arbitrary-response-envelope",
				content: [{ type: "text", text: "Legacy block." }],
			},
			{ role: "assistant", id: "response-envelope", phase: "commentary", content: "Classified legacy." },
			{
				role: "assistant",
				id: "response-envelope",
				messageId: "source-message",
				phase: "partial_answer",
				content: "Explicit source.",
			},
		]
		expect(buildOpenAiResponsesInput("", [], messages, false)).toEqual([
			{ role: "assistant", content: "Legacy string." },
			{ role: "assistant", content: "Legacy block." },
			{
				type: "message",
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "Classified legacy.", annotations: [] }],
			},
			{
				type: "message",
				role: "assistant",
				id: "source-message",
				phase: "partial_answer",
				content: [{ type: "output_text", text: "Explicit source.", annotations: [] }],
			},
		])
	})

	it("replays empty raw Responses messages without inventing IDs", () => {
		expect(
			buildOpenAiResponsesInput(
				"",
				[],
				[
					{ type: "message", role: "assistant", id: "empty-source", phase: "commentary", content: [] },
					{ type: "message", role: "assistant", content: [] },
				],
				false,
			),
		).toEqual([
			{ type: "message", role: "assistant", id: "empty-source", phase: "commentary", content: [] },
			{ role: "assistant", content: "" },
		])
	})
})

describe("OpenAI Responses freeform apply_patch conversion", () => {
	it.each([false, true])(
		"retains raw bytes, encrypted reasoning and terminal type across reused IDs (store=%s)",
		(store) => {
			const patch =
				'*** Begin Patch\r\n*** Add File: file.txt\r\n+const path = "C:\\work\\file.txt"\r\n*** End Patch\n'
			const messages = [
				{ type: "reasoning", id: "reasoning-1", encrypted_content: "synthetic-encrypted", summary: [] },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "reused-call", name: "apply_patch", input: patch }],
					provider_state: { opaque: [1, 2] },
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_call_id: "reused-call",
							content: "Error: cancelled",
							is_error: true,
						},
					],
				},
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "reused-call", name: "read_file", input: { path: "file.txt" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_call_id: "reused-call", content: null, is_error: true }],
				},
			] as const
			const before = structuredClone(messages)
			expect(buildOpenAiResponsesInput("", [], messages, store)).toEqual([
				{
					type: "reasoning",
					encrypted_content: "synthetic-encrypted",
					summary: [],
					...(store ? { id: "reasoning-1" } : {}),
				},
				{ type: "custom_tool_call", call_id: "reused-call", name: "apply_patch", input: patch },
				{ type: "custom_tool_call_output", call_id: "reused-call", output: "Error: cancelled" },
				{ type: "function_call", call_id: "reused-call", name: "read_file", arguments: '{"path":"file.txt"}' },
				// Retain Alpha's existing nonempty wire placeholder; the stored null/error receipt stays exact.
				{ type: "function_call_output", call_id: "reused-call", output: "(empty)" },
			])
			expect(messages).toEqual(before)
		},
	)

	it("replays a persisted freeform patch string without JSON quoting", () => {
		const patch =
			'*** Begin Patch\n*** Add File: quoted-path.txt\n+const path = "C:\\workspace\\file.txt"\n*** End Patch'
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "legacy-patch-call", name: "apply_patch", input: patch }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "legacy-patch-call", content: "Patch applied." }],
			},
		] as const
		const before = structuredClone(messages)

		expect(buildOpenAiResponsesInput("fallback prompt", [], messages, false)).toEqual([
			{ type: "custom_tool_call", call_id: "legacy-patch-call", name: "apply_patch", input: patch },
			{ type: "custom_tool_call_output", call_id: "legacy-patch-call", output: "Patch applied." },
		])
		expect(messages).toEqual(before)
	})

	it("replays a legacy tool_call_id result with its matching native function call", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "legacy-read-call", name: "read_file", input: { path: "file.txt" } }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_call_id: "legacy-read-call", content: "Saved file contents." }],
			},
		] as const

		expect(buildOpenAiResponsesInput("fallback prompt", [], messages, false)).toEqual([
			{
				type: "function_call",
				call_id: "legacy-read-call",
				name: "read_file",
				arguments: '{"path":"file.txt"}',
			},
			{ type: "function_call_output", call_id: "legacy-read-call", output: "Saved file contents." },
		])
	})

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
			{
				type: "function_call_output",
				call_id: "view-image-call",
				output: "File: pixel.png\n[Image 1 is attached in the following user message.]",
			},
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Image 1 from the preceding tool result:" },
					{ type: "input_image", image_url: `data:image/png;base64,${imageData}`, detail: "auto" },
				],
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
			{
				type: "custom_tool_call_output",
				call_id: "patch_call_1",
				output: "Patch applied.\n[Image 1 is attached in the following user message.]",
			},
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Image 1 from the preceding tool result:" },
					{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "auto" },
				],
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
