import type OpenAI from "openai"

import type { ApiInstructionFragment } from "../index"
import { normalizeToolHistory, toFunctionToolInput } from "../transform/tool-history"
import { getNativeOpenAiModelCapabilities } from "./utils/openai-model-capabilities"

const APPLY_PATCH_DESCRIPTION =
	"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON."

// Match the Codex patch wire contract at e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1
// (reviewed 2026-09-25). The host parser and path policy remain authoritative.
const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

/**
 * Transport selection and freeform tool support are distinct capabilities.
 * Compatible endpoints retain JSON functions unless explicitly supported.
 */
export function supportsOpenAiResponsesFreeformApplyPatch(
	modelId: string,
	baseUrl?: string,
	useAzure?: boolean,
): boolean {
	return getNativeOpenAiModelCapabilities(modelId, baseUrl, useAzure)?.freeformApplyPatch === true
}

export function toOpenAiResponsesTools(
	tools: readonly OpenAI.Chat.ChatCompletionTool[] | undefined,
	freeformApplyPatch = true,
): OpenAI.Responses.Tool[] | undefined {
	if (!tools) return undefined

	const result: OpenAI.Responses.Tool[] = []
	for (const tool of tools) {
		if (tool.type !== "function") return undefined
		const definition = tool.function
		if (definition.name === "apply_patch" && freeformApplyPatch) {
			result.push({
				type: "custom",
				name: definition.name,
				description: APPLY_PATCH_DESCRIPTION,
				format: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR },
			})
			continue
		}

		result.push({
			type: "function",
			name: definition.name,
			...(definition.description !== undefined ? { description: definition.description } : {}),
			parameters: (definition.parameters ?? null) as Record<string, unknown> | null,
			strict: definition.strict ?? false,
		})
	}

	return result
}

export function toOpenAiResponsesToolChoice(
	choice: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"] | undefined,
	freeformApplyPatch = true,
): OpenAI.Responses.ResponseCreateParamsNonStreaming["tool_choice"] | undefined {
	if (choice === undefined || typeof choice === "string") return choice
	if (choice.type !== "function") return undefined

	const name = choice.function.name
	return name === "apply_patch" && freeformApplyPatch ? { type: "custom", name } : { type: "function", name }
}

export function buildOpenAiResponsesInput(
	systemPrompt: string,
	instructionFragments: readonly ApiInstructionFragment[] | undefined,
	messages: readonly unknown[],
	store: boolean | undefined,
	freeformApplyPatch = true,
): OpenAI.Responses.ResponseInputItem[] {
	const input: OpenAI.Responses.ResponseInputItem[] = []
	const instructions = instructionFragments ?? [{ role: "system" as const, content: systemPrompt }]
	for (const fragment of instructions) {
		if (!fragment.content) continue
		input.push({ role: fragment.role, content: fragment.content })
	}

	const callNames = new Map<string, string>()
	for (const candidate of normalizeToolHistory(messages)) {
		if (!isRecord(candidate)) continue
		if (candidate.type === "reasoning") {
			const item = toReasoningInput(candidate, store)
			if (item) input.push(item)
			continue
		}

		if (candidate.role !== "user" && candidate.role !== "assistant") continue
		if (typeof candidate.content === "string") {
			if (candidate.content) input.push({ role: candidate.role, content: candidate.content })
			continue
		}
		if (!Array.isArray(candidate.content)) continue

		if (candidate.role === "user") {
			let content: Array<OpenAI.Responses.ResponseInputText | OpenAI.Responses.ResponseInputImage> = []
			const flushUserContent = () => {
				if (content.length > 0) input.push({ role: "user", content })
				content = []
			}

			for (const block of candidate.content) {
				if (isToolResult(block)) {
					flushUserContent()
					const toolName = callNames.get(block.tool_use_id)
					const output = toolResultText(block.content)
					input.push(
						toolName === "apply_patch" && freeformApplyPatch
							? { type: "custom_tool_call_output", call_id: block.tool_use_id, output }
							: { type: "function_call_output", call_id: block.tool_use_id, output },
					)
					const images = toolResultImages(block.content)
					if (images.length > 0) input.push({ role: "user", content: images })
					continue
				}
				if (!isRecord(block)) continue
				if (block.type === "text" && typeof block.text === "string" && block.text) {
					content.push({ type: "input_text", text: block.text })
				} else if (block.type === "image") {
					const image = toInputImage(block.source)
					if (image) content.push(image)
				}
			}
			flushUserContent()
			continue
		}

		for (const block of candidate.content) {
			if (!isRecord(block)) continue
			if (block.type === "text" && typeof block.text === "string" && block.text) {
				input.push({ role: "assistant", content: block.text })
				continue
			}
			if (block.type === "reasoning") {
				const reasoningItem = toReasoningInput(block, store)
				if (reasoningItem) {
					input.push(reasoningItem)
				} else if (typeof block.text === "string" && block.text) {
					input.push({ role: "assistant", content: block.text })
				}
				continue
			}
			if (!isToolUse(block)) continue
			callNames.set(block.id, block.name)
			if (block.name === "apply_patch" && freeformApplyPatch) {
				const patch =
					typeof block.input === "string"
						? block.input
						: isRecord(block.input) && typeof block.input.patch === "string"
							? block.input.patch
							: JSON.stringify(block.input)
				input.push({ type: "custom_tool_call", call_id: block.id, name: block.name, input: patch })
			} else {
				input.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(toFunctionToolInput(block.name, block.input)),
				})
			}
		}
	}

	return input
}

export function normalizeOpenAiCustomToolInput(name: string, input: string): string {
	return name === "apply_patch" ? JSON.stringify({ patch: input }) : input
}

export function encodeOpenAiCustomToolInputDelta(name: string, input: string): string {
	if (name !== "apply_patch") return input
	return JSON.stringify(input).slice(1, -1)
}

function toReasoningInput(
	candidate: Record<string, unknown>,
	store: boolean | undefined,
): OpenAI.Responses.ResponseInputItem | undefined {
	if (typeof candidate.encrypted_content !== "string") return undefined
	const item = {
		type: "reasoning" as const,
		encrypted_content: candidate.encrypted_content,
		summary: Array.isArray(candidate.summary) ? candidate.summary : [],
		...(store !== false && typeof candidate.id === "string" ? { id: candidate.id } : {}),
	}
	// OpenAI accepts stateless reasoning items without an id when store is false.
	return item as unknown as OpenAI.Responses.ResponseInputItem
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isToolResult(value: unknown): value is { type: "tool_result"; tool_use_id: string; content?: unknown } {
	return isRecord(value) && value.type === "tool_result" && typeof value.tool_use_id === "string"
}

function isToolUse(value: unknown): value is { type: "tool_use"; id: string; name: string; input: unknown } {
	return (
		isRecord(value) && value.type === "tool_use" && typeof value.id === "string" && typeof value.name === "string"
	)
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content || "(empty)"
	if (!Array.isArray(content)) return "(empty)"
	return (
		content
			.map((part) => {
				if (!isRecord(part)) return ""
				return typeof part.text === "string" ? part.text : ""
			})
			.filter(Boolean)
			.join("\n") || "(empty)"
	)
}

function toolResultImages(content: unknown): OpenAI.Responses.ResponseInputImage[] {
	if (!Array.isArray(content)) return []
	return content.flatMap((part) => {
		if (!isRecord(part) || part.type !== "image") return []
		const image = toInputImage(part.source)
		return image ? [image] : []
	})
}

function toInputImage(source: unknown): OpenAI.Responses.ResponseInputImage | undefined {
	if (!isRecord(source)) return undefined
	if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
		return {
			type: "input_image",
			image_url: `data:${source.media_type};base64,${source.data}`,
			detail: "auto",
		}
	}
	if (source.type === "url" && typeof source.url === "string") {
		return { type: "input_image", image_url: source.url, detail: "auto" }
	}
	return undefined
}
