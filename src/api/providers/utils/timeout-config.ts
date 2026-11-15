import * as vscode from "vscode"
import { Package } from "../../../shared/package"

const DEFAULT_API_REQUEST_TIMEOUT_SECONDS = 600

export class ApiRequestTimeoutError extends Error {
	readonly code = "ProviderTimeout"
	readonly timeoutScope = "provider_idle"
	readonly retryable = true
	constructor(
		operationName: string,
		readonly timeoutMs: number,
	) {
		super(formatApiRequestTimeoutError(operationName, timeoutMs))
		this.name = "ApiRequestTimeoutError"
	}
}

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

/** Reuses one Node timer across sequential reads of a response stream. */
export class ApiRequestIdleTimeout {
	private timer: ReturnType<typeof setTimeout> | undefined
	private expire: (() => void) | undefined

	constructor(
		private readonly operationName: string,
		private readonly timeoutMs: number | undefined,
		private readonly onTimeout?: (error: ApiRequestTimeoutError) => void,
	) {}

	async wait<T>(operation: PromiseLike<T>): Promise<T> {
		const { timeoutMs } = this
		if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation

		const timeout = new Promise<never>((_resolve, reject) => {
			this.expire = () => {
				const error = new ApiRequestTimeoutError(this.operationName, timeoutMs)
				try {
					this.onTimeout?.(error)
				} catch {
					// The timeout error below is the actionable failure.
				}
				reject(error)
			}
			if (this.timer) this.timer.refresh().ref()
			else this.timer = setTimeout(() => this.expire?.(), timeoutMs)
		})

		try {
			return await Promise.race([operation, timeout])
		} finally {
			// A stream consumer can pause between reads. Only a pending read can expire.
			this.expire = undefined
			this.timer?.unref()
		}
	}

	dispose() {
		if (this.timer !== undefined) clearTimeout(this.timer)
		this.timer = undefined
	}
}

export async function withApiRequestTimeout<T>(
	operation: PromiseLike<T>,
	operationName: string,
	timeoutMs = getApiRequestTimeout(),
	onTimeout?: () => void,
): Promise<T> {
	const timeout = new ApiRequestIdleTimeout(operationName, timeoutMs, onTimeout)
	try {
		return await timeout.wait(operation)
	} finally {
		timeout.dispose()
	}
}
