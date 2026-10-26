import { WorkflowFailure } from "./contracts"

export type LiveResponseFault = "pause" | "error" | "empty" | "no-choices"
export type LiveResponseFaultBoundary = "before-output" | "after-text" | "after-thinking" | "after-tool-call"

function matchesBoundary(part: unknown, boundary: LiveResponseFaultBoundary): boolean {
	if (boundary === "after-text" && typeof part === "string") return part.length > 0
	if (!part || typeof part !== "object") return false
	if (boundary === "after-tool-call")
		return (
			"callId" in part &&
			typeof part.callId === "string" &&
			part.callId.length > 0 &&
			"name" in part &&
			typeof part.name === "string" &&
			part.name.length > 0 &&
			"input" in part &&
			!!part.input &&
			typeof part.input === "object" &&
			!Array.isArray(part.input)
		)
	if (!("value" in part)) return false
	const thinking = "id" in part || "metadata" in part || Array.isArray(part.value)
	const visible =
		typeof part.value === "string"
			? part.value.length > 0
			: Array.isArray(part.value) && part.value.some((value) => typeof value === "string" && value.length > 0)
	return visible && (boundary === "after-thinking" ? thinking : boundary === "after-text" && !thinking)
}

/** Test-only interception after a real model response. No replacement model output is synthesized. */
export class LiveResponseFaultController {
	private armed?: LiveResponseFault
	private boundary: LiveResponseFaultBoundary = "before-output"
	private wasArmed = false
	private releasePause?: () => void
	private released = false
	private signalInjected!: () => void
	readonly whenInjected = new Promise<void>((resolve) => {
		this.signalInjected = resolve
	})
	observedParts = 0
	deliveredParts = 0
	deliveredBoundary?: Exclude<LiveResponseFaultBoundary, "before-output">
	injected = false

	arm(fault: LiveResponseFault, boundary: LiveResponseFaultBoundary = "before-output"): void {
		if (this.wasArmed) throw new Error("A fault controller owns exactly one injection")
		if (boundary !== "before-output" && (fault === "empty" || fault === "no-choices"))
			throw new Error("Empty-response faults must precede delivered output")
		this.wasArmed = true
		this.armed = fault
		this.boundary = boundary
	}

	release(): void {
		this.released = true
		this.releasePause?.()
	}

	wrap(response: unknown): unknown {
		const fault = this.armed
		if (!fault) return response
		if (!response || typeof response !== "object" || !("stream" in response))
			throw new WorkflowFailure("harness", "fault_response_unsupported")
		const source = response.stream
		if (!source || typeof source !== "object" || !(Symbol.asyncIterator in source))
			throw new WorkflowFailure("harness", "fault_stream_unsupported")
		this.armed = undefined
		const stream = this.intercept(source as AsyncIterable<unknown>, fault)
		// A facade preserves opaque provider properties and the receiver of host methods.
		return new Proxy(Object.create(response) as object, {
			get(_target, key) {
				if (key === "stream") return stream
				const value: unknown = Reflect.get(response, key, response)
				return typeof value === "function" ? value.bind(response) : value
			},
		})
	}

	private async inject(fault: LiveResponseFault): Promise<void> {
		this.injected = true
		this.signalInjected()
		if (fault === "error") throw new Error("Alpha live test injected a transport interruption")
		if (fault === "no-choices") throw new Error("Response contained no choices.")
		if (fault === "pause" && !this.released)
			await new Promise<void>((resolve) => {
				this.releasePause = resolve
			})
	}

	private async *intercept(source: AsyncIterable<unknown>, fault: LiveResponseFault) {
		try {
			for await (const part of source) {
				this.observedParts++
				if (!this.injected && this.boundary === "before-output") await this.inject(fault)
				if (fault !== "empty") {
					const matched = this.boundary !== "before-output" && matchesBoundary(part, this.boundary)
					this.deliveredParts++
					yield part
					// Resuming after yield proves that the consumer received the matched part.
					// Do not pull another source item before the fault, including at end of stream.
					if (!this.injected && this.boundary !== "before-output" && matched) {
						this.deliveredBoundary = this.boundary
						await this.inject(fault)
					}
				}
			}
		} finally {
			// A tool-only response can finish before a later model step delivers text.
			// Keep sole response ownership while active, then retain an undelivered fault.
			if (!this.injected) this.armed = fault
		}
	}
}
