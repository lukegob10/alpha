import { describe, expect, it, vi } from "vitest"

import type { AgentResponse } from "../AgentResponse"
import {
	AgentTurnEngine,
	type AgentTurnHost,
	type AgentTurnPhaseResult,
	type AgentTurnStagedHost,
	type AgentTurnStepStatus,
} from "../AgentTurnEngine"

const response: AgentResponse = {
	items: [{ type: "text", text: "Completion candidate." }],
	text: "Completion candidate.",
	reasoning: "",
	toolCalls: [],
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

describe.each(["legacy", "staged"] as const)("AgentTurnEngine %s finalization contract", (adapter) => {
	function createHost(
		onStepComplete: () => Promise<AgentTurnPhaseResult | void>,
		phaseResult: AgentTurnPhaseResult = {},
		capturedResponse = response,
	) {
		const callbacks = {
			shouldAbort: () => false,
			onStepComplete: vi.fn(onStepComplete),
		}
		const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
			adapter === "legacy"
				? {
						...callbacks,
						runStep: vi.fn(async () => ({
							response: capturedResponse,
							nextInput: "complete" as const,
							...phaseResult,
						})),
					}
				: {
						...callbacks,
						sampleStep: vi.fn(async () => ({ response: capturedResponse })),
						commitResponse: vi.fn(async () => phaseResult),
						executeEffects: vi.fn(),
						selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
						releaseStep: vi.fn(),
					}
		return host
	}

	it.each(["aborted", "failed", "incomplete", "exhausted", "awaiting-user"] satisfies AgentTurnStepStatus[])(
		"preserves a %s completion callback instead of publishing success",
		async (status) => {
			const error = new Error("Completion boundary did not settle.")
			const reason = `completion callback: ${status}`
			const host = createHost(async () => ({ status, reason, error }))

			const outcome = await new AgentTurnEngine(host).run("first")

			expect(outcome).toMatchObject({ status, steps: 1, reason, response })
			if (status === "failed") expect(outcome).toHaveProperty("error", error)
			expect(host.onStepComplete).toHaveBeenCalledExactlyOnceWith(response, 1)
			if (host.sampleStep) {
				expect(host.selectContinuation).not.toHaveBeenCalled()
				expect(host.releaseStep).toHaveBeenCalledOnce()
			} else {
				expect(host.runStep).toHaveBeenCalledOnce()
			}
		},
	)

	it.each(["return", "throw"] as const)(
		"retains the first phase failure when finalization fails by %s",
		async (kind) => {
			const phaseError = new Error("Transcript commit failed.")
			const callbackError = new Error("Completion callback failed.")
			const host = createHost(
				async () => {
					if (kind === "throw") throw callbackError
					return { status: "incomplete", reason: callbackError.message, error: callbackError }
				},
				{ status: "failed", reason: phaseError.message, error: phaseError },
			)

			const outcome = await new AgentTurnEngine(host).run("first")

			expect(outcome).toEqual({
				status: "failed",
				steps: 1,
				response,
				reason: phaseError.message,
				error: phaseError,
			})
			expect(host.onStepComplete).toHaveBeenCalledOnce()
			if (host.sampleStep) {
				expect(host.executeEffects).not.toHaveBeenCalled()
				expect(host.selectContinuation).not.toHaveBeenCalled()
				expect(host.releaseStep).toHaveBeenCalledOnce()
			}
		},
	)

	it("reports a thrown completion callback against the captured response", async () => {
		const error = new Error("Completion callback failed.")
		const host = createHost(async () => {
			throw error
		})

		expect(await new AgentTurnEngine(host).run("first")).toEqual({
			status: "failed",
			steps: 1,
			response,
			reason: error.message,
			error,
		})
	})

	it.each(["failed", "incomplete", "cancelled"] as const)(
		"retains a provider %s outcome when completion callbacks return or throw a secondary fault",
		async (providerStatus) => {
			for (const throws of [false, true]) {
				const capturedResponse: AgentResponse = {
					...response,
					outcome: { status: providerStatus, reason: "Primary provider boundary." },
				}
				const host = createHost(
					async () => {
						if (throws) throw new Error("Secondary completion fault.")
						return { status: "awaiting-user", reason: "Secondary completion status." }
					},
					{},
					capturedResponse,
				)

				expect(await new AgentTurnEngine(host).run("first")).toMatchObject({
					status: providerStatus === "cancelled" ? "aborted" : providerStatus,
					steps: 1,
					response: capturedResponse,
					reason: "Primary provider boundary.",
				})
				if (host.sampleStep) {
					expect(host.executeEffects).not.toHaveBeenCalled()
					expect(host.selectContinuation).not.toHaveBeenCalled()
					expect(host.releaseStep).toHaveBeenCalledOnce()
				}
			}
		},
	)
})

describe("AgentTurnEngine staged fault drains", () => {
	it.each(["failed", "aborted", "incomplete"] as const)(
		"retains a sampled %s boundary when transcript commit also throws",
		async (status) => {
			const sampleError = new Error("Primary sample boundary.")
			const host: AgentTurnStagedHost<string> = {
				shouldAbort: () => false,
				sampleStep: async () => ({ response, status, reason: sampleError.message, error: sampleError }),
				commitResponse: async () => {
					throw new Error("Secondary transcript fault.")
				},
				executeEffects: vi.fn(),
				onStepComplete: vi.fn(async () => {
					throw new Error("Secondary completion fault.")
				}),
				selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
				releaseStep: vi.fn(),
			}

			const outcome = await new AgentTurnEngine(host).run("first")

			expect(outcome).toMatchObject({ status, steps: 1, response, reason: sampleError.message })
			if (status === "failed") expect(outcome).toHaveProperty("error", sampleError)
			expect(host.executeEffects).not.toHaveBeenCalled()
			expect(host.selectContinuation).not.toHaveBeenCalled()
			expect(host.onStepComplete).toHaveBeenCalledOnce()
			expect(host.releaseStep).toHaveBeenCalledOnce()
		},
	)

	it.each(["commit", "effects", "callback", "continuation"] as const)(
		"joins cleanup exactly once after a %s fault before settling the turn",
		async (phase) => {
			const fault = new Error(`${phase} failed`)
			const releaseEntered = deferred()
			const releaseGate = deferred()
			const visited: string[] = []
			const enter = (name: string) => {
				visited.push(name)
				if (name === phase) throw fault
			}
			const host: AgentTurnStagedHost<string> = {
				shouldAbort: () => false,
				sampleStep: vi.fn(async () => ({ response })),
				commitResponse: vi.fn(async () => enter("commit")),
				executeEffects: vi.fn(async () => enter("effects")),
				onStepComplete: vi.fn(async () => enter("callback")),
				selectContinuation: vi.fn(async () => {
					enter("continuation")
					return { nextInput: "complete" }
				}),
				releaseStep: vi.fn(async () => {
					visited.push("release")
					releaseEntered.resolve()
					await releaseGate.promise
				}),
			}
			let settled = false
			const operation = new AgentTurnEngine(host).run("first").then((outcome) => {
				settled = true
				return outcome
			})

			try {
				await releaseEntered.promise
				expect(settled).toBe(false)
				expect(host.releaseStep).toHaveBeenCalledOnce()
				expect(host.sampleStep).toHaveBeenCalledOnce()
				if (phase === "commit") expect(host.executeEffects).not.toHaveBeenCalled()
				if (phase !== "continuation") expect(host.selectContinuation).not.toHaveBeenCalled()
			} finally {
				releaseGate.resolve()
			}

			expect(await operation).toEqual({
				status: "failed",
				steps: 1,
				response,
				reason: fault.message,
				error: fault,
			})
			expect(visited.at(-1)).toBe("release")
			expect(visited.filter((name) => name === "release")).toHaveLength(1)
		},
	)
})
