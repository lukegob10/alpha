import { WorkflowFailure } from "./contracts"

export type LiveResponseFault = "pause" | "error" | "empty" | "no-choices"

/** Test-only interception after a real model response. No replacement model output is synthesized. */
export class LiveResponseFaultController {
	private armed?: LiveResponseFault
	private wasArmed = false
	private releasePause?: () => void
	private released = false
	private signalInjected!: () => void
	readonly whenInjected = new Promise<void>((resolve) => {
		this.signalInjected = resolve
	})
	observedParts = 0
	injected = false

	arm(fault: LiveResponseFault): void {
		if (this.wasArmed) throw new Error("A fault controller owns exactly one injection")
		this.wasArmed = true
		this.armed = fault
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

	private async *intercept(source: AsyncIterable<unknown>, fault: LiveResponseFault) {
		for await (const part of source) {
			this.observedParts++
			if (!this.injected) {
				this.injected = true
				this.signalInjected()
				if (fault === "error") throw new Error("Alpha live test injected a transport interruption")
				if (fault === "no-choices") throw new Error("Response contained no choices.")
				if (fault === "pause" && !this.released)
					await new Promise<void>((resolve) => {
						this.releasePause = resolve
					})
			}
			if (fault !== "empty") yield part
		}
	}
}
