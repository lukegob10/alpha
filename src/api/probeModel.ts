import type { ProviderSettings, ModelProbeResult } from "@alpha-code/types"
import { buildApiHandler, type ApiHandler } from "./index"
import {
	createLinkedAbortController,
	isApiStreamAbortError,
	iterateApiStreamWithAbort,
	raceApiStreamAbort,
} from "./transform/stream"

/** One bounded, tool-free readiness request through Alpha's actual provider adapter. */
export async function probeModel(configuration: ProviderSettings, signal?: AbortSignal): Promise<ModelProbeResult> {
	const deadline = Date.now() + 60_000
	const control = createLinkedAbortController({ signal, deadline })
	const start = performance.now()
	const result: ModelProbeResult = {
		status: "failed",
		requests: 0,
		modelId: null,
		firstTextMs: null,
		wallMs: 0,
		usage: null,
		failureCode: "request_failed",
	}
	let handler: ApiHandler | undefined
	let observingPhase = true
	try {
		handler = buildApiHandler(structuredClone(configuration))
		if (!handler.streamCapabilities?.cancellation) {
			result.failureCode = "cancellation_unsupported"
			return result
		}
		if (handler.prepareModel) {
			result.requestPhase = "model-selection"
			await raceApiStreamAbort(handler.prepareModel({ signal: control.signal, deadline }), control.signal)
		}
		control.signal.throwIfAborted()
		result.modelId = handler.getModel().id
		result.requests = 1
		let text = false
		let completed = !handler.streamCapabilities.lifecycle
		let failed = false
		let cancelled = false
		let terminalAccepted = false
		for await (const chunk of iterateApiStreamWithAbort(
			handler.createMessage(
				"Reply with OK to this readiness check.",
				[{ role: "user", content: "Check model readiness." }],
				{
					taskId: "alpha-readiness-probe",
					signal: control.signal,
					deadline,
					tools: [],
					tool_choice: "none",
					store: false,
					suppressPreviousResponseId: true,
					onRequestPhase: (phase) => {
						if (
							observingPhase &&
							!control.signal.aborted &&
							(phase === "model-selection" ||
								phase === "request-admission" ||
								phase === "first-response-chunk" ||
								phase === "response-stream")
						)
							result.requestPhase = phase
					},
				},
			),
			control.signal,
		)) {
			if (chunk.type === "text" && chunk.text.trim()) {
				text = true
				result.firstTextMs ??= performance.now() - start
			} else if (chunk.type === "usage")
				result.usage = {
					inputTokens: chunk.inputTokens,
					outputTokens: chunk.outputTokens,
					source: chunk.usageSource ?? "unknown",
					cost: chunk.totalCost ?? null,
				}
			else if (chunk.type === "outcome") {
				control.signal.throwIfAborted()
				completed = chunk.terminal && chunk.status === "completed" && !chunk.requiresContinuation
				failed ||= !completed
				cancelled ||= chunk.status === "cancelled"
				if (chunk.terminal) {
					terminalAccepted = true
					observingPhase = false
					break
				}
			} else if (chunk.type === "error" || chunk.type.startsWith("tool_call")) failed = true
		}
		// The abort-aware iterator may finish cleanly when it races a stalled provider.
		// Cancellation still owns the terminal result, including after partial output.
		if (!terminalAccepted) control.signal.throwIfAborted()
		if (cancelled) result.failureCode = "cancelled_or_deadline"
		else if (text && completed && !failed) {
			result.status = "completed"
			result.failureCode = null
		} else result.failureCode = text ? "incomplete_response" : "empty_response"
	} catch (error) {
		result.failureCode = isApiStreamAbortError(error, control.signal) ? "cancelled_or_deadline" : "request_failed"
	} finally {
		observingPhase = false
		if (handler && "dispose" in handler && typeof handler.dispose === "function") {
			try {
				handler.dispose()
			} catch {
				result.status = "failed"
				if (result.failureCode !== "cancelled_or_deadline") result.failureCode = "request_failed"
			}
		}
		control.dispose()
		result.wallMs = performance.now() - start
	}
	return result
}
