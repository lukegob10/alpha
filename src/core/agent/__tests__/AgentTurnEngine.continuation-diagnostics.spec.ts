import { describe, expect, it, vi } from "vitest"

import { createAgentResponse } from "../AgentResponse"
import { AgentTurnEngine, type AgentTurnContinuationDiagnostic } from "../AgentTurnEngine"

describe("AgentTurnEngine continuation diagnostics", () => {
	it("records host idle continuation once after admission without starting another model request", async () => {
		const onContinuation = vi.fn()
		const runStep = vi.fn(async () => ({
			response: createAgentResponse([{ type: "text", text: "Answer" }]),
			nextInput: "complete" as const,
		}))
		const selectIdleContinuation = vi.fn(async () => "pending")
		const engine = new AgentTurnEngine<string>({
			shouldAbort: () => false,
			onContinuation,
			runStep,
			selectIdleContinuation,
		})
		const outcome = await engine.run("request")
		expect(onContinuation).not.toHaveBeenCalled()

		expect(await Promise.all([engine.continueIfIdle(outcome), engine.continueIfIdle(outcome)])).toEqual([
			"pending",
			undefined,
		])
		expect(selectIdleContinuation).toHaveBeenCalledOnce()
		expect(onContinuation).toHaveBeenCalledExactlyOnceWith({ step: 1, reason: "host-idle-continuation" })
		expect(runStep).toHaveBeenCalledOnce()
	})

	it("does not attribute an idle continuation rejected by a late cancellation", async () => {
		let aborted = false
		let finishAdmission!: (input: string) => void
		const admission = new Promise<string>((resolve) => {
			finishAdmission = resolve
		})
		const onContinuation = vi.fn()
		const engine = new AgentTurnEngine<string>({
			shouldAbort: () => aborted,
			onContinuation,
			runStep: async () => ({
				response: createAgentResponse([{ type: "text", text: "Answer" }]),
				nextInput: "complete",
			}),
			selectIdleContinuation: async () => admission,
		})
		const outcome = await engine.run("request")
		const pending = engine.continueIfIdle(outcome)
		aborted = true
		finishAdmission("pending")

		expect(await pending).toBeUndefined()
		expect(onContinuation).not.toHaveBeenCalled()
	})

	it.each([
		{ kind: "legacy", asynchronous: false },
		{ kind: "legacy", asynchronous: true },
		{ kind: "staged", asynchronous: false },
		{ kind: "staged", asynchronous: true },
	] as const)(
		"isolates a failed diagnostic observer in the $kind host (async=$asynchronous)",
		async ({ kind, asynchronous }) => {
			const response = createAgentResponse([{ type: "text", text: "Answer" }])
			let samples = 0
			const onContinuation = vi.fn(() => {
				if (asynchronous) return Promise.reject(new Error("Diagnostic export unavailable"))
				throw new Error("Diagnostic export unavailable")
			})
			const common = { shouldAbort: () => false, onContinuation }
			const engine =
				kind === "legacy"
					? new AgentTurnEngine<string>({
							...common,
							runStep: async () => ({
								response,
								nextInput: ++samples === 1 ? "pending" : "complete",
								requiresContinuation: samples === 1,
							}),
						})
					: new AgentTurnEngine<string>({
							...common,
							sampleStep: async () => {
								samples++
								return { response }
							},
							selectContinuation: async () => ({
								nextInput: samples === 1 ? "pending" : "complete",
								requiresContinuation: samples === 1,
							}),
						})

			expect(await engine.run("request")).toMatchObject({ status: "completed", steps: 2 })
			expect(samples).toBe(2)
			expect(onContinuation).toHaveBeenCalledExactlyOnceWith({ step: 2, reason: "host-pending-input" })
		},
	)

	it("retains explicit host provenance when provider tools also require continuation", async () => {
		const onContinuation = vi.fn()
		const engine = new AgentTurnEngine<string>({
			shouldAbort: () => false,
			onContinuation,
			sampleStep: async () => ({
				response: createAgentResponse([
					{ type: "tool_call", id: "call", name: "read_file", arguments: { path: "private" } },
				]),
			}),
			selectContinuation: async (_sample, step) => ({
				nextInput: step === 1 ? "pending" : "complete",
				requiresContinuation: step === 1,
				continuationReason: "host-pending-input",
			}),
		})

		expect(await engine.run("request")).toMatchObject({ status: "completed", steps: 2 })
		expect(onContinuation).toHaveBeenCalledExactlyOnceWith({ step: 2, reason: "host-pending-input" })
	})

	it("records provider recovery once after releasing the failed step", async () => {
		const events: Array<string | AgentTurnContinuationDiagnostic> = []
		let samples = 0
		const engine = new AgentTurnEngine<string>({
			shouldAbort: () => false,
			onContinuation: (diagnostic) => {
				events.push(diagnostic)
			},
			sampleStep: async () => ({
				response: createAgentResponse([{ type: "text", text: "Answer" }]),
				status: ++samples === 1 ? "failed" : "completed",
			}),
			selectContinuation: async () => ({ nextInput: "complete" }),
			selectRecovery: async () => ({ nextInput: "recovery", requiresContinuation: true }),
			releaseStep: (_sample, step) => {
				events.push(`release-${step}`)
			},
		})

		expect(await engine.run("request")).toMatchObject({ status: "completed", steps: 2 })
		expect(events).toEqual(["release-1", { step: 2, reason: "provider-recovery" }, "release-2"])
	})

	it("does not report a continuation that cancellation rejects during step release", async () => {
		let aborted = false
		const onContinuation = vi.fn()
		const sampleStep = vi.fn(async () => ({ response: createAgentResponse([]) }))
		const engine = new AgentTurnEngine<string>({
			shouldAbort: () => aborted,
			onContinuation,
			sampleStep,
			selectContinuation: async () => ({ nextInput: "pending", requiresContinuation: true }),
			releaseStep: () => {
				aborted = true
			},
		})

		expect(await engine.run("request")).toMatchObject({ status: "aborted", steps: 1 })
		expect(sampleStep).toHaveBeenCalledOnce()
		expect(onContinuation).not.toHaveBeenCalled()
	})
})
