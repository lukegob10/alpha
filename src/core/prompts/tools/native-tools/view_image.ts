import type OpenAI from "openai"

/**
 * The current provider-neutral image transport sends local image bytes to the
 * provider's automatic detail policy. Do not advertise a detail hint until the
 * selected provider can honor it end to end.
 */
export const viewImageToolSchema: OpenAI.Chat.ChatCompletionTool = {
	type: "function",
	function: {
		name: "view_image",
		description:
			"View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Local filesystem path to a supported image file.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
}
