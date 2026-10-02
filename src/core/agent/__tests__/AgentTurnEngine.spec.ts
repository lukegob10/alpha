import { describe, expect, it, vi } from "vitest"
import { createApiStreamOutcome } from "../../../api/transform/stream"

import {
	AgentResponseAccumulator,
	AgentTurnEngine,
	collectAgentResponse,
	type AgentResponse,
	type AgentTurnHost,
	type AgentTurnStagedHost,
} from "../AgentTurnEngine"

const emptyResponse = (): AgentResponse => ({
	items: [],
	text: "",
	reasoning: "",
	toolCalls: [],
})

describe("AgentResponseAccumulator", () => {
	it("forwards text and reasoning while keeping tool calls buffered", async () => {
		const accumulator = new AgentResponseAccumulator()
		const seen: string[] = []

		await accumulator.add({ type: "text", text: "before " }, (item) => {
			if (item.type === "text") {
				seen.push(item.text)
			}
		})
		await accumulator.add({ type: "tool_call_start", id: "call-1", name: "read_file" })
		await accumulator.add({ type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' })

		expect(seen).toEqual(["before "])
		const response = await accumulator.finish((item) => {
			if (item.type === "tool_call") {
				seen.push(item.name)
			}
		})

		expect(seen).toEqual(["before ", "read_file"])
		expect(response.toolCalls).toEqual([
			{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
		])
	})

	it("does not duplicate tool calls with duplicate end markers or IDs", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_start", id: "call-1", name: "read_file" } as const
				yield { type: "tool_call_delta", id: "call-1", delta: '{"path":"a.ts"}' } as const
				yield { type: "tool_call_end", id: "call-1" } as const
				yield { type: "tool_call_end", id: "call-1" } as const
				yield { type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' } as const
			})(),
		)

		expect(response.toolCalls).toHaveLength(1)
	})

	it("returns a structured error for malformed tool arguments", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call", id: "call-1", name: "read_file", arguments: "not-json" } as const
			})(),
		)

		expect(response.toolCalls).toHaveLength(0)
		expect(response.items).toContainEqual({
			type: "error",
			message: 'Unable to parse arguments for tool call "read_file" (call-1).',
			callId: "call-1",
			toolName: "read_file",
			retryable: false,
		})
		expect(response.outcome).toEqual({
			status: "failed",
			reason: 'Unable to parse arguments for tool call "read_file" (call-1).',
			retryable: false,
		})
	})
})

describe("AgentTurnEngine", () => {
	it("does not run effects or complete when a successful stream hides malformed tool arguments", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield { type: "text", text: "Finished." } as const
				yield { type: "tool_call", id: "bad", name: "read_file", arguments: "not-json" } as const
				yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true } as const
			})(),
		)
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => false,
			sampleStep: async () => ({ response }),
			commitResponse: vi.fn(),
			executeEffects: vi.fn(),
			selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
			releaseStep: vi.fn(),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toMatchObject({ status: "failed", steps: 1 })
		expect(host.commitResponse).toHaveBeenCalledOnce()
		expect(host.executeEffects).not.toHaveBeenCalled()
		expect(host.selectContinuation).not.toHaveBeenCalled()
		expect(host.releaseStep).toHaveBeenCalledOnce()
	})

	it("preserves cancellation received while the final step releases its runtime ownership", async () => {
		let aborted = false
		let releaseStarted!: () => void
		let finishRelease!: () => void
		const started = new Promise<void>((resolve) => {
			releaseStarted = resolve
		})
		const released = new Promise<void>((resolve) => {
			finishRelease = resolve
		})
		const response = { ...emptyResponse(), text: "Candidate answer." }
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => aborted,
			sampleStep: vi.fn(async () => ({ response })),
			selectContinuation: async () => ({ nextInput: "complete" }),
			releaseStep: vi.fn(async () => {
				releaseStarted()
				await released
			}),
		}
		const result = new AgentTurnEngine(host).run("first")
		await started
		aborted = true
		finishRelease()

		expect(await result).toMatchObject({ status: "aborted", steps: 1 })
		expect(host.releaseStep).toHaveBeenCalledOnce()
		expect(host.sampleStep).toHaveBeenCalledOnce()
	})

	it("does not run effects or complete a step for a truncated streamed tool call", async () => {
		const response = await collectAgentResponse(
			(async function* () {
				yield {
					type: "tool_call_partial",
					index: 0,
					id: "call-truncated",
					name: "apply_patch",
					arguments: '{"patch":"*** Begin Patch"}',
				} as const
				yield {
					type: "outcome",
					status: "incomplete",
					terminal: true,
					semanticOutputObserved: true,
					reason: "output token limit",
				} as const
			})(),
		)
		const effects: string[] = []
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => false,
			sampleStep: async () => ({ response }),
			commitResponse: vi.fn(),
			executeEffects: vi.fn(async (sample: { response: AgentResponse }) => {
				effects.push(...sample.response.toolCalls.map((call) => call.id))
			}),
			selectContinuation: vi.fn(async () => ({ nextInput: "complete" })),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(response.outcome?.status).toBe("incomplete")
		expect(response.toolCalls).toEqual([])
		expect(host.commitResponse).toHaveBeenCalledOnce()
		expect(host.executeEffects).not.toHaveBeenCalled()
		expect(host.selectContinuation).not.toHaveBeenCalled()
		expect(effects).toEqual([])
		expect(result).toMatchObject({ status: "incomplete", steps: 1, reason: "output token limit" })
	})

	it("treats a visible assistant response without tool calls as a completed turn", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async () => ({
				response: { ...emptyResponse(), text: "The requested explanation." },
				nextInput: "synthetic-recovery",
			})),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 1,
			completionReason: "assistant",
			response: { ...emptyResponse(), text: "The requested explanation." },
		})
		expect(host.runStep).toHaveBeenCalledOnce()
	})

	it("continues after a normally completed response explicitly requires another model step", async () => {
		const firstResponse = await collectAgentResponse(
			(async function* () {
				yield { type: "text", text: "Intermediate progress." } as const
				yield createApiStreamOutcome({
					status: "completed",
					terminal: true,
					semanticOutputObserved: true,
					requiresContinuation: true,
				})
			})(),
		)
		const finalResponse = { ...emptyResponse(), text: "The final answer." }
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => false,
			sampleStep: vi.fn(async (input) => ({
				response: input === "first" ? firstResponse : finalResponse,
			})),
			selectContinuation: vi.fn(async (_sample, step) => ({
				nextInput: step === 1 ? "provider-follow-up" : "complete",
			})),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(firstResponse.outcome).toEqual({ status: "completed", requiresContinuation: true })
		expect(host.sampleStep).toHaveBeenNthCalledWith(1, "first")
		expect(host.sampleStep).toHaveBeenNthCalledWith(2, "provider-follow-up")
		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "host",
			response: finalResponse,
		})
	})

	it("lets hosts require an explicit completion boundary", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			canCompleteWithoutTools: () => false,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "Managed child progress." },
					nextInput: "explicit-completion-required",
				})
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "complete" }),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "host",
			response: emptyResponse(),
		})
		expect(host.runStep).toHaveBeenNthCalledWith(2, "explicit-completion-required")
	})

	it("never completes a response that contains a canonical error item", async () => {
		const response: AgentResponse = {
			items: [
				{ type: "text", text: "Partial answer." },
				{ type: "error", message: "Provider stream failed." },
			],
			text: "Partial answer.",
			reasoning: "",
			toolCalls: [],
			outcome: { status: "completed" },
		}
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "failed",
			steps: 1,
			reason: "Provider stream failed.",
			response,
		})
	})

	it.each([
		{
			label: "an explicit attempt_completion call",
			response: {
				...emptyResponse(),
				items: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
				toolCalls: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
			},
		},
		{
			label: "assistant text accompanied by attempt_completion",
			response: {
				items: [
					{ type: "text" as const, text: "Finished." },
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
				text: "Finished.",
				reasoning: "",
				toolCalls: [
					{
						type: "tool_call" as const,
						id: "completion-1",
						name: "attempt_completion",
						arguments: { result: "Finished." },
					},
				],
			},
		},
	] satisfies Array<{ label: string; response: AgentResponse }>)(
		"treats $label as one host-owned completion step",
		async ({ response }) => {
			const onStepComplete = vi.fn()
			const host: AgentTurnHost<string> = {
				shouldAbort: () => false,
				runStep: vi.fn(async () => ({ response, nextInput: "complete" as const })),
				onStepComplete,
			}

			const result = await new AgentTurnEngine(host).run("first")

			expect(result).toEqual({ status: "completed", steps: 1, completionReason: "host", response })
			expect(host.runStep).toHaveBeenCalledOnce()
			expect(onStepComplete).toHaveBeenCalledOnce()
			expect(onStepComplete).toHaveBeenCalledWith(response, 1)
		},
	)

	it("runs selected continuation input before implicit completion", async () => {
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			canCompleteWithoutTools: () => true,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "First answer." },
					nextInput: "queued-user-message",
					requiresContinuation: true,
				})
				.mockResolvedValueOnce({
					response: { ...emptyResponse(), text: "Answer with queued context." },
					nextInput: "unused-recovery",
				}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "assistant",
			response: { ...emptyResponse(), text: "Answer with queued context." },
		})
		expect(host.runStep).toHaveBeenNthCalledWith(2, "queued-user-message")
	})

	it("sequences steps and stops when the host completes", async () => {
		const calls: string[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi.fn(async (input) => {
				calls.push(input)
				if (input === "first") {
					return { response: emptyResponse(), nextInput: "second" }
				}
				return { response: emptyResponse(), nextInput: "complete" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "host",
			response: emptyResponse(),
		})
		expect(calls).toEqual(["first", "second"])
	})

	it("does not start another step after abort", async () => {
		let aborted = false
		const host: AgentTurnHost<string> = {
			shouldAbort: () => aborted,
			runStep: vi.fn(async () => {
				aborted = true
				return { response: emptyResponse(), nextInput: "next" }
			}),
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toEqual({ status: "aborted", steps: 1 })
		expect(host.runStep).toHaveBeenCalledTimes(1)
	})

	it("runs the completion callback after each completed step", async () => {
		const completed: number[] = []
		const host: AgentTurnHost<string> = {
			shouldAbort: () => false,
			runStep: vi
				.fn()
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "next" })
				.mockResolvedValueOnce({ response: emptyResponse(), nextInput: "complete" }),
			onStepComplete: (_response, step) => {
				completed.push(step)
			},
		}

		await new AgentTurnEngine(host).run("first")

		expect(completed).toEqual([1, 2])
	})

	it("keeps sampled step state alive through continuation selection and releases afterward", async () => {
		const events: string[] = []
		const sample = { response: { ...emptyResponse(), text: "Answer." }, step: { retained: true } }
		const host: AgentTurnStagedHost<string, typeof sample.step> = {
			shouldAbort: () => false,
			sampleStep: vi.fn(async () => sample),
			commitResponse: async () => {
				events.push("commit")
			},
			executeEffects: async () => {
				events.push("effects")
			},
			selectContinuation: async (selectedSample) => {
				events.push("continuation")
				expect(selectedSample.step).toBe(sample.step)
				expect(events).not.toContain("release")
				return { nextInput: "complete" }
			},
			releaseStep: (releasedSample) => {
				events.push("release")
				expect(releasedSample.step).toBe(sample.step)
			},
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(events).toEqual(["commit", "effects", "continuation", "release"])
		expect(result).toEqual({
			status: "completed",
			steps: 1,
			response: sample.response,
			completionReason: "host",
		})
	})

	it("preserves the original phase failure and response when completion and release also fail", async () => {
		const response = { ...emptyResponse(), text: "Persisted candidate." }
		const phaseError = new Error("assistant commit failed")
		const host: AgentTurnStagedHost<string, { lease: number }> = {
			shouldAbort: () => false,
			sampleStep: async () => ({ response, step: { lease: 1 } }),
			commitResponse: async () => {
				throw phaseError
			},
			executeEffects: vi.fn(),
			onStepComplete: async () => {
				throw new Error("completion callback failed")
			},
			selectContinuation: vi.fn(async () => ({ nextInput: "complete" as const })),
			releaseStep: async () => {
				throw new Error("release failed")
			},
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toMatchObject({
			status: "failed",
			steps: 1,
			reason: "assistant commit failed",
			error: phaseError,
			response,
		})
		expect(host.executeEffects).not.toHaveBeenCalled()
		expect(host.selectContinuation).not.toHaveBeenCalled()
	})

	it("reports a release failure against the sampled response", async () => {
		const response = { ...emptyResponse(), text: "Candidate." }
		const releaseError = new Error("step cleanup failed")
		const host: AgentTurnStagedHost<string, { lease: number }> = {
			shouldAbort: () => false,
			sampleStep: async () => ({ response, step: { lease: 1 } }),
			selectContinuation: async () => ({ nextInput: "complete" }),
			releaseStep: async () => {
				throw releaseError
			},
		}

		const result = await new AgentTurnEngine(host).run("first")

		expect(result).toMatchObject({
			status: "failed",
			steps: 1,
			reason: "step cleanup failed",
			error: releaseError,
			response,
		})
	})
})
