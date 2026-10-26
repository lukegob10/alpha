import { BetaThinkingConfigParam } from "@anthropic-ai/sdk/resources/beta"
import OpenAI from "openai"
import { ThinkingLevel, type GenerateContentConfig } from "@google/genai"

import {
	resolveModelReasoningEffort,
	type ModelInfo,
	type ProviderSettings,
	type ReasoningEffortExtended,
} from "@alpha-code/types"

import { shouldUseReasoningBudget, shouldUseReasoningEffort } from "../../shared/api"

export type AnthropicReasoningParams = BetaThinkingConfigParam

export type OpenAiReasoningParams = { reasoning_effort: OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"] }

// Valid Gemini thinking levels for effort-based reasoning
const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const

export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number]

export function isGeminiThinkingLevel(value: unknown): value is GeminiThinkingLevel {
	return typeof value === "string" && GEMINI_THINKING_LEVELS.includes(value as GeminiThinkingLevel)
}

export type GeminiReasoningParams = GenerateContentConfig["thinkingConfig"]

export type GetModelReasoningOptions = {
	model: ModelInfo
	reasoningBudget: number | undefined
	reasoningEffort: ReasoningEffortExtended | "disable" | undefined
	settings: ProviderSettings
}

/** Omission can re-enable the service default; only declared zero-effort models map Off to none. */
export function getExplicitOpenAiOffEffort({
	model,
	settings,
	reasoningEffort,
}: Pick<GetModelReasoningOptions, "model" | "settings" | "reasoningEffort">): "none" | undefined {
	if (
		!model.requiredReasoningEffort &&
		!model.requiredReasoningBudget &&
		(settings.enableReasoningEffort === false ||
			settings.reasoningEffort === "disable" ||
			reasoningEffort === "disable") &&
		Array.isArray(model.supportsReasoningEffort) &&
		model.supportsReasoningEffort.includes("none")
	) {
		return "none"
	}
	return undefined
}

export const getAnthropicReasoning = ({
	model,
	reasoningBudget,
	settings,
}: GetModelReasoningOptions): AnthropicReasoningParams | undefined =>
	shouldUseReasoningBudget({ model, settings }) ? { type: "enabled", budget_tokens: reasoningBudget! } : undefined

export const getOpenAiReasoning = ({
	model,
	reasoningEffort,
	settings,
}: GetModelReasoningOptions): OpenAiReasoningParams | undefined => {
	const offEffort = getExplicitOpenAiOffEffort({ model, settings, reasoningEffort })
	if (!offEffort) {
		if (!shouldUseReasoningEffort({ model, settings })) return undefined
		if (!model.requiredReasoningEffort && reasoningEffort === "disable") return undefined
	}
	const effort =
		offEffort ?? resolveModelReasoningEffort(model, reasoningEffort, model.requiredReasoningEffort === true)
	if (!effort) return undefined

	// Catalog validation includes effort values newer than the pinned SDK's union.
	return {
		reasoning_effort: effort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
	}
}

export const getGeminiReasoning = ({
	model,
	reasoningBudget,
	reasoningEffort,
	settings,
}: GetModelReasoningOptions): GeminiReasoningParams | undefined => {
	// Budget-based (2.5) models: use thinkingBudget, not thinkingLevel.
	if (shouldUseReasoningBudget({ model, settings })) {
		return { thinkingBudget: reasoningBudget!, includeThoughts: true }
	}

	// A selected profile value is not proof that an unknown Gemini model accepts
	// effort-based thinking. Only catalogued capabilities (or an explicit
	// provider declaration) may produce a thinkingLevel payload.
	const effortCapability = model.supportsReasoningEffort
	if (
		effortCapability !== true &&
		(!Array.isArray(effortCapability) || !effortCapability.some((effort) => effort !== "disable"))
	) {
		return undefined
	}

	// For effort-based Gemini models, rely directly on the selected effort value.
	// We intentionally ignore enableReasoningEffort here so that explicitly chosen
	// efforts in the UI (e.g. "High" for gemini-3-pro-preview) always translate
	// into a thinkingConfig, regardless of legacy boolean flags.
	const selectedEffort = settings.reasoningEffort ?? reasoningEffort ?? model.reasoningEffort

	// Respect "off" / unset semantics from the effort selector itself.
	if (!model.requiredReasoningEffort && (!selectedEffort || selectedEffort === "disable")) {
		return undefined
	}

	// Validate that the selected effort is supported by this specific model.
	// e.g. gemini-3-pro-preview only supports ["low", "high"] — sending
	// "medium" (carried over from a different model's settings) causes errors.
	const effortToUse = resolveModelReasoningEffort(model, selectedEffort, model.requiredReasoningEffort === true)

	// Effort-based models on Google GenAI support minimal/low/medium/high levels.
	if (!effortToUse || !isGeminiThinkingLevel(effortToUse)) {
		return undefined
	}

	// Settings retain their lowercase values; the SDK now exposes the wire enum explicitly.
	const thinkingLevels: Record<GeminiThinkingLevel, ThinkingLevel> = {
		minimal: ThinkingLevel.MINIMAL,
		low: ThinkingLevel.LOW,
		medium: ThinkingLevel.MEDIUM,
		high: ThinkingLevel.HIGH,
	}
	return { thinkingLevel: thinkingLevels[effortToUse], includeThoughts: true }
}
