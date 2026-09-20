import { BetaThinkingConfigParam } from "@anthropic-ai/sdk/resources/beta"
import OpenAI from "openai"
import { ThinkingLevel, type GenerateContentConfig } from "@google/genai"

import type { ModelInfo, ProviderSettings, ReasoningEffortExtended } from "@alpha-code/types"

import { shouldUseReasoningBudget, shouldUseReasoningEffort } from "../../shared/api"

export type AlphaReasoningParams = {
	enabled?: boolean
	effort?: ReasoningEffortExtended
}

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

export const getAlphaReasoning = ({
	model,
	reasoningEffort,
	settings,
}: GetModelReasoningOptions): AlphaReasoningParams | undefined => {
	// Check if model supports reasoning effort
	if (!model.supportsReasoningEffort) {
		return undefined
	}

	if (model.requiredReasoningEffort) {
		// Honor the provided effort if it's valid, otherwise let the model choose.
		if (reasoningEffort && reasoningEffort !== "disable" && reasoningEffort !== "minimal") {
			return { enabled: true, effort: reasoningEffort }
		} else {
			return { enabled: true }
		}
	}

	// Explicit off switch from settings: always send disabled for back-compat and to
	// prevent automatic reasoning when the toggle is turned off.
	if (settings.enableReasoningEffort === false) {
		return { enabled: false }
	}

	// For Alpha models that support reasoning effort, absence of a selection should be
	// treated as an explicit "off" signal so that the backend does not auto-enable
	// reasoning. This aligns with the default behavior in tests.
	if (!reasoningEffort) {
		return { enabled: false }
	}

	// "disable" is a legacy sentinel that means "omit the reasoning field entirely"
	// and let the server decide any defaults.
	if (reasoningEffort === "disable") {
		return undefined
	}

	// For Alpha, "minimal" is treated as "none" for effort-based reasoning – we omit
	// the reasoning field entirely instead of sending an explicit effort.
	if (reasoningEffort === "minimal") {
		return undefined
	}

	// When an effort is provided (e.g. "low" | "medium" | "high" | "none"), enable
	// with the selected effort.
	return { enabled: true, effort: reasoningEffort as ReasoningEffortExtended }
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
	if (!shouldUseReasoningEffort({ model, settings })) return undefined
	if (reasoningEffort === "disable" || !reasoningEffort) return undefined

	// Include "none" | "minimal" | "low" | "medium" | "high" literally
	return {
		reasoning_effort: reasoningEffort as OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"],
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
	const selectedEffort = (settings.reasoningEffort ?? model.reasoningEffort) as
		| ReasoningEffortExtended
		| "disable"
		| undefined

	// Respect "off" / unset semantics from the effort selector itself.
	if (!selectedEffort || selectedEffort === "disable") {
		return undefined
	}

	// Validate that the selected effort is supported by this specific model.
	// e.g. gemini-3-pro-preview only supports ["low", "high"] — sending
	// "medium" (carried over from a different model's settings) causes errors.
	const effortToUse =
		Array.isArray(model.supportsReasoningEffort) &&
		isGeminiThinkingLevel(selectedEffort) &&
		!model.supportsReasoningEffort.includes(selectedEffort)
			? model.reasoningEffort
			: selectedEffort

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
