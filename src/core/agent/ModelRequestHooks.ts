import type { ApiStream, ApiStreamChunk } from "../../api/transform/stream"
import { ApiStreamDeadlineError } from "../../api/transform/stream"
import { ApiRequestTimeoutError } from "../../api/providers/utils/timeout-config"

export interface ModelRequestHookTokenUsage {
	input_tokens: number
	cached_input_tokens: number
	output_tokens: number
	reasoning_output_tokens: number
	total_tokens: number
}

export type ModelRequestHookEvent =
	| { hook_event_name: "PreModelRequest" }
	| {
			hook_event_name: "PostModelRequest"
			status: "completed" | "failed" | "cancelled"
			error: string | null
			token_usage: ModelRequestHookTokenUsage | null
	  }

interface ModelRequestObserver {
	signal: AbortSignal
	onEvent: (event: ModelRequestHookEvent) => Promise<void>
	onError: (error: unknown, event: ModelRequestHookEvent) => void
	/** The existing Task resource owner can fence unconfirmed hook cleanup. */
	beforeRequest?: () => Promise<void>
}

/**
 * Observe one physical attempt without choosing retries or changing stream output.
 * Codex 8806313 model_request.rs keeps these hooks observational, including JSON stdout.
 */
export async function* observeModelRequestStream(
	createStream: () => ApiStream,
	observer: ModelRequestObserver,
): ApiStream {
	const notify = async (event: ModelRequestHookEvent) => {
		try {
			await observer.onEvent(event)
		} catch (error) {
			observer.onError(error, event)
		}
	}
	await notify({ hook_event_name: "PreModelRequest" })
	let usage: ModelRequestHookTokenUsage | null = null
	let completed = false
	let failure: unknown
	let errorChunk = false
	let terminal: Extract<ApiStreamChunk, { type: "outcome" }> | undefined
	let post: Promise<void> | undefined
	const finish = (status: "completed" | "failed" | "cancelled", error: string | null) =>
		(post ??= notify({
			hook_event_name: "PostModelRequest",
			status,
			error,
			token_usage: usage ? { ...usage } : null,
		}))
	// A provider can ignore cancellation and strand next()/return(). The captured
	// attempt still emits its single cancelled observation, without awaiting transport.
	const timedOut = () =>
		observer.signal.reason instanceof ApiStreamDeadlineError ||
		observer.signal.reason instanceof ApiRequestTimeoutError
	const responseCompleted = () => terminal?.status === "completed" && !errorChunk
	const responseFailed = () => errorChunk || terminal?.status === "failed" || terminal?.status === "incomplete"
	const onAbort = () => {
		const failed = !responseCompleted() && (responseFailed() || timedOut())
		void finish(
			responseCompleted() ? "completed" : failed ? "failed" : "cancelled",
			failed ? (timedOut() ? "Model request timed out." : "Model request failed.") : null,
		)
	}
	observer.signal.addEventListener("abort", onAbort, { once: true })
	try {
		if (observer.signal.aborted) {
			onAbort()
			throw observer.signal.reason ?? new Error("Request cancelled by user")
		}
		await observer.beforeRequest?.()
		if (observer.signal.aborted) throw observer.signal.reason ?? new Error("Request cancelled by user")
		for await (const chunk of createStream()) {
			if (observer.signal.aborted) throw observer.signal.reason ?? new Error("Request cancelled by user")
			if (chunk.type === "usage" && chunk.usageSource === "provider") {
				usage ??= {
					input_tokens: 0,
					cached_input_tokens: 0,
					output_tokens: 0,
					reasoning_output_tokens: 0,
					total_tokens: 0,
				}
				usage.input_tokens += chunk.inputTokens
				usage.cached_input_tokens += chunk.cacheReadTokens ?? 0
				usage.output_tokens += chunk.outputTokens
				usage.reasoning_output_tokens += chunk.reasoningTokens ?? 0
				usage.total_tokens = usage.input_tokens + usage.output_tokens
			} else if (chunk.type === "outcome") terminal = chunk
			else if (chunk.type === "error") errorChunk = true
			yield chunk
		}
		if (observer.signal.aborted) throw observer.signal.reason ?? new Error("Request cancelled by user")
		completed = true
	} catch (error) {
		failure = error
		throw error
	} finally {
		observer.signal.removeEventListener("abort", onAbort)
		const cancelled =
			!responseCompleted() &&
			!responseFailed() &&
			((observer.signal.aborted && !timedOut()) || terminal?.status === "cancelled" || (!completed && !failure))
		// Legacy providers use clean EOF as a successful physical request. An
		// explicit incomplete outcome instead records a truncated response.
		const failed = !responseCompleted() && !cancelled && (failure !== undefined || responseFailed())
		await finish(
			cancelled ? "cancelled" : failed ? "failed" : "completed",
			// Provider messages can echo headers or prompt fragments. The ordinary
			// error path owns those diagnostics; observational hooks receive no body.
			failed ? "Model request failed." : null,
		)
	}
}
