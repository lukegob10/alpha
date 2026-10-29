import { providerNames, reasoningEffortsExtended } from "@alpha-code/types"

/** Alpha resolves provider/profile selections through saved host configuration; credentials never enter tool calls. */
export function modelSelectionProperties() {
	return {
		provider: {
			type: "string",
			enum: [...providerNames],
			description:
				"Optional canonical provider ID. OpenAI uses openai-native; OpenAI-compatible endpoints use openai; Sign in with ChatGPT uses openai-codex; GitHub Copilot uses vscode-lm. The host selects an existing configured profile; use profile if more than one matches. Provider selection does not change permissions.",
		},
		profile: {
			type: "string",
			minLength: 1,
			description:
				"Optional saved provider profile ID or exact saved name. Call list_provider_profiles to discover the user's current saved choices, then pass the returned ID as profile. Omit model and reasoning_effort to use that profile's configured choices. When provider is also set it must match the profile. Do not supply credentials or endpoint settings.",
		},
		model: {
			type: "string",
			minLength: 1,
			maxLength: 256,
			description:
				"Optional model ID within the selected provider; profile names are not model IDs. A model alone preserves the current provider. If the user names another saved connection or a model on another provider, call list_provider_profiles and select its profile explicitly. Omit model to use that profile's configured model.",
		},
		reasoning_effort: {
			type: "string",
			enum: [...reasoningEffortsExtended],
			description:
				"Optional reasoning effort, separate from the model. The host validates support for the selected model.",
		},
	}
}
