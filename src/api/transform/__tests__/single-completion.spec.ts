import { describe, expect, it, vi } from "vitest"

import { awaitSingleCompletion } from "../single-completion"

describe("single completion cancellation boundary", () => {
	it("rejects a noncooperative operation and detaches its caller listener", async () => {
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		const reason = new Error("Cancelled by caller")
		const completion = awaitSingleCompletion(new Promise<string>(() => undefined), { signal: controller.signal })
		const rejected = expect(completion).rejects.toBe(reason)
		controller.abort(reason)
		await rejected
		expect(add).toHaveBeenCalledOnce()
		expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1])
	})

	it("preserves cancellation when an SDK result wins the same event-loop boundary", async () => {
		const controller = new AbortController()
		const reason = new Error("Superseded draft")
		const result = awaitSingleCompletion(Promise.resolve("Stale enhancement"), { signal: controller.signal })
		controller.abort(reason)
		await expect(result).rejects.toBe(reason)
	})

	it("preserves caller cancellation over a concurrent SDK rejection", async () => {
		const controller = new AbortController()
		const reason = new Error("User cancelled")
		const result = awaitSingleCompletion(Promise.reject(new Error("Connection closed")), {
			signal: controller.signal,
		})
		controller.abort(reason)
		await expect(result).rejects.toBe(reason)
	})

	it("preserves a provider failure when the caller remains active", async () => {
		const failure = new Error("Provider unavailable")
		await expect(
			awaitSingleCompletion(Promise.reject(failure), { signal: new AbortController().signal }),
		).rejects.toBe(failure)
	})
})
