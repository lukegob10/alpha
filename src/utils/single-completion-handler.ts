import type { ProviderSettings } from "@alpha-code/types"

import { buildApiHandler, type SingleCompletionHandler, type ApiHandlerSingleCompletionMetadata } from "../api"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../api/transform/single-completion"

/**
 * Enhances a prompt using the configured API without creating a full Alpha instance or task history.
 * This is a lightweight alternative that only uses the API's completion functionality.
 */
export async function singleCompletionHandler(
	apiConfiguration: ProviderSettings,
	promptText: string,
	metadata?: ApiHandlerSingleCompletionMetadata,
): Promise<string> {
	if (!promptText) {
		throw new Error("No prompt text provided")
	}
	if (!apiConfiguration || !apiConfiguration.apiProvider) {
		throw new Error("No valid API configuration provided")
	}

	throwIfSingleCompletionAborted(metadata)
	const handler = buildApiHandler(apiConfiguration)

	try {
		// Check if handler supports single completions
		if (!("completePrompt" in handler)) {
			throw new Error("The selected API provider does not support prompt enhancement")
		}

		const completionHandler = handler as SingleCompletionHandler
		return await awaitSingleCompletion(
			metadata
				? completionHandler.completePrompt(promptText, metadata)
				: completionHandler.completePrompt(promptText),
			metadata,
		)
	} finally {
		handler.dispose?.()
	}
}
