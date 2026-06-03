import * as vscode from "vscode"
import { Package } from "../../../shared/package"

const DEFAULT_API_REQUEST_TIMEOUT_SECONDS = 600

/**
 * Gets the API request timeout from VSCode configuration with validation.
 *
 * @returns The timeout in milliseconds. Returns undefined to disable timeout
 *          (letting the SDK use its default), or a positive number for explicit timeout.
 */
export function getApiRequestTimeout(): number | undefined {
	// Get timeout with validation to ensure it's a valid non-negative number
	const configTimeout =
		vscode.workspace
			?.getConfiguration?.(Package.name)
			?.get<number>("apiRequestTimeout", DEFAULT_API_REQUEST_TIMEOUT_SECONDS) ??
		DEFAULT_API_REQUEST_TIMEOUT_SECONDS

	// Validate that it's actually a number and not NaN
	if (typeof configTimeout !== "number" || isNaN(configTimeout)) {
		return DEFAULT_API_REQUEST_TIMEOUT_SECONDS * 1000
	}

	// 0 or negative means "no timeout" - return undefined to let SDK use its default
	// (OpenAI SDK interprets 0 as "abort immediately", so we return undefined instead)
	if (configTimeout <= 0) {
		return undefined
	}

	return configTimeout * 1000 // Convert to milliseconds
}

export function formatApiRequestTimeoutError(operationName: string, timeoutMs: number): string {
	const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
	const unit = timeoutSeconds === 1 ? "second" : "seconds"
	return `${operationName} timed out after ${timeoutSeconds} ${unit}.`
}

export async function withApiRequestTimeout<T>(
	operation: PromiseLike<T>,
	operationName: string,
	timeoutMs = getApiRequestTimeout(),
	onTimeout?: () => void,
): Promise<T> {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return operation
	}

	let timeout: ReturnType<typeof setTimeout> | undefined

	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			try {
				onTimeout?.()
			} catch {
				// The timeout error below is the actionable failure.
			}

			reject(new Error(formatApiRequestTimeoutError(operationName, timeoutMs)))
		}, timeoutMs)
	})

	try {
		return await Promise.race([operation, timeoutPromise])
	} finally {
		if (timeout) {
			clearTimeout(timeout)
		}
	}
}
