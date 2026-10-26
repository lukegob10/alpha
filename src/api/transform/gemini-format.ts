import { Anthropic } from "@anthropic-ai/sdk"
import { Content, Part } from "@google/genai"
import { isDeepStrictEqual } from "node:util"

import { snapshotGeminiResponse, type GeminiResponseHistoryBlock } from "@alpha-code/types"

import { normalizeToolHistory, toFunctionToolInput } from "./tool-history"
import { t } from "../../i18n"
import { sanitizeToolUseId } from "../../utils/tool-id"

type ThoughtSignatureContentBlock = {
	type: "thoughtSignature"
	thoughtSignature?: string
}

type ReasoningContentBlock = {
	type: "reasoning"
	text: string
}

type ExtendedContentBlockParam =
	| Anthropic.ContentBlockParam
	| ThoughtSignatureContentBlock
	| ReasoningContentBlock
	| GeminiResponseHistoryBlock
type ExtendedAnthropicContent = string | ExtendedContentBlockParam[]

type GeminiConversionOptions = {
	includeThoughtSignatures?: boolean
	modelId?: string
	toolIdToName?: Map<string, string>
	toolIdToProviderId?: Map<string, string | undefined>
}

function getOriginalGeminiParts(
	message: Anthropic.Messages.MessageParam,
	options?: GeminiConversionOptions,
): Part[] | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined
	const blocks = (message.content as ExtendedContentBlockParam[]).filter(
		(block): block is GeminiResponseHistoryBlock => block.type === "gemini_response",
	)
	if (blocks.length === 0 || !options?.modelId) return undefined
	if (blocks.length !== 1) throw new Error("Ambiguous Gemini response replay state in conversation history.")
	const response = snapshotGeminiResponse(blocks[0]?.geminiResponse)
	if (!response) throw new Error("Invalid Gemini response replay state in conversation history.")
	if (response.modelId !== options.modelId) return undefined

	const calls = message.content.filter((block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use")
	const originalCalls = response.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []))
	if (
		calls.length !== originalCalls.length ||
		calls.some((call, index) => {
			const original = originalCalls[index]!
			return (
				call.name !== original.name ||
				!isDeepStrictEqual(toFunctionToolInput(call.name, call.input), original.args ?? {}) ||
				(original.id !== undefined && call.id !== original.id && call.id !== sanitizeToolUseId(original.id))
			)
		})
	) {
		throw new Error("Gemini response replay state does not match the canonical tool history.")
	}
	for (const [index, call] of calls.entries()) {
		options.toolIdToProviderId?.set(call.id, originalCalls[index]?.id)
	}
	return response.parts
}

// Extension type to safely add thoughtSignature to Part
type PartWithThoughtSignature = Part & {
	thoughtSignature?: string
}

function isThoughtSignatureContentBlock(block: ExtendedContentBlockParam): block is ThoughtSignatureContentBlock {
	return block.type === "thoughtSignature"
}

export function convertAnthropicContentToGemini(
	content: ExtendedAnthropicContent,
	options?: GeminiConversionOptions,
): Part[] {
	const includeThoughtSignatures = options?.includeThoughtSignatures ?? true
	const toolIdToName = options?.toolIdToName
	if (Array.isArray(content)) content = normalizeToolHistory([{ content }])[0]!.content

	// First pass: find thoughtSignature if it exists in the content blocks
	let activeThoughtSignature: string | undefined
	if (Array.isArray(content)) {
		const sigBlock = content.find((block) => isThoughtSignatureContentBlock(block)) as ThoughtSignatureContentBlock
		if (sigBlock?.thoughtSignature) {
			activeThoughtSignature = sigBlock.thoughtSignature
		}
	}

	// Determine the signature to attach to function calls.
	// If we're in a mode that expects signatures (includeThoughtSignatures is true):
	// 1. Use the actual signature if we found one in the history/content.
	// 2. Fallback to "skip_thought_signature_validator" if missing (e.g. cross-model history).
	let functionCallSignature: string | undefined
	if (includeThoughtSignatures) {
		functionCallSignature = activeThoughtSignature || "skip_thought_signature_validator"
	}

	if (typeof content === "string") {
		return [{ text: content }]
	}

	const parts = content.flatMap((block): Part | Part[] => {
		// Handle thoughtSignature blocks first
		if (isThoughtSignatureContentBlock(block)) {
			// We process thought signatures globally and attach them to the relevant parts
			// or create a placeholder part if no other content exists.
			return []
		}

		switch (block.type) {
			case "gemini_response":
				return []
			case "text":
				return { text: block.text }
			case "image":
				if (block.source.type !== "base64") {
					throw new Error("Unsupported image source type")
				}

				return { inlineData: { data: block.source.data, mimeType: block.source.media_type } }
			case "tool_use":
				// Gemini 3 validation rules:
				// - In a parallel function calling response, only the FIRST functionCall part has a signature.
				// - In sequential steps, each step's first functionCall must include its signature.
				// When converting from our history, we don't always have enough information to perfectly
				// recreate the original per-part distribution, but we can and should avoid attaching the
				// signature to every parallel call in a single assistant message.
				return {
					functionCall: {
						id: block.id,
						name: block.name,
						args: toFunctionToolInput(block.name, block.input) as Record<string, unknown>,
					},
					// Inject the thoughtSignature into the functionCall part if required.
					// This is necessary for Gemini 3+ thinking models to validate the tool call.
					...(functionCallSignature ? { thoughtSignature: functionCallSignature } : {}),
				} as Part
			case "tool_result": {
				const providerToolId = options?.toolIdToProviderId?.has(block.tool_use_id)
					? options.toolIdToProviderId.get(block.tool_use_id)
					: block.tool_use_id
				// Get tool name from the map (built from tool_use blocks in message history).
				// The map must contain the tool name - if it doesn't, this indicates a bug
				// where the conversation history is incomplete or tool_use blocks are missing.
				const toolName = toolIdToName?.get(block.tool_use_id)
				if (!toolName) {
					throw new Error(
						`Unable to find tool name for tool_use_id "${block.tool_use_id}". ` +
							`This indicates the conversation history is missing the corresponding tool_use block. ` +
							`Available tool IDs: ${Array.from(toolIdToName?.keys() ?? []).join(", ") || "none"}`,
					)
				}

				if (typeof block.content === "string" || block.content === undefined || block.content === null) {
					return {
						functionResponse: {
							...(providerToolId !== undefined ? { id: providerToolId } : {}),
							name: toolName,
							response: { name: toolName, content: block.content ?? "" },
						},
					}
				}

				if (!Array.isArray(block.content)) {
					return []
				}

				const textParts: string[] = []
				const imageParts: Part[] = []
				let imageCount = 0

				for (const item of block.content) {
					if (item.type === "text") {
						textParts.push(item.text)
					} else if (item.type === "image" && item.source.type === "base64") {
						const { data, media_type } = item.source
						const label = t("tools:mcpMedia.imageLabel", { index: ++imageCount })
						textParts.push(t("tools:mcpMedia.imageAttachedFollowingPart", { label }))
						imageParts.push(
							{ text: t("tools:mcpMedia.followingImageLabel", { label }) },
							{ inlineData: { data, mimeType: media_type } },
						)
					} else if (item.type === "image") {
						textParts.push(t("tools:mcpMedia.imageSourceUnsupported"))
					}
				}

				return [
					{
						functionResponse: {
							...(providerToolId !== undefined ? { id: providerToolId } : {}),
							name: toolName,
							response: { name: toolName, content: textParts.join("\n\n") },
						},
					},
					...imageParts,
				]
			}
			default:
				// Skip unsupported content block types (e.g., "reasoning", "thinking", "redacted_thinking", "document")
				// These are typically metadata from other providers that don't need to be sent to Gemini
				console.warn(`Skipping unsupported content block type: ${block.type}`)
				return []
		}
	})

	// Post-processing:
	// 1) Ensure thought signature is attached if required
	// 2) For multiple function calls in a single message, keep the signature only on the first
	//    functionCall part to match Gemini 3 parallel-calling behavior.
	if (includeThoughtSignatures && activeThoughtSignature) {
		const hasSignature = parts.some((p) => "thoughtSignature" in p)

		if (!hasSignature) {
			if (parts.length > 0) {
				// Attach to the first part (usually text)
				// We use the intersection type to allow adding the property safely
				;(parts[0] as PartWithThoughtSignature).thoughtSignature = activeThoughtSignature
			} else {
				// Create a placeholder part if no other content exists
				const placeholder: PartWithThoughtSignature = { text: "", thoughtSignature: activeThoughtSignature }
				parts.push(placeholder)
			}
		}
	}

	if (includeThoughtSignatures) {
		let seenFirstFunctionCall = false
		for (const part of parts) {
			if (part && typeof part === "object" && "functionCall" in part && (part as any).functionCall) {
				const partWithSig = part as PartWithThoughtSignature
				if (!seenFirstFunctionCall) {
					seenFirstFunctionCall = true
				} else {
					// Remove signature from subsequent function calls in this message.
					delete partWithSig.thoughtSignature
				}
			}
		}
	}

	return parts
}

export function convertAnthropicMessageToGemini(
	message: Anthropic.Messages.MessageParam,
	options?: GeminiConversionOptions,
): Content[] {
	const originalParts = getOriginalGeminiParts(message, options)
	if (originalParts) return [{ role: "model", parts: originalParts }]
	const parts = convertAnthropicContentToGemini(message.content, options)

	if (parts.length === 0) {
		return []
	}

	return [
		{
			role: message.role === "assistant" ? "model" : "user",
			parts,
		},
	]
}

/** Resolve result names at each call occurrence, including provider-reused IDs. */
export function convertAnthropicMessagesToGemini(
	messages: Anthropic.Messages.MessageParam[],
	options?: Pick<GeminiConversionOptions, "includeThoughtSignatures" | "modelId">,
): Content[] {
	const toolIdToName = new Map<string, string>()
	const toolIdToProviderId = new Map<string, string | undefined>()
	return normalizeToolHistory(messages).flatMap((message) => {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "tool_use") {
					toolIdToName.set(block.id, block.name)
					toolIdToProviderId.delete(block.id)
				}
			}
		}
		return convertAnthropicMessageToGemini(message, { ...options, toolIdToName, toolIdToProviderId })
	})
}
