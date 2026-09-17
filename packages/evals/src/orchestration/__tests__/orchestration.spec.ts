import { describe, expect, it, vi } from "vitest"

import { InMemoryLifecyclePort, ScriptedObserver, VirtualClock } from "../../testing/hostileRuntime"
import {
	AttemptResumeError,
	calculateBackoffMs,
	executeAttempt,
	executeRetryPolicy,
	systemClock,
	systemRandom,
	systemSleeper,
	type AttemptExecutionPorts,
	type AttemptLifecyclePort,
	type AttemptSnapshot,
	type HarnessRandomSource,
} from "../index"

function ports(lifecycle: AttemptLifecyclePort = new InMemoryLifecyclePort()): AttemptExecutionPorts {
	return {
		lifecycle,
		setup: async () => undefined,
		executeAgent: async () => undefined,
		collectEvidence: async () => undefined,
		grade: async () => "passed",
		cleanup: async () => undefined,
	}
}

describe("executeAttempt edge contracts", () => {
	it("skips a previously terminal attempt without rerunning stages", async () => {
		const lifecycle = new InMemoryLifecyclePort()
		const attempt = await lifecycle.ensureAttempt(1, 1)
		let state: AttemptSnapshot = attempt
		for (const event of [
			{ type: "start" },
			{ type: "setup_completed" },
			{ type: "agent_completed" },
			{ type: "evidence_collected" },
			{ type: "finalize", status: "passed" },
		] as const) {
			state = await lifecycle.applyEvent(state.id, event)
		}
		const setup = vi.fn()
		const observer = new ScriptedObserver()
		const result = await executeAttempt({ taskId: 1, attemptNumber: 1 }, { ...ports(lifecycle), setup, observer })
		expect(result).toMatchObject({ status: "passed", skipped: true })
		expect(setup).not.toHaveBeenCalled()
		expect(observer.records).toEqual([
			{ type: "attempt_skipped", attemptId: 1, attemptNumber: 1, detail: "passed" },
		])
	})

	it("reconciles and rejects re-entry from a non-created phase", async () => {
		const lifecycle = new InMemoryLifecyclePort()
		const attempt = await lifecycle.ensureAttempt(1, 1)
		await lifecycle.applyEvent(attempt.id, { type: "start" })
		await expect(executeAttempt({ taskId: 1, attemptNumber: 1 }, ports(lifecycle))).rejects.toBeInstanceOf(
			AttemptResumeError,
		)
		expect(lifecycle.all()[0]).toMatchObject({
			terminalStatus: "infrastructure_error",
		})
	})

	it("turns a pre-terminal observer failure into infrastructure error", async () => {
		const lifecycle = new InMemoryLifecyclePort()
		const observer = new ScriptedObserver({ fail: ["grade_completed"] })
		await expect(
			executeAttempt({ taskId: 1, attemptNumber: 1 }, { ...ports(lifecycle), observer }),
		).rejects.toThrow("event sink failure")
		expect(lifecycle.all()[0]).toMatchObject({ terminalStatus: "infrastructure_error" })
	})

	it("always cleans up after a stage failure", async () => {
		const cleanup = vi.fn(async () => undefined)
		await expect(
			executeAttempt(
				{ taskId: 1, attemptNumber: 1 },
				{ ...ports(), executeAgent: async () => Promise.reject(new Error("agent failed")), cleanup },
			),
		).rejects.toThrow("agent failed")
		expect(cleanup).toHaveBeenCalledOnce()
	})

	it("retains a terminal write when persistence reports an error after committing it", async () => {
		const base = new InMemoryLifecyclePort()
		const lifecycle = {
			ensureAttempt: base.ensureAttempt.bind(base),
			findAttempt: base.findAttempt.bind(base),
			applyEvent: async (attemptId: number, event: Parameters<typeof base.applyEvent>[1]) => {
				const result = await base.applyEvent(attemptId, event)
				if (event.type === "finalize") throw new Error("commit acknowledgement lost")
				return result
			},
		}
		await expect(executeAttempt({ taskId: 1, attemptNumber: 1 }, ports(lifecycle))).rejects.toThrow(
			"commit acknowledgement lost",
		)
		expect(base.all()[0]).toMatchObject({ terminalStatus: "passed" })
	})

	it("preserves a non-Error fault and tolerates failure observation loss", async () => {
		const base = new InMemoryLifecyclePort()
		const observer = new ScriptedObserver({ fail: ["attempt_failed"] })
		const lifecycle = {
			ensureAttempt: base.ensureAttempt.bind(base),
			applyEvent: base.applyEvent.bind(base),
			findAttempt: async () => undefined,
		}
		await expect(
			executeAttempt(
				{ taskId: 1, attemptNumber: 1 },
				{ ...ports(lifecycle), executeAgent: async () => Promise.reject("raw fault"), observer },
			),
		).rejects.toBe("raw fault")
	})
})

describe("retry policy edge contracts", () => {
	it("rejects invalid attempt limits", async () => {
		const clock = new VirtualClock()
		await expect(
			executeRetryPolicy(
				{ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 },
				{ clock, random: { next: () => 0 }, sleeper: clock },
				async () => "passed",
				async () => undefined,
			),
		).rejects.toThrow("maxAttempts")
	})

	it("stops after a nonretryable first result without sleeping or settling", async () => {
		const clock = new VirtualClock()
		const sleeper = { sleep: vi.fn(async () => undefined) }
		const settle = vi.fn(async () => undefined)
		const result = await executeRetryPolicy(
			{ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
			{ clock, random: { next: () => 0.5 }, sleeper },
			async () => "safety_failed",
			settle,
		)
		expect(result).toMatchObject({ status: "safety_failed", exhausted: false })
		expect(sleeper.sleep).not.toHaveBeenCalled()
		expect(settle).not.toHaveBeenCalled()
	})

	it.each([
		[1, 0.5, 0],
		[2, -10, 50],
		[2, 10, 150],
		[5, 1, 150],
	] as const)("bounds backoff for attempt %s random %s", (attemptNumber, randomValue, expected) => {
		const random: HarnessRandomSource = { next: () => randomValue }
		expect(calculateBackoffMs(attemptNumber, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 100 }, random)).toBe(
			expected,
		)
	})
})

describe("system ports", () => {
	it("provide real clock, random, and sleeper adapters", async () => {
		expect(systemClock.now()).toBeInstanceOf(Date)
		expect(systemClock.monotonicMs()).toBeGreaterThanOrEqual(0)
		expect(systemRandom.next()).toBeGreaterThanOrEqual(0)
		await systemSleeper.sleep(0)
	})
})
