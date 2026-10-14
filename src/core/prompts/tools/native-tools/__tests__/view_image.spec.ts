import type OpenAI from "openai"
import { describe, expect, it } from "vitest"

import { getNativeTools } from ".."

function functionTool(tool: OpenAI.Chat.ChatCompletionTool) {
	if (tool.type !== "function") throw new Error("expected function tool")
	return tool.function
}

describe("native view_image schema", () => {
	it("is only advertised to image-capable models", () => {
		const textOnlyNames = getNativeTools().map((tool) => functionTool(tool).name)
		const imageNames = getNativeTools({ supportsImages: true }).map((tool) => functionTool(tool).name)
		const planImageNames = getNativeTools({ supportsImages: true, planMode: true }).map(
			(tool) => functionTool(tool).name,
		)

		expect(textOnlyNames).not.toContain("view_image")
		expect(imageNames).toContain("view_image")
		expect(planImageNames).toContain("view_image")
	})

	it("requires one local image path and does not advertise unsupported detail hints", () => {
		const imageTool = getNativeTools({ supportsImages: true }).find(
			(tool) => functionTool(tool).name === "view_image",
		)

		expect(imageTool).toBeDefined()
		expect(functionTool(imageTool!).parameters).toEqual({
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Local filesystem path to a supported image file.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		})
	})
})
