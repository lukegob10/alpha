import type { ProviderSettings, ModelProbeResult } from "@alpha-code/types"
import { buildApiHandler, type ApiHandler } from "./index"
import { createLinkedAbortController, iterateApiStreamWithAbort, raceApiStreamAbort } from "./transform/stream"

/** One bounded, tool-free readiness request through Alpha's actual provider adapter. */
export async function probeModel(configuration: ProviderSettings, signal?: AbortSignal): Promise<ModelProbeResult> {
	const control = createLinkedAbortController({ signal, deadline: Date.now() + 60_000 })
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
	try {
		handler = buildApiHandler(structuredClone(configuration))
		if (!handler.streamCapabilities?.cancellation) {
			result.failureCode = "cancellation_unsupported"
			return result
		}
		if (handler.prepareModel)
			await raceApiStreamAbort(
				handler.prepareModel({ signal: control.signal, deadline: Date.now() + 60_000 }),
				control.signal,
			)
		control.signal.throwIfAborted()
		result.modelId = handler.getModel().id
		result.requests = 1
		let text = false
		let completed = !handler.streamCapabilities.lifecycle
		let failed = false
		for await (const chunk of iterateApiStreamWithAbort(
			handler.createMessage(
				"Reply with OK to this readiness check.",
				[{ role: "user", content: "Check model readiness." }],
				{
					taskId: "alpha-readiness-probe",
					signal: control.signal,
					deadline: Date.now() + 60_000,
					tools: [],
					tool_choice: "none",
					store: false,
					suppressPreviousResponseId: true,
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
				completed = chunk.terminal && chunk.status === "completed"
				failed ||= !completed
			} else if (chunk.type === "error" || chunk.type.startsWith("tool_call")) failed = true
		}
		if (text && completed && !failed) {
			result.status = "completed"
			result.failureCode = null
		} else result.failureCode = text ? "incomplete_response" : "empty_response"
	} catch {
		result.failureCode = control.signal.aborted ? "cancelled_or_deadline" : "request_failed"
	} finally {
		if (handler && "dispose" in handler && typeof handler.dispose === "function") {
			try {
				handler.dispose()
			} catch {
				result.status = "failed"
				result.failureCode = "request_failed"
			}
		}
		control.dispose()
		result.wallMs = performance.now() - start
	}
	return result
}
