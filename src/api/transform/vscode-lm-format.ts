import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { normalizeToolHistory, toFunctionToolInput } from "./tool-history"

/**
 * Safely converts a value into a plain object.
 */
function asObjectSafe(value: any): object {
	// Handle null/undefined
	if (!value) {
		return {}
	}

	try {
		// Handle strings that might be JSON
		if (typeof value === "string") {
			return JSON.parse(value)
		}

		// Handle pre-existing objects
		if (typeof value === "object") {
			return { ...value }
		}

		return {}
	} catch (error) {
		console.warn("Alpha <Language Model API>: Failed to parse object:", error)
		return {}
	}
}

type LanguageModelTextPartLike = vscode.LanguageModelTextPart | { value: string }
type LanguageModelToolCallPartLike = vscode.LanguageModelToolCallPart | { callId: string; name: string; input: object }
type LanguageModelToolResultPartLike = vscode.LanguageModelToolResultPart | { callId: string; content: unknown[] }
type LanguageModelDataPartLike = vscode.LanguageModelDataPart | { mimeType: string; data: Uint8Array }

export function isLanguageModelTextPartLike(value: unknown): value is LanguageModelTextPartLike {
	return (
		value instanceof vscode.LanguageModelTextPart ||
		(typeof value === "object" &&
			value !== null &&
			"value" in value &&
			typeof (value as { value?: unknown }).value === "string")
	)
}

export function isLanguageModelToolCallPartLike(value: unknown): value is LanguageModelToolCallPartLike {
	return (
		value instanceof vscode.LanguageModelToolCallPart ||
		(typeof value === "object" &&
			value !== null &&
			"callId" in value &&
			"name" in value &&
			"input" in value &&
			typeof (value as { callId?: unknown }).callId === "string" &&
			typeof (value as { name?: unknown }).name === "string" &&
			typeof (value as { input?: unknown }).input === "object" &&
			(value as { input?: unknown }).input !== null)
	)
}

export function isLanguageModelToolResultPartLike(value: unknown): value is LanguageModelToolResultPartLike {
	return (
		value instanceof vscode.LanguageModelToolResultPart ||
		(typeof value === "object" &&
			value !== null &&
			"callId" in value &&
			"content" in value &&
			typeof (value as { callId?: unknown }).callId === "string" &&
			Array.isArray((value as { content?: unknown }).content))
	)
}

export function isLanguageModelDataPartLike(value: unknown): value is LanguageModelDataPartLike {
	return (
		value instanceof vscode.LanguageModelDataPart ||
		(typeof value === "object" &&
			value !== null &&
			"mimeType" in value &&
			"data" in value &&
			typeof (value as { mimeType?: unknown }).mimeType === "string" &&
			(value as { data?: unknown }).data instanceof Uint8Array)
	)
}

function convertAnthropicImagePart(
	part: Anthropic.ImageBlockParam,
): vscode.LanguageModelDataPart | vscode.LanguageModelTextPart {
	const source = part.source as { type?: string; media_type?: string; data?: string }

	if (source.type === "base64" && source.media_type && source.data) {
		return vscode.LanguageModelDataPart.image(Buffer.from(source.data, "base64"), source.media_type)
	}

	return new vscode.LanguageModelTextPart(
		`[Image (${source.type || "Unknown source-type"}): ${source.media_type || "unknown media-type"} not supported by VSCode LM API]`,
	)
}

export function convertToVsCodeLmMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
): vscode.LanguageModelChatMessage[] {
	const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = []

	for (const anthropicMessage of normalizeToolHistory(anthropicMessages)) {
		// Handle simple string messages
		if (typeof anthropicMessage.content === "string") {
			vsCodeLmMessages.push(
				anthropicMessage.role === "assistant"
					? vscode.LanguageModelChatMessage.Assistant(anthropicMessage.content)
					: vscode.LanguageModelChatMessage.User(anthropicMessage.content),
			)
			continue
		}

		// Handle complex message structures
		switch (anthropicMessage.role) {
			case "user": {
				const contentParts: Array<
					vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
				> = []
				for (const part of anthropicMessage.content) {
					if (part.type === "tool_result") {
						const toolContentParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> =
							typeof part.content === "string"
								? [new vscode.LanguageModelTextPart(part.content)]
								: (part.content?.map((content) =>
										content.type === "image"
											? convertAnthropicImagePart(content)
											: new vscode.LanguageModelTextPart(content.text),
									) ?? [new vscode.LanguageModelTextPart("")])
						contentParts.push(new vscode.LanguageModelToolResultPart(part.tool_use_id, toolContentParts))
					} else if (part.type === "image") {
						contentParts.push(convertAnthropicImagePart(part))
					} else if (part.type === "text") {
						contentParts.push(new vscode.LanguageModelTextPart(part.text))
					}
				}

				// Add single user message with all content parts
				vsCodeLmMessages.push(vscode.LanguageModelChatMessage.User(contentParts))
				break
			}

			case "assistant": {
				const contentParts: Array<
					vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
				> = []
				for (const part of anthropicMessage.content) {
					if (part.type === "tool_use") {
						contentParts.push(
							new vscode.LanguageModelToolCallPart(
								part.id,
								part.name,
								asObjectSafe(toFunctionToolInput(part.name, part.input)),
							),
						)
					} else if (part.type === "image") {
						contentParts.push(convertAnthropicImagePart(part))
					} else if (part.type === "text") {
						contentParts.push(new vscode.LanguageModelTextPart(part.text))
					}
				}

				// Add the assistant message to the list of messages
				vsCodeLmMessages.push(vscode.LanguageModelChatMessage.Assistant(contentParts))
				break
			}
		}
	}

	return vsCodeLmMessages
}

export function convertToAnthropicRole(vsCodeLmMessageRole: vscode.LanguageModelChatMessageRole): string | null {
	switch (vsCodeLmMessageRole) {
		case vscode.LanguageModelChatMessageRole.Assistant:
			return "assistant"
		case vscode.LanguageModelChatMessageRole.User:
			return "user"
		default:
			return null
	}
}

/**
 * Extracts the text content from a VS Code Language Model chat message.
 * @param message A VS Code Language Model chat message.
 * @returns The extracted text content.
 */
export function extractTextCountFromMessage(message: vscode.LanguageModelChatMessage): string {
	let text = ""
	if (Array.isArray(message.content)) {
		for (const item of message.content) {
			if (isLanguageModelTextPartLike(item)) {
				text += item.value
			}
			if (isLanguageModelToolResultPartLike(item)) {
				text += item.callId
				for (const part of item.content) {
					if (isLanguageModelTextPartLike(part)) {
						text += part.value
					}
					if (isLanguageModelDataPartLike(part)) {
						text += part.mimeType
					}
				}
			}
			if (isLanguageModelToolCallPartLike(item)) {
				text += item.name
				text += item.callId
				if (item.input && Object.keys(item.input).length > 0) {
					try {
						text += JSON.stringify(item.input)
					} catch (error) {
						console.error("Alpha <Language Model API>: Failed to stringify tool call input:", error)
					}
				}
			}
			if (isLanguageModelDataPartLike(item)) {
				text += item.mimeType
			}
		}
	} else if (typeof message.content === "string") {
		text += message.content
	}
	return text
}
