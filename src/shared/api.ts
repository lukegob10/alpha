import {
	isProviderName,
	isFauxProvider,
	type ModelInfo,
	type ProviderSettings,
	ANTHROPIC_DEFAULT_MAX_TOKENS,
} from "@alpha-code/types"

/** Reject saved unsupported IDs before changing task lifecycle or provider state. */
export function assertSupportedApiProvider(provider: unknown): void {
	if (
		provider === undefined ||
		isProviderName(provider) ||
		(typeof provider === "string" && isFauxProvider(provider))
	)
		return
	throw new Error(`Unsupported API provider: ${String(provider)}`)
}

// ApiHandlerOptions
// Extend ProviderSettings (minus apiProvider) with handler-specific toggles.
// Task-level reasoning overrides are runtime-only and are deliberately not part
// of ProviderSettings, which is persisted as a provider profile.
export type TaskReasoningRuntimeOptions = {
	taskReasoningCustomEffort?: string
}

export type ApiHandlerOptions = Omit<ProviderSettings, "apiProvider"> &
	TaskReasoningRuntimeOptions & {
		/**
		 * When true and using OpenAI Responses API models that support reasoning summaries,
		 * include reasoning.summary: "auto" so the API returns summaries (we already parse
		 * and surface them). Defaults to true; set to false to disable summaries.
		 */
		enableResponsesReasoningSummary?: boolean
	}

// Reasoning

export const shouldUseReasoningBudget = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => !!model.requiredReasoningBudget || (!!model.supportsReasoningBudget && !!settings?.enableReasoningEffort)

export const shouldUseReasoningEffort = ({
	model,
	settings,
}: {
	model: ModelInfo
	settings?: ProviderSettings
}): boolean => {
	// Explicit off switch
	if (settings?.enableReasoningEffort === false) return false

	// Selected effort from settings or model default
	const selectedEffort = (settings?.reasoningEffort ?? (model as any).reasoningEffort) as
		| "disable"
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| undefined

	// "disable" explicitly omits reasoning
	if (selectedEffort === "disable") return false

	const cap = model.supportsReasoningEffort as unknown

	// Capability array: use only if selected is included (treat "none"/"minimal" as valid)
	if (Array.isArray(cap)) {
		return !!selectedEffort && (cap as ReadonlyArray<string>).includes(selectedEffort as string)
	}

	// Boolean capability: true → require a selected effort
	if (model.supportsReasoningEffort === true) {
		return !!selectedEffort
	}

	// Not explicitly supported: only allow when the model itself defines a default effort
	// Ignore settings-only selections when capability is absent/false
	const modelDefaultEffort = (model as any).reasoningEffort as
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| undefined
	return !!modelDefaultEffort
}

export const DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS = 16_384
export const DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS = 8_192
export const GEMINI_25_PRO_MIN_THINKING_TOKENS = 128

// Max Tokens

export const getModelMaxOutputTokens = ({
	modelId,
	model,
	settings,
	format,
}: {
	modelId: string
	model: ModelInfo
	settings?: ProviderSettings
	format?: "anthropic" | "openai" | "gemini"
}): number | undefined => {
	if (shouldUseReasoningBudget({ model, settings })) {
		return settings?.modelMaxTokens || DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS
	}

	const isAnthropicContext = modelId.includes("claude") || format === "anthropic"

	// For "Hybrid" reasoning models, discard the model's actual maxTokens for Anthropic contexts
	if (model.supportsReasoningBudget && isAnthropicContext) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// For Anthropic contexts, always ensure a maxTokens value is set
	if (isAnthropicContext && (!model.maxTokens || model.maxTokens === 0)) {
		return ANTHROPIC_DEFAULT_MAX_TOKENS
	}

	// If model has explicit maxTokens, clamp it to 20% of the context window
	// Exception: GPT-5 models should use their exact configured max output tokens
	if (model.maxTokens) {
		// Check if this is a GPT-5 model (case-insensitive)
		const isGpt5Model = modelId.toLowerCase().includes("gpt-5")

		// GPT-5 models bypass the 20% cap and use their full configured max tokens
		if (isGpt5Model) {
			return model.maxTokens
		}

		// All other models are clamped to 20% of context window
		return Math.min(model.maxTokens, Math.ceil(model.contextWindow * 0.2))
	}

	// For non-Anthropic formats without explicit maxTokens, return undefined
	if (format) {
		return undefined
	}

	// Default fallback
	return ANTHROPIC_DEFAULT_MAX_TOKENS
}

/** Normalize output reservation once for context budgeting and its UI projection. */
export function getModelReservedOutputTokens(options: Parameters<typeof getModelMaxOutputTokens>[0]): number {
	if (options.model.contextWindowIncludesOutput === false) return 0
	const tokens = getModelMaxOutputTokens(options)
	return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
		? Math.ceil(tokens)
		: ANTHROPIC_DEFAULT_MAX_TOKENS
}
