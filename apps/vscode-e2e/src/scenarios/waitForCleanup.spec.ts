import { strict as assert } from "node:assert"
import { test } from "node:test"
import { setTimeout as schedule, clearTimeout as cancel } from "node:timers"

import { waitFor } from "../suite/utils"

test("waitFor releases its deadline timer when the condition rejects and preserves the original failure", async (context) => {
	const pending = new Set<ReturnType<typeof schedule>>()
	context.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
		const timer = schedule(callback, delay)
		pending.add(timer)
		return timer
	})
	context.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof schedule>) => {
		pending.delete(timer)
		cancel(timer)
	})
	const failure = new Error("controlled condition failure")
	try {
		await assert.rejects(
			waitFor(
				() => {
					throw failure
				},
				{ timeout: 1_000 },
			),
			(error: unknown) => error === failure,
		)
		assert.equal(pending.size, 0, "a rejected condition must not retain its deadline timer")
	} finally {
		context.mock.restoreAll()
		for (const timer of pending) cancel(timer)
	}
})
