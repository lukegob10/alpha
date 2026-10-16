import type { Anthropic } from "@anthropic-ai/sdk"
import { beforeAll, describe, expect, it } from "vitest"

import { convertAnthropicMessageToGemini } from "../gemini-format"
import i18next from "../../../i18n"
import toolTranslations from "../../../i18n/locales/en/tools.json"

beforeAll(() => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
})

const image = (data: string): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
})
const toolName = "inspect_media"
const callId = "media-call"
const options = { includeThoughtSignatures: false, toolIdToName: new Map([[callId, toolName]]) }

function message(content: Anthropic.ToolResultBlockParam["content"]): Anthropic.MessageParam {
	return { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] }
}

describe("Gemini tool media projection", () => {
	it("pairs in-position numbered image slots with labeled following image parts", () => {
		const source = message([
			{ type: "text", text: "First caption" },
			image("Zmlyc3Q="),
			{ type: "text", text: "Second caption" },
			image("c2Vjb25k"),
		])
		const before = structuredClone(source)

		expect(convertAnthropicMessageToGemini(source, options)).toEqual([
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: callId,
							name: toolName,
							response: {
								name: toolName,
								content: [
									"First caption",
									"[Image 1 is attached in the following content parts.]",
									"Second caption",
									"[Image 2 is attached in the following content parts.]",
								].join("\n\n"),
							},
						},
					},
					{ text: "Image 1 from the preceding tool result:" },
					{ inlineData: { data: "Zmlyc3Q=", mimeType: "image/png" } },
					{ text: "Image 2 from the preceding tool result:" },
					{ inlineData: { data: "c2Vjb25k", mimeType: "image/png" } },
				],
			},
		])
		expect(source).toEqual(before)
	})

	it("gives an image-only result a numbered slot paired with its original call", () => {
		expect(convertAnthropicMessageToGemini(message([image("Zmlyc3Q=")]), options)).toEqual([
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: callId,
							name: toolName,
							response: {
								name: toolName,
								content: "[Image 1 is attached in the following content parts.]",
							},
						},
					},
					{ text: "Image 1 from the preceding tool result:" },
					{ inlineData: { data: "Zmlyc3Q=", mimeType: "image/png" } },
				],
			},
		])
	})

	it("describes unsupported sources in position without copying opaque image payloads", () => {
		const opaque = "opaque-image-payload-".repeat(500)
		const unsupported: Anthropic.ImageBlockParam = {
			type: "image",
			source: {
				type: "url",
				url: `https://example.invalid/image.png?opaque=${opaque}`,
			} as unknown as Anthropic.ImageBlockParam["source"],
		}
		const result = convertAnthropicMessageToGemini(
			message([{ type: "text", text: "Before" }, unsupported, { type: "text", text: "After" }]),
			options,
		)

		expect(result).toEqual([
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: callId,
							name: toolName,
							response: {
								name: toolName,
								content:
									"Before\n\n<image content omitted because its source is not supported by this provider>\n\nAfter",
							},
						},
					},
				],
			},
		])
		expect(JSON.stringify(result)).not.toContain(opaque)
	})

	it("keeps an audio omission explanation paired with the original function call", () => {
		const placeholder = "<audio content omitted because you do not support audio input>"
		const result = convertAnthropicMessageToGemini(message([{ type: "text", text: placeholder }]), options)

		expect(result[0].parts).toEqual([
			{ functionResponse: { id: callId, name: toolName, response: { name: toolName, content: placeholder } } },
		])
	})
})
