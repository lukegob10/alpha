import { describe, expect, it, vi } from "vitest"

import { createAgentResponse, type AgentResponse } from "../AgentResponse"
import { AgentRetryPolicy } from "../AgentRetryPolicy"
import { AgentTurnEngine, type AgentTurnStagedHost } from "../AgentTurnEngine"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

const originalError = new Error("The provider connection closed after partial output.")
const partialResponse = (): AgentResponse =>
	createAgentResponse(
		[
			{ type: "text", text: "The first part of the answer.", id: "partial-text" },
			{ type: "reasoning", text: "Partial reasoning", encryptedContent: "opaque+/=\r\n", id: "reasoning" },
			{ type: "error", message: originalError.message, retryable: true },
		],
		{ status: "failed", reason: originalError.message, retryable: true },
	)
const completedResponse = () => createAgentResponse([{ type: "text", text: "The complete answer." }])

function fixture() {
	const trace: string[] = []
	const partial = partialResponse()
	const completed = completedResponse()
	let aborted = false
	const host: AgentTurnStagedHost<string> = {
		shouldAbort: () => aborted,
		sampleStep: vi.fn<AgentTurnStagedHost<string>["sampleStep"]>(async (input) => {
			trace.push(`sample:${input}`)
			return input === "initial"
				? { response: partial, status: "failed", reason: originalError.message, error: originalError }
				: { response: completed, status: "completed" }
		}),
		commitResponse: vi.fn(async (_sample, step) => {
			trace.push(`commit:${step}`)
		}),
		executeEffects: vi.fn(async (_sample, step) => {
			trace.push(`effects:${step}`)
		}),
		onStepComplete: vi.fn(async (_response, step) => {
			trace.push(`callback:${step}`)
		}),
		selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
		releaseStep: vi.fn(async (_sample, step) => {
			trace.push(`release:${step}`)
		}),
		selectRecovery: vi.fn(async () => undefined),
	}
	return { host, partial, completed, trace, abort: () => (aborted = true) }
}

describe("AgentTurnEngine committed stream recovery", () => {
	it("drains the failed step before a host-admitted history continuation without promoting partial output", async () => {
		const { host, partial, completed, trace } = fixture()
		vi.mocked(host.selectRecovery!).mockImplementation(async (sample, step, failure) => {
			trace.push(`recovery:${step}`)
			expect(sample.response).toBe(partial)
			expect(sample.response.outcome).toEqual({
				status: "failed",
				reason: originalError.message,
				retryable: true,
			})
			expect(failure).toMatchObject({ status: "failed", reason: originalError.message, error: originalError })
			return { nextInput: "committed-history", requiresContinuation: true }
		})

		const outcome = await new AgentTurnEngine(host).run("initial")

		expect(outcome).toEqual({ status: "completed", steps: 2, response: completed, completionReason: "host" })
		expect(partial.outcome?.status).toBe("failed")
		expect(trace).toEqual([
			"sample:initial",
			"commit:1",
			"callback:1",
			"release:1",
			"recovery:1",
			"sample:committed-history",
			"commit:2",
			"effects:2",
			"callback:2",
			"release:2",
		])
		expect(host.executeEffects).toHaveBeenCalledOnce()
		expect(host.selectRecovery).toHaveBeenCalledOnce()
		expect(host.releaseStep).toHaveBeenCalledTimes(2)
	})

	it("retains the original terminal result when the host declines recovery", async () => {
		const { host, partial } = fixture()
		expect(await new AgentTurnEngine(host).run("initial")).toEqual({
			status: "failed",
			steps: 1,
			response: partial,
			reason: originalError.message,
			error: originalError,
		})
		expect(host.sampleStep).toHaveBeenCalledOnce()
		expect(host.executeEffects).not.toHaveBeenCalled()
		expect(host.releaseStep).toHaveBeenCalledOnce()
	})

	it.each(["aborted", "exhausted", "awaiting-user"] as const)(
		"does not ask for automatic recovery from an explicit %s sample",
		async (status) => {
			const { host } = fixture()
			vi.mocked(host.sampleStep).mockResolvedValue({ response: createAgentResponse([]), status })
			expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({ status, steps: 1 })
			expect(host.selectRecovery).not.toHaveBeenCalled()
			expect(host.releaseStep).toHaveBeenCalledOnce()
		},
	)

	it.each(["commitResponse", "onStepComplete", "releaseStep"] as const)(
		"does not retry after secondary %s rejection and preserves the first failure",
		async (phase) => {
			const { host, partial } = fixture()
			vi.mocked(host[phase]!).mockRejectedValueOnce(new Error(`Secondary ${phase} failure`))
			expect(await new AgentTurnEngine(host).run("initial")).toEqual({
				status: "failed",
				steps: 1,
				response: partial,
				reason: originalError.message,
				error: originalError,
			})
			expect(host.selectRecovery).not.toHaveBeenCalled()
			expect(host.sampleStep).toHaveBeenCalledOnce()
			expect(host.onStepComplete).toHaveBeenCalledOnce()
			expect(host.releaseStep).toHaveBeenCalledOnce()
		},
	)

	it.each(["commitResponse", "onStepComplete"] as const)(
		"does not retry when %s reports a second terminal failure",
		async (phase) => {
			const { host, partial } = fixture()
			vi.mocked(host[phase]!).mockResolvedValueOnce({
				status: "failed",
				reason: `Secondary ${phase} failure`,
				error: new Error("Local persistence or accounting failure"),
			})
			expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({
				status: "failed",
				steps: 1,
				response: partial,
				reason: originalError.message,
				error: originalError,
			})
			expect(host.selectRecovery).not.toHaveBeenCalled()
			expect(host.sampleStep).toHaveBeenCalledOnce()
		},
	)

	it.each(["commitResponse", "onStepComplete"] as const)(
		"does not recover after an error-only %s result",
		async (phase) => {
			const { host, partial } = fixture()
			vi.mocked(host[phase]!).mockResolvedValueOnce({ error: new Error("Local transaction failed") })
			expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({
				status: "failed",
				steps: 1,
				response: partial,
				error: originalError,
			})
			expect(host.selectRecovery).not.toHaveBeenCalled()
			expect(host.sampleStep).toHaveBeenCalledOnce()
		},
	)

	it("gives cancellation precedence after a held recovery admission and never samples its late input", async () => {
		const { host, abort } = fixture()
		const entered = deferred()
		const release = deferred()
		vi.mocked(host.selectRecovery!).mockImplementation(async () => {
			entered.resolve()
			await release.promise
			return { nextInput: "late-history", requiresContinuation: true }
		})
		const running = new AgentTurnEngine(host).run("initial")
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
		} finally {
			abort()
			release.resolve()
		}
		expect(await running).toMatchObject({ status: "aborted", steps: 1 })
		expect(host.sampleStep).toHaveBeenCalledOnce()
		expect(host.releaseStep).toHaveBeenCalledOnce()
	})

	it("preserves cancellation when a held recovery admission rejects after Stop", async () => {
		const { host, abort } = fixture()
		const entered = deferred()
		const release = deferred()
		vi.mocked(host.selectRecovery!).mockImplementation(async () => {
			entered.resolve()
			await release.promise
			throw new Error("Retry notification cancelled")
		})
		const running = new AgentTurnEngine(host).run("initial")
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
		} finally {
			abort()
			release.resolve()
		}
		expect(await running).toMatchObject({ status: "aborted", steps: 1 })
		expect(host.sampleStep).toHaveBeenCalledOnce()
	})

	it("preserves the failed outcome when recovery offers no concrete follow-up input", async () => {
		const { host, partial } = fixture()
		vi.mocked(host.selectRecovery!).mockResolvedValue({ nextInput: "complete", status: "completed" })
		expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({
			status: "failed",
			steps: 1,
			response: partial,
			error: originalError,
		})
		expect(host.sampleStep).toHaveBeenCalledOnce()
	})

	it("stops at the host's carried recovery budget and retains every failed response", async () => {
		const { host, partial } = fixture()
		const committed: AgentResponse[] = []
		vi.mocked(host.sampleStep).mockImplementation(async () => ({
			response: partial,
			status: "failed",
			reason: originalError.message,
			error: originalError,
		}))
		vi.mocked(host.commitResponse!).mockImplementation(async ({ response }) => {
			committed.push(response)
		})
		vi.mocked(host.selectRecovery!).mockImplementation(async (_sample, step) =>
			step < 2
				? { nextInput: "history-with-failed-response", requiresContinuation: true }
				: { nextInput: "complete", status: "exhausted", reason: "Provider retry budget exhausted (attempts)." },
		)
		expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({
			status: "exhausted",
			steps: 2,
			reason: "Provider retry budget exhausted (attempts).",
		})
		expect(committed).toEqual([partial, partial])
		expect(partial.outcome?.status).toBe("failed")
		expect(host.sampleStep).toHaveBeenCalledTimes(2)
		expect(host.releaseStep).toHaveBeenCalledTimes(2)
	})
})

describe("AgentTurnEngine completion admission", () => {
	it("keeps a completion candidate's step alive until admission and runs repair input before completion", async () => {
		const { host, trace, completed } = fixture()
		vi.mocked(host.sampleStep).mockImplementation(async (input) => {
			trace.push(`sample:${input}`)
			return { response: completed }
		})
		host.admitCompletion = vi.fn(async (_outcome) => {
			const count = vi.mocked(host.admitCompletion!).mock.calls.length
			trace.push(`admit:${count}`)
			expect(trace.filter((item) => item.startsWith("release:"))).toHaveLength(count - 1)
			return count === 1 ? { nextInput: "hook-repair", requiresContinuation: true } : undefined
		})
		expect(await new AgentTurnEngine(host).run("initial")).toMatchObject({ status: "completed", steps: 2 })
		expect(trace.indexOf("admit:1")).toBeLessThan(trace.indexOf("release:1"))
		expect(trace.indexOf("release:1")).toBeLessThan(trace.indexOf("sample:hook-repair"))
		expect(host.admitCompletion).toHaveBeenCalledTimes(2)
		expect(host.selectRecovery).not.toHaveBeenCalled()
	})

	it("aborts a held completion admission before another model step or successful terminal outcome", async () => {
		const { host, completed, abort } = fixture()
		vi.mocked(host.sampleStep).mockResolvedValue({ response: completed })
		const entered = deferred()
		const release = deferred()
		host.admitCompletion = vi.fn(async () => {
			entered.resolve()
			await release.promise
			return { nextInput: "late-hook-prompt", requiresContinuation: true }
		})
		const running = new AgentTurnEngine(host).run("initial")
		try {
			expect(await Promise.race([entered.promise.then(() => true), running.then(() => false)])).toBe(true)
		} finally {
			abort()
			release.resolve()
		}
		expect(await running).toMatchObject({ status: "aborted", steps: 1 })
		expect(host.sampleStep).toHaveBeenCalledOnce()
		expect(host.releaseStep).toHaveBeenCalledOnce()
	})
})

describe("committed-history retry policy admission", () => {
	it("keeps semantic replay denied by default and admits only explicitly committed transport history", () => {
		const policy = new AgentRetryPolicy({ maxAttempts: 2, baseDelayMs: 0, jitter: "none" })
		expect(policy.decide({ category: "transport", attempt: 1, hasSemanticOutput: true })).toMatchObject({
			shouldRetry: false,
			reason: "semantic-output",
		})
		expect(
			policy.decide({
				category: "transport",
				attempt: 1,
				hasSemanticOutput: true,
				recovery: "committed-history",
			}),
		).toMatchObject({ shouldRetry: true })
	})

	it.each(["rate-limit", "context", "empty-response"] as const)(
		"does not turn the committed-history opt-in into semantic replay for %s",
		(category) => {
			const policy = new AgentRetryPolicy({ maxAttempts: 2, baseDelayMs: 0, jitter: "none" })
			expect(
				policy.decide({ category, attempt: 1, hasSemanticOutput: true, recovery: "committed-history" }),
			).toMatchObject({ shouldRetry: false, reason: "semantic-output" })
		},
	)

	it("retains attempt and elapsed limits for committed history", () => {
		const policy = new AgentRetryPolicy({ maxAttempts: 2, maxElapsedMs: 1000, baseDelayMs: 0, jitter: "none" })
		expect(
			policy.decide({
				category: "transport",
				attempt: 2,
				hasSemanticOutput: true,
				recovery: "committed-history",
			}),
		).toMatchObject({ shouldRetry: false, reason: "attempts" })
		expect(
			policy.decide({
				category: "transport",
				attempt: 1,
				elapsedMs: 500,
				retryAfterMs: 1000,
				hasSemanticOutput: true,
				recovery: "committed-history",
			}),
		).toMatchObject({ shouldRetry: false, reason: "elapsed-budget" })
	})
})
