import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HarnessProcessSpec } from "../../orchestration/index"

const mocks = vi.hoisted(() => ({ findTrialForTask: vi.fn(), applyAttemptEvent: vi.fn() }))
vi.mock("../../db/index", () => mocks)

import { reconcileRunBeforeDispatch } from "../reconcileRun"

const success = (stdout = "") => ({
	exitCode: 0,
	stdout,
	stderr: "",
	durationMs: 1,
	timedOut: false,
	outputTruncated: false,
})

beforeEach(() => vi.clearAllMocks())

describe("production run restart reconciliation", () => {
	it.each(["setup", "agent_execution", "evidence_collection", "grading"])(
		"verifies owned cleanup before reconciling an interrupted %s attempt",
		async (phase) => {
			mocks.findTrialForTask.mockResolvedValue({
				id: 22,
				attempts: [
					{ id: 33, phase, terminalStatus: null, version: 7 },
					{ id: 34, phase: "grading", terminalStatus: "outcome_failed", version: 5 },
				],
			})
			const operations: string[] = []
			let present = true
			const runner = {
				run: async ({ args }: HarnessProcessSpec) => {
					operations.push(args[0]!)
					if (args[0] === "rm") present = false
					if (args[0] === "ps" && present)
						return success(
							JSON.stringify({
								ID: "owned-container",
								Names: "attempt-33",
								Status: "Up",
								Labels: "alpha.evals.attempt-id=33",
							}),
						)
					return success()
				},
			}
			mocks.applyAttemptEvent.mockImplementation(async () => {
				operations.push("reconcile")
				expect(present).toBe(false)
			})
			await reconcileRunBeforeDispatch({
				runId: 11,
				taskIds: [1],
				containerized: true,
				assertOwnership: async () => {
					operations.push("ownership")
				},
				processRunner: runner,
			})
			expect(operations).toEqual(["ownership", "ownership", "ps", "rm", "ps", "ps", "ownership", "reconcile"])
			expect(mocks.applyAttemptEvent).toHaveBeenCalledExactlyOnceWith(
				33,
				expect.objectContaining({ type: "reconcile_interrupted", failureCode: "controller_interrupted" }),
				{ expectedVersion: 7 },
			)
		},
	)

	it("never reconciles or dispatches while another controller owns the run", async () => {
		mocks.findTrialForTask.mockResolvedValue({ id: 22, attempts: [{ id: 33, terminalStatus: null, version: 1 }] })
		const run = vi.fn()
		await expect(
			reconcileRunBeforeDispatch({
				runId: 11,
				taskIds: [1],
				containerized: true,
				processRunner: { run },
				assertOwnership: async () => {
					throw new Error("lease lost")
				},
			}),
		).rejects.toThrow("lease lost")
		expect(run).not.toHaveBeenCalled()
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
	})

	it("blocks local re-entry when the previous host cannot be proven stopped", async () => {
		mocks.findTrialForTask.mockResolvedValue({ id: 22, attempts: [{ id: 33, terminalStatus: null, version: 1 }] })
		await expect(
			reconcileRunBeforeDispatch({
				runId: 11,
				taskIds: [1],
				containerized: false,
				assertOwnership: async () => {},
			}),
		).rejects.toThrow("owned host cleanup")
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
	})

	it("retains the interrupted attempt when cleanup fails", async () => {
		mocks.findTrialForTask.mockResolvedValue({ id: 22, attempts: [{ id: 33, terminalStatus: null, version: 1 }] })
		await expect(
			reconcileRunBeforeDispatch({
				runId: 11,
				taskIds: [1],
				containerized: true,
				assertOwnership: async () => {},
				processRunner: {
					run: async () => {
						throw new Error("Docker unavailable")
					},
				},
			}),
		).rejects.toThrow("Docker unavailable")
		expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
	})
})
