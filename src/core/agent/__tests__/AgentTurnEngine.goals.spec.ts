import { describe, expect, it, vi } from "vitest"

import { createAgentResponse } from "../AgentResponse"
import { AgentTurnEngine, type AgentTurnStagedHost } from "../AgentTurnEngine"

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

function host() {
	return {
		shouldAbort: vi.fn(() => false),
		canContinueWhenIdle: vi.fn(() => true),
		sampleStep: vi.fn(async () => ({ response: createAgentResponse([{ type: "text", text: "Progress." }]) })),
		selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
		selectIdleContinuation: vi.fn(async () => "goal input"),
		releaseStep: vi.fn(async () => undefined),
	} satisfies AgentTurnStagedHost<string>
}

describe("goal admission at the existing engine idle boundary", () => {
	it("admits at most once after the staged response and cleanup have drained", async () => {
		const adapter = host()
		const released = barrier()
		const release = barrier()
		adapter.releaseStep.mockImplementation(async () => {
			released.resolve()
			await release.promise
		})
		const engine = new AgentTurnEngine(adapter)
		const turn = engine.run("human input")
		await released.promise
		expect(adapter.selectIdleContinuation).not.toHaveBeenCalled()
		release.resolve()
		const outcome = await turn
		expect(await engine.continueIfIdle(outcome)).toBe("goal input")
		expect(await engine.continueIfIdle(outcome)).toBeUndefined()
		expect(adapter.selectIdleContinuation).toHaveBeenCalledOnce()
		expect(adapter.sampleStep).toHaveBeenCalledOnce()
	})

	it.each(["cancellation", "human input"])("rechecks %s after asynchronous admission", async (reason) => {
		const adapter = host()
		const admitted = barrier()
		const release = barrier()
		adapter.selectIdleContinuation.mockImplementation(async () => {
			admitted.resolve()
			await release.promise
			return "goal input"
		})
		const engine = new AgentTurnEngine(adapter)
		const outcome = await engine.run("human input")
		const continuation = engine.continueIfIdle(outcome)
		await admitted.promise
		if (reason === "cancellation") adapter.shouldAbort.mockReturnValue(true)
		else adapter.canContinueWhenIdle.mockReturnValue(false)
		release.resolve()
		expect(await continuation).toBeUndefined()
	})

	it.each(["failed", "exhausted", "incomplete", "awaiting-user", "aborted"] as const)(
		"never admits automatic work after %s",
		async (status) => {
			const adapter = host()
			const engine = new AgentTurnEngine(adapter)
			expect(await engine.continueIfIdle({ status, steps: 1, reason: "Stopped." })).toBeUndefined()
			expect(adapter.selectIdleContinuation).not.toHaveBeenCalled()
		},
	)

	it("coalesces concurrent consideration without creating a second execution loop", async () => {
		const adapter = host()
		const release = barrier()
		adapter.selectIdleContinuation.mockImplementation(async () => {
			await release.promise
			return "goal input"
		})
		const engine = new AgentTurnEngine(adapter)
		const outcome = await engine.run("human input")
		const first = engine.continueIfIdle(outcome)
		expect(await engine.continueIfIdle(outcome)).toBeUndefined()
		release.resolve()
		expect(await first).toBe("goal input")
		expect(adapter.sampleStep).toHaveBeenCalledOnce()
	})

	it("refuses a second run while the prior run owns sampling", async () => {
		const adapter = host()
		const sampled = barrier()
		const release = barrier()
		adapter.sampleStep.mockImplementation(async () => {
			sampled.resolve()
			await release.promise
			return { response: createAgentResponse([{ type: "text", text: "Progress." }]) }
		})
		const engine = new AgentTurnEngine(adapter)
		const first = engine.run("human input")
		await sampled.promise
		expect(await engine.run("goal input")).toMatchObject({ status: "failed", steps: 0 })
		release.resolve()
		expect(await first).toMatchObject({ status: "completed" })
	})
})
