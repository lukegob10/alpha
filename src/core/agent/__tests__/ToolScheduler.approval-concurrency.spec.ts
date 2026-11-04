import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture() {
	const firstApproval = deferred()
	const releaseApproval = deferred()
	const secondQueued = deferred()
	const bothEffects = deferred()
	const releaseEffects = deferred()
	const effects: string[] = []
	const approvals: string[] = []
	let activeApproval = false
	const host: ToolExecutionHost = {
		taskId: "streamed-read-approvals",
		cwd: process.cwd(),
		userMessageContent: [],
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		requestToolApproval: vi.fn(async (request) => {
			if (activeApproval) throw new Error("Task already has a pending tool approval request.")
			activeApproval = true
			approvals.push(request.callId)
			try {
				if (request.callId === "first") {
					firstApproval.resolve()
					await releaseApproval.promise
				}
				return { decision: "approve_once" as const }
			} finally {
				activeApproval = false
			}
		}),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "read_file",
		aliases: [],
		schema: { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: true },
		execute: async ({ call, callbacks }) => {
			const approval = callbacks.askApproval("tool", "Read " + call.id)
			if (call.id === "second") secondQueued.resolve()
			if (!(await approval)) return
			effects.push(call.id!)
			if (effects.length === 2) bothEffects.resolve()
			await releaseEffects.promise
			callbacks.pushToolResult("Read " + call.id)
		},
	})
	const run = (id: string, signal?: AbortSignal) =>
		new ToolScheduler({
			executionHost: { ...host, taskFacade: host as unknown as Task },
			registry,
			mode: "code",
			signal,
			preserveAbortedResults: true,
			validateCall: () => undefined,
		}).run([{ type: "tool_call", id, name: "read_file", arguments: { path: id + ".txt" } }])
	return { host, run, approvals, effects, firstApproval, releaseApproval, secondQueued, bothEffects, releaseEffects }
}

describe("approvals across streamed-read schedulers", () => {
	it("serializes a shared task's prompts while approved sibling reads remain in flight", async () => {
		const f = fixture()
		const first = f.run("first")
		await f.firstApproval.promise
		const second = f.run("second")
		await f.secondQueued.promise
		const completed = Promise.all([first, second])
		try {
			// All fixture dependencies except the held review settle in microtasks.
			// Let both schedulers reach admission before allowing that review to end.
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(f.host.requestToolApproval).toHaveBeenCalledTimes(1)
			f.releaseApproval.resolve()
			await Promise.race([
				f.bothEffects.promise,
				second.then((outcome) => expect(outcome.results[0]?.status).toBe("success")),
			])
			expect(f.approvals).toEqual(["first", "second"])
			expect(f.effects).toEqual(["first", "second"])
		} finally {
			f.releaseApproval.resolve()
			f.releaseEffects.resolve()
			await completed
		}
		const outcomes = await completed
		expect(outcomes.map((outcome) => outcome.results[0]?.status)).toEqual(["success", "success"])
		expect(f.host.userMessageContent).toHaveLength(2)
	})

	it("cancels a queued scheduler without waiting for another scheduler's active approval", async () => {
		const f = fixture()
		const first = f.run("first")
		await f.firstApproval.promise
		const cancellation = new AbortController()
		const second = f.run("second", cancellation.signal)
		await f.secondQueued.promise
		cancellation.abort()
		try {
			const outcome = await second
			expect(outcome.results).toMatchObject([{ callId: "second", status: "cancelled" }])
			expect(f.approvals).toEqual(["first"])
			expect(f.effects).toEqual([])
		} finally {
			f.releaseApproval.resolve()
			f.releaseEffects.resolve()
		}
		await first
		expect(f.host.userMessageContent).toHaveLength(2)
	})

	it("keeps another task's approval independent of a blocked task", async () => {
		const blocked = fixture()
		const other = fixture()
		const first = blocked.run("first")
		await blocked.firstApproval.promise
		other.releaseEffects.resolve()
		try {
			const outcome = await other.run("other")
			expect(outcome.results[0]?.status).toBe("success")
			expect(blocked.effects).toEqual([])
		} finally {
			blocked.releaseApproval.resolve()
			blocked.releaseEffects.resolve()
		}
		await first
	})

	it("keeps later approvals behind the active review after a queued request is cancelled", async () => {
		const f = fixture()
		const first = f.run("first")
		await f.firstApproval.promise
		const cancellation = new AbortController()
		const second = f.run("second", cancellation.signal)
		await f.secondQueued.promise
		cancellation.abort()
		await second
		const third = f.run("third")
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(f.host.requestToolApproval).toHaveBeenCalledTimes(1)
		} finally {
			f.releaseApproval.resolve()
			f.releaseEffects.resolve()
		}
		const outcomes = await Promise.all([first, third])
		expect(outcomes.map((outcome) => outcome.results[0]?.status)).toEqual(["success", "success"])
		expect(f.approvals).toEqual(["first", "third"])
		expect(f.host.userMessageContent).toHaveLength(3)
	})
})
