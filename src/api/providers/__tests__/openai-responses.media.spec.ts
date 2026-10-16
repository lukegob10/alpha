import type { Anthropic } from "@anthropic-ai/sdk"
import { beforeAll, describe, expect, it } from "vitest"

import { buildOpenAiResponsesInput } from "../openai-responses"
import i18next from "../../../i18n"
import toolTranslations from "../../../i18n/locales/en/tools.json"

beforeAll(() => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
})

const image = (data: string): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
})
const firstMarker = "[Image 1 is attached in the following user message.]"
const secondMarker = "[Image 2 is attached in the following user message.]"

function messages(content: Anthropic.ToolResultBlockParam["content"]): Anthropic.MessageParam[] {
	return [
		{ role: "assistant", content: [{ type: "tool_use", id: "media-call", name: "inspect_media", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "media-call", content }] },
	]
}

describe("OpenAI Responses tool media projection", () => {
	it("keeps captions and numbered image slots in string output with matching attachment labels", () => {
		const source = messages([
			{ type: "text", text: "First caption" },
			image("Zmlyc3Q="),
			{ type: "text", text: "Second caption" },
			image("c2Vjb25k"),
		])
		const before = structuredClone(source)

		expect(buildOpenAiResponsesInput("", [], source, false)).toEqual([
			{ type: "function_call", call_id: "media-call", name: "inspect_media", arguments: "{}" },
			{
				type: "function_call_output",
				call_id: "media-call",
				output: ["First caption", firstMarker, "Second caption", secondMarker].join("\n"),
			},
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Image 1 from the preceding tool result:" },
					{ type: "input_image", image_url: "data:image/png;base64,Zmlyc3Q=", detail: "auto" },
					{ type: "input_text", text: "Image 2 from the preceding tool result:" },
					{ type: "input_image", image_url: "data:image/png;base64,c2Vjb25k", detail: "auto" },
				],
			},
		])
		expect(source).toEqual(before)
	})

	it("gives image-only output a useful tool slot instead of an empty result", () => {
		const result = buildOpenAiResponsesInput("", [], messages([image("Zmlyc3Q=")]), false)

		expect(result[1]).toEqual({ type: "function_call_output", call_id: "media-call", output: firstMarker })
		expect(result[2]).toMatchObject({
			role: "user",
			content: [{ type: "input_text", text: "Image 1 from the preceding tool result:" }, { type: "input_image" }],
		})
	})

	it("describes unsupported image sources in position without copying the source payload", () => {
		const secretPayload = "opaque-provider-image-reference-".repeat(500)
		const unsupported: Anthropic.ImageBlockParam = {
			type: "image",
			source: { type: "opaque", data: secretPayload } as unknown as Anthropic.ImageBlockParam["source"],
		}

		const result = buildOpenAiResponsesInput(
			"",
			[],
			messages([{ type: "text", text: "Before" }, unsupported, { type: "text", text: "After" }]),
			false,
		)

		expect(result[1]).toEqual({
			type: "function_call_output",
			call_id: "media-call",
			output: "Before\n<image content omitted because its source is not supported by this provider>\nAfter",
		})
		expect(result).toHaveLength(2)
		expect(JSON.stringify(result)).not.toContain(secretPayload)
	})

	it("keeps ordinary text and audio omission markers paired with the original call", () => {
		const placeholder = "<audio content omitted because you do not support audio input>"
		const result = buildOpenAiResponsesInput("", [], messages([{ type: "text", text: placeholder }]), false)

		expect(result).toHaveLength(2)
		expect(result[1]).toEqual({ type: "function_call_output", call_id: "media-call", output: placeholder })
	})
})
