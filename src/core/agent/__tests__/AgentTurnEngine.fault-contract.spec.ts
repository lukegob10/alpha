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

	it("retains a null error payload when the completion callback omits its status", async () => {
		const host = createHost(async () => ({ error: null }))

		expect(await new AgentTurnEngine(host).run("first")).toEqual({
			status: "failed",
			steps: 1,
			response,
			reason: "null",
			error: null,
		})
	})

	it("preserves an explicit successful status with diagnostic metadata", async () => {
		const host = createHost(async () => ({ status: "completed", error: new Error("Diagnostic metadata.") }))

		expect(await new AgentTurnEngine(host).run("first")).toEqual({
			status: "completed",
			steps: 1,
			response,
			completionReason: "host",
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
	it.each([
		["commit", false],
		["commit", true],
		["effects", false],
		["effects", true],
	] as const)(
		"retains a returned error-only %s failure with secondary faults: %s",
		async (phase, secondaryFaults) => {
			const fault = new Error(`${phase} failed`)
			const host: AgentTurnStagedHost<string> = {
				shouldAbort: () => false,
				sampleStep: vi.fn(async () => ({ response })),
				commitResponse: vi.fn(async () => (phase === "commit" ? { error: fault } : undefined)),
				executeEffects: vi.fn(async () => ({ error: fault })),
				onStepComplete: vi.fn(async () => {
					if (secondaryFaults) throw new Error("Secondary completion fault.")
				}),
				selectContinuation: vi.fn(),
				selectRecovery: vi.fn(),
				releaseStep: vi.fn(() => {
					if (secondaryFaults) throw new Error("Secondary cleanup fault.")
				}),
			}

			expect(await new AgentTurnEngine(host).run("first")).toEqual({
				status: "failed",
				steps: 1,
				response,
				reason: fault.message,
				error: fault,
			})
			expect(host.onStepComplete).toHaveBeenCalledOnce()
			expect(host.releaseStep).toHaveBeenCalledOnce()
			expect(host.selectContinuation).not.toHaveBeenCalled()
			expect(host.selectRecovery).not.toHaveBeenCalled()
			if (phase === "commit") expect(host.executeEffects).not.toHaveBeenCalled()
			else expect(host.executeEffects).toHaveBeenCalledOnce()
		},
	)

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

describe.each(["legacy", "staged"] as const)("AgentTurnEngine %s error-only results", (adapter) => {
	it.each([
		["sample", false],
		["sample", true],
		["callback", false],
		["callback", true],
	] as const)(
		"does not complete after an error-only %s with a completed provider outcome: %s",
		async (phase, completed) => {
			const error = new Error(`${phase} failed`)
			const capturedResponse: AgentResponse = {
				...response,
				...(completed ? { outcome: { status: "completed" } as const } : {}),
			}
			const callbacks = {
				shouldAbort: () => false,
				onStepComplete: vi.fn(async () => (phase === "callback" ? { error } : undefined)),
				admitCompletion: vi.fn(),
			}
			const sample = async () => ({ response: capturedResponse, ...(phase === "sample" ? { error } : {}) })
			const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
				adapter === "legacy"
					? {
							...callbacks,
							runStep: vi.fn(async () => ({ ...(await sample()), nextInput: "complete" as const })),
						}
					: {
							...callbacks,
							sampleStep: vi.fn(sample),
							commitResponse: vi.fn(),
							executeEffects: vi.fn(),
							selectContinuation: vi.fn(),
							releaseStep: vi.fn(),
						}

			expect(await new AgentTurnEngine(host).run("first")).toEqual({
				status: "failed",
				steps: 1,
				response: capturedResponse,
				reason: error.message,
				error,
			})
			expect(host.onStepComplete).toHaveBeenCalledExactlyOnceWith(capturedResponse, 1)
			expect(host.admitCompletion).not.toHaveBeenCalled()
			if (host.sampleStep) {
				expect(host.selectContinuation).not.toHaveBeenCalled()
				expect(host.releaseStep).toHaveBeenCalledOnce()
				if (phase === "sample") expect(host.executeEffects).not.toHaveBeenCalled()
			}
		},
	)

	it("preserves cancellation after an error-only completion callback", async () => {
		let aborted = false
		const error = new Error("Completion callback cancelled.")
		const callbacks = {
			shouldAbort: () => aborted,
			onStepComplete: vi.fn(async () => {
				aborted = true
				return { error }
			}),
			admitCompletion: vi.fn(),
		}
		const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
			adapter === "legacy"
				? { ...callbacks, runStep: async () => ({ response, nextInput: "complete" }) }
				: { ...callbacks, sampleStep: async () => ({ response }), releaseStep: vi.fn() }

		expect(await new AgentTurnEngine(host).run("first")).toMatchObject({
			status: "aborted",
			steps: 1,
			reason: error.message,
		})
		expect(host.admitCompletion).not.toHaveBeenCalled()
		if (host.sampleStep) expect(host.releaseStep).toHaveBeenCalledOnce()
	})
})

describe("AgentTurnEngine decision failures", () => {
	const decisions = [
		["legacy", "admission"],
		["staged", "admission"],
		["staged", "continuation"],
	] as const

	it.each(decisions)("rejects an error-only %s %s before completing or resampling", async (adapter, phase) => {
		for (const error of [new Error("Decision failed."), null]) {
			for (const nextInput of ["complete", "repair"] as const) {
				const decision = { nextInput, requiresContinuation: nextInput === "repair", error }
				const callbacks = {
					shouldAbort: () => false,
					admitCompletion: vi
						.fn<NonNullable<AgentTurnStagedHost<string>["admitCompletion"]>>(async () => undefined)
						.mockResolvedValueOnce(phase === "admission" ? decision : undefined),
				}
				const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
					adapter === "legacy"
						? { ...callbacks, runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })) }
						: {
								...callbacks,
								sampleStep: vi.fn(async () => ({ response })),
								selectContinuation: vi
									.fn<NonNullable<AgentTurnStagedHost<string>["selectContinuation"]>>(async () => ({
										nextInput: "complete" as const,
									}))
									.mockResolvedValueOnce(
										phase === "continuation" ? decision : { nextInput: "complete" as const },
									),
								releaseStep: vi.fn(),
							}

				expect(await new AgentTurnEngine(host).run("first")).toEqual({
					status: "failed",
					steps: 1,
					response,
					reason: error instanceof Error ? error.message : "null",
					error,
				})
				if (host.sampleStep) {
					expect(host.sampleStep).toHaveBeenCalledOnce()
					expect(host.releaseStep).toHaveBeenCalledOnce()
					if (phase === "continuation") expect(host.admitCompletion).not.toHaveBeenCalled()
				} else expect(host.runStep).toHaveBeenCalledOnce()
			}
		}
	})

	it.each(decisions)("preserves explicit successful diagnostics from %s %s", async (adapter, phase) => {
		const decision = { nextInput: "complete" as const, status: "completed" as const, error: null }
		const callbacks = {
			shouldAbort: () => false,
			admitCompletion: vi.fn(async () => (phase === "admission" ? decision : undefined)),
		}
		const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
			adapter === "legacy"
				? { ...callbacks, runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })) }
				: {
						...callbacks,
						sampleStep: vi.fn(async () => ({ response })),
						selectContinuation: vi.fn(async () => decision),
						releaseStep: vi.fn(),
					}

		expect(await new AgentTurnEngine(host).run("first")).toEqual({
			status: "completed",
			steps: 1,
			response,
			completionReason: "host",
		})
		if (host.sampleStep) expect(host.releaseStep).toHaveBeenCalledOnce()
	})

	it.each(decisions)("lets cancellation win an error-only %s %s", async (adapter, phase) => {
		let aborted = false
		const fail = () => {
			aborted = true
			return { nextInput: "repair", requiresContinuation: true, error: new Error("Late decision.") }
		}
		const callbacks = {
			shouldAbort: () => aborted,
			admitCompletion: vi.fn(async () => (phase === "admission" ? fail() : undefined)),
		}
		const host: AgentTurnHost<string> | AgentTurnStagedHost<string> =
			adapter === "legacy"
				? { ...callbacks, runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })) }
				: {
						...callbacks,
						sampleStep: vi.fn(async () => ({ response })),
						selectContinuation: vi.fn(async () =>
							phase === "continuation" ? fail() : { nextInput: "complete" as const },
						),
						releaseStep: vi.fn(),
					}

		expect(await new AgentTurnEngine(host).run("first")).toMatchObject({ status: "aborted", steps: 1 })
		if (host.sampleStep) expect(host.releaseStep).toHaveBeenCalledOnce()
	})

	it.each(["failed", "incomplete"] as const)(
		"retains the original %s result when recovery reports an error without a status",
		async (status) => {
			for (const error of [new Error("Original sample failure."), null]) {
				const host: AgentTurnStagedHost<string> = {
					shouldAbort: () => false,
					sampleStep: vi.fn(async () => ({ response, status, reason: "Original sample boundary.", error })),
					selectRecovery: vi
						.fn<NonNullable<AgentTurnStagedHost<string>["selectRecovery"]>>(async () => undefined)
						.mockResolvedValueOnce({
							nextInput: "repair",
							requiresContinuation: true,
							error: new Error("Secondary recovery failure."),
						}),
					releaseStep: vi.fn(),
				}

				expect(await new AgentTurnEngine(host).run("first")).toEqual({
					status,
					steps: 1,
					response,
					reason: "Original sample boundary.",
					...(status === "failed" ? { error } : {}),
				})
				expect(host.sampleStep).toHaveBeenCalledOnce()
				expect(host.selectRecovery).toHaveBeenCalledOnce()
				expect(host.releaseStep).toHaveBeenCalledOnce()
			}
		},
	)

	it("preserves a null original error when recovery reports another terminal failure", async () => {
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => false,
			sampleStep: vi.fn(async () => ({ response, status: "failed" as const, error: null })),
			selectRecovery: vi.fn(async () => ({
				nextInput: "complete",
				status: "failed" as const,
				reason: "Recovery declined.",
				error: new Error("Secondary recovery failure."),
			})),
			releaseStep: vi.fn(),
		}

		expect(await new AgentTurnEngine(host).run("first")).toEqual({
			status: "failed",
			steps: 1,
			response,
			reason: "Recovery declined.",
			error: null,
		})
		expect(host.sampleStep).toHaveBeenCalledOnce()
		expect(host.releaseStep).toHaveBeenCalledOnce()
	})
})
