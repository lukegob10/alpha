/**
 * General error handler for API provider errors
 * Transforms technical errors into user-friendly messages while preserving metadata
 *
 * This utility ensures consistent error handling across all API providers:
 * - Preserves HTTP status codes for UI-aware error display
 * - Maintains error details for retry logic (e.g., RetryInfo for 429 errors)
 * - Provides consistent error message formatting
 * - Enables telemetry and debugging with complete error context
 */

import i18n from "../../../i18n/setup"
import { isAgentRetryCategory } from "../../../core/agent/AgentRetryPolicy"
import { readRetryAfterMs } from "../../../core/agent/RequestPacing"

function errorRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function preserveProviderMetadata(wrapped: Error, source: Record<string, unknown> | undefined): Error {
	if (!source) return wrapped
	// Cancellation identity is part of the retry contract even when its message is opaque.
	if (typeof source.name === "string") wrapped.name = source.name
	for (const key of ["status", "errorDetails", "code", "$metadata"] as const) {
		if (source[key] !== undefined) Object.assign(wrapped, { [key]: source[key] })
	}
	const explicitDelay = source.retryAfterMs
	const retryAfterMs =
		typeof explicitDelay === "number" &&
		Number.isFinite(explicitDelay) &&
		explicitDelay >= 0 &&
		explicitDelay <= Number.MAX_SAFE_INTEGER
			? Math.ceil(explicitDelay)
			: (readRetryAfterMs(errorRecord(source.error)?.headers) ?? readRetryAfterMs(source.headers))
	// Normalize only scheduling advice; raw headers may contain credentials.
	if (retryAfterMs !== undefined) Object.assign(wrapped, { retryAfterMs })
	if (typeof source.retryable === "boolean") Object.assign(wrapped, { retryable: source.retryable })
	if (isAgentRetryCategory(source.retryCategory)) Object.assign(wrapped, { retryCategory: source.retryCategory })
	return wrapped
}

/**
 * Handles API provider errors and transforms them into user-friendly messages
 * while preserving important metadata for retry logic and UI display.
 *
 * @param error - The error to handle
 * @param providerName - The name of the provider for context in error messages
 * @param options - Optional configuration for error handling
 * @returns A wrapped Error with preserved metadata (status, errorDetails, code)
 *
 * @example
 * // Basic usage
 * try {
 *   await apiClient.createMessage(...)
 * } catch (error) {
 *   throw handleProviderError(error, "OpenAI")
 * }
 *
 * @example
 * // With custom message prefix
 * catch (error) {
 *   throw handleProviderError(error, "Anthropic", { messagePrefix: "streaming" })
 * }
 */
export function handleProviderError(
	error: unknown,
	providerName: string,
	options?: {
		/** Custom message prefix (default: "completion") */
		messagePrefix?: string
		/** Custom message transformer */
		messageTransformer?: (msg: string) => string
	},
): Error {
	const messagePrefix = options?.messagePrefix || "completion"
	const source = errorRecord(error)

	if (error instanceof Error) {
		const raw = errorRecord(errorRecord(source?.error)?.metadata)?.raw
		const msg = (typeof raw === "string" && raw) || error.message || ""

		// Log the original error details for debugging
		console.error(`[${providerName}] API error:`, {
			message: msg,
			name: error.name,
			stack: error.stack,
			status: source?.status,
		})

		let wrapped: Error

		// Special case: Invalid character/ByteString conversion error in API key
		// This is specific to OpenAI-compatible SDKs
		if (msg.includes("Cannot convert argument to a ByteString")) {
			wrapped = new Error(i18n.t("common:errors.api.invalidKeyInvalidChars"))
		} else {
			// Apply custom transformer if provided, otherwise use default format
			const finalMessage = options?.messageTransformer
				? options.messageTransformer(msg)
				: `${providerName} ${messagePrefix} error: ${msg}`
			wrapped = new Error(finalMessage)
		}

		return preserveProviderMetadata(wrapped, source)
	}

	// Non-Error: wrap with provider-specific prefix
	console.error(`[${providerName}] Non-Error exception:`, { message: String(error), status: source?.status })
	const wrapped = new Error(`${providerName} ${messagePrefix} error: ${String(error)}`)
	return preserveProviderMetadata(wrapped, source)
}

/**
 * Specialized handler for OpenAI-compatible providers
 * Re-exports with OpenAI-specific defaults for backward compatibility
 */
export function handleOpenAIError(error: unknown, providerName: string): Error {
	return handleProviderError(error, providerName, { messagePrefix: "completion" })
}
