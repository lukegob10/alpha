import { describe, expect, it, vi } from "vitest"

import type { AgentResponse } from "../AgentResponse"
import { AgentTurnEngine, type AgentTurnHost, type AgentTurnStagedHost } from "../AgentTurnEngine"

const response: AgentResponse = {
	items: [{ type: "text", text: "Completion candidate." }],
	text: "Completion candidate.",
	reasoning: "",
	toolCalls: [],
}

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

describe.each(["legacy", "staged"] as const)("AgentTurnEngine %s cancellation fences", (adapter) => {
	it.each(["sampling", "completion admission"] as const)(
		"preserves cancellation when held %s rejects after Stop",
		async (phase) => {
			let aborted = false
			const entered = barrier()
			const release = barrier()
			const error = new Error("Callback cancelled after Stop.")
			const rejectWhenReleased = async () => {
				entered.resolve()
				await release.promise
				throw error
			}
			const callbacks = {
				shouldAbort: () => aborted,
				admitCompletion: vi.fn(async () => {
					if (phase === "completion admission") await rejectWhenReleased()
					return undefined
				}),
			}
			const sample = async () => {
				if (phase === "sampling") await rejectWhenReleased()
				return { response }
			}
			const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
				adapter === "legacy"
					? {
							...callbacks,
							runStep: vi.fn(async () => ({ ...(await sample()), nextInput: "complete" as const })),
						}
					: {
							...callbacks,
							sampleStep: vi.fn(sample),
							selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
							releaseStep: vi.fn(),
						}
			const engine = new AgentTurnEngine(host)
			const running = engine.run("first")
			await entered.promise
			aborted = true
			release.resolve()

			expect(await running).toMatchObject({
				status: "aborted",
				steps: phase === "sampling" ? 0 : 1,
				reason: error.message,
			})
			if (host.sampleStep) {
				expect(host.releaseStep).toHaveBeenCalledTimes(phase === "sampling" ? 0 : 1)
			}
			if (phase === "sampling") expect(host.admitCompletion).not.toHaveBeenCalled()
		},
	)

	it.each(["sampling", "completion admission"] as const)(
		"retains an ordinary %s rejection when no cancellation occurred",
		async (phase) => {
			const error = new Error("Host operation failed.")
			const sample = async () => {
				if (phase === "sampling") throw error
				return { response }
			}
			const callbacks = {
				shouldAbort: () => false,
				admitCompletion: async () => {
					throw error
				},
			}
			const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
				adapter === "legacy"
					? { ...callbacks, runStep: async () => ({ ...(await sample()), nextInput: "complete" as const }) }
					: {
							...callbacks,
							sampleStep: sample,
							selectContinuation: async () => ({ nextInput: "complete" as const }),
						}

			expect(await new AgentTurnEngine(host).run("first")).toEqual({
				status: "failed",
				steps: phase === "sampling" ? 0 : 1,
				reason: error.message,
				error,
				...(phase === "completion admission" ? { response } : {}),
			})
		},
	)
})

describe("AgentTurnEngine staged continuation cancellation", () => {
	it.each(["throw", "failed", "incomplete", "exhausted", "awaiting-user"] as const)(
		"drains the captured step before cancellation wins a late %s continuation",
		async (result) => {
			let aborted = false
			const entered = barrier()
			const release = barrier()
			const host: AgentTurnStagedHost<string> = {
				shouldAbort: () => aborted,
				sampleStep: vi.fn(async () => ({ response })),
				selectContinuation: vi.fn(async () => {
					entered.resolve()
					await release.promise
					if (result === "throw") throw new Error("Continuation cancelled.")
					return { nextInput: "complete", status: result }
				}),
				admitCompletion: vi.fn(),
				releaseStep: vi.fn(),
			}
			const running = new AgentTurnEngine(host).run("first")
			await entered.promise
			aborted = true
			release.resolve()

			expect(await running).toMatchObject({ status: "aborted", steps: 1, response })
			expect(host.releaseStep).toHaveBeenCalledOnce()
			expect(host.sampleStep).toHaveBeenCalledOnce()
			expect(host.admitCompletion).not.toHaveBeenCalled()
		},
	)
})
