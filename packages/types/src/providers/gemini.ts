import { z } from "zod"

import type { ModelInfo } from "../model.js"

export const MAX_GEMINI_RESPONSE_PARTS = 65_536
export const MAX_GEMINI_RESPONSE_CHARACTERS = 16 * 1024 * 1024

function isJsonTree(value: unknown): boolean {
	const seen = new WeakSet<object>()
	let nodes = 0
	const visit = (candidate: unknown, depth: number): boolean => {
		if (++nodes > 262_144 || depth > 64) return false
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true
		if (typeof candidate === "number") return Number.isFinite(candidate)
		if (typeof candidate !== "object" || seen.has(candidate)) return false
		seen.add(candidate)
		if (Object.getOwnPropertySymbols(candidate).length > 0) return false
		const descriptors = Object.getOwnPropertyDescriptors(candidate)
		if (Array.isArray(candidate)) {
			if (Object.keys(candidate).length !== candidate.length) return false
			for (let index = 0; index < candidate.length; index++) {
				const descriptor = descriptors[String(index)]
				if (!descriptor || !("value" in descriptor) || !visit(descriptor.value, depth + 1)) return false
			}
			return true
		}
		const prototype = Object.getPrototypeOf(candidate)
		if (prototype !== Object.prototype && prototype !== null) return false
		return Object.values(descriptors).every(
			(descriptor) => descriptor.enumerable && "value" in descriptor && visit(descriptor.value, depth + 1),
		)
	}
	return visit(value, 0)
}

function isBoundedGeminiJson(value: unknown): boolean {
	try {
		return isJsonTree(value) && JSON.stringify(value).length <= MAX_GEMINI_RESPONSE_CHARACTERS
	} catch {
		return false
	}
}

/** Preserve provider fields without importing the Google SDK into shared contracts. */
const geminiResponsePartSchema = z
	.object({
		text: z.string().optional(),
		thought: z.boolean().optional(),
		thoughtSignature: z.string().optional(),
		functionCall: z
			.object({ id: z.string().optional(), name: z.string(), args: z.record(z.unknown()).optional() })
			.passthrough()
			.optional(),
	})
	.passthrough()

const geminiResponseShape = z
	.object({
		modelId: z.string().min(1).max(128),
		parts: z.array(geminiResponsePartSchema).min(1).max(MAX_GEMINI_RESPONSE_PARTS),
	})
	.strict()

export type GeminiResponse = z.infer<typeof geminiResponseShape>

/** Validate without rewriting signed objects: Zod's record parser can omit JSON `__proto__` keys. */
export const geminiResponseSchema = z.custom<GeminiResponse>(
	(value) => isBoundedGeminiJson(value) && geminiResponseShape.safeParse(value).success,
	"Gemini response state must contain a bounded plain JSON tree with valid response parts",
)

export const geminiResponseHistoryBlockSchema = z.object({
	type: z.literal("gemini_response"),
	geminiResponse: geminiResponseSchema,
})
export type GeminiResponseHistoryBlock = z.infer<typeof geminiResponseHistoryBlockSchema>

/** Parse untrusted persisted state and detach mutable SDK/message objects. */
export function snapshotGeminiResponse(value: unknown): GeminiResponse | undefined {
	const result = geminiResponseSchema.safeParse(value)
	if (!result.success) return undefined
	return JSON.parse(JSON.stringify(result.data)) as GeminiResponse
}

// Verified 2026-10-25 against Google's native model and thinking contracts:
// https://ai.google.dev/gemini-api/docs/models/gemini-4-argon
// https://aistudio.google.com/docs/models/gemini-3.8-flash
// https://ai.google.dev/gemini-api/docs/generate-content/thinking
// Keep synchronous output bounded; Argon's long-decode continuation protocol is a separate capability.
export const geminiModels = {
	"gemini-4-argon": {
		contextWindow: 1_048_576,
		contextWindowIncludesOutput: true,
		maxTokens: 65_536,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		description: "Gemini 4 Argon: Google's flagship model for coding and multi-step reasoning",
	},
	"gemini-3.8-flash": {
		contextWindow: 1_048_576,
		contextWindowIncludesOutput: false,
		maxTokens: 65_536,
		supportsImages: true,
		supportsPromptCache: true,
		supportsStreaming: true,
		supportsTemperature: false,
		supportsReasoningEffort: ["low", "medium", "high"],
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		preserveReasoning: true,
		description: "Gemini 3.8 Flash: Google's fast model for coding and agent workflows",
	},
} as const satisfies Record<string, ModelInfo>

export type GeminiModelId = keyof typeof geminiModels
export const geminiDefaultModelId: GeminiModelId = "gemini-4-argon"
