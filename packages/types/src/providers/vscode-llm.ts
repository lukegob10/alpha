import type { ModelInfo } from "../model.js"

export type VscodeLlmModelId = keyof typeof vscodeLlmModels

export const vscodeLlmDefaultModelId: VscodeLlmModelId = "gpt-5.5"

const COPILOT_DEFAULT_CONTEXT_WINDOW = 128_000
const COPILOT_EXTENDED_CONTEXT_WINDOW = 1_000_000
const COPILOT_REASONING_EFFORTS: ModelInfo["supportsReasoningEffort"] = ["none", "low", "medium", "high"]

function copilotModel({
	name,
	family,
	version = family,
	contextWindow = COPILOT_DEFAULT_CONTEXT_WINDOW,
	supportsImages = false,
	supportsReasoningEffort,
	deprecated,
}: {
	name: string
	family: string
	version?: string
	contextWindow?: number
	supportsImages?: boolean
	supportsReasoningEffort?: ModelInfo["supportsReasoningEffort"]
	deprecated?: boolean
}) {
	return {
		contextWindow,
		maxInputTokens: contextWindow,
		maxTokens: -1,
		supportsImages,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		family,
		version,
		name,
		supportsToolCalling: true,
		supportsReasoningEffort,
		deprecated,
	}
}

// Mirrors the current GitHub Copilot supported-models documentation. The live
// VS Code LM provider still uses vscode.lm.selectChatModels() as the source of truth.
// https://docs.github.com/en/copilot/reference/ai-models/supported-models
export const vscodeLlmModels = {
	"gpt-5-mini": copilotModel({
		name: "GPT-5 mini",
		family: "gpt-5-mini",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.3-codex": copilotModel({
		name: "GPT-5.3-Codex",
		family: "gpt-5.3-codex",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.4": copilotModel({
		name: "GPT-5.4",
		family: "gpt-5.4",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.4-mini": copilotModel({
		name: "GPT-5.4 mini",
		family: "gpt-5.4-mini",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.4-nano": copilotModel({
		name: "GPT-5.4 nano",
		family: "gpt-5.4-nano",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gpt-5.5": copilotModel({
		name: "GPT-5.5",
		family: "gpt-5.5",
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"claude-haiku-4.5": copilotModel({
		name: "Claude Haiku 4.5",
		family: "claude-haiku-4.5",
	}),
	"claude-sonnet-4.5": copilotModel({
		name: "Claude Sonnet 4.5",
		family: "claude-sonnet-4.5",
		supportsImages: true,
	}),
	"claude-sonnet-4.6": copilotModel({
		name: "Claude Sonnet 4.6",
		family: "claude-sonnet-4.6",
		contextWindow: COPILOT_EXTENDED_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"claude-opus-4.5": copilotModel({
		name: "Claude Opus 4.5",
		family: "claude-opus-4.5",
		supportsImages: true,
	}),
	"claude-opus-4.6": copilotModel({
		name: "Claude Opus 4.6",
		family: "claude-opus-4.6",
		contextWindow: COPILOT_EXTENDED_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"claude-opus-4.6-fast": copilotModel({
		name: "Claude Opus 4.6 (fast mode)",
		family: "claude-opus-4.6-fast",
		contextWindow: COPILOT_EXTENDED_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"claude-opus-4.7": copilotModel({
		name: "Claude Opus 4.7",
		family: "claude-opus-4.7",
		contextWindow: COPILOT_EXTENDED_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"claude-opus-4.8": copilotModel({
		name: "Claude Opus 4.8",
		family: "claude-opus-4.8",
		contextWindow: COPILOT_EXTENDED_CONTEXT_WINDOW,
		supportsImages: true,
		supportsReasoningEffort: COPILOT_REASONING_EFFORTS,
	}),
	"gemini-2.5-pro": copilotModel({
		name: "Gemini 2.5 Pro",
		family: "gemini-2.5-pro",
		supportsImages: true,
	}),
	"gemini-3-flash": copilotModel({
		name: "Gemini 3 Flash",
		family: "gemini-3-flash",
		supportsImages: true,
	}),
	"gemini-3.1-pro": copilotModel({
		name: "Gemini 3.1 Pro",
		family: "gemini-3.1-pro",
		supportsImages: true,
	}),
	"gemini-3.5-flash": copilotModel({
		name: "Gemini 3.5 Flash",
		family: "gemini-3.5-flash",
		supportsImages: true,
	}),
	"mai-code-1-flash": copilotModel({
		name: "MAI-Code-1-Flash",
		family: "mai-code-1-flash",
	}),
	"raptor-mini": copilotModel({
		name: "Raptor mini",
		family: "raptor-mini",
	}),
	"gpt-4.1": copilotModel({
		name: "GPT-4.1",
		family: "gpt-4.1",
		deprecated: true,
	}),
	"gpt-5.2": copilotModel({
		name: "GPT-5.2",
		family: "gpt-5.2",
		deprecated: true,
	}),
	"gpt-5.2-codex": copilotModel({
		name: "GPT-5.2-Codex",
		family: "gpt-5.2-codex",
		deprecated: true,
	}),
} as const satisfies Record<
	string,
	ModelInfo & {
		family: string
		version: string
		name: string
		supportsToolCalling: boolean
		maxInputTokens: number
	}
>
